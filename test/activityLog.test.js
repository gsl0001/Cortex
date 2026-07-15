import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CortexStorage } from "../src/storage.js";

async function withStorage(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cortex-actlog-"));
  const storage = new CortexStorage({ dbPath: join(dir, "a.sqlite") });
  try { await fn(storage, dir); } finally { storage.close(); await rm(dir, { recursive: true, force: true }); }
}

test("activityLog merges record types across projects, newest first", async () => {
  await withStorage(async (storage) => {
    const A = "C:/proj/a";
    const B = "C:/proj/b";
    storage.insertFix({ id: "f1", projectPath: A, agent: "claude", summary: "Fixed cache", filesChanged: ["x.js"] });
    storage.insertResearch({ id: "r1", projectPath: A, agent: "codex", question: "Why slow?", finding: "N+1 query", sources: [], evidence: [], reuseTags: [] });
    storage.insertDecision({ id: "d1", projectPath: B, agent: "claude", decision: "Use WAL", rationale: "concurrency" });
    storage.recordMetric("recall_injected", B, { agent: "claude", usedTokens: 100 });

    const all = storage.activityLog({ limit: 50 });
    assert.equal(all.length, 4, "all four records returned");
    const types = all.map((r) => r.type);
    assert.ok(types.includes("fix") && types.includes("research") && types.includes("decision") && types.includes("metric"));
    // newest first: timestamps are non-increasing
    for (let i = 1; i < all.length; i += 1) assert.ok(all[i - 1].ts >= all[i].ts, "sorted desc by ts");
  });
});

test("activityLog filters by project, type, and text", async () => {
  await withStorage(async (storage) => {
    const A = "C:/proj/a";
    const B = "C:/proj/b";
    storage.insertFix({ id: "f1", projectPath: A, agent: "claude", summary: "Fixed cache eviction", filesChanged: ["x.js"] });
    storage.insertFix({ id: "f2", projectPath: B, agent: "claude", summary: "Fixed login redirect", filesChanged: ["y.js"] });
    storage.insertDecision({ id: "d1", projectPath: A, agent: "claude", decision: "Adopt TS", rationale: "safety" });

    assert.equal(storage.activityLog({ projectPath: A }).length, 2, "project filter");
    assert.equal(storage.activityLog({ types: ["fix"] }).length, 2, "type filter");
    assert.equal(storage.activityLog({ types: ["decision"] }).length, 1, "single type");
    const q = storage.activityLog({ query: "login" });
    assert.equal(q.length, 1, "text filter");
    assert.equal(q[0].id, "f2");
  });
});
