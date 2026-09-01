import { normalizeProjectPath } from "./storage.js";

export const PROJECT_LIFECYCLES = ["unclassified", "active", "waiting", "maintenance", "archived"];
const LIFECYCLE_PREFIX = "portfolio.lifecycle.";
const OPEN = new Set(["ready", "in_progress", "blocked", "review"]);
const PRIORITY = { urgent: 0, high: 1, normal: 2, medium: 2, low: 3 };
const STATUS = { in_progress: 0, review: 1, ready: 2, blocked: 3 };
const DAY = 86_400_000;

const projectKey = (path) => String(path || "").replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
const lifecycleKey = (path) => `${LIFECYCLE_PREFIX}${projectKey(path)}`;
const storedState = (value) => value && typeof value === "object" ? value.state : value;
const safeList = (value) => {
  try { const parsed = JSON.parse(value || "[]"); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
};
const basename = (path) => String(path || "").split(/[\\/]/).filter(Boolean).at(-1) || path;
const ageDays = (value, today) => value
  ? Math.floor((new Date(`${today}T00:00:00Z`) - new Date(value)) / DAY)
  : Number.POSITIVE_INFINITY;
const maxDate = (...values) => values.filter(Boolean).sort().at(-1) || null;
const suspiciousPath = (path) => /(?:\/\.claude\/worktrees\/|\/\.worktrees\/|\/appdata\/local\/temp\/|\/windows\/system32$|\/program files\/windowsapps\/|\/users\/[^/]+$)/i
  .test(String(path || "").replaceAll("\\", "/"));

export function projectLifecycle(storage, projectPath) {
  const state = storedState(storage.getSetting(lifecycleKey(projectPath), null));
  return PROJECT_LIFECYCLES.includes(state) ? state : "unclassified";
}

export function setProjectLifecycle(storage, projectPath, state) {
  if (!PROJECT_LIFECYCLES.includes(state)) {
    throw new Error(`state must be one of: ${PROJECT_LIFECYCLES.join(", ")}`);
  }
  const path = normalizeProjectPath(projectPath);
  if (state === "active" && projectLifecycle(storage, path) !== "active") {
    const active = (storage.listSettingKeys?.(LIFECYCLE_PREFIX) || [])
      .filter((key) => storedState(storage.getSetting(key, null)) === "active").length;
    if (active >= 3) throw new Error("three projects are already active; park one before activating another");
  }
  storage.setSetting(lifecycleKey(path), { state, path });
  return { projectPath: path, state };
}

function lifecycleSuggestion({ activeGoals, openTasks, lastActivityAt, today }) {
  if (openTasks.length && openTasks.every(({ status }) => status === "blocked")) return "waiting";
  if (activeGoals || openTasks.some(({ status }) => status !== "blocked")) return "active";
  const age = ageDays(lastActivityAt, today);
  if (age <= 30) return "maintenance";
  if (age > 90 && Number.isFinite(age)) return "archived";
  return "unclassified";
}

function taskOrder(a, b) {
  return (STATUS[a.status] ?? 9) - (STATUS[b.status] ?? 9)
    || (PRIORITY[a.priority] ?? PRIORITY.normal) - (PRIORITY[b.priority] ?? PRIORITY.normal)
    || String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
}

function nextAction(row) {
  const task = [...row.openTasks].sort(taskOrder)[0];
  if (task) {
    return {
      kind: task.status === "blocked" ? "recheck" : "task",
      taskId: task.id,
      status: task.status,
      title: task.status === "blocked" ? `Recheck: ${task.title}` : task.title,
    };
  }
  if (!row.profile) return { kind: "profile", title: "Profile or archive this project" };
  if (!row.activeGoals) return { kind: "goal", title: "Choose one measurable outcome" };
  return { kind: "task", title: "Create one evidence-backed next task" };
}

function addAggregate(rows, projects, apply) {
  for (const source of rows) {
    const normalized = normalizeProjectPath(source.projectPath);
    const key = projectKey(normalized);
    const row = projects.get(key) || {
      key,
      projectPath: normalized,
      profile: null,
      fixes: 0,
      research: 0,
      decisions: 0,
      lastFixAt: null,
      lastResearchAt: null,
      lastDecisionAt: null,
      tasks: [],
      goals: [],
      runs: { total: 0, verified: 0, unverified: 0 },
      lastVerifiedOutcome: null,
    };
    apply(row, source);
    projects.set(key, row);
  }
}

export function buildPortfolioDoctor(storage, { today = new Date().toISOString().slice(0, 10) } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error("today must be YYYY-MM-DD");
  const db = storage.db;
  const projects = new Map();

  addAggregate(db.prepare(`
    SELECT project_path AS projectPath, name, mode, summary, updated_at AS updatedAt
    FROM project_profiles
  `).all(), projects, (row, source) => {
    row.profile = source;
    row.projectPath = normalizeProjectPath(source.projectPath);
  });
  addAggregate(db.prepare(`
    SELECT project_path AS projectPath, COUNT(*) AS count, MAX(created_at) AS lastAt
    FROM fix_entries GROUP BY project_path
  `).all(), projects, (row, source) => {
    row.fixes += source.count;
    row.lastFixAt = maxDate(row.lastFixAt, source.lastAt);
  });
  addAggregate(db.prepare(`
    SELECT project_path AS projectPath, COUNT(*) AS count, MAX(created_at) AS lastAt
    FROM research_entries GROUP BY project_path
  `).all(), projects, (row, source) => {
    row.research += source.count;
    row.lastResearchAt = maxDate(row.lastResearchAt, source.lastAt);
  });
  addAggregate(db.prepare(`
    SELECT project_path AS projectPath, COUNT(*) AS count, MAX(created_at) AS lastAt
    FROM decision_entries GROUP BY project_path
  `).all(), projects, (row, source) => {
    row.decisions += source.count;
    row.lastDecisionAt = maxDate(row.lastDecisionAt, source.lastAt);
  });
  addAggregate(db.prepare(`
    SELECT id, project_path AS projectPath, title, status, priority,
      verification_command AS verificationCommand, deliverable, recheck_at AS recheckAt,
      depends_on AS dependsOn, created_at AS createdAt, updated_at AS updatedAt
    FROM workflow_tasks
  `).all(), projects, (row, source) => {
    row.tasks.push({ ...source, dependsOn: safeList(source.dependsOn) });
  });
  addAggregate(db.prepare(`
    SELECT id, project_path AS projectPath, title, status, updated_at AS updatedAt
    FROM project_goals
  `).all(), projects, (row, source) => row.goals.push(source));
  addAggregate(db.prepare(`
    SELECT t.project_path AS projectPath, COUNT(*) AS total,
      SUM(CASE WHEN r.verification_exit = 0 THEN 1 ELSE 0 END) AS verified,
      SUM(CASE WHEN r.verification_exit IS NULL THEN 1 ELSE 0 END) AS unverified
    FROM runs r JOIN workflow_tasks t ON t.id = r.task_id
    GROUP BY t.project_path
  `).all(), projects, (row, source) => {
    row.runs.total += source.total;
    row.runs.verified += source.verified;
    row.runs.unverified += source.unverified;
  });
  addAggregate(db.prepare(`
    SELECT project_path AS projectPath, summary AS title, created_at AS at, 'fix' AS kind
    FROM fix_entries WHERE verification IS NOT NULL AND TRIM(verification) != ''
    UNION ALL
    SELECT project_path AS projectPath, title, completed_at AS at, 'task' AS kind
    FROM workflow_tasks
    WHERE status = 'done' AND evidence IS NOT NULL AND TRIM(evidence) != ''
  `).all(), projects, (row, source) => {
    if (!row.lastVerifiedOutcome || source.at > row.lastVerifiedOutcome.at) {
      row.lastVerifiedOutcome = { title: source.title, at: source.at, kind: source.kind };
    }
  });

  const rows = [...projects.values()].map((row) => {
    const state = projectLifecycle(storage, row.projectPath);
    const openTasks = row.tasks.filter(({ status }) => OPEN.has(status));
    const activeGoals = row.goals.filter(({ status }) => status === "active").length;
    const lastTaskAt = row.tasks.map(({ updatedAt }) => updatedAt).filter(Boolean).sort().at(-1) || null;
    const lastGoalAt = row.goals.map(({ updatedAt }) => updatedAt).filter(Boolean).sort().at(-1) || null;
    const lastActivityAt = maxDate(row.lastFixAt, row.lastResearchAt, row.lastDecisionAt, lastTaskAt, lastGoalAt);
    const contractTasks = openTasks.filter(({ verificationCommand, deliverable }) => verificationCommand?.trim() || deliverable?.trim()).length;
    const missingContracts = openTasks.length - contractTasks;
    const overdueRechecks = openTasks.filter(({ status, recheckAt }) => status === "blocked" && recheckAt && recheckAt < today).length;
    const dependencyEdges = openTasks.reduce((total, task) => total + task.dependsOn.length, 0);
    const sequencedTasks = openTasks.filter(({ title }) => /\b(step|phase|then|after|before|p\d+(?:\.\d+)?)\b/i.test(title)).length;
    const issues = [];
    const add = (code, severity, message, count = 1) => issues.push({ code, severity, message, count });

    // Archiving is the explicit way to retire historical noise. Keep the row and evidence
    // visible, but stop asking the operator to repair or advance it.
    if (state !== "archived") {
      if (!row.profile) add("missing-profile", "warning", "Project has durable work but no profile.");
      if (suspiciousPath(row.projectPath)) add("suspicious-path", "warning", "Path looks like a worktree, temp folder, app install, or home directory.");
      if (state === "unclassified") add("lifecycle-unset", "info", "Choose Active, Waiting, Maintenance, or Archived.");
      if (state === "active" && !activeGoals) add("missing-active-goal", "warning", "Active project has no active goal.");
      if (state === "active" && !openTasks.length) add("no-open-task", "warning", "Active project has no owned next task.");
      if (missingContracts) add("missing-evidence-contract", "warning", `${missingContracts} open task(s) have no verification command or deliverable.`, missingContracts);
      if (overdueRechecks) add("overdue-recheck", "blocker", `${overdueRechecks} blocked task recheck(s) are overdue.`, overdueRechecks);
      if (sequencedTasks >= 2 && dependencyEdges === 0) add("missing-dependencies", "warning", "Sequenced tasks have no dependency edges.");
      if (row.runs.unverified) add("unverified-runs", "warning", `${row.runs.unverified} run(s) recorded no verification result.`, row.runs.unverified);
      if (row.research >= 3 && ageDays(row.lastResearchAt, today) <= 14
        && (!row.lastDecisionAt || row.lastDecisionAt < row.lastResearchAt)
        && (!lastTaskAt || lastTaskAt < row.lastResearchAt)) {
        add("research-not-converted", "info", "Recent research has not produced a newer decision or task.");
      }
    }

    const enriched = {
      projectPath: row.projectPath,
      name: row.profile?.name || basename(row.projectPath),
      mode: row.profile?.mode || null,
      lifecycle: state,
      suggestedLifecycle: state === "unclassified"
        ? lifecycleSuggestion({ activeGoals, openTasks, lastActivityAt, today })
        : state,
      profile: Boolean(row.profile),
      records: { fixes: row.fixes, research: row.research, decisions: row.decisions },
      lastActivityAt,
      activeGoals,
      tasks: {
        total: row.tasks.length,
        open: openTasks.length,
        blocked: openTasks.filter(({ status }) => status === "blocked").length,
        evidenceContracts: contractTasks,
        dependencyEdges,
      },
      runs: row.runs,
      lastVerifiedOutcome: row.lastVerifiedOutcome,
      issues,
      openTasks,
    };
    enriched.nextAction = nextAction({ ...enriched, profile: row.profile });
    delete enriched.openTasks;
    return enriched;
  });

  const severity = { blocker: 0, warning: 1, info: 2 };
  rows.sort((a, b) => {
    const aSeverity = Math.min(...a.issues.map((item) => severity[item.severity] ?? 9), 9);
    const bSeverity = Math.min(...b.issues.map((item) => severity[item.severity] ?? 9), 9);
    return aSeverity - bSeverity
      || String(b.lastActivityAt || "").localeCompare(String(a.lastActivityAt || ""))
      || a.name.localeCompare(b.name);
  });

  const knownKeys = new Set(rows.map(({ projectPath }) => projectKey(projectPath)));
  const identityIssues = db.prepare(`
    SELECT project_path AS projectPath, COUNT(*) AS sessions, MAX(updated_at) AS lastAt
    FROM agent_sessions GROUP BY project_path
  `).all()
    .filter(({ projectPath }) => suspiciousPath(projectPath) || !knownKeys.has(projectKey(normalizeProjectPath(projectPath))))
    .map((item) => ({ ...item, suspicious: suspiciousPath(item.projectPath) }))
    .sort((a, b) => b.sessions - a.sessions);

  const countState = (state) => rows.filter(({ lifecycle }) => lifecycle === state).length;
  return {
    generatedAt: new Date().toISOString(),
    today,
    summary: {
      projects: rows.length,
      profiled: rows.filter(({ profile }) => profile).length,
      unprofiled: rows.filter(({ profile }) => !profile).length,
      active: countState("active"),
      waiting: countState("waiting"),
      maintenance: countState("maintenance"),
      archived: countState("archived"),
      unclassified: countState("unclassified"),
      attention: rows.filter(({ issues }) => issues.some(({ severity: level }) => level !== "info")).length,
      openTasks: rows.reduce((total, row) => total + row.tasks.open, 0),
      missingContracts: rows.reduce((total, row) => total + row.tasks.open - row.tasks.evidenceContracts, 0),
      overdueRechecks: rows.reduce((total, row) => total + row.issues.filter(({ code }) => code === "overdue-recheck").reduce((sum, issue) => sum + issue.count, 0), 0),
      runs: rows.reduce((total, row) => total + row.runs.total, 0),
      verifiedRuns: rows.reduce((total, row) => total + row.runs.verified, 0),
      identityIssues: identityIssues.length,
    },
    rows,
    identityIssues,
  };
}

export function formatPortfolioDoctor(report) {
  const { summary } = report;
  const lines = [
    `Portfolio Doctor - ${report.today}`,
    `${summary.projects} projects (${summary.profiled} profiled, ${summary.unclassified} unclassified)`,
    `${summary.attention} need attention | ${summary.openTasks} open tasks | ${summary.missingContracts} missing proof contracts | ${summary.overdueRechecks} overdue rechecks`,
    `${summary.verifiedRuns}/${summary.runs} runs verified`,
    "",
  ];
  for (const row of report.rows) {
    const flags = row.issues.filter(({ severity }) => severity !== "info").map(({ code }) => code).join(", ") || "clear";
    const suggested = row.lifecycle === "unclassified" && row.suggestedLifecycle !== "unclassified"
      ? ` -> ${row.suggestedLifecycle}` : "";
    lines.push(`[${row.lifecycle}${suggested}] ${row.name}`);
    lines.push(`  Next: ${row.nextAction.title}`);
    lines.push(`  Flags: ${flags}`);
  }
  return lines.join("\n");
}
