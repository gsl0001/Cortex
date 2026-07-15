import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCortex } from "../src/index.js";

async function withHub(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cortex-next-"));
  const hub = createCortex({ dbPath: join(dir, "n.sqlite") });
  try { await fn(hub, dir); } finally { hub.close(); await rm(dir, { recursive: true, force: true }); }
}

test("nextTask returns the highest-priority ready task", async () => {
  await withHub(async (hub, dir) => {
    hub.addTask({ type: "chore", projectPath: dir, title: "low", status: "ready", priority: "normal" });
    const high = hub.addTask({ type: "chore", projectPath: dir, title: "high", status: "ready", priority: "high" });
    assert.equal(hub.nextTask({ projectPath: dir }).id, high.id);
  });
});

test("nextTask --claim atomically claims it (in_progress, leased)", async () => {
  await withHub(async (hub, dir) => {
    hub.addTask({ type: "chore", projectPath: dir, title: "t", status: "ready", priority: "high" });
    const claimed = hub.nextTask({ projectPath: dir, claim: true, agent: "claude-code" });
    assert.equal(claimed.status, "in_progress");
    assert.equal(claimed.leaseAgent, "claude-code");
    assert.equal(hub.nextTask({ projectPath: dir }), null); // nothing ready left
  });
});

test("nextTask skips a task actively leased by another agent", async () => {
  await withHub(async (hub, dir) => {
    const a = hub.addTask({ type: "chore", projectPath: dir, title: "leased", status: "ready", priority: "high" });
    hub.addTask({ type: "chore", projectPath: dir, title: "free", status: "ready", priority: "normal" });
    hub.claimTask({ id: a.id, agent: "codex" }); // codex grabs the high one
    const next = hub.nextTask({ projectPath: dir, agent: "claude-code" });
    assert.equal(next.title, "free"); // claude-code gets the next free one
  });
});
