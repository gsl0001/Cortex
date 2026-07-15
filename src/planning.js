const DAY = 86_400_000;
const PRIORITY = { urgent: 0, high: 1, normal: 2, low: 3 };
const EXECUTABLE = new Set(["ready", "in_progress"]);

function date(value) {
  if (value instanceof Date) return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  return new Date(`${value}T00:00:00Z`);
}

function iso(value) {
  return value.toISOString().slice(0, 10);
}

function ageInDays(value, today) {
  return (date(today) - date(String(value).slice(0, 10))) / DAY;
}

function number(value) {
  return value ?? Number.POSITIVE_INFINITY;
}

function taskOrder(a, b) {
  return (PRIORITY[a.priority] ?? PRIORITY.normal) - (PRIORITY[b.priority] ?? PRIORITY.normal)
    || number(a.activeRank) - number(b.activeRank)
    || number(a.roadmapOrder) - number(b.roadmapOrder)
    || String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

function weeklyTaskOrder(a, b) {
  return (PRIORITY[a.priority] ?? PRIORITY.normal) - (PRIORITY[b.priority] ?? PRIORITY.normal)
    || String(a.milestoneDueDate ?? "9999-12-31").localeCompare(String(b.milestoneDueDate ?? "9999-12-31"))
    || number(a.roadmapOrder) - number(b.roadmapOrder)
    || number(a.activeRank) - number(b.activeRank)
    || String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

export function goalProgress(tasks) {
  const linked = tasks.filter(({ milestoneId }) => milestoneId);
  const done = linked.filter(({ status }) => status === "done").length;
  return { done, total: linked.length, percent: linked.length ? Math.round(done * 100 / linked.length) : 0 };
}

export function criterionVerified(criterion, tasksById) {
  const ids = criterion?.task_ids;
  if (!Array.isArray(ids) || ids.length === 0) return false;
  return ids.every((id) => {
    const task = tasksById instanceof Map ? tasksById.get(id) : tasksById?.[id];
    return task?.status === "done" && Boolean(task.evidence?.trim());
  });
}

export function deadlineHealth({ dueDate, weeklyCapacity, tasks, today }) {
  const incomplete = tasks.filter(({ status }) => status !== "done");
  if (incomplete.length === 0) return "on_track";
  const start = date(today);
  const due = date(dueDate);
  if (due < start) return "overdue";
  if (incomplete.some((task) => task.scheduledFor && date(task.scheduledFor) < start)) return "at_risk";

  const weekdaysByWeek = new Map();
  for (let day = start; day <= due; day = new Date(day.getTime() + DAY)) {
    const weekday = day.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const monday = new Date(day.getTime() - (weekday - 1) * DAY);
    const key = iso(monday);
    weekdaysByWeek.set(key, (weekdaysByWeek.get(key) ?? 0) + 1);
  }
  const capacity = [...weekdaysByWeek.values()].reduce(
    (total, weekdays) => total + Math.min(weeklyCapacity, Math.ceil(weeklyCapacity * weekdays / 5)),
    0,
  );
  return incomplete.length <= capacity ? "on_track" : "at_risk";
}

export function isProjectStalled({ tasks, today }) {
  const open = tasks.filter(({ status }) => status !== "done");
  if (open.length && open.every(({ status }) => status === "blocked")) return true;
  if (tasks.some((task) => task.status === "in_progress" && task.updatedAt && ageInDays(task.updatedAt, today) >= 3)) return true;
  const completed = tasks.filter(({ status }) => status === "done").map(({ completedAt }) => completedAt).filter(Boolean);
  const started = tasks.map(({ createdAt }) => createdAt).filter(Boolean);
  const lastProgress = completed.length
    ? completed.reduce((latest, value) => new Date(value) > new Date(latest) ? value : latest)
    : started.reduce((earliest, value) => !earliest || new Date(value) < new Date(earliest) ? value : earliest, null);
  return open.length > 0 && lastProgress ? ageInDays(lastProgress, today) >= 7 : false;
}

export function selectNextAction(tasks, milestoneDueDates = {}, today) {
  if (!today) throw new Error("today is required");
  const dueDate = (task) => milestoneDueDates instanceof Map
    ? milestoneDueDates.get(task.milestoneId)
    : milestoneDueDates[task.milestoneId];
  return tasks.filter(({ status }) => EXECUTABLE.has(status)).sort((a, b) => {
    const aOverdue = a.scheduledFor && a.scheduledFor < today ? 0 : 1;
    const bOverdue = b.scheduledFor && b.scheduledFor < today ? 0 : 1;
    return aOverdue - bOverdue
      || String(dueDate(a) ?? "9999-12-31").localeCompare(String(dueDate(b) ?? "9999-12-31"))
      || taskOrder(a, b);
  })[0] ?? null;
}

export function autoPlanWeek(tasks, { weekStart, totalCapacity = 10, projectCapacities = {} }) {
  const weekdays = Array.from({ length: 5 }, (_, offset) => iso(new Date(date(weekStart).getTime() + offset * DAY)));
  const used = new Map();
  const planned = [];
  for (const task of tasks.filter(({ status }) => EXECUTABLE.has(status)).sort(weeklyTaskOrder)) {
    const project = task.projectId ?? task.projectPath;
    const cap = projectCapacities instanceof Map ? projectCapacities.get(project) : projectCapacities[project];
    if (cap == null || (used.get(project) ?? 0) >= cap || planned.length >= totalCapacity) continue;
    used.set(project, (used.get(project) ?? 0) + 1);
    planned.push({ ...task, scheduledFor: weekdays[planned.length % weekdays.length] });
  }
  return planned;
}
