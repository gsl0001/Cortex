import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCortex, normalizeProjectPath } from "../src/index.js";

async function withHub(run) {
  const dir = await mkdtemp(join(tmpdir(), "cortex-roadmap-"));
  const hub = createCortex({ dbPath: join(dir, "roadmap.sqlite") });
  try { await run({ hub, dir }); }
  finally { hub.close(); await rm(dir, { recursive: true, force: true }); }
}

function payload(overrides = {}) {
  return {
    version: 1,
    goal: {
      title: "Ship result",
      outcome: "Verified result",
      targetDate: "2026-07-31",
      weeklyCapacity: 3,
      activeRank: 1,
      criteria: [{ key: "c1", text: "Verification passes", taskKeys: ["t1"] }],
      ...overrides.goal,
    },
    milestones: overrides.milestones || [
      { key: "m1", title: "Baseline", order: 1, dueDate: "2026-07-05" },
    ],
    tasks: overrides.tasks || [{
      key: "t1",
      action: "create", type: "feature",
      milestoneKey: "m1",
      number: "1.1",
      order: 1,
      title: "Run verification",
      priority: "high",
      acceptanceCriteria: "Evidence saved",
      verificationCommand: "npm test",
      scheduledFor: "2026-06-29",
    }],
  };
}

test("createRoadmapProposal stores only a normalized pending proposal", async () => withHub(({ hub, dir }) => {
  const proposal = hub.createRoadmapProposal({ projectPath: dir, agent: "codex", payload: payload() });

  assert.equal(proposal.status, "pending");
  assert.equal(proposal.projectPath, normalizeProjectPath(dir));
  assert.deepEqual(proposal.payload, payload());
  for (const table of ["project_goals", "roadmap_milestones", "workflow_tasks"]) {
    assert.equal(hub.storage.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  }
}));

test("approval creates ordered roadmap rows, resolves criteria, and is idempotent", async () => withHub(({ hub, dir }) => {
  const existing = hub.addTask({ type: "chore", projectPath: dir, title: "Existing task" });
  const proposed = payload({
    goal: { criteria: [{ key: "c1", text: "Both verified", taskKeys: ["new", "linked"] }] },
    milestones: [
      { key: "later", title: "Later", order: 2, dueDate: "2026-07-20" },
      { key: "first", title: "First", order: 1, dueDate: "2026-07-05" },
    ],
    tasks: [
      { key: "linked", action: "link", taskId: existing.id, milestoneKey: "later", number: "2.1", order: 2, scheduledFor: "2026-07-06" },
      { key: "new", action: "create", type: "feature", milestoneKey: "first", number: "1.1", order: 1, title: "New task" },
    ],
  });
  const proposal = hub.createRoadmapProposal({ projectPath: dir, agent: "codex", payload: proposed });
  const first = hub.approveRoadmapProposal({ id: proposal.id, agent: "human" });
  const second = hub.approveRoadmapProposal({ id: proposal.id, agent: "human" });

  assert.equal(first.goal.status, "active");
  assert.deepEqual(first.milestones.map(({ title }) => title), ["First", "Later"]);
  assert.deepEqual(first.tasks.map(({ title }) => title), ["New task", "Existing task"]);
  assert.equal(first.tasks[1].id, existing.id);
  assert.deepEqual(first.goal.successCriteria, [{ id: "c1", text: "Both verified", task_ids: [first.tasks[0].id, existing.id] }]);
  assert.equal(hub.storage.getRoadmapProposal(proposal.id).appliedGoalId, first.goal.id);
  assert.equal(second.goal.id, first.goal.id);
  assert.equal(hub.storage.db.prepare("SELECT COUNT(*) AS n FROM project_goals").get().n, 1);
  assert.equal(hub.storage.db.prepare("SELECT COUNT(*) AS n FROM roadmap_milestones").get().n, 2);
  assert.equal(hub.storage.db.prepare("SELECT COUNT(*) AS n FROM workflow_tasks").get().n, 2);
}));

test("database failure during task insert rolls back roadmap and proposal resolution", async () => withHub(({ hub, dir }) => {
  const proposal = hub.createRoadmapProposal({ projectPath: dir, agent: "codex", payload: payload() });
  hub.storage.db.exec("CREATE TRIGGER force_task_failure BEFORE INSERT ON workflow_tasks BEGIN SELECT RAISE(ABORT, 'forced'); END");

  assert.throws(() => hub.approveRoadmapProposal({ id: proposal.id, agent: "human" }), /forced/);
  assert.equal(hub.storage.db.prepare("SELECT COUNT(*) AS n FROM project_goals").get().n, 0);
  assert.equal(hub.storage.db.prepare("SELECT COUNT(*) AS n FROM roadmap_milestones").get().n, 0);
  assert.equal(hub.storage.db.prepare("SELECT COUNT(*) AS n FROM workflow_tasks").get().n, 0);
  assert.equal(hub.storage.getRoadmapProposal(proposal.id).status, "pending");
}));

test("proposal validation rejects malformed and unsafe payloads without writes", async () => withHub(({ hub, dir }) => {
  const local = hub.addTask({ type: "chore", projectPath: dir, title: "Local" });
  const foreign = hub.addTask({ type: "chore", projectPath: `${dir}-other`, title: "Foreign" });
  const invalid = [
    [{ ...payload(), extra: true }, /unknown.*extra/i],
    [payload({ goal: { extra: true } }), /unknown.*extra/i],
    [payload({ goal: { criteria: [{ key: "c1", text: "x", taskKeys: ["t1"], extra: true }] } }), /unknown.*extra/i],
    [payload({ milestones: [{ key: "m1", title: "x", order: 1, dueDate: "2026-07-01", extra: true }] }), /unknown.*extra/i],
    [payload({ tasks: [{ key: "t1", action: "create", type: "feature", milestoneKey: "m1", number: "1.1", order: 1, title: "x", extra: true }] }), /unknown.*extra/i],
    [payload({ milestones: [{ key: "m1", title: "a", order: 1, dueDate: "2026-07-01" }, { key: "m1", title: "b", order: 2, dueDate: "2026-07-02" }] }), /duplicate milestone key/i],
    [payload({ tasks: [{ key: "x", action: "create", type: "feature", milestoneKey: "m1", number: "1.1", order: 1, title: "x" }, { key: "x", action: "create", type: "feature", milestoneKey: "m1", number: "1.2", order: 2, title: "y" }] }), /duplicate task key/i],
    [payload({ tasks: [{ key: "x", action: "create", type: "feature", milestoneKey: "m1", number: "1.1", order: 1, title: "x" }, { key: "y", action: "create", type: "feature", milestoneKey: "m1", number: "1.1", order: 2, title: "y" }] }), /duplicate task number/i],
    [payload({ goal: { targetDate: "2026-02-30" } }), /targetDate/i],
    [payload({ milestones: [{ key: "m1", title: "x", order: 1, dueDate: "07\/01\/2026" }] }), /dueDate/i],
    [payload({ tasks: [{ key: "t1", action: "create", type: "feature", milestoneKey: "m1", number: "1.1", order: 1, title: "x", scheduledFor: "2026-13-01" }] }), /scheduledFor/i],
    [payload({ tasks: [{ key: "t1", action: "create", type: "feature", milestoneKey: "missing", number: "1.1", order: 1, title: "x" }] }), /milestone/i],
    [payload({ goal: { criteria: [{ key: "c1", text: "x", taskKeys: ["missing"] }] } }), /taskKeys/i],
    [payload({ tasks: [{ key: "t1", action: "delete", milestoneKey: "m1", number: "1.1", order: 1 }] }), /action/i],
    [payload({ tasks: [{ key: "t1", action: "update", taskId: local.id, milestoneKey: "m1", number: "1.1", order: 1, changes: { status: "done" } }] }), /update field/i],
    [payload({ tasks: [{ key: "t1", action: "link", taskId: "missing", milestoneKey: "m1", number: "1.1", order: 1 }] }), /Task not found/i],
    [payload({ tasks: [{ key: "t1", action: "link", taskId: foreign.id, milestoneKey: "m1", number: "1.1", order: 1 }] }), /same project/i],
  ];

  for (const [badPayload, message] of invalid) {
    assert.throws(() => hub.createRoadmapProposal({ projectPath: dir, agent: "codex", payload: badPayload }), message);
  }
  assert.equal(hub.storage.db.prepare("SELECT COUNT(*) AS n FROM roadmap_proposals").get().n, 0);
}));

test("sixth active project and occupied active rank are rejected without live writes", async () => withHub(({ hub, dir }) => {
  for (let rank = 1; rank <= 5; rank += 1) {
    const proposal = hub.createRoadmapProposal({ projectPath: `${dir}-${rank}`, agent: "codex", payload: payload({ goal: { activeRank: rank } }) });
    hub.approveRoadmapProposal({ id: proposal.id, agent: "human" });
    if (rank === 1) {
      const collision = hub.createRoadmapProposal({ projectPath: `${dir}-collision`, agent: "codex", payload: payload({ goal: { activeRank: 1 } }) });
      assert.throws(() => hub.approveRoadmapProposal({ id: collision.id, agent: "human" }), /active rank/i);
      assert.equal(hub.storage.getRoadmapProposal(collision.id).status, "pending");
      assert.equal(hub.storage.db.prepare("SELECT COUNT(*) AS n FROM project_goals").get().n, 1);
    }
  }
  const sixth = hub.createRoadmapProposal({ projectPath: `${dir}-6`, agent: "codex", payload: payload({ goal: { activeRank: 1 } }) });
  assert.throws(() => hub.approveRoadmapProposal({ id: sixth.id, agent: "human" }), /five active projects|active rank/i);
  assert.equal(hub.storage.db.prepare("SELECT COUNT(*) AS n FROM project_goals").get().n, 5);
  assert.equal(hub.storage.getRoadmapProposal(sixth.id).status, "pending");
}));

test("update changes only allowed fields and planning metadata", async () => withHub(({ hub, dir }) => {
  const target = hub.addTask({ type: "chore", projectPath: dir, title: "Old", priority: "low", assignedAgent: "owner", evidence: "keep" });
  const untouched = hub.addTask({ type: "chore", projectPath: dir, title: "Untouched", priority: "urgent" });
  const proposal = hub.createRoadmapProposal({
    projectPath: dir,
    agent: "codex",
    payload: payload({ tasks: [{
      key: "t1", action: "update", taskId: target.id, milestoneKey: "m1", number: "1.1", order: 1,
      scheduledFor: "2026-06-30", changes: { title: "New", priority: "high", acceptanceCriteria: "Pass", verificationCommand: "npm test" },
    }] }),
  });
  hub.approveRoadmapProposal({ id: proposal.id, agent: "human" });

  assert.deepEqual(hub.storage.getTask(target.id), {
    ...hub.storage.getTask(target.id),
    title: "New", priority: "high", assignedAgent: "owner", evidence: "keep",
    acceptanceCriteria: "Pass", verificationCommand: "npm test", taskNumber: "1.1", roadmapOrder: 1, scheduledFor: "2026-06-30",
  });
  assert.equal(hub.storage.getTask(untouched.id).title, "Untouched");
  assert.equal(hub.storage.getTask(untouched.id).milestoneId, null);
}));

test("goal achievement requires explicit confirmation after every criterion is verified", async () => withHub(({ hub, dir }) => {
  const linked = hub.addTask({ type: "chore", projectPath: dir, title: "Linked" });
  const proposal = hub.createRoadmapProposal({
    projectPath: dir,
    agent: "codex",
    payload: payload({
      goal: { criteria: [{ key: "c1", text: "new", taskKeys: ["new"] }, { key: "c2", text: "linked", taskKeys: ["linked"] }] },
      tasks: [
        { key: "new", action: "create", type: "feature", milestoneKey: "m1", number: "1.1", order: 1, title: "New" },
        { key: "linked", action: "link", taskId: linked.id, milestoneKey: "m1", number: "1.2", order: 2 },
      ],
    }),
  });
  const roadmap = hub.approveRoadmapProposal({ id: proposal.id, agent: "human" });
  hub.completeTask({ id: roadmap.tasks[0].id, evidence: "passed" });
  assert.throws(() => hub.confirmGoalAchieved({ id: roadmap.goal.id }), /criteria.*verified/i);
  assert.equal(hub.getRoadmap({ projectPath: dir }).goal.status, "active");
  hub.completeTask({ id: linked.id, evidence: "passed" });
  assert.equal(hub.getRoadmap({ projectPath: dir }).goal.status, "active");
  assert.equal(hub.confirmGoalAchieved({ id: roadmap.goal.id }).status, "achieved");
}));

test("rejection requires a reason and prevents application", async () => withHub(({ hub, dir }) => {
  const proposal = hub.createRoadmapProposal({ projectPath: dir, agent: "codex", payload: payload() });
  assert.throws(() => hub.rejectRoadmapProposal({ id: proposal.id, agent: "human", reason: " " }), /reason is required/);
  const rejected = hub.rejectRoadmapProposal({ id: proposal.id, agent: "human", reason: "Not now" });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.resolutionReason, "Not now");
  assert.throws(() => hub.approveRoadmapProposal({ id: proposal.id, agent: "human" }), /pending/);
  assert.equal(hub.storage.db.prepare("SELECT COUNT(*) AS n FROM project_goals").get().n, 0);
}));

test("proposal resolution is compare-and-set and terminal decisions cannot overwrite each other", async () => withHub(({ hub, dir }) => {
  const rejected = hub.createRoadmapProposal({ projectPath: dir, agent: "codex", payload: payload() });
  assert.equal(hub.storage.resolveRoadmapProposal(rejected.id, { status: "rejected", reason: "No" }), true);
  assert.equal(hub.storage.resolveRoadmapProposal(rejected.id, { status: "approved" }), false);
  assert.equal(hub.storage.getRoadmapProposal(rejected.id).status, "rejected");
  assert.throws(() => hub.approveRoadmapProposal({ id: rejected.id, agent: "human" }), /pending/);

  const approved = hub.createRoadmapProposal({ projectPath: `${dir}-approved`, agent: "codex", payload: payload() });
  const roadmap = hub.approveRoadmapProposal({ id: approved.id, agent: "human" });
  assert.throws(() => hub.rejectRoadmapProposal({ id: approved.id, agent: "human", reason: "Too late" }), /pending/);
  assert.equal(hub.storage.getRoadmapProposal(approved.id).appliedGoalId, roadmap.goal.id);
}));

test("validation rejects duplicate existing task actions and silent reparenting", async () => withHub(({ hub, dir }) => {
  const existing = hub.addTask({ type: "chore", projectPath: dir, title: "Existing" });
  const duplicate = payload({
    goal: { criteria: [{ key: "c1", text: "x", taskKeys: ["one"] }] },
    tasks: [
      { key: "one", action: "link", taskId: existing.id, milestoneKey: "m1", number: "1.1", order: 1 },
      { key: "two", action: "update", taskId: existing.id, milestoneKey: "m1", number: "1.2", order: 2, changes: { title: "Changed" } },
    ],
  });
  assert.throws(() => hub.createRoadmapProposal({ projectPath: dir, agent: "codex", payload: duplicate }), /duplicate.*taskId|same existing task/i);

  const first = hub.createRoadmapProposal({
    projectPath: dir,
    agent: "codex",
    payload: payload({ tasks: [{ key: "t1", action: "link", taskId: existing.id, milestoneKey: "m1", number: "1.1", order: 1 }] }),
  });
  hub.approveRoadmapProposal({ id: first.id, agent: "human" });
  assert.throws(() => hub.createRoadmapProposal({
    projectPath: dir,
    agent: "codex",
    payload: payload({ tasks: [{ key: "t1", action: "link", taskId: existing.id, milestoneKey: "m1", number: "1.1", order: 1 }] }),
  }), /already.*milestone|reparent/i);
}));

test("Windows roadmap identity treats path case aliases as the same project", { skip: process.platform !== "win32" }, async () => withHub(({ hub, dir }) => {
  const upper = dir.toUpperCase();
  const lower = dir.toLowerCase();
  const existing = hub.addTask({ type: "chore", projectPath: upper, title: "Existing" });
  const first = hub.createRoadmapProposal({
    projectPath: lower,
    agent: "codex",
    payload: payload({ tasks: [{ key: "t1", action: "link", taskId: existing.id, milestoneKey: "m1", number: "1.1", order: 1 }] }),
  });
  hub.approveRoadmapProposal({ id: first.id, agent: "human" });

  const alias = hub.createRoadmapProposal({ projectPath: upper, agent: "codex", payload: payload({ goal: { activeRank: 2 } }) });
  assert.throws(() => hub.approveRoadmapProposal({ id: alias.id, agent: "human" }), /project already has an active goal/i);
  assert.equal(hub.storage.getRoadmapProposal(alias.id).status, "pending");
  assert.equal(hub.storage.listActiveGoals().length, 1);
}));

test("Windows roadmap reads accept a project path case alias", { skip: process.platform !== "win32" }, async () => withHub(({ hub, dir }) => {
  const proposal = hub.createRoadmapProposal({ projectPath: dir.toLowerCase(), agent: "codex", payload: payload() });
  const applied = hub.approveRoadmapProposal({ id: proposal.id, agent: "human" });

  const aliased = hub.getRoadmap({ projectPath: dir.toUpperCase() });
  assert.equal(aliased.goal.id, applied.goal.id);
  assert.deepEqual(aliased.tasks.map(({ id }) => id), applied.tasks.map(({ id }) => id));
  assert.equal(hub.listRoadmapProposals({ projectPath: dir.toUpperCase() }).length, 1);
  assert.equal(hub.storage.getActiveGoal(dir.toUpperCase()).id, applied.goal.id);
}));

test("Windows alias-linked criterion tasks can confirm goal achievement", { skip: process.platform !== "win32" }, async () => withHub(({ hub, dir }) => {
  const existing = hub.addTask({ type: "chore", projectPath: dir.toUpperCase(), title: "Existing" });
  const proposal = hub.createRoadmapProposal({
    projectPath: dir.toLowerCase(),
    agent: "codex",
    payload: payload({ tasks: [{ key: "t1", action: "link", taskId: existing.id, milestoneKey: "m1", number: "1.1", order: 1 }] }),
  });
  const roadmap = hub.approveRoadmapProposal({ id: proposal.id, agent: "human" });
  hub.completeTask({ id: existing.id, evidence: "verified" });

  assert.equal(hub.confirmGoalAchieved({ id: roadmap.goal.id }).status, "achieved");
}));

function approve(hub, projectPath, overrides = {}) {
  return hub.approveRoadmapProposal({
    id: hub.createRoadmapProposal({ projectPath, agent: "codex", payload: payload(overrides) }).id,
    agent: "human",
  });
}

test("portfolio ranks active goals, uses the next incomplete milestone deadline, and reports attention and weekly outcomes", async () => withHub(({ hub, dir }) => {
  const second = approve(hub, `${dir}-second`, {
    goal: { activeRank: 2, weeklyCapacity: 5 },
    tasks: [{ key: "t1", action: "create", type: "feature", milestoneKey: "m1", number: "1.1", order: 1, title: "Blocked", priority: "urgent" }],
  });
  hub.blockTask({ id: second.tasks[0].id, reason: "waiting" });
  const first = approve(hub, `${dir}-first`, {
    goal: { activeRank: 1, weeklyCapacity: 5 },
    milestones: [
      { key: "m1", title: "Friday", order: 1, dueDate: "2026-07-03" },
      { key: "m2", title: "Later", order: 2, dueDate: "2026-07-31" },
    ],
    tasks: [
      { key: "t1", action: "create", type: "feature", milestoneKey: "m1", number: "1.1", order: 1, title: "Do one", priority: "high" },
      { key: "t2", action: "create", type: "feature", milestoneKey: "m1", number: "1.2", order: 2, title: "Do two", priority: "normal" },
      { key: "t3", action: "create", type: "feature", milestoneKey: "m1", number: "1.3", order: 3, title: "Do three", priority: "normal" },
      { key: "t4", action: "create", type: "feature", milestoneKey: "m2", number: "2.1", order: 4, title: "Later task", priority: "low" },
    ],
  });
  const achieved = approve(hub, `${dir}-done`, { goal: { activeRank: 3 } });
  hub.completeTask({ id: achieved.tasks[0].id, evidence: "yes" });
  hub.confirmGoalAchieved({ id: achieved.goal.id });
  hub.storage.db.prepare("UPDATE project_goals SET achieved_at = ?, updated_at = ? WHERE id = ?").run("2026-07-01T12:00:00.000Z", "2026-07-20T12:00:00.000Z", achieved.goal.id);
  const older = approve(hub, `${dir}-older`, { goal: { activeRank: 4 } });
  hub.completeTask({ id: older.tasks[0].id, evidence: "yes" });
  hub.confirmGoalAchieved({ id: older.goal.id });
  hub.storage.db.prepare("UPDATE project_goals SET achieved_at = ?, updated_at = ? WHERE id = ?").run("2026-06-26T12:00:00.000Z", "2026-07-01T12:00:00.000Z", older.goal.id);

  const result = hub.getGoalsPortfolio({ today: "2026-07-02" });
  assert.deepEqual(result.projects.map(({ activeRank }) => activeRank), [1, 2]);
  assert.equal(result.projects[0].deadlineHealth, "at_risk");
  assert.equal(result.projects[0].progress.total, 4);
  assert.equal(result.projects[0].nextTask.title, "Do one");
  assert.equal(result.projects[1].stalled, true);
  assert.equal(result.nextAction.title, "Do one");
  assert.ok(result.attention.some(({ kind, taskId }) => kind === "blocked_task" && taskId === second.tasks[0].id));
  assert.ok(result.attention.some((item) => item.kind === "blocked_task" && item.taskId === second.tasks[0].id && !("id" in item)));
  assert.ok(result.attention.some(({ kind, id }) => kind === "project_at_risk" && id === first.goal.id));
  assert.deepEqual(result.verifiedOutcomes.map(({ id }) => id), [achieved.goal.id]);

  hub.storage.updateMilestone(first.milestones[0].id, { dueDate: "2026-07-01" });
  assert.equal(hub.getGoalsPortfolio({ today: "2026-07-02" }).projects[0].deadlineHealth, "overdue");
}));

test("weekly planning reads candidates, respects caps, rolls missed work once, and persists schedules", async () => withHub(({ hub, dir }) => {
  const one = approve(hub, `${dir}-one`, {
    goal: { activeRank: 1, weeklyCapacity: 1 },
    tasks: [
      { key: "t1", action: "create", type: "feature", milestoneKey: "m1", number: "1.1", order: 1, title: "Missed", scheduledFor: "2026-06-26" },
      { key: "t2", action: "create", type: "feature", milestoneKey: "m1", number: "1.2", order: 2, title: "Extra" },
    ],
  });
  const two = approve(hub, `${dir}-two`, {
    goal: { activeRank: 2, weeklyCapacity: 2 },
    tasks: [
      { key: "t1", action: "create", type: "feature", milestoneKey: "m1", number: "1.1", order: 1, title: "Scheduled", scheduledFor: "2026-07-01" },
      { key: "t2", action: "create", type: "feature", milestoneKey: "m1", number: "1.2", order: 2, title: "Blocked" },
      { key: "t3", action: "create", type: "feature", milestoneKey: "m1", number: "1.3", order: 3, title: "Done" },
    ],
  });
  hub.blockTask({ id: two.tasks[1].id, reason: "wait" });
  hub.completeTask({ id: two.tasks[2].id, evidence: "ok" });
  const unlinked = hub.addTask({ type: "chore", projectPath: one.goal.projectPath, title: "Unlinked ops", status: "in_progress" });

  const before = hub.getWeeklyPlan({ weekStart: "2026-06-29", totalCapacity: 6 });
  assert.deepEqual([before.weekStart, before.weekEnd, before.totalCapacity], ["2026-06-29", "2026-07-03", 6]);
  assert.deepEqual(before.scheduled.map(({ title }) => title), ["Scheduled"]);
  assert.deepEqual(new Set(before.unscheduled.map(({ title }) => title)), new Set(["Missed", "Extra", "Unlinked ops"]));
  assert.equal(before.unscheduled.find(({ id }) => id === unlinked.id).activeRank, 1);
  assert.equal(before.projectCapacities[one.goal.projectPath], 1);

  const planned = hub.autoPlanWeeklyTasks({ weekStart: "2026-06-29", totalCapacity: 2, agent: "codex" });
  assert.equal(planned.scheduled.length, 2);
  assert.ok(planned.scheduled.some(({ id }) => id === one.tasks[0].id));
  assert.equal(hub.storage.getTask(one.tasks[1].id).scheduledFor, null);
  assert.equal(hub.storage.getTask(two.tasks[1].id).scheduledFor, null);
  assert.equal(hub.storage.getTask(two.tasks[2].id).scheduledFor, null);
  const missed = () => hub.storage.listMetrics(one.goal.projectPath, { kind: "task_schedule_missed" });
  assert.equal(missed().filter(({ payload }) => payload.taskId === one.tasks[0].id && payload.oldScheduledFor === "2026-06-26").length, 1);
  hub.autoPlanWeeklyTasks({ weekStart: "2026-06-29", totalCapacity: 2, agent: "codex" });
  assert.equal(missed().filter(({ payload }) => payload.taskId === one.tasks[0].id && payload.oldScheduledFor === "2026-06-26").length, 1);
}));

test("auto-plan records a missed schedule once and preserves it when no slot is available", async () => withHub(({ hub, dir }) => {
  const roadmap = approve(hub, dir, {
    goal: { weeklyCapacity: 1, criteria: [{ key: "c1", text: "Fill", taskKeys: ["fill"] }] },
    tasks: [
      { key: "fill", action: "create", type: "feature", milestoneKey: "m1", number: "1.1", order: 1, title: "Fill", priority: "urgent" },
      { key: "missed", action: "create", type: "feature", milestoneKey: "m1", number: "1.2", order: 2, title: "Missed", priority: "normal", scheduledFor: "2026-06-26" },
      { key: "blocked", action: "create", type: "feature", milestoneKey: "m1", number: "1.3", order: 3, title: "Blocked missed", priority: "low", scheduledFor: "2026-06-25" },
    ],
  });
  const missedTask = roadmap.tasks.find(({ title }) => title === "Missed");
  const blockedTask = roadmap.tasks.find(({ title }) => title === "Blocked missed");
  hub.blockTask({ id: blockedTask.id, reason: "waiting" });

  hub.autoPlanWeeklyTasks({ weekStart: "2026-06-29", totalCapacity: 1, agent: "codex" });
  hub.autoPlanWeeklyTasks({ weekStart: "2026-06-29", totalCapacity: 1, agent: "codex" });

  assert.equal(hub.storage.getTask(missedTask.id).scheduledFor, "2026-06-26");
  assert.equal(hub.storage.listMetrics(dir, { kind: "task_schedule_missed" })
    .filter(({ payload }) => payload.taskId === missedTask.id && payload.oldScheduledFor === "2026-06-26").length, 1);
  assert.equal(hub.storage.getTask(blockedTask.id).scheduledFor, "2026-06-25");
  assert.equal(hub.storage.listMetrics(dir, { kind: "task_schedule_missed" })
    .filter(({ payload }) => payload.taskId === blockedTask.id && payload.oldScheduledFor === "2026-06-25").length, 1);
}));

test("goal, milestone, and task planning updates validate invariants", async () => withHub(({ hub, dir }) => {
  const first = approve(hub, `${dir}-first`, { goal: { activeRank: 1 } });
  const second = approve(hub, `${dir}-second`, {
    goal: { activeRank: 2 },
    milestones: [
      { key: "m1", title: "First", order: 1, dueDate: "2026-07-05" },
      { key: "m2", title: "Second", order: 2, dueDate: "2026-07-12" },
    ],
  });
  assert.throws(() => hub.updateGoal({ id: first.goal.id, status: "achieved" }), /confirmGoalAchieved/i);
  assert.throws(() => hub.updateGoal({ id: first.goal.id, activeRank: 2 }), /rank/i);
  assert.throws(() => hub.updateGoal({ id: first.goal.id, targetDate: "2026-02-30" }), /targetDate/i);
  assert.throws(() => hub.updateGoal({ id: first.goal.id, weeklyCapacity: 0 }), /weeklyCapacity/i);
  assert.equal(hub.updateGoal({ id: first.goal.id, status: "paused" }).activeRank, null);
  assert.equal(hub.updateGoal({ id: second.goal.id, activeRank: 1 }).activeRank, 1);

  assert.throws(() => hub.updateMilestone({ id: second.milestones[0].id, title: " " }), /title/i);
  assert.throws(() => hub.updateMilestone({ id: second.milestones[0].id, sortOrder: 0 }), /sortOrder/i);
  assert.throws(() => hub.updateMilestone({ id: second.milestones[0].id, dueDate: "bad" }), /dueDate/i);
  assert.throws(() => hub.updateMilestone({ id: second.milestones[0].id, sortOrder: 2 }), /unique/i);
  assert.throws(() => hub.updateMilestone({ id: second.milestones[0].id, title: "Second" }), /unique/i);
  assert.equal(hub.updateMilestone({ id: second.milestones[0].id, title: "Renamed" }).title, "Renamed");

  assert.throws(() => hub.scheduleTask({ id: second.tasks[0].id, scheduledFor: "2026-02-30" }), /scheduledFor/i);
  hub.blockTask({ id: second.tasks[0].id, reason: "wait" });
  assert.throws(() => hub.scheduleTask({ id: second.tasks[0].id, scheduledFor: "2026-07-01" }), /blocked/i);
  hub.storage.updateTask(second.tasks[0].id, { status: "backlog" });
  assert.equal(hub.scheduleTask({ id: second.tasks[0].id, scheduledFor: "2026-07-01" }).scheduledFor, "2026-07-01");
  hub.storage.updateTask(second.tasks[0].id, { status: "ready" });
  assert.equal(hub.scheduleTask({ id: second.tasks[0].id, scheduledFor: "2026-07-02" }).scheduledFor, "2026-07-02");
  hub.storage.updateTask(second.tasks[0].id, { status: "in_progress" });
  assert.equal(hub.scheduleTask({ id: second.tasks[0].id, scheduledFor: "2026-07-03" }).scheduledFor, "2026-07-03");
  hub.completeTask({ id: second.tasks[0].id, evidence: "done" });
  assert.throws(() => hub.scheduleTask({ id: second.tasks[0].id, scheduledFor: "2026-07-04" }), /done/i);
  assert.throws(() => hub.getGoalsPortfolio({}), /today/i);
  assert.throws(() => hub.getGoalsPortfolio({ today: "2026-02-30" }), /today/i);
  assert.throws(() => hub.getWeeklyPlan({}), /weekStart/i);
  assert.throws(() => hub.getWeeklyPlan({ weekStart: "bad" }), /weekStart/i);
}));

test("goal activation enforces the five-project limit and terminal achievement time", async () => withHub(({ hub, dir }) => {
  const goals = [];
  for (let rank = 1; rank <= 5; rank += 1) goals.push(approve(hub, `${dir}-${rank}`, { goal: { activeRank: rank } }).goal);
  const sixth = hub.storage.insertGoal({ id: "sixth", projectPath: `${dir}-6`, title: "Sixth", outcome: "No", successCriteria: [], targetDate: "2026-08-01", weeklyCapacity: 1, status: "paused" });
  assert.throws(() => hub.updateGoal({ id: sixth.id, status: "active", activeRank: 1 }), /five/i);
  assert.equal(hub.updateGoal({ id: goals[0].id, status: "abandoned" }).activeRank, null);

  const achievedRoadmap = approve(hub, `${dir}-achieved`, { goal: { activeRank: 1 } });
  hub.completeTask({ id: achievedRoadmap.tasks[0].id, evidence: "yes" });
  const achieved = hub.confirmGoalAchieved({ id: achievedRoadmap.goal.id });
  assert.ok(achieved.achievedAt);
  assert.equal(hub.updateGoal({ id: achieved.id, targetDate: "2026-08-02" }).achievedAt, achieved.achievedAt);
  assert.throws(() => hub.updateGoal({ id: achieved.id, status: "paused" }), /achieved/i);
}));

test("Windows case aliases cannot activate a second goal for one project", { skip: process.platform !== "win32" }, async () => withHub(({ hub, dir }) => {
  approve(hub, dir.toLowerCase(), { goal: { activeRank: 1 } });
  const alias = hub.storage.insertGoal({ id: "alias", projectPath: dir.toUpperCase(), title: "Alias", outcome: "No", successCriteria: [], targetDate: "2026-08-01", weeklyCapacity: 1, status: "paused" });
  assert.throws(() => hub.updateGoal({ id: alias.id, status: "active", activeRank: 2 }), /project already/i);
}));
