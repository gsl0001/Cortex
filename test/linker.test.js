import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCortex } from "../src/index.js";
import { ensureRecordLinks } from "../src/linker.js";

test("links accepted fixes to deterministic project evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-linker-"));
  const hub = createCortex({ dbPath: join(dir, "linker.sqlite") });
  try {
    const accepted = hub.captureCandidate({
      projectPath: dir,
      agent: "claude-code",
      message: "Fixed close path. Files changed: src/reconcile.js. Commit: 77eae8e. Verification: npm test passed.",
    });
    const entities = hub.storage.db.prepare(`
      SELECT entity_type AS entityType, canonical_key AS canonicalKey FROM entities ORDER BY entity_type
    `).all();
    const linkTypes = hub.storage.db.prepare("SELECT link_type AS linkType FROM links ORDER BY link_type").all()
      .map(({ linkType }) => linkType);
    const attachments = hub.storage.db.prepare("SELECT record_id AS recordId FROM record_entities").all();

    assert.equal(attachments.every(({ recordId }) => recordId === accepted.recordId), true);
    assert.equal(entities.some(({ entityType }) => entityType === "project"), true);
    assert.equal(entities.some(({ entityType, canonicalKey }) => entityType === "file" && canonicalKey.endsWith(join("src", "reconcile.js"))), true);
    assert.equal(entities.some(({ entityType, canonicalKey }) => entityType === "commit" && canonicalKey === "77eae8e"), true);
    assert.equal(entities.some(({ entityType }) => entityType === "agent"), true);
    assert.deepEqual(new Set(linkTypes), new Set(["belongs_to_project", "changes_file", "fixed_by_commit", "related_to"]));
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("backfills deterministic links for durable records created before graph support", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-linker-backfill-"));
  const hub = createCortex({ dbPath: join(dir, "linker.sqlite") });
  try {
    hub.captureCandidate({ projectPath: dir, agent: "codex", message: "Fixed graph backfill. Verification: npm test passed." });
    hub.storage.db.exec("DELETE FROM links; DELETE FROM record_entities; DELETE FROM entities;");

    assert.equal(ensureRecordLinks(hub.storage).linked, 1);
    assert.equal(hub.storage.db.prepare("SELECT COUNT(*) AS count FROM links").get().count > 0, true);
    assert.equal(ensureRecordLinks(hub.storage).linked, 0);
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("does not extract entities from ambiguous unlabeled prose", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-linker-ambiguous-"));
  const hub = createCortex({ dbPath: join(dir, "linker.sqlite") });
  try {
    hub.captureCandidate({
      projectPath: dir,
      agent: "codex",
      message: "Implemented ranking that might relate to abcdef1 someday.",
    });
    const commitCount = hub.storage.db.prepare("SELECT COUNT(*) AS count FROM entities WHERE entity_type = 'commit'").get().count;
    assert.equal(commitCount, 0);
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});
