import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCortex } from "../src/index.js";

async function withHub(name, fn) {
  const dir = await mkdtemp(join(tmpdir(), `cortex-${name}-`));
  const hub = createCortex({ dbPath: join(dir, "t.sqlite") });
  try { await fn(hub, dir); } finally { hub.close(); await rm(dir, { recursive: true, force: true }); }
}

test("settings: get returns fallback, set round-trips JSON values", () =>
  withHub("settings", async (hub) => {
    assert.equal(hub.storage.getSetting("dispatcher.enabled", false), false);
    hub.storage.setSetting("dispatcher.enabled", true);
    assert.equal(hub.storage.getSetting("dispatcher.enabled", false), true);
    hub.storage.setSetting("dispatcher.projects", ["C:/spy/sitelogs"]);
    assert.deepEqual(hub.storage.getSetting("dispatcher.projects", []), ["C:/spy/sitelogs"]);
    hub.storage.setSetting("dispatcher.projects", []); // overwrite, not duplicate
    assert.deepEqual(hub.storage.getSetting("dispatcher.projects", null), []);
  }));

test("tasks: recheckAt persists through updateTask and survives unrelated patches", () =>
  withHub("recheck", async (hub, dir) => {
    const task = hub.addTask({ type: "chore", projectPath: dir, assignedAgent: "codex", title: "Watch App Review" });
    const blocked = hub.storage.updateTask(task.id, { status: "blocked", blockReason: "waiting", recheckAt: "2026-07-10" });
    assert.equal(blocked.recheckAt, "2026-07-10");
    const touched = hub.storage.updateTask(task.id, { priority: "high" });
    assert.equal(touched.recheckAt, "2026-07-10"); // unrelated patch must not wipe it
    assert.equal(hub.listTasks({ projectPath: dir })[0].recheckAt, "2026-07-10");
  }));

test("sessions: finishSession stores outcome; updateSessionGoal replaces goal", () =>
  withHub("sessions", async (hub, dir) => {
    hub.storage.insertSession({ id: "s1", projectPath: dir, agent: "claude-code", source: "claude-session-hook", goal: "active session", status: "active" });
    hub.storage.updateSessionGoal("s1", "Fix the paywall gate");
    assert.equal(hub.storage.getSession("s1").goal, "Fix the paywall gate");
    hub.storage.finishSession("s1", { outcome: "Paywall gate shipped, tests green." });
    const done = hub.storage.getSession("s1");
    assert.equal(done.status, "finished");
    assert.equal(done.outcome, "Paywall gate shipped, tests green.");
  }));

test("sessions: Cortex.finishSession wrapper forwards the outcome to storage", () =>
  withHub("session-wrapper", async (hub, dir) => {
    const started = hub.startSession({ projectPath: dir, agent: "codex", goal: "wrapper outcome" });
    hub.finishSession({ id: started.id, outcome: "Shipped. Verification: npm test passed." });
    const done = hub.storage.getSession(started.id);
    assert.equal(done.status, "finished");
    assert.equal(done.outcome, "Shipped. Verification: npm test passed.");
  }));

test("sessions: finishSession without outcome keeps existing outcome null and still finishes", () =>
  withHub("session-noout", async (hub, dir) => {
    hub.storage.insertSession({ id: "s2", projectPath: dir, agent: "claude-code", source: "claude-session-hook", goal: "g", status: "active" });
    hub.storage.finishSession("s2");
    assert.equal(hub.storage.getSession("s2").status, "finished");
    assert.equal(hub.storage.getSession("s2").outcome ?? null, null);
  }));

test("blockTask accepts optional recheckAt and validates it", () =>
  withHub("block-recheck", async (hub, dir) => {
    const a = hub.addTask({ type: "chore", projectPath: dir, title: "A" });
    const blocked = hub.blockTask({ id: a.id, reason: "App Review pending", recheckAt: "2026-07-09" });
    assert.equal(blocked.recheckAt, "2026-07-09");
    const b = hub.addTask({ type: "chore", projectPath: dir, title: "B" });
    assert.throws(() => hub.blockTask({ id: b.id, reason: "x", recheckAt: "soon" }), /recheckAt/);
    const c = hub.blockTask({ id: b.id, reason: "no date" }); // recheckAt stays optional
    assert.equal(c.recheckAt ?? null, null);
  }));

test("blockTask without recheckAt preserves an existing recheck date", () =>
  withHub("block-preserve", async (hub, dir) => {
    const t = hub.addTask({ type: "chore", projectPath: dir, title: "T" });
    hub.blockTask({ id: t.id, reason: "first", recheckAt: "2026-07-09" });
    const again = hub.blockTask({ id: t.id, reason: "second" });
    assert.equal(again.recheckAt, "2026-07-09");
  }));

test("editTask can set and clear recheckAt", () =>
  withHub("edit-recheck", async (hub, dir) => {
    const t = hub.addTask({ type: "chore", projectPath: dir, title: "T" });
    assert.equal(hub.editTask({ id: t.id, recheckAt: "2026-08-01" }).recheckAt, "2026-08-01");
    assert.equal(hub.editTask({ id: t.id, recheckAt: null }).recheckAt ?? null, null);
  }));

test("dependsOn is validated, cycle-checked, and drives dependency state", () =>
  withHub("deps", async (hub, dir) => {
    const a = hub.addTask({ type: "feature", projectPath: dir, title: "producer" });
    const b = hub.addTask({ type: "feature", projectPath: dir, title: "consumer", dependsOn: [a.id] });
    assert.deepEqual(hub.storage.getTask(b.id).dependsOn, [a.id]);
    assert.equal(hub.dependencyState(hub.storage.getTask(b.id)).satisfied, false); // producer still ready
    hub.editTask({ id: a.id, status: "review" });
    assert.equal(hub.dependencyState(hub.storage.getTask(b.id)).satisfied, true); // review counts
    assert.throws(() => hub.editTask({ id: a.id, dependsOn: [b.id] }), /cycle/i);
  }));

test("dependsOn producers must exist, and deleting a producer unblocks its dependents", () =>
  withHub("deps-integrity", async (hub, dir) => {
    // a typo'd producer id used to read as "stuck" forever — the consumer silently never dispatched
    assert.throws(() => hub.addTask({ type: "feature", projectPath: dir, title: "x", dependsOn: ["no-such-task"] }), /missing task/i);
    const a = hub.addTask({ type: "feature", projectPath: dir, title: "producer" });
    const b = hub.addTask({ type: "feature", projectPath: dir, title: "consumer", dependsOn: [a.id] });
    assert.throws(() => hub.editTask({ id: b.id, dependsOn: ["no-such-task"] }), /missing task/i);
    hub.deleteTask({ id: a.id });
    assert.deepEqual(hub.storage.getTask(b.id).dependsOn, []); // dangling edge stripped
    assert.equal(hub.dependencyState(hub.storage.getTask(b.id)).satisfied, true);
  }));

test("listInbox passes limit through", () =>
  withHub("inbox-limit", async (hub, dir) => {
    for (let i = 0; i < 7; i += 1) hub.addInboxItem({ projectPath: dir, author: "codex", message: `m${i}` });
    assert.equal(hub.listInbox({ projectPath: dir }).length, 5); // storage default preserved
    assert.equal(hub.listInbox({ projectPath: dir, limit: 50 }).length, 7);
  }));
