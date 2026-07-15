import { randomUUID } from "node:crypto";
import { LocalMinHashEmbeddingProvider } from "./embeddingProvider.js";

export function enqueueRecord(storage, recordId, recordType) {
  const timestamp = new Date().toISOString();
  storage.db.prepare(`
    INSERT INTO index_jobs (id, record_id, record_type, status, attempts, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', 0, ?, ?)
  `).run(randomUUID(), recordId, recordType, timestamp, timestamp);
}

function recordContent(storage, job) {
  if (job.recordType === "fix") {
    const record = storage.getFix(job.recordId);
    if (!record) return undefined;
    return { record, title: record.summary, body: [record.verification, record.residualRisk].filter(Boolean).join(" "), tags: record.filesChanged.join(" ") };
  }
  if (job.recordType === "research") {
    const record = storage.getResearch(job.recordId);
    if (!record) return undefined;
    return { record, title: record.question, body: [record.finding, record.verification, record.residualRisk].filter(Boolean).join(" "), tags: record.reuseTags.join(" ") };
  }
  if (job.recordType === "decision") {
    const record = storage.getDecision(job.recordId);
    if (!record) return undefined;
    return { record, title: record.decision, body: [record.rationale, record.alternatives].filter(Boolean).join(" "), tags: "" };
  }
  throw new Error(`Unknown index record type: ${job.recordType}`); // marked failed, not silent-skip
}

// ponytail: comparing against every same-project record is O(n) per job, O(n^2) over a full
// reindex — measured 84s to seed 550 records. Capped to the most recently indexed N candidates
// (rowid as a recency proxy; search_chunks has no timestamp column of its own) so cost per job
// stays bounded regardless of project size. Trades recall of similarity links against very old
// records for that bound — raise the cap, or pre-filter via FTS, if that recall loss matters.
const SIMILARITY_CANDIDATE_CAP = Number(process.env.CORTEX_SIMILARITY_CANDIDATE_CAP || 200);

function linkSimilarRecords(storage, job, content, embeddingProvider, threshold) {
  const subject = storage.db.prepare(
    "SELECT entity_id AS id FROM record_entities WHERE record_id = ? AND role = 'subject'",
  ).get(job.recordId);
  if (!subject) return;
  for (const candidate of storage.db.prepare(`
    SELECT record_id AS id, title, body FROM search_chunks
    WHERE project_path = ? AND record_id != ?
    ORDER BY rowid DESC LIMIT ?
  `).all(content.record.projectPath, job.recordId, SIMILARITY_CANDIDATE_CAP)) {
    const confidence = embeddingProvider.similarity(
      `${content.title} ${content.body}`,
      `${candidate.title} ${candidate.body}`,
    );
    if (confidence < threshold) continue;
    const target = storage.db.prepare(
      "SELECT entity_id AS id FROM record_entities WHERE record_id = ? AND role = 'subject'",
    ).get(candidate.id);
    if (!target) continue;
    const exists = storage.db.prepare(`
      SELECT 1 FROM links WHERE link_type = 'similar_to'
        AND ((from_entity_id = ? AND to_entity_id = ?) OR (from_entity_id = ? AND to_entity_id = ?))
    `).get(subject.id, target.id, target.id, subject.id);
    if (!exists) storage.linkRecords({
      fromEntityId: subject.id,
      toEntityId: target.id,
      linkType: "similar_to",
      source: "minhash",
      confidence,
      originRecordId: job.recordId,
    });
  }
}

export function runNextIndexJob(storage, {
  now = new Date(),
  baseDelayMs = 1000,
  maxAttempts = 5,
  embeddingProvider = new LocalMinHashEmbeddingProvider(),
  similarityThreshold = 0.6,
} = {}) {
  const job = storage.db.prepare(`
    SELECT id, record_id AS recordId, record_type AS recordType, status, attempts,
      updated_at AS updatedAt
    FROM index_jobs WHERE status = 'pending' OR (status = 'failed' AND attempts < ?)
    ORDER BY created_at
  `).all(maxAttempts).find((candidate) => candidate.status === "pending"
    || now.getTime() - Date.parse(candidate.updatedAt) >= baseDelayMs * (2 ** (candidate.attempts - 1)));
  if (!job) return undefined;
  const timestamp = now.toISOString();
  storage.db.prepare("UPDATE index_jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(timestamp, job.id);
  try {
    const content = recordContent(storage, job);
    storage.db.prepare("DELETE FROM search_chunks WHERE record_id = ?").run(job.recordId);
    if (content) storage.db.prepare(`
      INSERT INTO search_chunks (record_id, project_path, record_type, title, body, tags)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(job.recordId, content.record.projectPath, job.recordType, content.title, content.body, content.tags);
    if (content) linkSimilarRecords(storage, job, content, embeddingProvider, similarityThreshold);
    storage.db.prepare("UPDATE index_jobs SET status = 'done', last_error = NULL, updated_at = ? WHERE id = ?").run(timestamp, job.id);
    return { ...job, status: "done" };
  } catch (error) {
    storage.db.prepare("UPDATE index_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?").run(String(error.message).slice(0, 300), timestamp, job.id);
    return { ...job, status: "failed", error: error.message };
  }
}

export function drainIndexJobs(storage, options = {}) {
  const results = [];
  const now = options.now || new Date();
  const embeddingProvider = options.embeddingProvider || new LocalMinHashEmbeddingProvider();
  while (true) {
    const result = runNextIndexJob(storage, { ...options, now, embeddingProvider });
    if (!result) break;
    results.push(result);
  }
  return results;
}

export function ensureSearchIndex(storage) {
  let queued = 0;
  storage.transaction(() => {
    for (const [table, type] of [["fix_entries", "fix"], ["research_entries", "research"], ["decision_entries", "decision"]]) {
      const missing = storage.db.prepare(`
        SELECT record.id
        FROM ${table} AS record
        WHERE NOT EXISTS (SELECT 1 FROM search_chunks AS chunk WHERE chunk.record_id = record.id)
          AND NOT EXISTS (
            SELECT 1 FROM index_jobs AS job
            WHERE job.record_id = record.id AND job.status IN ('pending', 'running', 'failed')
          )
      `).all();
      for (const { id } of missing) {
        enqueueRecord(storage, id, type);
        queued += 1;
      }
    }
  });
  const indexed = drainIndexJobs(storage).filter((job) => job?.status === "done").length;
  return { queued, indexed };
}

export function rebuildSearchIndex(storage) {
  storage.transaction(() => {
    storage.db.exec("DELETE FROM search_chunks; DELETE FROM index_jobs;");
    for (const [table, type] of [["fix_entries", "fix"], ["research_entries", "research"], ["decision_entries", "decision"]]) {
      for (const { id } of storage.db.prepare(`SELECT id FROM ${table}`).all()) enqueueRecord(storage, id, type);
    }
  });
  return drainIndexJobs(storage);
}
