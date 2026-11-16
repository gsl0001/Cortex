import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CortexStorage } from "../src/storage.js";

test("stores validated typed links with provenance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-links-"));
  const storage = new CortexStorage({ dbPath: join(dir, "links.sqlite") });
  try {
    const project = storage.upsertEntity({
      entityType: "project", canonicalKey: "C:\\repo", label: "Repo", projectPath: "C:\\repo",
    });
    const file = storage.upsertEntity({
      entityType: "file", canonicalKey: "C:\\repo\\src\\index.js", label: "src/index.js", projectPath: "C:\\repo",
    });
    const sameFile = storage.upsertEntity({
      entityType: "file", canonicalKey: "C:\\repo\\src\\index.js", label: "Index", projectPath: "C:\\repo",
    });
    const link = storage.linkRecords({
      fromEntityId: file.id,
      toEntityId: project.id,
      linkType: "belongs_to_project",
      source: "deterministic",
      confidence: 1,
      originRecordId: "fix-1",
    });

    assert.equal(sameFile.id, file.id);
    assert.equal(storage.listLinks(file.id)[0].id, link.id);
    assert.throws(() => storage.linkRecords({ ...link, id: undefined, linkType: "typo_link" }), /Unknown link type/);
    assert.throws(() => storage.linkRecords({ ...link, id: undefined, confidence: 2 }), /between 0 and 1/);
    assert.equal(storage.unlink(link.id), true);
    assert.equal(storage.listLinks(file.id).length, 0);
    assert.equal(storage.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 24);
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});
