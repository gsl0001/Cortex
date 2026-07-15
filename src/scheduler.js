// Pure scheduling helpers — no DB, no side effects, unit-testable in isolation.

const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, medium: 2, low: 3 };
const hhmm = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; };

// now inside the configured run window? null window = always open. Windows may cross
// midnight (start > end). `days` (0=Sun..6=Sat) filters by local weekday when present.
export function withinWindow(now = new Date(), window = null) {
  if (!window) return true;
  const { start, end, days } = window;
  const cur = now.getHours() * 60 + now.getMinutes();
  const s = hhmm(start), e = hhmm(end);
  const open = s <= e ? (cur >= s && cur < e) : (cur >= s || cur < e); // crosses midnight
  if (!open) return false;
  if (!Array.isArray(days) || !days.length) return true;
  // The after-midnight tail of an overnight window belongs to the day it STARTED:
  // Fri 22:00-07:00 with days=[5] must still be open at Sat 02:00.
  const startedYesterday = s > e && cur < e;
  return days.includes((now.getDay() + (startedYesterday ? 6 : 0)) % 7);
}

export function notBeforeReached(task, now = new Date()) {
  return !task.notBefore || new Date(task.notBefore) <= now;
}

// Ordering across the eligible set: priority, then earliest not_before/scheduled_for,
// then FIFO by creation. Returns <0 if a should run before b.
export function compareTasks(a, b) {
  const pa = PRIORITY_RANK[a.priority] ?? 9, pb = PRIORITY_RANK[b.priority] ?? 9;
  if (pa !== pb) return pa - pb;
  const ta = a.notBefore || a.scheduledFor || "", tb = b.notBefore || b.scheduledFor || "";
  if (ta !== tb) return ta < tb ? -1 : 1;
  return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
}

// Round-robin across projects inside a priority band: prefer the project served least
// recently (never-served counts as oldest), so one project's backlog can't monopolize
// the run slots. `lastServed` maps projectPath -> monotonically increasing launch
// sequence. Priority still wins across projects; equal recency falls back to
// compareTasks (earliest time, then FIFO).
export function compareTasksFairly(a, b, lastServed = new Map()) {
  const pa = PRIORITY_RANK[a.priority] ?? 9, pb = PRIORITY_RANK[b.priority] ?? 9;
  if (pa !== pb) return pa - pb;
  const la = lastServed.get(a.projectPath) || 0, lb = lastServed.get(b.projectPath) || 0;
  if (la !== lb) return la - lb;
  return compareTasks(a, b);
}
