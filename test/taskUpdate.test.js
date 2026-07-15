import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCortex } from "../src/index.js";
import { updateTaskByReference } from "../src/taskUpdater.js";

test("prefers an exact task ID and reports the state transition", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-task-update-"));
  const hub = createCortex({ dbPath: join(dir, "tasks.sqlite") });
  try {
    const first = hub.addTask({ type: "chore", projectPath: dir, title: "Fix close path" });
    hub.addTask({ type: "chore", projectPath: dir, title: "Fix close path documentation" });
    const result = updateTaskByReference(hub, {
      projectPath: dir, id: first.id, title: "Fix close", status: "in_progress", agent: "codex",
    });

    assert.equal(result.id, first.id);
    assert.equal(result.previousStatus, "ready");
    assert.equal(result.newStatus, "in_progress");
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects ambiguous title matches without mutation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-task-ambiguous-"));
  const hub = createCortex({ dbPath: join(dir, "tasks.sqlite") });
  try {
    hub.addTask({ type: "chore", projectPath: dir, title: "Fix close path" });
    hub.addTask({ type: "chore", projectPath: dir, title: "Fix close path documentation" });

    assert.throws(
      () => updateTaskByReference(hub, { projectPath: dir, title: "Fix close", status: "done", evidence: "done" }),
      /matched 2 tasks/,
    );
    assert.deepEqual(hub.listTasks({ projectPath: dir }).map(({ status }) => status), ["ready", "ready"]);
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});
