import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import * as crypto from "node:crypto";
import { createCortex, normalizeProjectPath } from "../src/index.js";
import { drainIndexJobs } from "../src/indexer.js";
import { searchMemory } from "../src/search.js";
import { LocalMinHashEmbeddingProvider } from "../src/embeddingProvider.js";

async function withSearchHub(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cortex-search-"));
  const hub = createCortex({ dbPath: join(dir, "search.sqlite") });
  try { await fn(hub, dir); } finally { hub.close(); await rm(dir, { recursive: true, force: true }); }
}

test("returns stable explainable results and keeps quality stronger than recency", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-search-"));
  const hub = createCortex({ dbPath: join(dir, "search.sqlite") });
  try {
    const verified = hub.captureCandidate({ projectPath: dir, agent: "codex", message: "Fixed close reconciliation. Verification: npm test passed." });
    const recent = hub.captureCandidate({ projectPath: dir, agent: "codex", message: "Implemented close reconciliation notes." });
    hub.storage.db.prepare("UPDATE fix_entries SET created_at = ? WHERE id = ?").run("2026-05-01T00:00:00.000Z", verified.recordId);
    drainIndexJobs(hub.storage);

    const options = { projectPath: dir, query: "close reconciliation", now: new Date("2026-06-18T00:00:00.000Z") };
    const first = searchMemory(hub.storage, options);
    const second = searchMemory(hub.storage, options);

    assert.equal(first.results[0].id, verified.recordId);
    assert.deepEqual(first.results.map(({ id }) => id), second.results.map(({ id }) => id));
    assert.equal(first.diagnostics.semanticAvailable, true);
    assert.equal(Object.keys(first.results[0].scoreComponents).sort().join(","), "graph,lexical,quality,recency,semantic");
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("search hides superseded records unless explicitly included", async () => {
  await withSearchHub(async (hub, dir) => {
    const old = hub.storage.insertFix({ id: crypto.randomUUID(), projectPath: dir, agent: "a", summary: "close fill bug", filesChanged: ["reconcile.js"] });
    hub.storage.insertFix({ id: crypto.randomUUID(), projectPath: dir, agent: "a", summary: "close fill bug fixed properly", filesChanged: ["reconcile.js"], supersedesId: old.id });
    hub.rebuildIndex();

    const hidden = hub.search({ projectPath: dir, query: "close fill" });
    assert.equal(hidden.results.some((r) => r.id === old.id), false);
    const shown = hub.search({ projectPath: dir, query: "close fill", includeSuperseded: true });
    assert.equal(shown.results.some((r) => r.id === old.id), true);
  });
});

test("graph score excludes project/agent supernodes so it does not saturate to 1.0", async () => {
  await withSearchHub(async (hub, dir) => {
    // Many fixes in one project pile links onto the shared project + agent entities.
    // A bare fix (no shared files/tags) must not inherit their degree and clamp to 1.0.
    for (let i = 0; i < 8; i += 1) {
      hub.storage.insertFix({ id: crypto.randomUUID(), projectPath: dir, agent: "a", summary: `unrelated change ${i}`, filesChanged: [] });
    }
    const bare = hub.storage.insertFix({ id: crypto.randomUUID(), projectPath: dir, agent: "a", summary: "isolated stampede fix", filesChanged: [] });
    hub.rebuildIndex();

    const result = searchMemory(hub.storage, { projectPath: dir, query: "isolated stampede" }).results.find((r) => r.id === bare.id);
    assert.ok(result, "bare fix should be found");
    assert.ok(result.scoreComponents.graph < 1, `graph should not be saturated, got ${result.scoreComponents.graph}`);
  });
});

test("search normalizes the project path so non-canonical paths still match", async () => {
  await withSearchHub(async (hub, dir) => {
    hub.captureCandidate({ projectPath: dir, agent: "codex", message: "Fixed the cache stampede. Verification: load test passed." });
    drainIndexJobs(hub.storage);
    // a client passing a non-canonical form of the same path (trailing separator) must still find it
    const nonCanonical = dir + sep;
    const results = searchMemory(hub.storage, { projectPath: nonCanonical, query: "cache stampede" }).results;
    assert.equal(results.length, 1);
  });
});

test("local MinHash gives related text more semantic similarity than unrelated text", () => {
  const provider = new LocalMinHashEmbeddingProvider();
  assert.equal(provider.signature("websocket retry backoff"), provider.signature("websocket retry backoff"));
  const related = provider.similarity("websocket retry backoff", "websocket retry delay and backoff");
  const unrelated = provider.similarity("websocket retry backoff", "calendar meeting agenda");
  assert.equal(provider.available(), true);
  assert.ok(related > unrelated);
  assert.ok(related > 0);
});

test("quality score increases gradually with evidence instead of using a binary cliff", async () => {
  await withSearchHub(async (hub, dir) => {
    const old = "2025-01-01T00:00:00.000Z";
    const bare = hub.storage.insertFix({ id: crypto.randomUUID(), projectPath: dir, agent: "a", summary: "graded quality cache", filesChanged: [] });
    const files = hub.storage.insertFix({ id: crypto.randomUUID(), projectPath: dir, agent: "a", summary: "graded quality cache files", filesChanged: ["cache.js"] });
    const proven = hub.storage.insertFix({
      id: crypto.randomUUID(), projectPath: dir, agent: "a", summary: "graded quality cache proven",
      filesChanged: ["cache.js"], commitSha: "abc123", verification: "npm test passed",
    });
    hub.storage.db.prepare("UPDATE fix_entries SET created_at = ? WHERE id IN (?, ?)").run(old, bare.id, files.id);
    hub.rebuildIndex();

    const results = searchMemory(hub.storage, {
      projectPath: dir, query: "graded quality cache", now: new Date("2026-06-18T00:00:00.000Z"),
    }).results;
    const quality = Object.fromEntries(results.map((result) => [result.id, result.scoreComponents.quality]));
    assert.ok(quality[bare.id] >= 0.2 && quality[bare.id] < quality[files.id]);
    assert.ok(quality[files.id] < quality[proven.id]);
    assert.equal(quality[proven.id], 1);
  });
});

test("search includes cross-project matches with a same-project affinity advantage", async () => {
  await withSearchHub(async (hub, dir) => {
    const other = join(dir, "other");
    const local = hub.storage.insertFix({ id: crypto.randomUUID(), projectPath: dir, agent: "a", summary: "portable cache repair", filesChanged: [] });
    const remote = hub.storage.insertFix({ id: crypto.randomUUID(), projectPath: other, agent: "a", summary: "portable cache repair", filesChanged: [] });
    hub.rebuildIndex();

    const results = searchMemory(hub.storage, { projectPath: dir, query: "portable cache repair" }).results;
    assert.deepEqual(new Set(results.map((result) => result.id)), new Set([local.id, remote.id]));
    assert.equal(results[0].id, local.id);
    assert.equal(results.find((result) => result.id === remote.id).projectPath, normalizeProjectPath(other));
    assert.ok(results.find((result) => result.id === remote.id).score < results[0].score);
  });
});
