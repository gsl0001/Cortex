import test from "node:test";
import assert from "node:assert/strict";

import {
  autoPlanWeek,
  criterionVerified,
  deadlineHealth,
  goalProgress,
  isProjectStalled,
  portfolioStalls,
  selectNextAction,
} from "../src/planning.js";

test("goalProgress counts only milestone tasks", () => {
  assert.deepEqual(goalProgress([
    { status: "done", milestoneId: "m1" },
    { status: "ready", milestoneId: "m1" },
    { status: "done", milestoneId: null },
    { status: "done", milestoneId: "" },
  ]), { done: 1, total: 2, percent: 50 });
  assert.deepEqual(goalProgress([]), { done: 0, total: 0, percent: 0 });
});

test("criterionVerified requires linked done tasks with evidence", () => {
  const tasks = {
    a: { status: "done", evidence: "test passed" },
    b: { status: "done", evidence: "  " },
  };
  assert.equal(criterionVerified({ task_ids: ["a"] }, tasks), true);
  assert.equal(criterionVerified({ task_ids: [] }, tasks), false);
  assert.equal(criterionVerified({ task_ids: ["a", "b"] }, tasks), false);
  assert.equal(criterionVerified({ task_ids: ["missing"] }, tasks), false);
});

test("deadlineHealth accounts for partial-week capacity", () => {
  assert.equal(deadlineHealth({
    dueDate: "2026-07-03",
    weeklyCapacity: 5,
    tasks: [{ status: "ready" }, { status: "ready" }, { status: "ready" }],
    today: "2026-07-02",
  }), "at_risk");
  assert.equal(deadlineHealth({
    dueDate: "2026-07-03",
    weeklyCapacity: 5,
    tasks: [{ status: "ready" }],
    today: "2026-07-04",
  }), "overdue");
  assert.equal(deadlineHealth({
    dueDate: "2026-07-03",
    weeklyCapacity: 5,
    tasks: [{ status: "done" }],
    today: "2026-07-04",
  }), "on_track");
  assert.equal(deadlineHealth({
    dueDate: "2026-07-10",
    weeklyCapacity: 5,
    tasks: [{ status: "ready", scheduledFor: "2026-07-01" }],
    today: "2026-07-02",
  }), "at_risk");
  assert.equal(deadlineHealth({
    dueDate: "2026-07-03",
    weeklyCapacity: 5,
    tasks: [{ status: "ready" }, { status: "ready" }],
    today: "2026-07-02",
  }), "on_track");
});

test("isProjectStalled recognizes stale and recent project activity", () => {
  const today = "2026-07-10";
  assert.equal(isProjectStalled({
    today,
    tasks: [{ status: "in_progress", updatedAt: "2026-07-07T00:00:00Z" }],
  }), true);
  assert.equal(isProjectStalled({
    today,
    tasks: [{ status: "blocked" }, { status: "blocked" }],
  }), true);
  assert.equal(isProjectStalled({
    today,
    tasks: [{ status: "ready", createdAt: "2026-07-03T00:00:00Z" }],
  }), true);
  assert.equal(isProjectStalled({
    today,
    tasks: [{ status: "ready", createdAt: "2026-07-09T00:00:00Z" }],
  }), false);
  assert.equal(isProjectStalled({
    today,
    tasks: [{ status: "done", evidence: "ok", updatedAt: "2026-07-09T00:00:00Z" }],
  }), false);
  assert.equal(isProjectStalled({
    today,
    tasks: [{ status: "done", evidence: "ok", updatedAt: "2026-06-01T00:00:00Z" }],
  }), false);
});

test("isProjectStalled uses the last completion despite recent ready-task edits", () => {
  assert.equal(isProjectStalled({
    today: "2026-07-10",
    tasks: [
      { status: "done", completedAt: "2026-07-02T00:00:00Z", updatedAt: "2026-07-10T00:00:00Z" },
      { status: "ready", createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-10T00:00:00Z" },
    ],
  }), true);
});

test("isProjectStalled uses project inception when nothing has completed", () => {
  assert.equal(isProjectStalled({
    today: "2026-07-10",
    tasks: [
      { status: "ready", createdAt: "2026-07-02T00:00:00Z", updatedAt: "2026-07-10T00:00:00Z" },
      { status: "ready", createdAt: "2026-07-09T00:00:00Z", updatedAt: "2026-07-10T00:00:00Z" },
    ],
  }), true);
});

test("isProjectStalled gives a new project seven days to complete work", () => {
  assert.equal(isProjectStalled({
    today: "2026-07-10",
    tasks: [
      { status: "ready", createdAt: "2026-07-04T00:00:00Z" },
      { status: "ready", createdAt: "2026-07-09T00:00:00Z" },
    ],
  }), false);
});

test("selectNextAction ignores blocked tasks and applies deterministic ordering", () => {
  const today = "2026-07-10";
  const milestones = { soon: "2026-07-11", later: "2026-07-20" };
  const tasks = [
    { id: "blocked", status: "blocked", priority: "urgent", scheduledFor: "2026-07-01" },
    { id: "ready", status: "ready", priority: "normal", milestoneId: "soon" },
  ];
  assert.equal(selectNextAction(tasks, milestones, today).id, "ready");

  const ordered = [
    { id: "roadmap-later", status: "ready", priority: "high", milestoneId: "soon", activeRank: 1, roadmapOrder: 2 },
    { id: "low-priority", status: "ready", priority: "normal", milestoneId: "soon", activeRank: 0, roadmapOrder: 1 },
    { id: "later-due", status: "ready", priority: "urgent", milestoneId: "later", activeRank: 0, roadmapOrder: 1 },
    { id: "winner", status: "in_progress", priority: "high", milestoneId: "soon", activeRank: 1, roadmapOrder: 1 },
    { id: "overdue", status: "ready", priority: "low", milestoneId: "later", scheduledFor: "2026-07-09", activeRank: 9, roadmapOrder: 9 },
  ];
  assert.equal(selectNextAction(ordered, milestones, today).id, "overdue");
  assert.equal(selectNextAction(ordered.slice(0, -1), milestones, today).id, "winner");
  assert.equal(selectNextAction([{ id: "done", status: "done" }], milestones, today), null);
  assert.throws(() => selectNextAction(tasks, milestones), /today is required/);
});

test("autoPlanWeek respects total and project caps without mutating tasks", () => {
  const tasks = [
    ...Array.from({ length: 4 }, (_, i) => ({ id: `a${i}`, projectPath: "a", status: "ready", priority: "high", roadmapOrder: i })),
    ...Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, projectPath: "b", status: "ready", priority: "normal", roadmapOrder: i })),
    { id: "blocked", projectPath: "a", status: "blocked", priority: "urgent" },
    { id: "uncapped", projectPath: "c", status: "ready", priority: "urgent" },
  ];
  const original = structuredClone(tasks);
  const planned = autoPlanWeek(tasks, {
    weekStart: "2026-07-06",
    totalCapacity: 6,
    projectCapacities: { a: 3, b: 5 },
  });

  assert.equal(planned.length, 6);
  assert.equal(planned.filter(({ projectPath }) => projectPath === "a").length, 3);
  assert.equal(planned.filter(({ projectPath }) => projectPath === "b").length, 3);
  assert.deepEqual(new Set(planned.map(({ scheduledFor }) => scheduledFor)), new Set([
    "2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10",
  ]));
  assert.equal(planned.some(({ id }) => id === "blocked" || id === "uncapped"), false);
  assert.deepEqual(tasks, original);
  assert.notEqual(planned[0], tasks.find(({ id }) => id === planned[0].id));
});

test("autoPlanWeek prefers earlier milestone deadlines before rank for equal priorities", () => {
  const planned = autoPlanWeek([
    { id: "rank-one", projectPath: "a", status: "ready", priority: "high", activeRank: 1, milestoneDueDate: "2026-07-31", roadmapOrder: 1 },
    { id: "due-first", projectPath: "b", status: "ready", priority: "high", activeRank: 2, milestoneDueDate: "2026-07-03", roadmapOrder: 2 },
  ], { weekStart: "2026-06-29", totalCapacity: 1, projectCapacities: { a: 1, b: 1 } });

  assert.equal(planned[0].id, "due-first");
});

test("portfolioStalls finds projects being worked on with nothing to pick up next", () => {
  const today = "2026-07-25";
  const stalls = portfolioStalls([
    // Shipped code two days ago and carries no task at all -- the live shape of Frontboard,
    // the video factory and dev-dist, and invisible to isProjectStalled (which needs tasks).
    { projectPath: "C:/work/noteapp", tier: "assist", lastRecordAt: "2026-07-23", tasks: [] },
    // Active, but every open task is blocked: nothing can be picked up either.
    { projectPath: "C:/work/sitelogs", tier: "assist", lastRecordAt: "2026-07-24",
      tasks: [{ status: "blocked" }, { status: "done" }] },
    // Active and has ready work -- not stalled.
    { projectPath: "C:/work/sleep", tier: "auto", lastRecordAt: "2026-07-25",
      tasks: [{ status: "ready" }] },
    // Dormant: no records in the window, so silence is expected, not a signal.
    { projectPath: "C:/work/marketplace", tier: "watch", lastRecordAt: "2026-07-09", tasks: [] },
    // Never produced anything at all.
    { projectPath: "C:/work/ghost", tier: "watch", lastRecordAt: null, tasks: [] },
  ], { today });

  assert.deepEqual(stalls.map((s) => [s.projectPath, s.reason]), [
    ["C:/work/sitelogs", "all-blocked"],
    ["C:/work/noteapp", "no-open-tasks"],
  ]);
  assert.equal(stalls[0].tier, "assist");
  assert.throws(() => portfolioStalls([], {}), /today is required/);
});
