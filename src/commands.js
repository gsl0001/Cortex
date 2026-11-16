import { randomUUID } from "node:crypto";
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildProjectBrief } from "./brief.js";
import { captureCandidate, findDecisionDuplicate } from "./captureService.js";
import { isAnswerProse } from "./capturePolicy.js";
import { auditDatabase, auditProject, remediateAudit, computeFragilePaths } from "./audit.js";
import { briefQuery, extractContextTerms } from "./contextRanking.js";
import { drainIndexJobs, enqueueRecord, rebuildSearchIndex } from "./indexer.js";
import { searchMemory } from "./search.js";
import { OllamaEmbeddingProvider } from "./embeddingProvider.js";
import { packContext } from "./tokenPacker.js";
import { CortexStorage, normalizeProjectPath } from "./storage.js";
import { computeStats } from "./stats.js";
import { computeRecallEconomics } from "./recallEconomics.js";
import { buildProjectIndex, isOffTopic } from "./topicScope.js";
import {
  autoPlanWeek,
  criterionVerified,
  deadlineHealth,
  goalProgress,
  isProjectStalled,
  selectNextAction,
} from "./planning.js";
import {
  buildPortfolioDoctor,
  setProjectLifecycle as storeProjectLifecycle,
} from "./portfolio.js";

const TASK_STATUSES = new Set(["backlog", "ready", "in_progress", "blocked", "review", "done"]);

// Controlled task-type vocabulary. Single source of truth for every write-path (CLI, HTTP,
// roadmap proposals) and referenced by the two task-writing skills. `chore` doubles as the
// neutral/misc bucket (also the migration backfill for pre-type rows).
export const TASK_TYPES = ["feature", "bug", "chore", "docs", "test", "research", "infra"];

// Completion authority. Only human sign-off (agent 'human') may push a task to `done`; an
// autonomous agent that identifies itself may only reach `review`. An absent agent stays
// privileged (CLI, tests, roadmap machinery) — same convention as _assertLeaseOwnership.
function assertCompletionAllowed(input) {
  if (input.agent && input.agent !== "human") {
    throw new Error(
      `Agent '${input.agent}' may not set a task to 'done'; agents park in review for human sign-off.`,
    );
  }
}

function requireOneOf(value, allowed, field) {
  if (!allowed.includes(value)) throw new Error(`${field} must be one of: ${allowed.join(", ")}`);
  return value;
}

function requireText(value, field) {
  // must actually be a string, not just String()-coercible: a CLI flag with no value parses to
  // boolean true (String(true) = "true", passing the old check silently), and an HTTP JSON body
  // can send any type ({nested:"object"} -> "[object Object]") — both used to corrupt the field
  // instead of failing with a clear error.
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function taskStatus(status) {
  const normalized = status || "ready";
  if (!TASK_STATUSES.has(normalized)) {
    throw new Error(`Invalid task status: ${status}`);
  }
  return normalized;
}

function requireObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value;
}

function allowKeys(value, allowed, field) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`unknown ${field} key: ${unknown}`);
}

function requirePositiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

const RECHECK_DEFAULT_DAYS = Number(process.env.CORTEX_RECHECK_DEFAULT_DAYS || 7);
function defaultRecheckDate(now = new Date()) {
  const due = new Date(now.getTime() + RECHECK_DEFAULT_DAYS * 86400000);
  return `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")}`;
}

export function requireIsoDate(value, field) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) throw new Error(`${field} must be a valid YYYY-MM-DD date`);
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`${field} must be a valid YYYY-MM-DD date`);
  }
  return value;
}

// notBefore is a per-task earliest-start moment (needs time-of-day, not just a calendar date),
// unlike requireIsoDate above which is deliberately YYYY-MM-DD only (targetDate/dueDate/
// scheduledFor/recheckAt). Delegates to Date parsing so both "2026-07-09T06:00:00" (local) and
// "2026-07-09T02:00:00.000Z" (UTC) round-trip.
function requireIsoDateTime(value, field) {
  if (typeof value !== "string" || !value.trim() || Number.isNaN(new Date(value).getTime())) {
    throw new Error(`${field} must be a valid ISO datetime`);
  }
  return value;
}

function unique(values, field) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${field}: ${value}`);
    seen.add(value);
  }
}

function roadmapProjectKey(projectPath) {
  const normalized = normalizeProjectPath(projectPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function addDays(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekBounds(value) {
  const weekStart = requireIsoDate(value, "weekStart");
  return { weekStart, weekEnd: addDays(weekStart, 4) };
}

export function validateRoadmapPayload(storage, projectPath, payload) {
  requireObject(payload, "proposal");
  allowKeys(payload, new Set(["version", "goal", "milestones", "tasks"]), "proposal");
  if (payload.version !== 1) throw new Error("proposal version must be 1");

  const goal = requireObject(payload.goal, "goal");
  allowKeys(goal, new Set(["title", "outcome", "targetDate", "weeklyCapacity", "activeRank", "criteria"]), "goal");
  if (!Array.isArray(goal.criteria) || !goal.criteria.length) throw new Error("at least one criterion is required");
  if (!Array.isArray(payload.milestones) || !payload.milestones.length) throw new Error("at least one milestone is required");
  if (!Array.isArray(payload.tasks)) throw new Error("tasks must be an array");
  if (!Number.isInteger(goal.activeRank) || goal.activeRank < 1 || goal.activeRank > 5) throw new Error("activeRank must be between 1 and 5");

  const normalized = {
    version: 1,
    goal: {
      title: requireText(goal.title, "goal.title"),
      outcome: requireText(goal.outcome, "goal.outcome"),
      targetDate: requireIsoDate(goal.targetDate, "goal.targetDate"),
      weeklyCapacity: requirePositiveInteger(goal.weeklyCapacity, "goal.weeklyCapacity"),
      activeRank: goal.activeRank,
      criteria: goal.criteria.map((criterion) => {
        requireObject(criterion, "criterion");
        allowKeys(criterion, new Set(["key", "text", "taskKeys"]), "criterion");
        if (!Array.isArray(criterion.taskKeys) || !criterion.taskKeys.length) throw new Error("criterion.taskKeys must be a non-empty array");
        return {
          key: requireText(criterion.key, "criterion.key"),
          text: requireText(criterion.text, "criterion.text"),
          taskKeys: criterion.taskKeys.map((key) => requireText(key, "criterion.taskKeys")),
        };
      }),
    },
    milestones: payload.milestones.map((milestone) => {
      requireObject(milestone, "milestone");
      allowKeys(milestone, new Set(["key", "title", "order", "dueDate"]), "milestone");
      return {
        key: requireText(milestone.key, "milestone.key"),
        title: requireText(milestone.title, "milestone.title"),
        order: requirePositiveInteger(milestone.order, "milestone.order"),
        dueDate: requireIsoDate(milestone.dueDate, "milestone.dueDate"),
      };
    }),
    tasks: [],
  };

  unique(normalized.goal.criteria.map(({ key }) => key), "criterion key");
  unique(normalized.milestones.map(({ key }) => key), "milestone key");
  unique(normalized.milestones.map(({ order }) => order), "milestone order");
  const milestoneKeys = new Set(normalized.milestones.map(({ key }) => key));
  const normalizedProject = roadmapProjectKey(projectPath);
  const shared = new Set(["key", "action", "milestoneKey", "number", "order", "scheduledFor"]);

  normalized.tasks = payload.tasks.map((task) => {
    requireObject(task, "task");
    const action = task.action;
    if (!["create", "link", "update"].includes(action)) throw new Error(`unsupported task action: ${action}`);
    const allowed = new Set(shared);
    for (const key of action === "create"
      ? ["title", "type", "priority", "acceptanceCriteria", "verificationCommand"]
      : action === "update" ? ["taskId", "changes"] : ["taskId"]) allowed.add(key);
    allowKeys(task, allowed, "task");
    const result = {
      key: requireText(task.key, "task.key"),
      action,
      milestoneKey: requireText(task.milestoneKey, "task.milestoneKey"),
      number: requireText(task.number, "task.number"),
      order: requirePositiveInteger(task.order, "task.order"),
    };
    if (!milestoneKeys.has(result.milestoneKey)) throw new Error(`unknown milestone key: ${result.milestoneKey}`);
    if (task.scheduledFor != null) result.scheduledFor = requireIsoDate(task.scheduledFor, "task.scheduledFor");

    if (action === "create") {
      result.title = requireText(task.title, "task.title");
      result.type = requireOneOf(task.type, TASK_TYPES, "task.type");
      if (task.priority != null) result.priority = requireText(task.priority, "task.priority");
      if (task.acceptanceCriteria != null) result.acceptanceCriteria = requireText(task.acceptanceCriteria, "task.acceptanceCriteria");
      if (task.verificationCommand !== undefined) result.verificationCommand = task.verificationCommand === null
        ? null : requireText(task.verificationCommand, "task.verificationCommand");
    } else {
      result.taskId = requireText(task.taskId, "task.taskId");
      const existing = storage.getTask(result.taskId);
      if (!existing) throw new Error(`Task not found: ${result.taskId}`);
      if (roadmapProjectKey(existing.projectPath) !== normalizedProject) throw new Error("linked task must belong to the same project");
      if (existing.milestoneId) throw new Error(`Task already belongs to a milestone: ${result.taskId}`);
      if (action === "update") {
        const changes = requireObject(task.changes, "update.changes");
        const updateFields = new Set(["title", "type", "priority", "acceptanceCriteria", "verificationCommand"]);
        const unknown = Object.keys(changes).find((key) => !updateFields.has(key));
        if (unknown) throw new Error(`unsupported update field: ${unknown}`);
        result.changes = {};
        for (const [key, value] of Object.entries(changes)) {
          if (key === "type") { result.changes.type = requireOneOf(value, TASK_TYPES, "update.changes.type"); continue; }
          result.changes[key] = key === "verificationCommand" && value === null
            ? null : requireText(value, `update.changes.${key}`);
        }
      }
    }
    return result;
  });

  unique(normalized.tasks.map(({ key }) => key), "task key");
  unique(normalized.tasks.map(({ number }) => number), "task number");
  unique(normalized.tasks.map(({ order }) => order), "task order");
  unique(normalized.tasks.filter(({ taskId }) => taskId).map(({ taskId }) => taskId), "taskId");
  const taskKeys = new Set(normalized.tasks.map(({ key }) => key));
  for (const criterion of normalized.goal.criteria) {
    unique(criterion.taskKeys, `criterion ${criterion.key} task key`);
    if (criterion.taskKeys.some((key) => !taskKeys.has(key))) throw new Error(`criterion ${criterion.key} has unknown taskKeys`);
  }
  return normalized;
}

export class Cortex {
  constructor({ dbPath } = {}) {
    this.storage = new CortexStorage({ dbPath });
    // one instance per hub, not one per search() call: its doc-vector and MinHash caches
    // only amortize if actually reused across searches. Cosine scoring activates only where
    // a caller awaits embeddingProvider.prepare(query); everything else gets MinHash.
    this.embeddingProvider = new OllamaEmbeddingProvider({ storage: this.storage });
  }

  close() {
    this.storage.close();
  }

  upsertProjectProfile(input) {
    return this.storage.upsertProjectProfile({
      projectPath: normalizeProjectPath(input.projectPath),
      name: requireText(input.name, "name"),
      mode: requireText(input.mode, "mode"),
      summary: input.summary || "",
      standardCommands: input.standardCommands || [],
      risks: input.risks || [],
      externalMemoryDirs: input.externalMemoryDirs || [],
    });
  }

  portfolioDoctor(input = {}) {
    return buildPortfolioDoctor(this.storage, { today: input.today });
  }

  setProjectLifecycle(input) {
    return storeProjectLifecycle(
      this.storage,
      requireText(input.projectPath, "projectPath"),
      requireText(input.state, "state"),
    );
  }

  // Producers must exist at write time — a typo'd id reads as "stuck" forever and the
  // consumer silently never dispatches.
  _requireTasksExist(ids) {
    for (const pid of ids) if (!this.storage.getTask(pid)) throw new Error(`dependsOn refers to a missing task: ${pid}`);
  }

  addTask(input) {
    const id = randomUUID();
    const dependsOn = Array.isArray(input.dependsOn) ? input.dependsOn.map((x) => requireText(x, "dependsOn[]")) : [];
    this._requireTasksExist(dependsOn);
    if (this.wouldCreateCycle(id, dependsOn)) throw new Error("dependsOn would create a cycle");
    const notBefore = input.notBefore != null ? requireIsoDateTime(input.notBefore, "notBefore") : null;
    return this.storage.insertTask({
      id,
      projectPath: normalizeProjectPath(input.projectPath),
      title: requireText(input.title, "title"),
      type: requireOneOf(input.type, TASK_TYPES, "type"),
      status: taskStatus(input.status),
      priority: input.priority || "normal",
      assignedAgent: input.assignedAgent,
      relatedFiles: input.relatedFiles || [],
      acceptanceCriteria: input.acceptanceCriteria,
      verificationCommand: input.verificationCommand,
      evidence: input.evidence,
      branch: input.branch,
      commitSha: input.commitSha,
      blockReason: input.blockReason,
      dependsOn,
      notBefore,
    });
  }

  // A dependency is satisfied when every producer is in review or done.
  dependencyState(task) {
    const ids = task.dependsOn || [];
    if (!ids.length) return { satisfied: true, waitingOn: [], stuck: [] };
    const waitingOn = [];
    const stuck = [];
    for (const id of ids) {
      const producer = this.storage.getTask(id);
      if (!producer || producer.status === "blocked") { stuck.push(id); continue; }
      if (producer.status !== "review" && producer.status !== "done") waitingOn.push(id);
    }
    return { satisfied: waitingOn.length === 0 && stuck.length === 0, waitingOn, stuck };
  }

  // Reject a dependsOn edit that would create a cycle (DFS over existing edges).
  wouldCreateCycle(taskId, dependsOn) {
    const seen = new Set();
    const visit = (id) => {
      if (id === taskId) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      const producer = this.storage.getTask(id);
      return (producer?.dependsOn || []).some(visit);
    };
    return (dependsOn || []).some(visit);
  }

  claimTask(input) {
    // atomic conditional lease claim (no list-then-update race)
    return this.storage.claimTaskLease(requireText(input.id, "id"), requireText(input.agent, "agent"), input.branch);
  }

  // if an agent is supplied and the task is leased by someone else, refuse; no agent = privileged override
  _assertLeaseOwnership(id, agent) {
    if (!agent) return;
    const task = this.storage.getTask(id);
    if (task?.leaseAgent && task.leaseAgent !== agent) throw new Error("Task is leased by another agent");
  }

  // Blocked work needs a way back. 6 of 11 blocked tasks in the live DB carried no recheck
  // date — "Blocked until the build is submitted to App Review" had no mechanism to ever ask
  // again, so it wasn't blocked, it was forgotten. A task waiting on the world gets a date.
  blockTask(input) {
    const id = requireText(input.id, "id");
    this._assertLeaseOwnership(id, input.agent);
    const reason = requireText(input.reason, "reason");
    const patch = { status: "blocked", blockReason: reason };
    if (input.recheckAt !== undefined && input.recheckAt !== null) {
      patch.recheckAt = requireIsoDate(input.recheckAt, "recheckAt");
    } else if (!this.storage.getTask(id)?.recheckAt) {
      // Never overwrite a date a human already chose; only fill the gap that leaves work stranded.
      patch.recheckAt = defaultRecheckDate();
    }
    const task = this.storage.updateTask(id, patch);
    this.storage.clearLease(id); // terminal -> lease moot
    return task;
  }

  reviewTask(input) {
    const id = requireText(input.id, "id");
    const task = this.storage.updateTask(id, {
      status: "review",
      evidence: input.evidence,
      commitSha: input.commitSha,
    });
    this.storage.clearLease(id); // review is terminal for the agent -> lease moot
    return task;
  }

  editTask(input) {
    const patch = {};
    for (const key of ["title", "type", "status", "priority", "assignedAgent", "relatedFiles", "acceptanceCriteria", "verificationCommand", "recheckAt", "dependsOn", "notBefore"]) {
      if (input[key] !== undefined) patch[key] = input[key];
    }
    if (patch.title !== undefined) patch.title = requireText(patch.title, "title");
    if (patch.type !== undefined) patch.type = requireOneOf(patch.type, TASK_TYPES, "type");
    if (patch.status !== undefined) patch.status = taskStatus(patch.status);
    if (patch.status === "done") assertCompletionAllowed(input); // editing to done is a completion too
    if (patch.recheckAt != null) requireIsoDate(patch.recheckAt, "recheckAt");
    if (patch.dependsOn !== undefined) {
      patch.dependsOn = Array.isArray(patch.dependsOn) ? patch.dependsOn.map((x) => requireText(x, "dependsOn[]")) : [];
      this._requireTasksExist(patch.dependsOn);
      if (this.wouldCreateCycle(input.id, patch.dependsOn)) throw new Error("dependsOn would create a cycle");
    }
    if (patch.notBefore != null) requireIsoDateTime(patch.notBefore, "notBefore");
    return this.storage.updateTask(input.id, patch);
  }

  deleteTask(input) {
    return this.storage.deleteTask(input.id);
  }

  completeTask(input) {
    const id = requireText(input.id, "id");
    if (!this.storage.getTask(id)) throw new Error(`Task not found: ${id}`); // not-found beats the authority error
    this._assertLeaseOwnership(id, input.agent);
    assertCompletionAllowed(input);
    const task = this.storage.updateTask(id, {
      status: "done",
      evidence: requireText(input.evidence, "evidence"),
      commitSha: input.commitSha,
    });
    this.storage.clearLease(id);
    return task;
  }

  releaseTask(input) {
    return this.storage.releaseLease(input.id, requireText(input.agent, "agent"));
  }

  // ---- agent-run history (the launch machinery is gone; runs are read-only history) ----
  listRuns(input = {}) {
    return this.storage.listRuns(normalizeProjectPath(input.projectPath || process.cwd()), { limit: input.limit || 100 });
  }

  listTasks(input) {
    return this.storage.listTasks(normalizeProjectPath(input.projectPath || process.cwd()), input);
  }

  createRoadmapProposal(input) {
    const projectPath = normalizeProjectPath(input.projectPath);
    const payload = validateRoadmapPayload(this.storage, projectPath, input.payload);
    return this.storage.insertRoadmapProposal({
      id: randomUUID(),
      projectPath,
      createdBy: requireText(input.agent, "agent"),
      payload,
    });
  }

  listRoadmapProposals(input = {}) {
    return this.storage.listRoadmapProposals(
      normalizeProjectPath(input.projectPath || process.cwd()),
      { status: input.status },
    );
  }

  approveRoadmapProposal(input) {
    return this.storage.transaction(() => {
      const proposal = this.storage.getRoadmapProposal(input.id);
      if (!proposal) throw new Error(`Roadmap proposal not found: ${input.id}`);
      if (proposal.appliedGoalId) return this.storage.getRoadmap(proposal.projectPath, proposal.appliedGoalId);
      if (proposal.status !== "pending") throw new Error("Roadmap proposal must be pending");
      const payload = validateRoadmapPayload(this.storage, proposal.projectPath, proposal.payload);
      const active = this.storage.listActiveGoals();
      if (active.some(({ projectPath }) => roadmapProjectKey(projectPath) === roadmapProjectKey(proposal.projectPath))) {
        throw new Error("project already has an active goal");
      }
      if (active.length >= 5) throw new Error("Cannot exceed five active projects");
      if (active.some(({ activeRank }) => activeRank === payload.goal.activeRank)) throw new Error("active rank is already occupied");

      const goalId = randomUUID();
      this.storage.insertGoal({
        id: goalId,
        projectPath: proposal.projectPath,
        ...payload.goal,
        successCriteria: [],
        status: "active",
      });
      const milestoneIds = new Map();
      for (const milestone of payload.milestones) {
        const id = randomUUID();
        milestoneIds.set(milestone.key, id);
        this.storage.insertMilestone({
          id,
          goalId,
          title: milestone.title,
          sortOrder: milestone.order,
          dueDate: milestone.dueDate,
        });
      }

      const taskIds = new Map();
      for (const task of payload.tasks) {
        const planning = {
          milestoneId: milestoneIds.get(task.milestoneKey),
          taskNumber: task.number,
          roadmapOrder: task.order,
          scheduledFor: task.scheduledFor ?? null,
        };
        let applied;
        if (task.action === "create") {
          applied = this.storage.insertTask({
            id: randomUUID(),
            projectPath: proposal.projectPath,
            title: task.title,
            type: task.type,
            status: "ready",
            priority: task.priority || "normal",
            relatedFiles: [],
            acceptanceCriteria: task.acceptanceCriteria,
            verificationCommand: task.verificationCommand,
            ...planning,
          });
        } else {
          applied = this.storage.updateTask(task.taskId, {
            ...(task.action === "update" ? task.changes : {}),
            ...planning,
          });
        }
        taskIds.set(task.key, applied.id);
      }

      this.storage.updateGoal(goalId, {
        successCriteria: payload.goal.criteria.map(({ key, text, taskKeys }) => ({
          id: key,
          text,
          task_ids: taskKeys.map((taskKey) => taskIds.get(taskKey)),
        })),
      });
      if (!this.storage.resolveRoadmapProposal(proposal.id, { status: "approved", appliedGoalId: goalId })) {
        throw new Error("Roadmap proposal must be pending");
      }
      return this.storage.getRoadmap(proposal.projectPath, goalId);
    });
  }

  rejectRoadmapProposal(input) {
    const reason = requireText(input.reason, "reason");
    return this.storage.transaction(() => {
      const proposal = this.storage.getRoadmapProposal(input.id);
      if (!proposal) throw new Error(`Roadmap proposal not found: ${input.id}`);
      if (proposal.status !== "pending") throw new Error("Roadmap proposal must be pending");
      if (!this.storage.resolveRoadmapProposal(proposal.id, { status: "rejected", reason })) {
        throw new Error("Roadmap proposal must be pending");
      }
      return this.storage.getRoadmapProposal(proposal.id);
    });
  }

  getRoadmap(input = {}) {
    return this.storage.getRoadmap(normalizeProjectPath(input.projectPath || process.cwd()));
  }

  getGoalsPortfolio(input = {}) {
    const today = requireIsoDate(input.today, "today");
    // instrument-or-delete counter (2026-07 audit): does anything actually read the
    // goals/roadmap layer? Recorded machine-wide — the portfolio spans projects.
    try { this.storage.recordMetric("goals_viewed", "machine", {}); } catch { /* best-effort */ }
    const projects = this.storage.listGoals({ status: "active" }).map((goal) => {
      const roadmap = this.storage.getRoadmap(goal.projectPath, goal.id);
      const milestonesWithTasks = roadmap.milestones.map((milestone) => ({
        ...milestone,
        tasks: roadmap.tasks.filter(({ milestoneId }) => milestoneId === milestone.id),
      }));
      const candidates = roadmap.tasks.map((task) => ({
        ...task,
        activeRank: goal.activeRank,
        projectPath: goal.projectPath,
        milestone: roadmap.milestones.find(({ id }) => id === task.milestoneId) ?? null,
      }));
      const nextMilestone = milestonesWithTasks.find(({ tasks }) => tasks.some(({ status }) => status !== "done"));
      const tasksById = new Map(roadmap.tasks.map((task) => [task.id, task]));
      return {
        ...goal,
        progress: goalProgress(roadmap.tasks),
        eligibleForAchievement: goal.successCriteria.every((criterion) => criterionVerified(criterion, tasksById)),
        deadlineHealth: nextMilestone ? deadlineHealth({
          dueDate: nextMilestone.dueDate,
          weeklyCapacity: goal.weeklyCapacity,
          tasks: nextMilestone.tasks,
          today,
        }) : "on_track",
        stalled: isProjectStalled({ tasks: roadmap.tasks, today }),
        nextTask: selectNextAction(candidates, new Map(roadmap.milestones.map(({ id, dueDate }) => [id, dueDate])), today),
        milestones: roadmap.milestones,
        _candidates: candidates,
      };
    });
    const allCandidates = projects.flatMap(({ _candidates }) => _candidates);
    const dueDates = new Map(projects.flatMap(({ milestones }) => milestones.map(({ id, dueDate }) => [id, dueDate])));
    const attention = [];
    for (const project of projects) {
      for (const task of project._candidates.filter(({ status }) => status === "blocked")) {
        attention.push({ kind: "blocked_task", taskId: task.id, projectPath: project.projectPath, message: task.blockReason || task.title });
      }
      if (project.stalled) attention.push({ kind: "project_stalled", id: project.id, projectPath: project.projectPath, message: `${project.title} is stalled` });
      if (["at_risk", "overdue"].includes(project.deadlineHealth)) {
        attention.push({ kind: `project_${project.deadlineHealth}`, id: project.id, projectPath: project.projectPath, message: `${project.title} is ${project.deadlineHealth.replace("_", " ")}` });
      }
      delete project._candidates;
    }
    const date = new Date(`${today}T00:00:00Z`);
    const monday = addDays(today, -((date.getUTCDay() + 6) % 7));
    const friday = addDays(monday, 4);
    const verifiedOutcomes = this.storage.listGoals({ status: "achieved" })
      .filter(({ achievedAt }) => achievedAt?.slice(0, 10) >= monday && achievedAt.slice(0, 10) <= friday);
    return { projects, nextAction: selectNextAction(allCandidates, dueDates, today), attention, verifiedOutcomes };
  }

  getWeeklyPlan(input = {}) {
    const { weekStart, weekEnd } = weekBounds(input.weekStart);
    const totalCapacity = input.totalCapacity ?? 10;
    if (!Number.isInteger(totalCapacity) || totalCapacity < 1) throw new Error("totalCapacity must be a positive integer");
    const goals = this.storage.listGoals({ status: "active" });
    const projectCapacities = Object.fromEntries(goals.map(({ projectPath, weeklyCapacity }) => [projectPath, weeklyCapacity]));
    const tasks = goals.flatMap((goal) => {
      const roadmap = this.storage.getRoadmap(goal.projectPath, goal.id);
      const milestones = new Map(roadmap.milestones.map((milestone) => [milestone.id, milestone]));
      return this.storage.listTasks(goal.projectPath)
        .filter(({ status }) => ["ready", "in_progress"].includes(status))
        .map((task) => {
          const milestone = milestones.get(task.milestoneId)
            ?? (task.milestoneId ? this.storage.getMilestone(task.milestoneId) : null);
          return {
            ...task,
            goalId: milestone?.goalId ?? null,
            activeRank: goal.activeRank,
            projectPath: goal.projectPath,
            milestone,
            milestoneDueDate: milestone?.dueDate ?? null,
          };
        });
    });
    const scheduled = tasks.filter(({ scheduledFor }) => scheduledFor >= weekStart && scheduledFor <= weekEnd);
    const scheduledIds = new Set(scheduled.map(({ id }) => id));
    const unscheduled = tasks.filter(({ id }) => !scheduledIds.has(id));
    return { weekStart, weekEnd, totalCapacity, projectCapacities, scheduled, unscheduled };
  }

  autoPlanWeeklyTasks(input = {}) {
    const current = this.getWeeklyPlan(input);
    const tasks = [...current.scheduled, ...current.unscheduled];
    const planned = autoPlanWeek(tasks, current);
    const missedTasks = [...new Map(this.storage.listGoals({ status: "active" })
      .flatMap(({ projectPath }) => this.storage.listTasks(projectPath))
      .filter(({ status, scheduledFor }) => status !== "done" && scheduledFor && scheduledFor < current.weekStart)
      .map((task) => [task.id, task])).values()];
    return this.storage.transaction(() => {
      const metricKeys = new Map();
      for (const task of missedTasks) {
        if (!metricKeys.has(task.projectPath)) {
          metricKeys.set(task.projectPath, new Set(this.storage.listMetrics(task.projectPath, { kind: "task_schedule_missed" })
            .map(({ payload }) => `${payload.taskId}\0${payload.oldScheduledFor}`)));
        }
        const key = `${task.id}\0${task.scheduledFor}`;
        if (!metricKeys.get(task.projectPath).has(key)) {
          this.storage.recordMetric("task_schedule_missed", task.projectPath, {
            taskId: task.id,
            oldScheduledFor: task.scheduledFor,
            agent: input.agent || null,
          });
          metricKeys.get(task.projectPath).add(key);
        }
      }
      for (const task of tasks) {
        const next = planned.find(({ id }) => id === task.id);
        const missed = task.scheduledFor && task.scheduledFor < current.weekStart;
        const scheduledFor = next?.scheduledFor ?? (missed ? task.scheduledFor : null);
        if (scheduledFor !== task.scheduledFor) this.storage.updateTask(task.id, { scheduledFor });
      }
      return this.getWeeklyPlan(input);
    });
  }

  updateGoal(input) {
    const goal = this.storage.getGoal(input.id);
    if (!goal) throw new Error(`Goal not found: ${input.id}`);
    if (input.status === "achieved") throw new Error("Use confirmGoalAchieved to achieve a goal");
    if (goal.status === "achieved" && input.status != null && input.status !== "achieved") throw new Error("An achieved goal cannot leave achieved status");
    if (input.status != null && !["active", "paused", "abandoned"].includes(input.status)) throw new Error("Invalid goal status");
    if (input.targetDate != null) requireIsoDate(input.targetDate, "targetDate");
    if (input.weeklyCapacity != null) requirePositiveInteger(input.weeklyCapacity, "weeklyCapacity");
    if (input.activeRank != null && (!Number.isInteger(input.activeRank) || input.activeRank < 1 || input.activeRank > 5)) throw new Error("activeRank must be between 1 and 5");
    const status = input.status ?? goal.status;
    const activeRank = status === "active" ? (input.activeRank ?? goal.activeRank) : null;
    if (status === "active") {
      if (!activeRank) throw new Error("activeRank is required for an active goal");
      const active = this.storage.listGoals({ status: "active" }).filter(({ id }) => id !== goal.id);
      if (active.some(({ projectPath }) => roadmapProjectKey(projectPath) === roadmapProjectKey(goal.projectPath))) throw new Error("project already has an active goal");
      if (active.length >= 5) throw new Error("Cannot exceed five active projects");
      if (active.some((other) => other.activeRank === activeRank)) throw new Error("active rank is already occupied");
    }
    const updated = this.storage.updateGoal(goal.id, {
      status,
      activeRank,
      ...(input.targetDate != null ? { targetDate: input.targetDate } : {}),
      ...(input.weeklyCapacity != null ? { weeklyCapacity: input.weeklyCapacity } : {}),
    });
    // Abandoning a goal retires its open tasks: leaving them `ready` keeps them in the
    // dispatch pool for work nobody wants (18 tasks from one abandoned goal sat there
    // for five days). Backlog, not delete — reactivating the goal can resurface them.
    if (status === "abandoned" && goal.status !== "abandoned") {
      const demoted = this.storage.demoteGoalTasksToBacklog(goal.id);
      if (demoted > 0) {
        // PR #35 retirement was visible only as an inbox note (audit III); count it too.
        try { this.storage.recordMetric("goal_retired", goal.projectPath, { goalId: goal.id, taskCount: demoted }); }
        catch { /* best-effort */ }
        this.addInboxItem({ projectPath: goal.projectPath, author: "system",
          message: `Goal "${goal.title}" abandoned: ${demoted} open task(s) moved to backlog.` });
      }
    }
    return updated;
  }

  updateMilestone(input) {
    const milestone = this.storage.getMilestone(input.id);
    if (!milestone) throw new Error(`Milestone not found: ${input.id}`);
    const patch = {};
    if (input.title != null) patch.title = requireText(input.title, "title");
    if (input.sortOrder != null) patch.sortOrder = requirePositiveInteger(input.sortOrder, "sortOrder");
    if (input.dueDate != null) patch.dueDate = requireIsoDate(input.dueDate, "dueDate");
    const siblings = this.storage.db.prepare("SELECT id, title, sort_order AS sortOrder FROM roadmap_milestones WHERE goal_id = ? AND id <> ?").all(milestone.goalId, milestone.id);
    if (patch.title && siblings.some(({ title }) => title === patch.title)) throw new Error("milestone title must be unique within the goal");
    if (patch.sortOrder && siblings.some(({ sortOrder }) => sortOrder === patch.sortOrder)) throw new Error("milestone sortOrder must be unique within the goal");
    return this.storage.updateMilestone(milestone.id, patch);
  }

  scheduleTask(input) {
    const task = this.storage.getTask(input.id);
    if (!task) throw new Error(`Task not found: ${input.id}`);
    requireIsoDate(input.scheduledFor, "scheduledFor");
    if (!["backlog", "ready", "in_progress"].includes(task.status)) throw new Error(`${task.status} tasks cannot be scheduled`);
    return this.storage.updateTask(task.id, { scheduledFor: input.scheduledFor });
  }

  confirmGoalAchieved(input) {
    const goal = this.storage.getGoal(input.id);
    if (!goal) throw new Error(`Goal not found: ${input.id}`);
    if (goal.status !== "active") throw new Error("Goal must be active");
    const taskIds = new Set(goal.successCriteria.flatMap(({ task_ids: ids }) => Array.isArray(ids) ? ids : []));
    const tasks = new Map([...taskIds].map((id) => [id, this.storage.getTask(id)]));
    if (!goal.successCriteria.every((criterion) => criterionVerified(criterion, tasks))) {
      throw new Error("All goal criteria must be verified");
    }
    return this.storage.updateGoal(goal.id, { status: "achieved", achievedAt: goal.achievedAt ?? new Date().toISOString() });
  }

  // ponytail: status:"ready" already excludes claimed (in_progress) tasks, so
  // the lease predicate was dead code. First ready task wins.
  nextTask(input = {}) {
    const projectPath = normalizeProjectPath(input.projectPath || process.cwd());
    const next = this.storage.listTasks(projectPath, { statuses: ["ready"] })[0] || null;
    if (next && input.claim) return this.storage.claimTaskLease(next.id, requireText(input.agent, "agent"), input.branch);
    return next;
  }

  addResearchEntry(input) {
    const inserted = this.storage.insertResearch({
      id: randomUUID(),
      projectPath: normalizeProjectPath(input.projectPath),
      agent: requireText(input.agent, "agent"),
      question: requireText(input.question, "question"),
      sources: input.sources || [],
      evidence: input.evidence || [],
      finding: requireText(input.finding, "finding"),
      fixMade: input.fixMade,
      verification: input.verification,
      residualRisk: input.residualRisk,
      reuseTags: input.reuseTags || [],
    });
    // matches captureCandidate's path: without this, CLI-added records are unsearchable until
    // someone remembers to run `cortex index rebuild`.
    enqueueRecord(this.storage, inserted.id, "research");
    return inserted;
  }

  addFixEntry(input) {
    const inserted = this.storage.insertFix({
      id: randomUUID(),
      projectPath: normalizeProjectPath(input.projectPath),
      agent: requireText(input.agent, "agent"),
      summary: requireText(input.summary, "summary"),
      filesChanged: input.filesChanged || [],
      commitSha: input.commitSha,
      verification: input.verification,
      residualRisk: input.residualRisk,
    });
    enqueueRecord(this.storage, inserted.id, "fix");
    return inserted;
  }

  startSession(input) {
    return this.storage.insertSession({
      id: randomUUID(),
      projectPath: normalizeProjectPath(input.projectPath),
      agent: requireText(input.agent, "agent"),
      source: input.source || "local",
      goal: requireText(input.goal, "goal"),
      branch: input.branch,
      dirtyFiles: input.dirtyFiles || [],
      status: "active",
    });
  }

  finishSession(input) {
    return this.storage.finishSession(requireText(input.id, "id"), { outcome: input.outcome });
  }

  captureCandidate(input) {
    const result = captureCandidate(this.storage, input);
    // A Stop-hook capture carries its transcript path: enqueue distillation so the server can
    // mine the WHOLE session (root causes, dead ends, decisions) instead of just the final
    // message. Distilled captures come back with source "distill" and no path — no recursion.
    if (input.transcriptPath && input.source !== "distill") {
      try {
        if (this.storage.getSetting("distill.enabled", true)) {
          this.storage.enqueueDistillJob({
            projectPath: input.projectPath,
            transcriptPath: input.transcriptPath,
            agent: input.agent,
          });
        }
      } catch { /* distillation is best-effort; the primary capture already landed */ }
    }
    return result;
  }

  addInboxItem(input) {
    return this.storage.insertInboxItem({
      projectPath: normalizeProjectPath(input.projectPath),
      author: requireText(input.author, "author"),
      message: requireText(input.message, "message"),
    });
  }

  addLesson(input) {
    return this.storage.insertLesson({
      // raw: storage's lessonScope keeps the reserved "machine" scope literal —
      // normalizing here would resolve it against cwd and strand the lesson in a fake project
      projectPath: input.projectPath,
      statement: requireText(input.lesson || input.statement, "lesson"),
    });
  }

  listInbox(input = {}) {
    return this.storage.listInboxItems(normalizeProjectPath(input.projectPath || process.cwd()), {
      includeResolved: Boolean(input.includeResolved),
      ...(input.limit ? { limit: input.limit } : {}),
    });
  }

  resolveInbox(input) {
    return this.storage.resolveInboxItem(normalizeProjectPath(input.projectPath || process.cwd()), input.id);
  }

  // Fragile paths for Memory Guard and any consumer that wants the warning list directly.
  fragilePaths(input = {}) {
    return computeFragilePaths(this.storage, {
      projectPath: normalizeProjectPath(input.projectPath || process.cwd()),
      threshold: input.threshold ?? Number(process.env.CORTEX_FRAGILE_THRESHOLD || 3),
    });
  }

  audit(input = {}) {
    const remediation = input.fix ? remediateAudit(this.storage, input) : null;
    const result = input.projectPath
      ? auditProject(this.storage, input.projectPath, input)
      : auditDatabase(this.storage, input);
    return remediation ? { ...result, remediation } : result;
  }

  search(input = {}) {
    const startedAt = performance.now();
    drainIndexJobs(this.storage);
    const search = searchMemory(this.storage, { embeddingProvider: this.embeddingProvider, ...input });
    const context = packContext(search.results, { maxTokens: input.maxTokens || 1500 });
    // 2026-07 audit: 1,775 indexed chunks with zero usage telemetry — instrument-or-delete
    // needs this counter before the two-week clock can judge the search subsystem. Internal
    // callers (buildBrief's cross-project lookup) are excluded: the counter measures demand,
    // not the hub calling itself.
    if (!input.internal) {
      try {
        this.storage.recordMetric("search_used", normalizeProjectPath(input.projectPath || process.cwd()), {
          agent: input.agent || null,
          // traceVersion 1: result identities and pack losses, read by scripts/search-diagnostics.mjs
          traceVersion: 1,
          query: String(input.query || "").slice(0, 2000),
          queryTruncated: String(input.query || "").length > 2000,
          results: search.results?.length ?? 0,
          returnedIds: search.results.map((record) => record.id).slice(0, 100),
          packedIds: context.citations.map((record) => record.id).slice(0, 100),
          budgetExcluded: context.excluded.filter((record) => record.reason === "budget").length,
          duplicateExcluded: context.excluded.filter((record) => record.reason === "duplicate").length,
          usedTokens: context.usedTokens, maxTokens: context.maxTokens,
          embeddingMode: this.embeddingProvider?.queryVec && this.embeddingProvider.queryKey === String(input.query || "") ? "ollama" : "minhash",
          searchDurationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        });
      } catch { /* observability is best-effort */ }
    }
    return {
      ...search,
      context,
      text: context.text || "No matching durable memory.",
    };
  }

  // Which sessions pulled from memory vs spun up cold, and what the brief cost each project —
  // see recallEconomics.js for the verdicts. `projectPath` null = whole portfolio.
  recallEconomics(input = {}) {
    return computeRecallEconomics(this.storage, {
      projectPath: input.projectPath ? normalizeProjectPath(input.projectPath) : null,
      since: input.since,
      sessionLimit: input.sessionLimit,
    });
  }

  stats(input = {}) {
    return {
      ...computeStats(this.storage, {
        projectPath: normalizeProjectPath(input.projectPath || process.cwd()),
        since: input.since,
      }),
      // throughput is a number, not a vibe: weekly merged/verified/reviewed run rollup
      runsWeekly: this.storage.weeklyRunRollup(),
    };
  }

  // One-time backfill for decisions captured before the revision gate existed (2026-08-03:
  // 133 of 630 live decisions were restatements). Chains each duplicate cluster oldest←newest
  // so only the newest wording stays live; superseded rows remain in history and search.
  // Dry-run by default. ponytail: O(n²) minhash per project, fine at maintenance cadence.
  dedupeDecisions({ projectPath = null, apply = false } = {}) {
    const projects = projectPath
      ? [normalizeProjectPath(projectPath)]
      : this.storage.listDecisionProjectPaths();
    const report = { projects: projects.length, clusters: 0, redundant: 0, linked: 0, applied: Boolean(apply) };
    for (const project of projects) {
      // oldest first, so each cluster's last member is its newest wording
      const live = this.storage.listDecisions(project, { limit: 10000, excludeSuperseded: true }).reverse();
      const clusters = [];
      for (const record of live) {
        const home = clusters.find((members) => members.some((m) => findDecisionDuplicate(record, [m])));
        if (home) home.push(record);
        else clusters.push([record]);
      }
      for (const cluster of clusters) {
        if (cluster.length < 2) continue;
        report.clusters += 1;
        report.redundant += cluster.length - 1;
        if (!apply) continue;
        for (let i = cluster.length - 1; i > 0; i -= 1) {
          report.linked += this.storage.supersedeDecision(cluster[i].id, cluster[i - 1].id);
        }
      }
    }
    return report;
  }

  sweep(now = new Date(), { logRoot } = {}) {
    const result = {
      sessionEventsDeleted: this.storage.sweepExpiredSessionEvents(now),
      metricsDeleted: this.storage.sweepExpiredMetrics(now, Number(process.env.CORTEX_METRICS_RETENTION_DAYS || 90)),
      inboxDeleted: this.storage.sweepExpiredInbox(now),
      staleSessionsClosed: this.storage.sweepStaleSessions(now, Number(process.env.CORTEX_SESSION_TTL_HOURS || 12)),
      distillJobsDeleted: this.storage.sweepProcessedDistillJobs(now),
      agentLogsDeleted: this.reapAgentLogs(now, logRoot),
    };
    this.storage.checkpoint();
    return result;
  }

  // Best-effort reaper for autonomous-run logs. ponytail: sweep can't know a custom
  // agentLauncher logRoot, so it defaults to the same path the launcher writes to
  // (next to the DB); pass logRoot only when it differs (e.g. tests).
  reapAgentLogs(now, logRoot = join(dirname(this.storage.dbPath), "agent-runs")) {
    const retentionDays = Number(process.env.CORTEX_AGENT_LOG_RETENTION_DAYS || 14);
    const cutoff = now.getTime() - retentionDays * 86_400_000;
    let deleted = 0;
    try {
      for (const name of readdirSync(logRoot)) {
        if (!name.endsWith(".jsonl")) continue;
        const file = join(logRoot, name);
        try {
          if (statSync(file).mtimeMs < cutoff) { unlinkSync(file); deleted += 1; }
        } catch { /* file vanished mid-sweep — fine */ }
      }
    } catch { /* no log dir yet, or unreadable — nothing to reap */ }
    return deleted;
  }

  drainIndex() {
    return drainIndexJobs(this.storage);
  }

  rebuildIndex() {
    return rebuildSearchIndex(this.storage);
  }

  // Pull one record in full by its citable [m:xxxxxx] prefix — the read half of the
  // stub-index brief (stubs inject one line; bodies are pulled on demand). The pull is a
  // direct usage signal, recorded like a citation channel.
  getRecord({ idPrefix, agent } = {}) {
    const prefix = String(idPrefix || "").toLowerCase().replace(/^\[?m:/, "").replace(/\]$/, "");
    const ref = this.storage.findRecordByPrefix(prefix);
    if (!ref) return null;
    const record = ref.recordType === "fix" ? this.storage.getFix(ref.id)
      : ref.recordType === "research" ? this.storage.getResearch(ref.id)
      : this.storage.getDecision(ref.id);
    try {
      this.storage.recordMetric("recall_pulled", ref.projectPath, { agent: agent || null, idPrefix: prefix, recordType: ref.recordType });
    } catch { /* telemetry only */ }
    return { ...record, recordType: ref.recordType };
  }

  // Await before buildBrief to enable cosine scoring for the brief's semantic arm — embeds
  // the session query once (2s cap, silent MinHash fallback if Ollama is down). Callers that
  // skip it (tests, cold paths) just get the MinHash-scale semantic scores.
  async prepareBrief(context = {}) {
    if (process.env.CORTEX_BRIEF_SEMANTIC === "0") return;
    const query = briefQuery(context);
    if (query) await this.embeddingProvider.prepare?.(query);
  }

  buildBrief(input = {}) {
    const projectPath = normalizeProjectPath(input.projectPath || process.cwd());
    const profile = this.storage.getProjectProfile(projectPath);
    const tasks = this.storage.listTasks(projectPath);
    const maxAgeDays = Number(process.env.CORTEX_BRIEF_MAX_AGE_DAYS || 120);
    // Citation counts ([m:xxxxxx] ids echoed by agents → recall_cited metrics) attach to each
    // record as useCount: ranking prefers memories agents actually used, and the TTL below
    // spares them from aging out.
    const citedCounts = new Map();
    try {
      for (const m of this.storage.listMetrics(projectPath, { kind: "recall_cited", limit: 1000 })) {
        const prefix = m.payload?.idPrefix;
        if (prefix) citedCounts.set(prefix, (citedCounts.get(prefix) || 0) + 1);
      }
    } catch { /* citation telemetry is best-effort */ }
    // Injection counts back the fatigue penalty in contextRanking.confidence(): a record served
    // repeatedly with no citation yields its slot. Reads the same recall_injected payloads the
    // metric already writes, so no new bookkeeping — see topicScope.js for the sibling problem.
    // Counted as distinct SESSIONS served, not raw injections: per-injection counts fed back
    // into ranking every prompt, reordering the brief and changing its hash — fatigue and
    // delta suppression were wired in opposition. Per-session counts are stable within a
    // session (this session adds at most 1) and measure the honest thing: sessions that saw
    // the record and never cited it.
    const injectedSessions = new Map();
    try {
      for (const m of this.storage.listMetrics(projectPath, { kind: "recall_injected", limit: 400 })) {
        const sessionKey = m.payload?.sessionId || m.id;
        for (const key of ["injectedFixIds", "injectedResearchIds", "injectedDecisionIds"]) {
          for (const id of m.payload?.[key] || []) {
            if (!injectedSessions.has(id)) injectedSessions.set(id, new Set());
            injectedSessions.get(id).add(sessionKey);
          }
        }
      }
    } catch { /* injection telemetry is best-effort */ }
    const withUse = (record) => ({
      ...record,
      useCount: citedCounts.get(String(record.id || "").replace(/-/g, "").slice(0, 6)) || 0,
      injectedCount: injectedSessions.get(record.id)?.size || 0,
    });
    // Topic scope (value audit IV): decline to serve records whose content plainly belongs to a
    // different registered project. Labels alone cannot catch these — the record is filed under
    // the directory the session ran in, which is why the label-based scope check reads clean.
    const topicIndex = process.env.CORTEX_TOPIC_SCOPE === "0"
      ? new Map()
      : buildProjectIndex(this.storage.listProjectProfiles());
    let offTopicFiltered = 0;
    const onTopic = (textOf) => (record) => {
      if (!isOffTopic(textOf(record), projectPath, topicIndex)) return true;
      offTopicFiltered += 1;
      return false;
    };
    // Quarantined records (Stale: corrections, poisoning flags) never re-enter briefs;
    // they stay in the store for search and dashboard review.
    const notQuarantined = (record) => record.qualityStatus !== "quarantined";
    // withUse runs BEFORE the topic filter so a cited record is exempt from topic scoping:
    // the filter's false negatives concentrate in cross-project rules ("never enroll master
    // in Autopilot"), and a citation is direct evidence the record belongs in this brief.
    const citedOrOnTopic = (textOf) => { const gate = onTopic(textOf); return (r) => r.useCount > 0 || gate(r); };
    const research = this.storage.listResearch(projectPath, { limit: 20, excludeSuperseded: true, maxAgeDays })
      .filter(notQuarantined)
      .map(withUse)
      .filter(citedOrOnTopic((r) => `${r.question} ${r.finding}`));
    // Quality-tiered TTL: unverified, never-cited fixes leave brief eligibility after 45 days
    // (they stay in the store and FTS-searchable) — stale unverified prose was the main
    // occupant of the brief's five fix slots.
    const unverifiedTtlDays = Number(process.env.CORTEX_UNVERIFIED_BRIEF_TTL_DAYS || 45);
    const ttlCutoff = Date.now() - unverifiedTtlDays * 86_400_000;
    const fixes = this.storage.listFixes(projectPath, { limit: 20, excludeSuperseded: true, maxAgeDays })
      .filter(notQuarantined)
      .map(withUse)
      .filter(citedOrOnTopic((f) => `${f.summary} ${(f.filesChanged || []).join(" ")}`))
      // Same test the capture gate applies, on the read side: answers stored as fixes before
      // that gate existed are still fixes in the table, and they were holding brief slots.
      .filter((fix) => { if (!isAnswerProse(fix)) return true; offTopicFiltered += 1; return false; })
      .filter((fix) => Boolean(fix.verification) || fix.qualityStatus === "verified"
        || fix.useCount > 0 || new Date(fix.createdAt).getTime() >= ttlCutoff);
    const sessions = this.storage.listActiveSessions(projectPath);
    // limit 20, not 5: decisions are ranked now (rankDecisions), and a ranker fed exactly as many
    // candidates as it has slots is just the recency list wearing a ranker's name.
    const decisions = this.storage.listDecisions(projectPath, { limit: 20, excludeSuperseded: true, maxAgeDays })
      .filter(notQuarantined)
      .map(withUse)
      .filter(citedOrOnTopic((d) => `${d.decision} ${d.rationale} ${d.alternatives || ""}`));
    // Inbox and lessons no longer feed the brief (value audit V): inbox had 0 rows ever;
    // lessons earned 0 citations ever and still reach agents via JIT recall on file touch.
    const previouslyAttempted = this.storage.listSupersededFixes(projectPath, { limit: 20 });
    const fragilePaths = this.fragilePaths({ projectPath });
    // reuses search's existing same-project-affinity ranking; just keeps the OTHER-project
    // hits the brief currently throws away — e.g. a Windows path-casing fix from a sibling repo.
    const contextTerms = extractContextTerms(input.context || {});
    const crossProjectMatches = contextTerms.length
      ? this.search({ projectPath, query: contextTerms.slice(0, 8).join(" "), maxTokens: 300, internal: true }).results
          .filter((r) => r.projectPath !== projectPath)
          .slice(0, 3)
      : [];
    // "where I left off": a Stop-hook "Handoff:" note (captureService.js), tagged with its
    // branch via session_events.source (no schema change). Same-branch match preferred;
    // falls back to the most recent handoff of any branch when no branch context is known.
    const branch = input.context?.branch;
    const sessionEvents = this.storage.listSessionEvents(projectPath);
    const handoff = sessionEvents.find((e) => e.source === `handoff:${branch || "unknown"}`)
      || (!branch ? sessionEvents.find((e) => e.source.startsWith("handoff:")) : undefined);
    // The demotion tier must not be write-only: the newest unevidenced session summary gets
    // one line in the next brief, so a real-but-unproven result can be confirmed (and
    // graduate to a fix) instead of dying silently at its 7-day TTL.
    const lastSession = sessionEvents.find((e) => !String(e.source || "").startsWith("handoff:"));

    // Semantic scorer for ranking/admission: cosine against precomputed doc vectors when
    // prepareBrief ran (same briefQuery string, so the provider's query cache hits), MinHash
    // otherwise. Disabled with the same env switch as prepareBrief.
    const query = briefQuery(input.context || {});
    const semantic = query && process.env.CORTEX_BRIEF_SEMANTIC !== "0"
      ? (record, text) => this.embeddingProvider.similarity(query, text, record.id)
      : null;
    const built = buildProjectBrief({
      projectPath, profile, tasks, research, fixes, sessions, semantic,
      decisions, previouslyAttempted, fragilePaths, crossProjectMatches, handoff: handoff?.summary,
      lastSession: handoff ? null : lastSession?.summary,
      context: input.context || {},
      // setting > env so the cap-size test (value audit II Phase 2) is a live settings flip
      // Default 600 (was 1200; injection research Aug 28): the context-file ablation found no
      // correctness gain from bigger briefs, Chroma's context-rot data shows each uncited
      // record is an active distractor, and at the old cap ~81% of injected tokens were never
      // cited. Override via the brief.maxTokens setting or CORTEX_BRIEF_TOKENS.
      maxTokens: input.maxTokens ?? this.storage.getSetting("brief.maxTokens", Number(process.env.CORTEX_BRIEF_TOKENS || 600)),
      fieldChars: Number(process.env.CORTEX_BRIEF_FIELD_CHARS || 160),
    });
    return { ...built, offTopicFiltered };
  }
}

export function createCortex(options = {}) {
  return new Cortex(options);
}
