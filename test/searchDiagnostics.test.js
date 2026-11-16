import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createCortex } from "../src/index.js";
import { summarizeSearches } from "../src/searchDiagnostics.js";

test("search diagnostics distinguish missing legacy telemetry from an empty pack", () => {
  const report = summarizeSearches([
    { payload: { results: 2 } },
    { payload: { results: 0 } },
    { payload: { traceVersion: 1, results: 1, returnedIds: ["a"], packedIds: [], budgetExcluded: 1, embeddingMode: "minhash", searchDurationMs: 20, queryTruncated: true } },
    { payload: { traceVersion: 1, results: 1, returnedIds: ["a"], packedIds: ["a"], embeddingMode: "ollama", searchDurationMs: 10 } },
  ]);
  assert.equal(report.legacy, 2);
  assert.equal(report.traced, 2);
  assert.equal(report.emptyResults, 1);
  assert.equal(report.emptyPacksWithResults, 1);
  assert.equal(report.budgetLimited, 1);
  assert.equal(report.truncatedQueries, 1);
  assert.equal(report.searchP50Ms, 10);
  assert.equal(report.searchP95Ms, 20);
  assert.deepEqual(report.embeddingModes, { minhash: 1, ollama: 1 });
  assert.equal(summarizeSearches([]).searchP50Ms, null);
});

test("actual search traces preserve identities, budget losses and bounded queries; report is read-only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-diagnostics-"));
  const dbPath = join(dir, "test.sqlite");
  const hub = createCortex({ dbPath });
  try {
    const capture = hub.captureCandidate({ projectPath: dir, agent: "codex", message: "Fixed restore reconciliation after backup. Verification: npm test passed." });
    const result = hub.search({ projectPath: dir, query: "restore", maxTokens: 1 });
    assert.equal(result.results[0].id, capture.recordId);
    const trace = hub.storage.listMetrics(dir, { kind: "search_used" })[0].payload;
    assert.deepEqual(trace.returnedIds, [capture.recordId]);
    assert.deepEqual(trace.packedIds, []);
    assert.equal(trace.budgetExcluded, 1);
    assert.equal(trace.maxTokens, 1);
    assert.equal(trace.queryTruncated, false);
    hub.search({ projectPath: dir, query: "restore ".repeat(300) });
    hub.search({ projectPath: dir, query: "restore", internal: true });
    const traces = hub.storage.listMetrics(dir, { kind: "search_used" });
    assert.equal(traces.length, 2);
    assert.equal(traces.filter((r) => r.payload.queryTruncated)[0].payload.query.length, 2000);
    const before = hub.storage.db.prepare("SELECT COUNT(*) AS n FROM metrics_events").get().n;
    const report = JSON.parse(execFileSync(process.execPath, ["scripts/search-diagnostics.mjs", "--db", dbPath, "--since", "2020-01-01", "--project", dir], { encoding: "utf8" }));
    assert.equal(report.searches, 2);
    assert.equal(report.traced, 2);
    assert.equal(report.embeddingCoverage.indexed, 1);
    assert.equal(report.embeddingCoverage.missing, 1);
    assert.equal(JSON.stringify(report).includes("restore"), false);
    assert.equal(hub.storage.db.prepare("SELECT COUNT(*) AS n FROM metrics_events").get().n, before);
  } finally { hub.close(); await rm(dir, { recursive: true, force: true }); }
});
