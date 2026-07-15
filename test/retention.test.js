import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, utimes, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { CortexStorage } from "../src/storage.js";

async function withStorage(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cortex-retention-"));
  const storage = new CortexStorage({ dbPath: join(dir, "r.sqlite") });
  try { await fn(storage, dir); } finally { storage.close(); await rm(dir, { recursive: true, force: true }); }
}

test("sweeps only past-deadline session events", async () => {
  await withStorage(async (storage, dir) => {
    const past = new Date(Date.now() - 86400000).toISOString();
    const future = new Date(Date.now() + 86400000).toISOString();
    storage.insertSessionEvent({ id: randomUUID(), projectPath: dir, agent: "a", source: "s", summary: "old", expiresAt: past });
    storage.insertSessionEvent({ id: randomUUID(), projectPath: dir, agent: "a", source: "s", summary: "live", expiresAt: future });
    const deleted = storage.sweepExpiredSessionEvents(new Date());
    assert.equal(deleted, 1);
    assert.equal(storage.listSessionEvents(dir).length, 1);
  });
});

test("excludes superseded fixes and ages out unverified records", async () => {
  await withStorage(async (storage, dir) => {
    const old = storage.insertFix({ id: randomUUID(), projectPath: dir, agent: "a", summary: "old fix", filesChanged: ["x.js"] });
    const fresh = storage.insertFix({ id: randomUUID(), projectPath: dir, agent: "a", summary: "new fix", filesChanged: ["x.js"], supersedesId: old.id });

    const visible = storage.listFixes(dir, { excludeSuperseded: true });
    assert.equal(visible.some((f) => f.id === old.id), false);
    assert.equal(visible.some((f) => f.id === fresh.id), true);

    // Backdate an unverified fix beyond the age window; it should drop when maxAgeDays is set.
    const ancient = storage.insertFix({ id: randomUUID(), projectPath: dir, agent: "a", summary: "ancient", filesChanged: ["y.js"] });
    storage.db.prepare("UPDATE fix_entries SET created_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 200 * 86400000).toISOString(), ancient.id);
    const recent = storage.listFixes(dir, { maxAgeDays: 120 });
    assert.equal(recent.some((f) => f.id === ancient.id), false);

    assert.equal(storage.countRecords(dir).fix, 3);
    assert.equal(storage.countSupersededFixes(dir), 1);
  });
});

test("finds the most recent overlapping fix and upgrades verification", async () => {
  await withStorage(async (storage, dir) => {
    const first = storage.insertFix({ id: randomUUID(), projectPath: dir, agent: "a", summary: "first", filesChanged: ["a.js"] });
    storage.insertFix({ id: randomUUID(), projectPath: dir, agent: "a", summary: "unrelated", filesChanged: ["b.js"] });

    const target = storage.findSupersedableFix({ projectPath: dir, filesChanged: ["a.js"] });
    assert.equal(target.id, first.id);
    assert.equal(storage.findSupersedableFix({ projectPath: dir, filesChanged: ["zzz.js"] }), null);

    storage.setRecordVerification("fix", first.id, "npm test passed");
    const upgraded = storage.getFix(first.id);
    assert.equal(upgraded.verification, "npm test passed");
    assert.equal(upgraded.qualityStatus, "verified");
  });
});

import { createCortex } from "../src/index.js";

test("a verified same-file fix supersedes the prior and links them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-supersede-"));
  const hub = createCortex({ dbPath: join(dir, "s.sqlite") });
  try {
    const first = hub.captureCandidate({ projectPath: dir, agent: "a", message: "Fixed close fill. Files changed: reconcile.js. Commit: abc1111." });
    const second = hub.captureCandidate({ projectPath: dir, agent: "a", message: "Refactored close fill path entirely. Files changed: reconcile.js. Verification: npm test passed." });
    const newer = hub.storage.getFix(second.recordId);
    assert.equal(newer.supersedesId, first.recordId);
    assert.equal(hub.storage.listFixes(dir, { excludeSuperseded: true }).some((f) => f.id === first.recordId), false);

    const link = hub.storage.db.prepare("SELECT COUNT(*) AS c FROM links WHERE link_type = 'supersedes'").get();
    assert.equal(link.c >= 1, true);
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("sweep reaps agent-run logs older than the retention window and keeps fresh ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-logreaper-"));
  const hub = createCortex({ dbPath: join(dir, "l.sqlite") });
  const logRoot = join(dir, "agent-runs");
  try {
    await mkdir(logRoot, { recursive: true });
    const oldLog = join(logRoot, "old.jsonl");
    const freshLog = join(logRoot, "fresh.jsonl");
    await writeFile(oldLog, "{}\n");
    await writeFile(freshLog, "{}\n");
    // backdate the old log's mtime well past the 14-day default
    const ancient = new Date(Date.now() - 30 * 86_400_000);
    await utimes(oldLog, ancient, ancient);

    const result = hub.sweep(new Date(), { logRoot });
    assert.equal(result.agentLogsDeleted, 1);
    const remaining = await readdir(logRoot);
    assert.deepEqual(remaining, ["fresh.jsonl"]);
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});
