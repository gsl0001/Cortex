import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCortex } from "../src/index.js";
import { drainIndexJobs, enqueueRecord, ensureSearchIndex, rebuildSearchIndex } from "../src/indexer.js";
import { linkCapturedRecord } from "../src/linker.js";

test("indexes captured records incrementally and rebuilds equivalently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-indexer-"));
  const hub = createCortex({ dbPath: join(dir, "index.sqlite") });
  try {
    hub.captureCandidate({ projectPath: dir, agent: "codex", message: "Fixed close-fill reconciliation. Verification: npm test passed." });
    assert.equal(hub.storage.db.prepare("SELECT COUNT(*) AS count FROM index_jobs WHERE status = 'pending'").get().count, 1);
    drainIndexJobs(hub.storage);
    const before = hub.storage.db.prepare("SELECT record_id AS recordId FROM search_chunks WHERE search_chunks MATCH 'reconciliation'").all();
    assert.equal(before.length, 1);

    rebuildSearchIndex(hub.storage);
    const after = hub.storage.db.prepare("SELECT record_id AS recordId FROM search_chunks WHERE search_chunks MATCH 'reconciliation'").all();
    assert.deepEqual(after, before);
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("queues and indexes durable records missing from an existing database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-existing-index-"));
  const hub = createCortex({ dbPath: join(dir, "index.sqlite") });
  try {
    hub.captureCandidate({ projectPath: dir, agent: "codex", message: "Fixed startup indexing. Verification: npm test passed." });
    hub.storage.db.exec("DELETE FROM index_jobs; DELETE FROM search_chunks;");

    const result = ensureSearchIndex(hub.storage);

    assert.equal(result.queued, 1);
    assert.equal(result.indexed, 1);
    assert.equal(hub.storage.db.prepare("SELECT COUNT(*) AS count FROM search_chunks").get().count, 1);
    assert.deepEqual(ensureSearchIndex(hub.storage), { queued: 0, indexed: 0 });
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed index jobs retry with exponential backoff and stop after five attempts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-index-retry-"));
  const hub = createCortex({ dbPath: join(dir, "index.sqlite") });
  try {
    enqueueRecord(hub.storage, "bad-record", "unknown");
    const start = new Date("2026-06-18T00:00:00.000Z");

    assert.equal(drainIndexJobs(hub.storage, { now: start, baseDelayMs: 1000 }).length, 1);
    assert.equal(drainIndexJobs(hub.storage, { now: new Date(start.getTime() + 999), baseDelayMs: 1000 }).length, 0);
    for (const elapsed of [1000, 3000, 7000, 15000]) {
      drainIndexJobs(hub.storage, { now: new Date(start.getTime() + elapsed), baseDelayMs: 1000 });
    }

    const job = hub.storage.db.prepare("SELECT status, attempts, last_error AS error FROM index_jobs").get();
    assert.equal(job.status, "failed");
    assert.equal(job.attempts, 5);
    assert.match(job.error, /Unknown index record type/);
    assert.equal(drainIndexJobs(hub.storage, { now: new Date(start.getTime() + 60000), baseDelayMs: 1000 }).length, 0);
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a long record's chunks do not use up the similarity candidate cap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-index-similar-long-"));
  const hub = createCortex({ dbPath: join(dir, "index.sqlite") });
  try {
    const addFix = (id, summary) => {
      const record = hub.storage.insertFix({ id, projectPath: dir, agent: "a", summary, filesChanged: [] });
      linkCapturedRecord(hub.storage, record, "fix");
      enqueueRecord(hub.storage, id, "fix");
      drainIndexJobs(hub.storage);
    };
    addFix("fix-a", "websocket retry backoff failure");
    // unrelated, and more chunk rows than the 200-candidate cap
    hub.addResearchEntry({ projectPath: dir, agent: "a", question: "Quarterly invoice export review", finding: "The ledger totals matched the bank statement for every month reviewed. ".repeat(4500), sources: [] });
    drainIndexJobs(hub.storage);
    assert.ok(hub.storage.db.prepare("SELECT COUNT(*) AS n FROM search_chunks WHERE record_type = 'research'").get().n > 200);
    addFix("fix-b", "websocket retry backoff handling");

    const links = hub.storage.db.prepare("SELECT origin_record_id AS origin FROM links WHERE link_type = 'similar_to'").all();
    assert.deepEqual(links.map((link) => link.origin), ["fix-b"]);
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("indexing similar records creates one automatic similar_to edge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-index-similar-"));
  const hub = createCortex({ dbPath: join(dir, "index.sqlite") });
  try {
    for (const [id, summary] of [
      ["fix-a", "websocket retry backoff failure"],
      ["fix-b", "websocket retry backoff handling"],
    ]) {
      const record = hub.storage.insertFix({ id, projectPath: dir, agent: "a", summary, filesChanged: [] });
      linkCapturedRecord(hub.storage, record, "fix");
      enqueueRecord(hub.storage, id, "fix");
    }
    drainIndexJobs(hub.storage);
    rebuildSearchIndex(hub.storage);

    const links = hub.storage.db.prepare("SELECT link_type AS type, source FROM links WHERE link_type = 'similar_to'").all();
    assert.equal(links.length, 1, "rebuild must not duplicate semantic edges");
    assert.equal(links[0].source, "minhash");
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// Bounds linkSimilarRecords' per-job comparison to the most recently indexed N same-project
// records (default 200) instead of every same-project record ever — an unbounded O(n) scan
// per job (O(n^2) over a full reindex) that measured 84s to seed 550 records before this cap.
test("similar-record linking is capped to the most recently indexed candidates, not every same-project record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-index-cap-"));
  const hub = createCortex({ dbPath: join(dir, "index.sqlite") });
  try {
    const old = hub.storage.insertFix({ id: crypto.randomUUID(), projectPath: dir, agent: "a", summary: "websocket retry backoff failure", filesChanged: [] });
    linkCapturedRecord(hub.storage, old, "fix");
    enqueueRecord(hub.storage, old.id, "fix");
    drainIndexJobs(hub.storage);

    // push `old` well past the default 200-candidate cap; varied unrelated topics so filler
    // records don't spuriously minhash-match each other and bury the assertion in noise
    const topics = ["pagination", "billing invoice", "dark mode toggle", "csv export", "cache eviction", "avatar upload"];
    for (let i = 0; i < 205; i += 1) {
      const filler = hub.storage.insertFix({ id: crypto.randomUUID(), projectPath: dir, agent: "a", summary: `Reworked ${topics[i % topics.length]} layout ${i}`, filesChanged: [] });
      linkCapturedRecord(hub.storage, filler, "fix");
      enqueueRecord(hub.storage, filler.id, "fix");
    }
    drainIndexJobs(hub.storage);

    const recent = hub.storage.insertFix({ id: crypto.randomUUID(), projectPath: dir, agent: "a", summary: "websocket retry backoff handling", filesChanged: [] });
    linkCapturedRecord(hub.storage, recent, "fix");
    enqueueRecord(hub.storage, recent.id, "fix");
    drainIndexJobs(hub.storage);

    const oldEntity = hub.storage.db.prepare("SELECT entity_id AS id FROM record_entities WHERE record_id = ? AND role = 'subject'").get(old.id);
    const linksToOld = hub.storage.db.prepare(
      "SELECT 1 FROM links WHERE link_type = 'similar_to' AND (from_entity_id = ? OR to_entity_id = ?)",
    ).all(oldEntity.id, oldEntity.id);
    assert.equal(linksToOld.length, 0, "old similar record is outside the candidate cap -> no link to it");
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});
