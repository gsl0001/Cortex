import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCortex } from "../src/index.js";

async function withHub(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cortex-tasktype-"));
  const hub = createCortex({ dbPath: join(dir, "t.sqlite") });
  try { await fn(hub, dir); } finally { hub.close(); await rm(dir, { recursive: true, force: true }); }
}

test("addTask requires a valid type", () =>
  withHub(async (hub, dir) => {
    assert.throws(() => hub.addTask({ projectPath: dir, title: "no type" }), /type must be one of/);
    assert.throws(() => hub.addTask({ projectPath: dir, title: "bad type", type: "bogus" }), /type must be one of/);
  }));

test("a valid type round-trips through get and list", () =>
  withHub(async (hub, dir) => {
    const task = hub.addTask({ projectPath: dir, title: "Typed", type: "feature" });
    assert.equal(task.type, "feature");
    assert.equal(hub.storage.getTask(task.id).type, "feature");
    assert.equal(hub.listTasks({ projectPath: dir })[0].type, "feature");
  }));

test("editTask changes type but rejects an unknown value", () =>
  withHub(async (hub, dir) => {
    const task = hub.addTask({ projectPath: dir, title: "Retype me", type: "chore" });
    assert.equal(hub.editTask({ id: task.id, type: "bug" }).type, "bug");
    assert.throws(() => hub.editTask({ id: task.id, type: "nope" }), /type must be one of/);
    assert.equal(hub.storage.getTask(task.id).type, "bug"); // rejected edit left it unchanged
  }));

test("roadmap proposal create tasks require a type", () =>
  withHub(async (hub, dir) => {
    const base = {
      version: 1,
      goal: {
        title: "Ship", outcome: "Verified", targetDate: "2026-07-31", weeklyCapacity: 3, activeRank: 1,
        criteria: [{ key: "c1", text: "done", taskKeys: ["t1"] }],
      },
      milestones: [{ key: "m1", title: "Baseline", order: 1, dueDate: "2026-07-05" }],
    };
    const missing = { ...base, tasks: [{ key: "t1", action: "create", milestoneKey: "m1", number: "1.1", order: 1, title: "x" }] };
    assert.throws(() => hub.createRoadmapProposal({ agent: "codex", projectPath: dir, payload: missing }), /task\.type must be one of/);

    const ok = { ...base, tasks: [{ key: "t1", action: "create", milestoneKey: "m1", number: "1.1", order: 1, title: "x", type: "feature" }] };
    const proposal = hub.createRoadmapProposal({ agent: "codex", projectPath: dir, payload: ok });
    const goal = hub.approveRoadmapProposal({ id: proposal.id, agent: "human" });
    const created = hub.listTasks({ projectPath: dir }).find((t) => t.milestoneId);
    assert.equal(created.type, "feature");
    assert.ok(goal);
  }));
