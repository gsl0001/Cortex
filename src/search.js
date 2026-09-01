import { LocalMinHashEmbeddingProvider } from "./embeddingProvider.js";
import { normalizeProjectPath } from "./storage.js";

// 2026-07-19 A/B on the live DB (9 ground-truth queries through this full pipeline):
// shifting 0.10 from lexical to semantic moved median ground-truth rank 3 → 2 with zero
// regressions, and the MinHash-fallback mode (Ollama down) also ranked equal-or-better.
export const DEFAULT_WEIGHTS = Object.freeze({
  lexical: 0.25,
  semantic: 0.35,
  graph: 0.15,
  quality: 0.15,
  recency: 0.10,
});

function effectiveWeights(weights, semanticAvailable) {
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > 1e-9) throw new Error("Search weights must sum to 1");
  if (semanticAvailable) return weights;
  const active = 1 - weights.semantic;
  return { ...weights, lexical: weights.lexical / active, graph: weights.graph / active, quality: weights.quality / active, recency: weights.recency / active, semantic: 0 };
}

function recency(createdAt, now, halfLifeDays) {
  const ageDays = Math.max(0, (now.getTime() - new Date(createdAt).getTime()) / 86400000);
  return Math.exp(-Math.log(2) * ageDays / halfLifeDays);
}

export function searchMemory(storage, {
  projectPath,
  query,
  limit = 20,
  now = new Date(),
  halfLifeDays = 30,
  weights = DEFAULT_WEIGHTS,
  includeSuperseded = false,
  embeddingProvider = new LocalMinHashEmbeddingProvider(),
} = {}) {
  const terms = String(query || "").toLowerCase().match(/[a-z0-9_-]{2,}/g) || [];
  if (!terms.length) return { results: [], diagnostics: { semanticAvailable: false, weights } };
  const normalizedProject = normalizeProjectPath(projectPath);
  const ftsQuery = [...new Set(terms)].map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
  const rows = storage.db.prepare(`
    SELECT record_id AS id, record_type AS recordType, bm25(search_chunks) AS rank,
      project_path AS projectPath, title, body, tags
    FROM search_chunks
    WHERE search_chunks MATCH ?
    ORDER BY rank LIMIT 100
  `).all(ftsQuery);
  const supersededIds = includeSuperseded ? new Set() : new Set(
    storage.db.prepare("SELECT supersedes_id AS id FROM fix_entries WHERE supersedes_id IS NOT NULL")
      .all().map((row) => row.id),
  );
  const semanticAvailable = Boolean(embeddingProvider.available?.());
  const activeWeights = effectiveWeights(weights, semanticAvailable);
  // ponytail: count links only to discriminating entities. Project/agent are
  // supernodes every record attaches to, so including them saturated every
  // record's score to 1.0 and the graph term ranked nothing.
  // Batched once for all candidate rows (was a per-row query inside the .map() below — a
  // genuine N+1 that measured 10x slower than this single GROUP BY at realistic record counts).
  const linkCounts = new Map();
  if (rows.length) {
    storage.db.prepare(`
      SELECT re.record_id AS recordId, COUNT(DISTINCT l.id) AS count
      FROM record_entities re
      JOIN entities e ON e.id = re.entity_id
      JOIN links l ON l.from_entity_id = re.entity_id OR l.to_entity_id = re.entity_id
      WHERE re.record_id IN (${rows.map(() => "?").join(",")}) AND e.entity_type NOT IN ('project', 'agent')
      GROUP BY re.record_id
    `).all(...rows.map((row) => row.id)).forEach((row) => linkCounts.set(row.recordId, row.count));
  }
  const results = rows.map((row) => {
    const record = row.recordType === "fix" ? storage.getFix(row.id)
      : row.recordType === "decision" ? storage.getDecision(row.id)
      : storage.getResearch(row.id);
    // FTS5's bm25() (selected as `rank`, lower/more negative = better) replaces the old
    // term-coverage ratio, which weighted "src" like "quarantine" and ignored term frequency
    // and field length. Normalized into (0,1) so the weighted sum keeps its scale.
    const bm25Goodness = Math.max(0, -Number(row.rank) || 0);
    const lexical = bm25Goodness / (bm25Goodness + 1);
    const semantic = semanticAvailable ? embeddingProvider.similarity(query, `${row.title} ${row.body}`, row.id) : 0;
    const graph = Math.min(1, (linkCounts.get(row.id) || 0) / 5);
    const recent = recency(record.createdAt, now, halfLifeDays);
    const quality = Math.min(1,
      0.2
      + (record.qualityStatus === "verified" || record.verification ? 0.5 : 0)
      + (record.filesChanged?.length ? 0.15 : 0)
      + (record.commitSha ? 0.1 : 0)
      + 0.05 * recent,
    );
    const scoreComponents = { lexical, semantic, graph, quality, recency: recent };
    const affinity = row.projectPath === normalizedProject ? 1 : 0.75;
    const score = Object.entries(scoreComponents).reduce((sum, [name, value]) => sum + value * activeWeights[name], 0) * affinity;
    return {
      id: row.id,
      recordType: row.recordType,
      projectPath: row.projectPath,
      title: row.title,
      excerpt: row.body || row.title,
      verification: record.verification,
      createdAt: record.createdAt,
      score,
      scoreComponents,
    };
  }).filter((result) => !supersededIds.has(result.id))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit);
  return { results, diagnostics: { semanticAvailable, weights: activeWeights, candidateCount: rows.length } };
}
