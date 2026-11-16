#!/usr/bin/env node
// Read-only: does not instantiate the hub, migrate, index, or contact a model.
import { DatabaseSync } from "node:sqlite";
import { summarizeSearches } from "../src/searchDiagnostics.js";

const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (!["--db", "--since", "--project", "--model"].includes(key) || !args[i + 1] || args[i + 1].startsWith("--")) {
    throw new Error("Usage: node scripts/search-diagnostics.mjs [--db path] [--since YYYY-MM-DD] [--project exact-path] [--model model-name]");
  }
  options[key] = args[++i];
}
const since = options["--since"] || new Date(Date.now() - 14 * 86400000).toISOString();
if (!Number.isFinite(Date.parse(since))) throw new Error("Invalid --since date");
const project = options["--project"]?.replaceAll("\\", "/").replace(/\/$/, "");
const db = new DatabaseSync(options["--db"] || ".cortex/cortex.sqlite", { readOnly: true });
try {
  const rows = db.prepare(`SELECT payload_json FROM metrics_events
    WHERE kind = 'search_used' AND created_at >= ? ${project ? "AND project_path = ?" : ""}`)
    .all(...[new Date(since).toISOString(), ...(project ? [project] : [])])
    .map((row) => { try { return { payload: JSON.parse(row.payload_json) }; } catch { return { payload: {} }; } });
  const model = options["--model"] || process.env.CORTEX_EMBED_MODEL || "nomic-embed-text";
  // one row per (record, chunk); chunk n>0 vectors are keyed "<id>#<n>" (src/chunk.js)
  const coverage = db.prepare(`WITH s AS (
      SELECT record_id, project_path, ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY rowid) - 1 AS chunk_index FROM search_chunks)
    SELECT COUNT(*) AS indexed,
    SUM(CASE WHEN EXISTS (SELECT 1 FROM embedding_vectors e
      WHERE e.record_id = (CASE WHEN s.chunk_index = 0 THEN s.record_id ELSE s.record_id || '#' || s.chunk_index END) AND e.model = ?) THEN 1 ELSE 0 END) AS embedded
    FROM s ${project ? "WHERE s.project_path = ?" : ""}`).get(...[model, ...(project ? [project] : [])]);
  const indexed = Number(coverage.indexed);
  const embedded = Number(coverage.embedded || 0);
  console.log(JSON.stringify({ since: new Date(since).toISOString(), project: project || "all",
    ...summarizeSearches(rows), embeddingCoverage: { model, indexed, embedded, missing: indexed - embedded },
    notes: ["Counts describe retained search telemetry, not retrieval accuracy or user satisfaction.",
      "Timing covers synchronous indexing/search/packing only; excludes query embedding preparation and HTTP transport.",
      "Legacy events lack result identities; they cannot be reconstructed as complete search traces.",
      "Coverage counts matching-model rows; it does not validate vector contents. No query text is printed."] }, null, 2));
} finally { db.close(); }
