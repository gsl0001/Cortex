// In-server autopilot: launches headless agents on ready, due, agent-assigned
// tasks in enrolled projects. All downstream behavior (claiming, run tracking,
// review/blocked transitions) is agentLauncher's, untouched.
import { existsSync } from "node:fs";
import { localToday } from "./storage.js";
import { withinWindow, notBeforeReached, compareTasksFairly } from "./scheduler.js";
import { runBranch } from "./worktree.js";
import { createPreflight } from "./preflight.js";

const AGENTS = new Set(["codex", "claude-code"]);

// The class tag agentLauncher stamps onto a failed run's block reason. Keep the
// vocabulary in sync with agentLauncher's finish path (auth/transient/permanent/stopped).
const FAIL_TAG = /\[fail:(auth|transient|permanent|stopped)]/;
const failureClass = (task) => FAIL_TAG.exec(task?.blockReason || "")?.[1] || "permanent";

// Pure eligibility: ready, agent-owned, due (scheduled date reached), earliest-start
// reached, dependencies satisfied — and machine-checkable: a task with no verification
// command gives the post-run verifier nothing to run, so trust would rest entirely on the
// agent's own claims. Un-verifiable tasks stay ready for humans; autopilot skips them.
// `now` is a Date; `depsSatisfied` is precomputed (hub.dependencyState) so this stays pure.
export function isDispatchable(task, now = new Date(), depsSatisfied = true) {
  return task.status === "ready"
    && AGENTS.has(task.assignedAgent)
    && Boolean(task.verificationCommand)
    && (!task.scheduledFor || task.scheduledFor <= localToday(now))
    && notBeforeReached(task, now)
    && depsSatisfied;
}

export function createDispatcher({ hub, launcher, intervalMs = 15_000, maxConcurrent = 1, maxPerProject = 1,
    maxRetries = 3, retryBaseMs = 30_000, retryMaxMs = 10 * 60_000, preflight = createPreflight() } = {}) {
  let timer = null;
  let inFlight = 0;                         // global count of live runs (all projects)
  let lastPreflight = null;                 // last preflight verdict, surfaced in status()
  const notedProblems = new Set();          // preflight problems already noted to the inbox
  const inFlightByProject = new Map();      // projectPath -> live-run count, for the per-project cap
  let lastTickAt = null;
  let launchSeq = 0;                        // monotonic counter backing round-robin fairness
  const lastServed = new Map();             // projectPath -> launchSeq of its latest launch
  const retries = new Map(); // taskId -> transient retry attempts so far (cleared on success/permanent)
  const retryTimers = new Set(); // pending backoff timers, cleared on stop() so none fires after shutdown

  const incProject = (p) => inFlightByProject.set(p, (inFlightByProject.get(p) || 0) + 1);
  const decProject = (p) => {
    const n = (inFlightByProject.get(p) || 0) - 1;
    if (n > 0) inFlightByProject.set(p, n); else inFlightByProject.delete(p);
  };

  const enabled = () => hub.storage.getSetting("dispatcher.enabled", false);
  const projects = () => hub.storage.getSetting("dispatcher.projects", []);
  const window = () => hub.storage.getSetting("dispatcher.window", null);
  // Enrolled paths that no longer exist on disk (deleted worktree, moved repo): never
  // dispatch into them — the run would only fail at the git stage — and surface them
  // in status so Needs-You/the dashboard can show the stale enrollment.
  const missingProjects = () => projects().filter((p) => !existsSync(p));

  function note(projectPath, message) {
    try { hub.addInboxItem({ projectPath, author: "dispatcher", message }); }
    catch { /* best-effort: the state change is what matters, the note is a courtesy */ }
  }

  // Reason-aware failure handling (replaces the old blunt consecutive-failure breaker):
  //   auth      -> pause dispatch; only an interactive /login recovers, so retrying burns runs
  //   transient -> re-ready the task after a capped exponential backoff, up to maxRetries
  //   permanent -> leave it blocked, as today
  // Reads the resting task the launcher already wrote (its [fail:CLASS] tag); nothing here spawns.
  function handleOutcome(task) {
    const cur = hub.storage.getTask(task.id);
    if (cur?.status !== "blocked") { retries.delete(task.id); return; } // success/review — nothing to do
    const cls = failureClass(cur);
    if (cls === "auth") {
      // Parallel runs can all fail auth at once — only the first pauses and notes; the rest
      // land while dispatch is already disabled and would just duplicate the inbox note.
      if (enabled()) {
        hub.storage.setSetting("dispatcher.enabled", false);
        note(cur.projectPath, "Autopilot paused: the CLI needs /login (auth expired). Run /login, then re-enable.");
      }
      return;
    }
    if (cls === "transient") { scheduleRetry(cur); return; }
    retries.delete(task.id); // permanent / user-stopped: block as today, no retry
  }

  // Backoff lives in a timer, not the DB: sub-minute precision the date-granular schedule
  // fields can't express. Re-ready only if the task is still blocked (a human may have moved it).
  function scheduleRetry(task) {
    const attempts = (retries.get(task.id) || 0) + 1;
    if (attempts > maxRetries) {
      retries.delete(task.id);
      note(task.projectPath, `Task "${task.title}" still failing after ${maxRetries} transient retries; left blocked.`);
      return;
    }
    retries.set(task.id, attempts);
    const delay = Math.min(retryBaseMs * 2 ** (attempts - 1), retryMaxMs);
    const t = setTimeout(() => {
      retryTimers.delete(t);
      if (hub.storage.getTask(task.id)?.status === "blocked") hub.editTask({ id: task.id, status: "ready" });
    }, delay);
    retryTimers.add(t);
    t.unref?.(); // never keep the process alive just to hold a retry timer
  }

  // A consumer whose producer is finished-but-unmerged (review) must build ON that producer's
  // branch so it sees the unmerged work; a producer that's `done` is already merged into base,
  // and independent tasks use base. Returns the branch to stack on, or undefined for base.
  // If multiple deps are simultaneously in review, the first one wins — chains are effectively
  // linear in practice, so this doesn't try to stack on more than one producer branch at once.
  function baseRefFor(task) {
    for (const id of task.dependsOn || []) {
      const producer = hub.storage.getTask(id);
      if (producer && producer.status === "review") return runBranch(id);
    }
    return undefined;
  }

  // Next task to launch, in compareTasks priority order, skipping (a) anything already
  // attempted this tick and (b) any project already at its maxPerProject cap. `attempted`
  // guards against re-picking a task whose launch just threw (a thrown launch leaves the
  // task still "ready", so the per-project count alone wouldn't exclude it once decremented).
  // Safety enforcement (Memory Guard) is the launcher's job — it refuses and blocks a
  // guard-flagged task at the spawn chokepoint — so the dispatcher stays pure selection.
  function pickTask(now, attempted) {
    const eligible = [];
    for (const projectPath of projects()) {
      if (!existsSync(projectPath)) continue;
      for (const task of hub.listTasks({ projectPath, statuses: ["ready"] })) {
        if (isDispatchable(task, now, hub.dependencyState(task).satisfied)) eligible.push(task);
      }
    }
    eligible.sort((a, b) => compareTasksFairly(a, b, lastServed));
    return eligible.find((t) =>
      !attempted.has(t.id) && (inFlightByProject.get(t.projectPath) || 0) < maxPerProject
    ) ?? null;
  }

  // One tick fills every open slot: up to maxConcurrent globally, never more than
  // maxPerProject live runs in one project, choosing in compareTasks priority order.
  // Returns the FIRST launched id (or null) to preserve the single-launch return contract.
  async function tick(now = new Date()) {
    lastTickAt = new Date().toISOString();
    if (!enabled() || !withinWindow(now, window())) return null; // off, or outside the run window
    const attempted = new Set();
    const launched = [];
    while (enabled() && withinWindow(now, window()) && inFlight < maxConcurrent) {
      const task = pickTask(now, attempted);
      if (!task) break; // nothing eligible under the caps this tick
      // Pre-flight before spending a run: auth expiry and worktree viability were 100% of the
      // live failure volume, and both are knowable without spawning. Results are cached
      // (createPreflight TTL) so this is one file read + one probe per project per TTL.
      const pf = preflight.check({ projects: [task.projectPath], agentsNeeded: new Set([task.assignedAgent]) });
      lastPreflight = { ok: pf.ok, problems: pf.problems, at: new Date().toISOString() };
      if (!pf.ok) {
        for (const problem of pf.problems) {
          if (!notedProblems.has(problem)) {
            notedProblems.add(problem);
            note(task.projectPath, `Autopilot held by pre-flight: ${problem}`);
          }
        }
        // Auth affects every claude-code launch — stop the tick. A project-specific worktree
        // problem only skips that task; other projects still get their turn.
        if (pf.problems.some((p) => /OAuth|\/login/i.test(p))) break;
        attempted.add(task.id);
        continue;
      }
      // No blanket clear on success: with one broken project and one healthy one, clearing
      // here would re-note the broken project's problem every 15s tick (inbox flood). Problem
      // strings self-refresh when their cause changes (auth reasons embed the expiry time),
      // and preflight.reset()/restart clears the slate.
      attempted.add(task.id);
      const p = task.projectPath;
      lastServed.set(p, ++launchSeq); // even a failed launch counts as this project's turn
      inFlight += 1;
      incProject(p);
      try {
        const { completed } = await launcher.launch({ taskId: task.id, agent: task.assignedAgent, baseRef: baseRefFor(task) });
        completed.finally(() => {
          inFlight -= 1;
          decProject(p);
          handleOutcome(task); // launcher owns the outcome; we react to the resting status/class
        }).catch(() => { /* slot already freed */ });
        launched.push(task.id);
      } catch {
        // launch failures already block the task inside the launcher; a claim race just means
        // someone else got it — free the slot and move on to the next candidate rather than
        // aborting the whole tick. (`attempted` keeps us from re-picking this still-"ready" task.)
        inFlight -= 1;
        decProject(p);
        handleOutcome(task);
      }
    }
    return launched[0] ?? null;
  }

  return {
    tick,
    status: () => ({
      enabled: enabled(), projects: projects(), missingProjects: missingProjects(),
      activeRuns: inFlight, lastTickAt, intervalMs, maxConcurrent, maxPerProject,
      window: window(), windowOpen: withinWindow(new Date(), window()),
      preflight: lastPreflight,
    }),
    start() {
      if (timer) return;
      // Restart recovery: retry state lives in this process (the `retries` map and its
      // timers), so a transient-blocked task whose backoff died with the old process would
      // otherwise be stranded blocked forever. Re-enter the retry path once for each.
      if (enabled()) {
        try {
          for (const projectPath of projects()) {
            for (const task of hub.listTasks({ projectPath, statuses: ["blocked"] })) {
              if (failureClass(task) === "transient") scheduleRetry(task);
            }
          }
        } catch { /* recovery is best-effort; polling still starts */ }
      }
      timer = setInterval(() => { tick().catch(() => { /* tick must never throw */ }); }, intervalMs);
      timer.unref?.(); // never keep the process alive just to poll
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      // A retry timer firing after stop() would mutate task state (or throw against a
      // closed DB) from a dispatcher the caller has already shut down.
      for (const t of retryTimers) clearTimeout(t);
      retryTimers.clear();
    },
  };
}
