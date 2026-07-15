import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCortex } from "../src/index.js";
import { createDispatcher, isDispatchable } from "../src/dispatcher.js";
import { createAgentLauncher } from "../src/agentLauncher.js";
import { localToday } from "../src/storage.js";

function fakeLauncher() {
  const calls = [];
  let release;
  return {
    calls,
    releaseCurrent: () => release?.(),
    async launch({ taskId, agent }) {
      calls.push({ taskId, agent });
      const completed = new Promise((resolveDone) => { release = resolveDone; });
      return { completed };
    },
  };
}

async function withHub(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cortex-dispatch-"));
  const hub = createCortex({ dbPath: join(dir, "d.sqlite") });
  try { await fn(hub, dir); } finally { hub.close(); await rm(dir, { recursive: true, force: true }); }
}

function readyTask(hub, dir, { agent = "codex", scheduledFor } = {}) {
  const task = hub.addTask({ type: "chore", projectPath: dir, title: `t-${Math.random()}`, verificationCommand: "npm test" });
  hub.editTask({ id: task.id, status: "ready", ...(agent ? { assignedAgent: agent } : {}) });
  if (scheduledFor) hub.scheduleTask({ id: task.id, scheduledFor });
  return hub.storage.getTask(task.id);
}

// A launcher that immediately blocks the task with a [fail:CLASS]-tagged reason, exactly like
// the real launcher's finish path — lets us drive the dispatcher's reason-aware outcome handling.
function blockingLauncher(hub, reasonFor) {
  const calls = [];
  return {
    calls,
    async launch({ taskId, agent }) {
      calls.push({ taskId, agent });
      hub.claimTask({ id: taskId, agent });
      hub.blockTask({ id: taskId, agent, reason: reasonFor(taskId) });
      return { completed: Promise.resolve() };
    },
  };
}
// preflight always passes in unit tests — its own checks are covered in preflight.test.js
const okPreflight = { check: () => ({ ok: true, problems: [] }), reset() {} };

const settle = () => new Promise((r) => setImmediate(r)); // let completed.finally run
const afterBackoff = () => new Promise((r) => setTimeout(r, 25));

test("isDispatchable: ready + agent-assigned + due", () => {
  // isDispatchable now takes (task, now: Date, depsSatisfied); noon avoids any tz date-flip.
  const now = new Date("2026-07-04T12:00:00");
  const base = { status: "ready", assignedAgent: "codex", scheduledFor: null, verificationCommand: "npm test" };
  assert.equal(isDispatchable(base, now), true);
  // no verification command -> the post-run verifier has nothing to run -> not dispatchable
  assert.equal(isDispatchable({ ...base, verificationCommand: null }, now), false);
  assert.equal(isDispatchable({ ...base, status: "review" }, now), false);
  assert.equal(isDispatchable({ ...base, assignedAgent: null }, now), false);
  assert.equal(isDispatchable({ ...base, assignedAgent: "human" }, now), false);
  assert.equal(isDispatchable({ ...base, scheduledFor: "2026-07-05" }, now), false);
  assert.equal(isDispatchable({ ...base, scheduledFor: "2026-07-04" }, now), true);
  // an unmet dependency (depsSatisfied=false) gates an otherwise-dispatchable task
  assert.equal(isDispatchable(base, now, false), false);
  // not_before in the future gates it too
  assert.equal(isDispatchable({ ...base, notBefore: "2026-07-04T18:00:00" }, now), false);
});

test("skips enrolled projects whose directory no longer exists and reports them", () =>
  withHub(async (hub, dir) => {
    const launcher = fakeLauncher();
    const dispatcher = createDispatcher({ preflight: okPreflight, hub, launcher });
    hub.storage.setSetting("dispatcher.enabled", true);
    const gone = join(dir, "deleted-project"); // enrolled but never created on disk
    hub.storage.setSetting("dispatcher.projects", [gone, dir]);
    readyTask(hub, gone, { agent: "codex" }); // older, would win FIFO if not skipped
    const live = readyTask(hub, dir, { agent: "codex" });

    assert.equal(await dispatcher.tick(), live.id);
    assert.deepEqual(launcher.calls.map(({ taskId }) => taskId), [live.id]);
    assert.deepEqual(dispatcher.status().missingProjects, [gone]);
  }));

test("localToday is a local YYYY-MM-DD matching the local calendar date", () => {
  const d = new Date();
  const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  assert.match(localToday(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(localToday(), expected);
});

test("tick with no today arg defaults to the LOCAL date, not UTC", () =>
  withHub(async (hub, dir) => {
    const launcher = fakeLauncher();
    const dispatcher = createDispatcher({ preflight: okPreflight, hub, launcher });
    hub.storage.setSetting("dispatcher.enabled", true);
    hub.storage.setSetting("dispatcher.projects", [dir]);
    // scheduled for the local calendar date: dispatchable today only if the
    // dispatcher's default today is the LOCAL date (a UTC default could be tomorrow).
    const due = readyTask(hub, dir, { agent: "codex", scheduledFor: localToday() });
    assert.equal(await dispatcher.tick(), due.id);
  }));

test("tick is a no-op when disabled or project not enrolled", () =>
  withHub(async (hub, dir) => {
    const launcher = fakeLauncher();
    const dispatcher = createDispatcher({ preflight: okPreflight, hub, launcher });
    readyTask(hub, dir);
    assert.equal(await dispatcher.tick(), null); // dispatcher.enabled defaults off
    hub.storage.setSetting("dispatcher.enabled", true);
    assert.equal(await dispatcher.tick(), null); // no enrolled projects
    assert.equal(launcher.calls.length, 0);
  }));

test("tick launches the first due agent-assigned ready task with the task's agent", () =>
  withHub(async (hub, dir) => {
    const launcher = fakeLauncher();
    const dispatcher = createDispatcher({ preflight: okPreflight, hub, launcher });
    hub.storage.setSetting("dispatcher.enabled", true);
    hub.storage.setSetting("dispatcher.projects", [dir]);
    readyTask(hub, dir, { agent: null });                       // unassigned — skipped
    readyTask(hub, dir, { scheduledFor: "2999-01-01" });        // future — skipped
    const due = readyTask(hub, dir, { agent: "claude-code" });  // launches
    const launched = await dispatcher.tick();
    assert.equal(launched, due.id);
    assert.deepEqual(launcher.calls, [{ taskId: due.id, agent: "claude-code" }]);
  }));

test("maxConcurrent holds the slot until the run completes", () =>
  withHub(async (hub, dir) => {
    const launcher = fakeLauncher();
    const dispatcher = createDispatcher({ preflight: okPreflight, hub, launcher, maxConcurrent: 1 });
    hub.storage.setSetting("dispatcher.enabled", true);
    hub.storage.setSetting("dispatcher.projects", [dir]);
    readyTask(hub, dir);
    readyTask(hub, dir);
    assert.notEqual(await dispatcher.tick(), null);
    assert.equal(await dispatcher.tick(), null); // slot busy
    assert.equal(dispatcher.status().activeRuns, 1);
    launcher.releaseCurrent();
    await new Promise((r) => setImmediate(r)); // let the .finally run
    assert.equal(dispatcher.status().activeRuns, 0);
    assert.notEqual(await dispatcher.tick(), null); // second task picked up
    assert.equal(launcher.calls.length, 2);
  }));

test("Memory Guard blocks autopilot: no agent spawns and the task is left blocked with a reason", () =>
  withHub(async (hub, dir) => {
    // real launcher through the same chokepoint the dispatcher uses; spawn throws if reached
    const launcher = createAgentLauncher({ hub, spawnImpl: () => { throw new Error("must not spawn"); }, logRoot: join(dir, "logs") });
    const dispatcher = createDispatcher({ preflight: okPreflight, hub, launcher });
    hub.storage.setSetting("dispatcher.enabled", true);
    hub.storage.setSetting("dispatcher.projects", [dir]);
    const task = readyTask(hub, dir, { agent: "codex" });
    hub.editTask({ id: task.id, relatedFiles: ["src/server.js"] });
    // two prior fixes on the file that were later superseded → guard verdict is block
    const insert = (id, summary, supersedesId) => hub.storage.insertFix({ id, projectPath: dir, agent: "codex", summary, filesChanged: ["src/server.js"], supersedesId });
    insert("old-a", "attempt A"); insert("new-b", "replaces A", "old-a");
    insert("old-c", "attempt C"); insert("new-d", "replaces C", "old-c");
    await dispatcher.tick();
    await new Promise((r) => setImmediate(r));
    const blocked = hub.storage.getTask(task.id);
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.blockReason, /Memory Guard \[block\]/);
    assert.equal(dispatcher.status().activeRuns, 0); // slot freed
  }));

test("a throwing launcher frees the slot and does not kill the loop", () =>
  withHub(async (hub, dir) => {
    const boom = { calls: [], async launch() { throw new Error("spawn failed"); } };
    const dispatcher = createDispatcher({ preflight: okPreflight, hub, launcher: boom });
    hub.storage.setSetting("dispatcher.enabled", true);
    hub.storage.setSetting("dispatcher.projects", [dir]);
    readyTask(hub, dir);
    assert.equal(await dispatcher.tick(), null); // swallowed, no throw
    assert.equal(dispatcher.status().activeRuns, 0);
  }));

// The old blunt "pause after 5 consecutive failures" breaker was replaced by reason-aware
// handling — see the auth/transient/permanent tests above. (A blocked task doesn't re-run and
// transient retries are capped, so there's no all-night burn to break.)

test("dispatcher gates on window, deps, not_before, and orders by priority", async () => {
  const dir = mkdtempSync(join(tmpdir(), "disp-"));
  const hub = createCortex({ dbPath: join(dir, "h.sqlite") });
  hub.storage.setSetting("dispatcher.enabled", true);
  hub.storage.setSetting("dispatcher.projects", [dir]);
  const launched = [];
  const launcher = { launch: async ({ taskId }) => { launched.push(taskId); return { completed: Promise.resolve() }; } };
  const producer = hub.addTask({ projectPath: dir, title: "producer", type: "feature", status: "ready", assignedAgent: "claude-code" , verificationCommand: "npm test" });
  const consumer = hub.addTask({ projectPath: dir, title: "consumer", type: "feature", status: "ready", assignedAgent: "claude-code", dependsOn: [producer.id] , verificationCommand: "npm test" });
  const urgent = hub.addTask({ projectPath: dir, title: "urgent", type: "feature", status: "ready", assignedAgent: "claude-code", priority: "urgent" , verificationCommand: "npm test" });
  const d = createDispatcher({ preflight: okPreflight, hub, launcher, scheduler: { requireCleanWorkspace: false, enforceGuardBlock: false } });
  await d.tick(new Date("2026-07-09T23:00:00"));
  assert.equal(launched[0], urgent.id);   // urgent wins; consumer dep-gated, producer lower priority
  hub.close();
});

test("a dependent run branch-stacks on its producer's branch; independent runs use base", async () => {
  await withHub(async (hub, dir) => {
    hub.storage.setSetting("dispatcher.enabled", true);
    hub.storage.setSetting("dispatcher.projects", [dir]);
    const seen = [];
    const launcher = { launch: async ({ taskId, baseRef }) => { seen.push({ taskId, baseRef }); return { completed: Promise.resolve() }; } };
    const d = createDispatcher({ preflight: okPreflight, hub, launcher });
    // producer finished (review, unmerged) → consumer should branch from autopilot/<producer>
    const producer = hub.addTask({ projectPath: dir, title: "producer", type: "feature", status: "ready", assignedAgent: "claude-code" , verificationCommand: "npm test" });
    hub.editTask({ id: producer.id, status: "review" });
    const consumer = hub.addTask({ projectPath: dir, title: "consumer", type: "feature", status: "ready", assignedAgent: "claude-code", dependsOn: [producer.id] , verificationCommand: "npm test" });
    await d.tick(new Date());
    assert.equal(seen[0].taskId, consumer.id);
    assert.equal(seen[0].baseRef, `autopilot/${producer.id}`);
  });
});

test("an independent ready task dispatches with no explicit baseRef (base branch)", async () => {
  await withHub(async (hub, dir) => {
    hub.storage.setSetting("dispatcher.enabled", true);
    hub.storage.setSetting("dispatcher.projects", [dir]);
    const seen = [];
    const launcher = { launch: async ({ taskId, baseRef }) => { seen.push({ taskId, baseRef }); return { completed: Promise.resolve() }; } };
    const d = createDispatcher({ preflight: okPreflight, hub, launcher });
    const t = hub.addTask({ projectPath: dir, title: "solo", type: "feature", status: "ready", assignedAgent: "claude-code" , verificationCommand: "npm test" });
    await d.tick(new Date());
    assert.equal(seen[0].baseRef, undefined); // launcher falls back to the project default
  });
});

test("slot manager fills up to maxConcurrent, capped per project", async () => {
  await withHub(async (hub, dir) => {
    // two enrolled projects (reuse dir as A; make a second dir B)
    const dirB = mkdtempSync(join(tmpdir(), "disp-b-"));
    hub.storage.setSetting("dispatcher.enabled", true);
    hub.storage.setSetting("dispatcher.projects", [dir, dirB]);
    const launched = [];
    let release;
    const pending = new Promise((r) => { release = r; }); // never resolves during the tick
    const launcher = { launch: async ({ taskId }) => { launched.push(taskId); return { completed: pending }; } };
    const d = createDispatcher({ preflight: okPreflight, hub, launcher, maxConcurrent: 3, maxPerProject: 1 });
    const a1 = hub.addTask({ projectPath: dir, title: "a1", type: "feature", status: "ready", assignedAgent: "claude-code", priority: "high" , verificationCommand: "npm test" });
    const a2 = hub.addTask({ projectPath: dir, title: "a2", type: "feature", status: "ready", assignedAgent: "claude-code" , verificationCommand: "npm test" });
    const b1 = hub.addTask({ projectPath: dirB, title: "b1", type: "feature", status: "ready", assignedAgent: "claude-code" , verificationCommand: "npm test" });
    await d.tick(new Date());
    // A is capped at 1 (a1, the higher priority), B gets b1; a2 is NOT launched this tick
    assert.deepEqual(launched.sort(), [a1.id, b1.id].sort());
    assert.equal(d.status().activeRuns, 2);
    assert.equal(d.status().maxPerProject, 1);
    release();
    rmSync(dirB, { recursive: true, force: true });
  });
});

test("round-robin across projects: one project's backlog can't starve the other", () =>
  withHub(async (hub, dir) => {
    const dirB = mkdtempSync(join(tmpdir(), "disp-fair-"));
    try {
      const launcher = fakeLauncher();
      const dispatcher = createDispatcher({ preflight: okPreflight, hub, launcher });
      hub.storage.setSetting("dispatcher.enabled", true);
      hub.storage.setSetting("dispatcher.projects", [dir, dirB]);
      // explicit created_at: same-millisecond inserts would tie the FIFO comparator and
      // leave the order to SQLite's unspecified row order (flaky)
      const at = (task, iso) => {
        hub.storage.db.prepare("UPDATE workflow_tasks SET created_at = ? WHERE id = ?").run(iso, task.id);
        return hub.storage.getTask(task.id);
      };
      const a1 = at(readyTask(hub, dir, { agent: "codex" }), "2026-07-09T00:00:01.000Z");  // oldest
      const a2 = at(readyTask(hub, dir, { agent: "codex" }), "2026-07-09T00:00:02.000Z");  // still older than b1
      const b1 = at(readyTask(hub, dirB, { agent: "codex" }), "2026-07-09T00:00:03.000Z");

      // fakeLauncher never claims, so retire each launched task the way a real run would
      const finishRun = async (id) => {
        launcher.releaseCurrent();
        await new Promise((r) => setImmediate(r));
        hub.editTask({ id, status: "done" });
      };

      assert.equal(await dispatcher.tick(), a1.id); // FIFO seeds project A
      await finishRun(a1.id);
      // A was just served — B goes next even though a2 was created earlier than b1
      assert.equal(await dispatcher.tick(), b1.id);
      await finishRun(b1.id);
      assert.equal(await dispatcher.tick(), a2.id);
    } finally {
      rmSync(dirB, { recursive: true, force: true });
    }
  }));

test("dispatcher launches nothing outside the window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "disp2-"));
  const hub = createCortex({ dbPath: join(dir, "h.sqlite") });
  hub.storage.setSetting("dispatcher.enabled", true);
  hub.storage.setSetting("dispatcher.projects", [dir]);
  hub.storage.setSetting("dispatcher.window", { start: "22:00", end: "07:00", days: [0,1,2,3,4,5,6] });
  hub.addTask({ projectPath: dir, title: "t", type: "feature", status: "ready", assignedAgent: "claude-code" , verificationCommand: "npm test" });
  const launcher = { launch: async () => { throw new Error("must not launch"); } };
  const d = createDispatcher({ preflight: okPreflight, hub, launcher, scheduler: { requireCleanWorkspace: false, enforceGuardBlock: false } });
  assert.equal(await d.tick(new Date("2026-07-09T12:00:00")), null); // midday: window closed
  hub.close();
});

test("auth-expiry failure pauses dispatch and leaves a /login inbox note", () =>
  withHub(async (hub, dir) => {
    const launcher = blockingLauncher(hub, () => "[fail:auth] CLI needs /login — authentication expired. Agent exited with code 1: API Error: 401");
    const dispatcher = createDispatcher({ preflight: okPreflight, hub, launcher });
    hub.storage.setSetting("dispatcher.enabled", true);
    hub.storage.setSetting("dispatcher.projects", [dir]);
    readyTask(hub, dir);
    await dispatcher.tick(); await settle();
    assert.equal(hub.storage.getSetting("dispatcher.enabled", false), false); // paused immediately
    const inbox = hub.listInbox({ projectPath: dir });
    assert.equal(inbox.some((i) => i.author === "dispatcher" && /\/login/i.test(i.message)), true);
  }));

test("transient failure re-readies the task after a backoff, then gives up at the cap", () =>
  withHub(async (hub, dir) => {
    const launcher = blockingLauncher(hub, () => "[fail:transient] Agent exited with code 1: 429 rate limit");
    const dispatcher = createDispatcher({ preflight: okPreflight, hub, launcher, maxRetries: 2, retryBaseMs: 5, retryMaxMs: 5 });
    hub.storage.setSetting("dispatcher.enabled", true);
    hub.storage.setSetting("dispatcher.projects", [dir]);
    const task = readyTask(hub, dir);
    await dispatcher.tick(); await settle();
    assert.equal(hub.storage.getTask(task.id).status, "blocked"); // before backoff
    await afterBackoff();
    assert.equal(hub.storage.getTask(task.id).status, "ready");   // retried (attempt 1)
    await dispatcher.tick(); await settle(); await afterBackoff();
    assert.equal(hub.storage.getTask(task.id).status, "ready");   // retried (attempt 2)
    await dispatcher.tick(); await settle(); await afterBackoff();
    assert.equal(hub.storage.getTask(task.id).status, "blocked"); // exceeded maxRetries(2) -> left blocked
    assert.equal(hub.storage.getSetting("dispatcher.enabled", false), true); // never paused
    assert.equal(hub.listInbox({ projectPath: dir }).some((i) => /transient retries/i.test(i.message)), true);
  }));

test("permanent failure leaves the task blocked without pausing or retrying", () =>
  withHub(async (hub, dir) => {
    const launcher = blockingLauncher(hub, () => "[fail:permanent] Agent exited with code 1: 2 tests failed");
    const dispatcher = createDispatcher({ preflight: okPreflight, hub, launcher, retryBaseMs: 5, retryMaxMs: 5 });
    hub.storage.setSetting("dispatcher.enabled", true);
    hub.storage.setSetting("dispatcher.projects", [dir]);
    const task = readyTask(hub, dir);
    await dispatcher.tick(); await settle(); await afterBackoff();
    assert.equal(hub.storage.getTask(task.id).status, "blocked");            // no retry
    assert.equal(hub.storage.getSetting("dispatcher.enabled", false), true); // no pause
  }));

test("stop() cancels pending retry backoffs so nothing fires after shutdown", () =>
  withHub(async (hub, dir) => {
    const launcher = blockingLauncher(hub, () => "[fail:transient] Agent exited with code 1: 429 rate limit");
    const dispatcher = createDispatcher({ preflight: okPreflight, hub, launcher, retryBaseMs: 5, retryMaxMs: 5 });
    hub.storage.setSetting("dispatcher.enabled", true);
    hub.storage.setSetting("dispatcher.projects", [dir]);
    const task = readyTask(hub, dir);
    await dispatcher.tick(); await settle();
    dispatcher.stop(); // retry backoff is pending — a stopped dispatcher must not re-ready the task later
    await afterBackoff();
    assert.equal(hub.storage.getTask(task.id).status, "blocked");
  }));

test("start() re-enters the retry path for transient-blocked tasks stranded by a restart", () =>
  withHub(async (hub, dir) => {
    // Retry state is per-process: a task blocked [fail:transient] whose backoff timer died
    // with the old process must get a fresh retry when the dispatcher comes back up.
    const task = readyTask(hub, dir);
    hub.claimTask({ id: task.id, agent: "codex" });
    hub.blockTask({ id: task.id, agent: "codex", reason: "[fail:transient] Agent exited with code 1: 429 rate limit" });
    const permanent = readyTask(hub, dir);
    hub.claimTask({ id: permanent.id, agent: "codex" });
    hub.blockTask({ id: permanent.id, agent: "codex", reason: "[fail:permanent] 2 tests failed" });
    hub.storage.setSetting("dispatcher.enabled", true);
    hub.storage.setSetting("dispatcher.projects", [dir]);
    const dispatcher = createDispatcher({ preflight: okPreflight, hub, launcher: fakeLauncher(), retryBaseMs: 5, retryMaxMs: 5 });
    dispatcher.start();
    await afterBackoff();
    dispatcher.stop();
    assert.equal(hub.storage.getTask(task.id).status, "ready");          // recovered
    assert.equal(hub.storage.getTask(permanent.id).status, "blocked");   // permanent stays put
  }));

test("parallel auth failures pause once and leave a single inbox note", () =>
  withHub(async (hub, dir) => {
    const launcher = blockingLauncher(hub, () => "[fail:auth] Agent exited with code 1: API Error: 401");
    const dispatcher = createDispatcher({ preflight: okPreflight, hub, launcher, maxConcurrent: 2, maxPerProject: 2 });
    hub.storage.setSetting("dispatcher.enabled", true);
    hub.storage.setSetting("dispatcher.projects", [dir]);
    readyTask(hub, dir); readyTask(hub, dir);
    await dispatcher.tick(); await settle();
    assert.equal(hub.storage.getSetting("dispatcher.enabled", false), false); // paused
    const notes = hub.listInbox({ projectPath: dir }).filter((i) => i.author === "dispatcher" && /\/login/i.test(i.message));
    assert.equal(notes.length, 1); // both runs failed auth, but only the first one noted
  }));
