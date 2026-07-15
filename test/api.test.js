import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createCortex } from "../src/index.js";
import { createCortexServer } from "../src/server.js";
import { NEVER_AUTOPILOT, autopilotKey } from "../src/agentLauncher.js";
import { normalizeProjectPath } from "../src/storage.js";
import { createAgentLauncher } from "../src/agentLauncher.js";

// A killable stand-in for a spawned CLI: kill() emits close(143), like a real signal.
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => child.emit("close", 143);
  return child;
}

// Stub git so the launcher's per-run worktree lifecycle stays off real git in these API tests.
const fakeGit = (_cmd, args) => (args[2] === "rev-parse" ? "main\n" : "");

// hermetic: a developer machine may have CORTEX_TOKEN set globally (real hub auth);
// these tests assume no token unless a test sets one itself.
delete process.env.CORTEX_TOKEN;

test("serves health, search, projects, tasks, links, and audit on loopback", async () => {
  process.env.CORTEX_TOKEN = "api-secret"; // writes are default-deny without a configured token
  const dir = await mkdtemp(join(tmpdir(), "cortex-api-"));
  const hub = createCortex({ dbPath: join(dir, "api.sqlite") });
  const staticDir = join(dir, "dist");
  await mkdir(staticDir);
  await writeFile(join(staticDir, "index.html"), "<main>Memory Hub UI</main>");
  hub.upsertProjectProfile({ projectPath: dir, name: "Repo", mode: "general", summary: "Test" });
  hub.captureCandidate({ projectPath: dir, agent: "codex", message: "Fixed close reconciliation. Verification: npm test passed." });
  const server = createCortexServer({ hub, staticDir });
  try {
    const address = await server.start();
    assert.equal(address.host, "127.0.0.1");
    assert.match(await (await fetch(`http://${address.host}:${address.port}/`)).text(), /Memory Hub UI/);
    const base = `http://${address.host}:${address.port}/api/v1`;
    assert.equal((await (await fetch(`${base}/health`)).json()).ok, true);
    const search = await (await fetch(`${base}/search?project=${encodeURIComponent(dir)}&query=close`)).json();
    assert.equal(search.results.length, 1);
    assert.equal(Array.isArray(await (await fetch(`${base}/projects`)).json()), true);
    assert.equal(Array.isArray(await (await fetch(`${base}/tasks?project=${encodeURIComponent(dir)}`)).json()), true);
    const links = await (await fetch(`${base}/links`)).json();
    assert.equal(Array.isArray(links), true);
    assert.equal(typeof links[0].fromLabel, "string");
    assert.equal(typeof links[0].toLabel, "string");
    const entities = await (await fetch(`${base}/entities`)).json();
    const authed = { "content-type": "application/json", authorization: "Bearer api-secret" };
    const createdLinkResponse = await fetch(`${base}/links`, {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ agent: "codex", fromEntityId: entities[0].id, toEntityId: entities[1].id, linkType: "related_to" }),
    });
    assert.equal(createdLinkResponse.status, 201);
    assert.equal((await createdLinkResponse.json()).source, "manual");
    const malformed = await fetch(`${base}/links`, { method: "POST", headers: authed, body: "{" });
    assert.equal(malformed.status, 400);
    assert.equal((await (await fetch(`${base}/audit`)).json()).summary.totalIssues >= 0, true);
  } finally {
    await server.stop();
    hub.close();
    await rm(dir, { recursive: true, force: true });
    delete process.env.CORTEX_TOKEN;
  }
});

test("tasks read model carries the resolved model and runs persist it from launch", async () => {
  process.env.CORTEX_TOKEN = "api-secret";
  const dir = await mkdtemp(join(tmpdir(), "cortex-api-model-"));
  const hub = createCortex({ dbPath: join(dir, "model.sqlite") });
  hub.upsertProjectProfile({ projectPath: dir, name: "Repo", mode: "general", summary: "Test" });
  const task = hub.addTask({ type: "feature", projectPath: dir, title: "route me", assignedAgent: "claude-code", status: "ready" });
  const server = createCortexServer({ hub });
  try {
    const address = await server.start();
    const base = `http://${address.host}:${address.port}/api/v1`;
    const authed = { "content-type": "application/json", authorization: "Bearer api-secret" };

    // default routing: feature + claude-code → opus, straight from the read model
    let tasks = await (await fetch(`${base}/tasks?project=${encodeURIComponent(dir)}`)).json();
    assert.equal(tasks.find((t) => t.id === task.id).model, "opus");

    // POST /settings accepts modelRouting and the read model follows it
    const set = await fetch(`${base}/settings`, {
      method: "POST", headers: authed,
      body: JSON.stringify({ agent: "human", key: "modelRouting", value: { "claude-code": { feature: "haiku" } } }),
    });
    assert.equal(set.status, 200);
    tasks = await (await fetch(`${base}/tasks?project=${encodeURIComponent(dir)}`)).json();
    assert.equal(tasks.find((t) => t.id === task.id).model, "haiku");
    const settings = await (await fetch(`${base}/settings`)).json();
    assert.deepEqual(settings.modelRouting, { "claude-code": { feature: "haiku" } });

    // a run row carries the intended model from the start, before any result event lands
    const run = hub.startRun({ taskId: task.id, agent: "claude-code", model: "haiku" });
    assert.equal(hub.storage.getRun(run.id).model, "haiku");
  } finally {
    await server.stop();
    hub.close();
    await rm(dir, { recursive: true, force: true });
    delete process.env.CORTEX_TOKEN;
  }
});

test("GET /runs/:id/log tails the run log and is safe when the log is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-api-runlog-"));
  const hub = createCortex({ dbPath: join(dir, "log.sqlite") });
  hub.upsertProjectProfile({ projectPath: dir, name: "Repo", mode: "general", summary: "" });
  const task = hub.addTask({ type: "chore", projectPath: dir, title: "logged", status: "ready" });
  const run = hub.startRun({ taskId: task.id, agent: "claude-code" });
  const logPath = join(dir, "run.jsonl");
  await writeFile(logPath, Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n"));
  hub.updateRunProgress({ id: run.id, logPath });
  const bare = hub.startRun({ taskId: task.id, agent: "claude-code" }); // never got a logPath
  const server = createCortexServer({ hub });
  try {
    const address = await server.start();
    const base = `http://${address.host}:${address.port}/api/v1`;

    const tail = await (await fetch(`${base}/runs/${run.id}/log?lines=5`)).json();
    assert.equal(tail.missing, false);
    assert.deepEqual(tail.lines, ["line 8", "line 9", "line 10", "line 11", "line 12"]);

    const full = await (await fetch(`${base}/runs/${run.id}/log`)).json();
    assert.equal(full.lines.length, 12); // default window comfortably covers the whole file

    const missing = await (await fetch(`${base}/runs/${bare.id}/log`)).json();
    assert.equal(missing.missing, true);
    assert.deepEqual(missing.lines, []);

    assert.equal((await fetch(`${base}/runs/does-not-exist/log`)).status, 404);
  } finally {
    await server.stop();
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("serves project stats", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-api-stats-"));
  const hub = createCortex({ dbPath: join(dir, "stats.sqlite") });
  const staticDir = join(dir, "dist");
  await mkdir(staticDir);
  await writeFile(join(staticDir, "index.html"), "<main>Memory Hub UI</main>");
  hub.storage.recordMetric("recall_injected", dir, { usedTokens: 50, maxTokens: 1200, dropped: 0 });
  const server = createCortexServer({ hub, staticDir });
  try {
    const address = await server.start();
    const body = await (await fetch(`http://${address.host}:${address.port}/api/v1/stats?project=${encodeURIComponent(dir)}`)).json();
    assert.equal(body.recallCount, 1);
    assert.equal(body.avgTokens, 50);
  } finally {
    await server.stop();
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects remote binding unless explicitly enabled", () => {
  assert.throws(() => createCortexServer({ hub: {}, host: "0.0.0.0" }), /loopback/);
});

test("server construction sweeps orphaned worktrees without throwing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-api-sweep-"));
  const hub = createCortex({ dbPath: join(dir, "sweep.sqlite") });
  const staticDir = join(dir, "dist");
  await mkdir(staticDir);
  await writeFile(join(staticDir, "index.html"), "<main>UI</main>");
  try {
    // default (no enrolled projects): the sweep loop has nothing to iterate.
    assert.doesNotThrow(() => createCortexServer({ hub, staticDir }));
    // an enrolled project that isn't a git repo -> `git worktree list` fails; the sweep
    // must swallow that (best-effort cleanup) rather than block server construction.
    hub.storage.setSetting("dispatcher.projects", [dir]);
    assert.doesNotThrow(() => createCortexServer({ hub, staticDir }));
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("dispatcher endpoints and needs-you aggregation", async () => {
  process.env.CORTEX_TOKEN = "api-secret";
  const dir = await mkdtemp(join(tmpdir(), "cortex-api-dispatch-"));
  const hub = createCortex({ dbPath: join(dir, "d.sqlite") });
  const staticDir = join(dir, "dist");
  await mkdir(staticDir);
  await writeFile(join(staticDir, "index.html"), "<main>UI</main>");
  hub.upsertProjectProfile({ projectPath: dir, name: "Repo", mode: "general", summary: "Test" });
  // one review task, one recheck-due blocked task, one future-recheck task, one inbox item
  const review = hub.addTask({ type: "chore", projectPath: dir, title: "Reviewable" });
  hub.editTask({ id: review.id, status: "ready" });
  hub.reviewTask({ id: review.id, evidence: "npm test passed" });
  const due = hub.addTask({ type: "chore", projectPath: dir, title: "Recheck due" });
  hub.blockTask({ id: due.id, reason: "App Review pending", recheckAt: "2020-01-01" });
  const future = hub.addTask({ type: "chore", projectPath: dir, title: "Recheck later" });
  hub.blockTask({ id: future.id, reason: "waiting", recheckAt: "2999-01-01" });
  hub.addInboxItem({ projectPath: dir, author: "codex", message: "PR open, awaiting merge" });
  const server = createCortexServer({ hub, staticDir });
  try {
    const address = await server.start();
    const base = `http://${address.host}:${address.port}/api/v1`;
    const post = (path, body) => fetch(`${base}${path}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer api-secret" }, body: JSON.stringify(body),
    });

    const initial = await (await fetch(`${base}/dispatcher`)).json();
    assert.equal(initial.enabled, false); // default off — never surprise-launch

    const enabledResponse = await post("/dispatcher", { agent: "human", enabled: true, projects: [dir] });
    assert.equal(enabledResponse.status, 200);
    const enabledBody = await enabledResponse.json();
    assert.equal(enabledBody.enabled, true);
    assert.equal(enabledBody.projects.length, 1);

    const badProjects = await post("/dispatcher", { agent: "human", projects: "not-an-array" });
    assert.equal(badProjects.status, 400);

    const needs = await (await fetch(`${base}/needs-you`)).json();
    assert.equal(needs.reviews.length, 1);
    assert.equal(needs.reviews[0].title, "Reviewable");
    assert.equal(needs.inbox.length, 1);
    assert.equal(needs.rechecks.length, 1); // only the past-due recheck
    assert.equal(needs.rechecks[0].title, "Recheck due");
    assert.equal(needs.dispatcher.enabled, true);
  } finally {
    await server.stop();
    hub.close();
    await rm(dir, { recursive: true, force: true });
    delete process.env.CORTEX_TOKEN;
  }
});

test("POST /dispatcher persists the run window", async () => {
  process.env.CORTEX_TOKEN = "api-secret";
  const dir = await mkdtemp(join(tmpdir(), "sched-api-"));
  const hub = createCortex({ dbPath: join(dir, "d.sqlite") });
  const staticDir = join(dir, "dist"); await mkdir(staticDir); await writeFile(join(staticDir, "index.html"), "<main>UI</main>");
  const server = createCortexServer({ hub, staticDir });
  try {
    const address = await server.start();
    const base = `http://${address.host}:${address.port}/api/v1`;
    const post = (b) => fetch(`${base}/dispatcher`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer api-secret" }, body: JSON.stringify(b) });
    await post({ agent: "human", window: { start: "22:00", end: "07:00", days: [0,1,2,3,4,5,6] } });
    const status = await (await fetch(`${base}/dispatcher`)).json();
    assert.deepEqual(status.window, { start: "22:00", end: "07:00", days: [0,1,2,3,4,5,6] });
    assert.equal(typeof status.windowOpen, "boolean");
    assert.equal(hub.storage.getSetting("dispatcher.window", null).start, "22:00");
  } finally { await server.stop(); hub.close(); await rm(dir, { recursive: true, force: true }); delete process.env.CORTEX_TOKEN; }
});

test("POST /dispatcher persists maxPerProject and it appears in status", async () => {
  process.env.CORTEX_TOKEN = "api-secret";
  const dir = await mkdtemp(join(tmpdir(), "sched-mpp-"));
  const hub = createCortex({ dbPath: join(dir, "d.sqlite") });
  // read once at construction (like maxConcurrent) — the running dispatcher reflects this value
  hub.storage.setSetting("dispatcher.maxPerProject", 2);
  const staticDir = join(dir, "dist"); await mkdir(staticDir); await writeFile(join(staticDir, "index.html"), "<main>UI</main>");
  const server = createCortexServer({ hub, staticDir });
  try {
    const address = await server.start();
    const base = `http://${address.host}:${address.port}/api/v1`;
    const post = (b) => fetch(`${base}/dispatcher`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer api-secret" }, body: JSON.stringify(b) });
    const status = await (await fetch(`${base}/dispatcher`)).json();
    assert.equal(status.maxPerProject, 2); // construction-time value surfaces in status
    await post({ agent: "human", maxPerProject: 3 });
    assert.equal(hub.storage.getSetting("dispatcher.maxPerProject", 1), 3); // POST persists the new value
  } finally { await server.stop(); hub.close(); await rm(dir, { recursive: true, force: true }); delete process.env.CORTEX_TOKEN; }
});

test("POST /dispatcher rejects malformed window and concurrency values instead of persisting them", async () => {
  // Persisting garbage here used to silently brick dispatch: a malformed window makes
  // withinWindow() false forever, and NaN/0 caps mean `inFlight < cap` never launches.
  process.env.CORTEX_TOKEN = "api-secret";
  const dir = await mkdtemp(join(tmpdir(), "sched-valid-"));
  const hub = createCortex({ dbPath: join(dir, "d.sqlite") });
  const staticDir = join(dir, "dist"); await mkdir(staticDir); await writeFile(join(staticDir, "index.html"), "<main>UI</main>");
  const server = createCortexServer({ hub, staticDir });
  try {
    const address = await server.start();
    const base = `http://${address.host}:${address.port}/api/v1`;
    const post = (b) => fetch(`${base}/dispatcher`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer api-secret" }, body: JSON.stringify(b) });
    for (const bad of [
      { window: "banana" }, { window: {} }, { window: { start: "22:00", end: "7pm" } },
      { window: { start: "22:00", end: "07:00", days: [7] } },
      { maxConcurrent: "abc" }, { maxConcurrent: 0 }, { maxConcurrent: 2.5 }, { maxConcurrent: 999 },
      { maxPerProject: null }, { maxPerProject: -1 },
    ]) {
      assert.equal((await post({ agent: "human", ...bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal(hub.storage.getSetting("dispatcher.window", "unset"), "unset");        // nothing persisted
    assert.equal(hub.storage.getSetting("dispatcher.maxConcurrent", "unset"), "unset");
    assert.equal((await post({ agent: "human", window: null, maxConcurrent: 2 })).status, 200); // valid still works
    assert.equal(hub.storage.getSetting("dispatcher.maxConcurrent", 1), 2);
  } finally { await server.stop(); hub.close(); await rm(dir, { recursive: true, force: true }); delete process.env.CORTEX_TOKEN; }
});

test("needs-you surfaces Memory Guard verdicts with reason and matched memory context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-api-guard-"));
  const hub = createCortex({ dbPath: join(dir, "g.sqlite") });
  const staticDir = join(dir, "dist");
  await mkdir(staticDir);
  await writeFile(join(staticDir, "index.html"), "<main>UI</main>");
  hub.upsertProjectProfile({ projectPath: dir, name: "Repo", mode: "general", summary: "Test" });
  // a durable memory the guard's reason can be matched against
  hub.captureCandidate({ projectPath: dir, agent: "codex", message: "Fixed schema corruption by preserving storage migration order. Verification: npm test passed." });
  // hard block by memory governance
  const blocked = hub.addTask({ type: "chore", projectPath: dir, title: "Rework storage migration order", acceptanceCriteria: "schema migration passes" });
  hub.blockTask({ id: blocked.id, reason: "Memory Guard [block]: conflicts with a durable lesson about migration order" });
  // soft warn: the task ran and reached review with a sentinel-prefixed evidence line
  const warned = hub.addTask({ type: "chore", projectPath: dir, title: "Touch the schema" });
  hub.editTask({ id: warned.id, status: "ready" });
  hub.reviewTask({ id: warned.id, evidence: "Memory Guard [warn]: overlaps a fragile file, review before accepting" });
  const server = createCortexServer({ hub, staticDir });
  try {
    const address = await server.start();
    const needs = await (await fetch(`http://${address.host}:${address.port}/api/v1/needs-you`)).json();
    assert.equal(needs.guard.length, 2);
    const block = needs.guard.find((g) => g.guard.kind === "block");
    assert.match(block.guard.reason, /migration order/);
    assert.ok(block.guard.memories.length >= 1); // recalled the durable lesson that fired the block
    const warn = needs.guard.find((g) => g.guard.kind === "warn");
    assert.match(warn.guard.reason, /fragile file/);
    // the warn is still in the raw reviews list too; the UI dedupes by id into the guard card
    assert.ok(needs.reviews.find((t) => t.id === warned.id));
  } finally {
    await server.stop();
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /runs/:id/stop kills a running agent; 404 when the run is not active", async () => {
  process.env.CORTEX_TOKEN = "api-secret";
  const dir = await mkdtemp(join(tmpdir(), "cortex-api-stop-"));
  const hub = createCortex({ dbPath: join(dir, "s.sqlite") });
  const staticDir = join(dir, "dist");
  await mkdir(staticDir);
  await writeFile(join(staticDir, "index.html"), "<main>UI</main>");
  hub.upsertProjectProfile({ projectPath: dir, name: "Repo", mode: "general", summary: "Test" });
  const agentLauncher = createAgentLauncher({ hub, spawnImpl: () => fakeChild(), logRoot: join(dir, "logs"), worktreesDir: join(dir, "wt"), git: fakeGit });
  const server = createCortexServer({ hub, agentLauncher, staticDir });
  try {
    const address = await server.start();
    const base = `http://${address.host}:${address.port}/api/v1`;
    const post = (path, body) => fetch(`${base}${path}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer api-secret" }, body: JSON.stringify(body),
    });

    const task = hub.addTask({ type: "chore", projectPath: dir, title: "Long run", status: "ready" });
    const launched = await agentLauncher.launch({ taskId: task.id, agent: "codex" });
    assert.equal(hub.storage.getTask(task.id).status, "in_progress");

    const stopped = await post(`/runs/${launched.run.id}/stop`, { agent: "human" });
    assert.equal(stopped.status, 200);
    await launched.completed;
    const blocked = hub.storage.getTask(task.id);
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.blockReason, /Stopped by user/);

    const missing = await post("/runs/not-a-run/stop", { agent: "human" });
    assert.equal(missing.status, 404);
  } finally {
    await server.stop();
    hub.close();
    await rm(dir, { recursive: true, force: true });
    delete process.env.CORTEX_TOKEN;
  }
});

test("POST /runs/:id/merge local-merges a run's branch; 404 when the run has no branch", async () => {
  process.env.CORTEX_TOKEN = "api-secret";
  const dir = await mkdtemp(join(tmpdir(), "cortex-api-merge-"));
  const repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "autopilot/t1"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "autopilot work"]);
  execFileSync("git", ["-C", repo, "checkout", "-q", "main"]);

  const hub = createCortex({ dbPath: join(dir, "m.sqlite") });
  const staticDir = join(dir, "dist");
  await mkdir(staticDir);
  await writeFile(join(staticDir, "index.html"), "<main>UI</main>");
  const server = createCortexServer({ hub, staticDir });
  try {
    const address = await server.start();
    const base = `http://${address.host}:${address.port}/api/v1`;
    const post = (path, body) => fetch(`${base}${path}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer api-secret" }, body: JSON.stringify(body),
    });

    const task = hub.addTask({ type: "chore", projectPath: repo, title: "Do it", status: "ready" });
    const run = hub.startRun({ taskId: task.id, agent: "codex" });
    hub.updateRunProgress({ id: run.id, branch: "autopilot/t1" });

    // a still-running run has a branch (written at launch) but nothing on it yet — refuse
    const active = await post(`/runs/${run.id}/merge`, { agent: "human", baseRef: "main" });
    assert.equal(active.status, 400);
    hub.finishRun({ id: run.id, outcome: "success" });

    // a baseRef that would parse as a git option is rejected before reaching git
    const optionRef = await post(`/runs/${run.id}/merge`, { agent: "human", baseRef: "-q" });
    assert.equal(optionRef.status, 400);

    const merged = await post(`/runs/${run.id}/merge`, { agent: "human", baseRef: "main" });
    assert.equal(merged.status, 200);
    assert.equal((await merged.json()).merged, true);
    // main now contains the run branch's commit
    const log = execFileSync("git", ["-C", repo, "log", "main", "--oneline"], { encoding: "utf8" });
    assert.match(log, /autopilot work/);

    const noBranchTask = hub.addTask({ type: "chore", projectPath: repo, title: "No branch", status: "ready" });
    const noBranchRun = hub.startRun({ taskId: noBranchTask.id, agent: "codex" });
    const missing = await post(`/runs/${noBranchRun.id}/merge`, { agent: "human" });
    assert.equal(missing.status, 404);
  } finally {
    await server.stop();
    hub.close();
    await rm(dir, { recursive: true, force: true });
    delete process.env.CORTEX_TOKEN;
  }
});

test("GET /costs aggregates spend by model and project", async () => {
  process.env.CORTEX_TOKEN = "api-secret";
  const dir = await mkdtemp(join(tmpdir(), "cortex-api-costs-"));
  const hub = createCortex({ dbPath: join(dir, "c.sqlite") });
  const staticDir = join(dir, "dist");
  await mkdir(staticDir);
  await writeFile(join(staticDir, "index.html"), "<main>UI</main>");
  hub.upsertProjectProfile({ projectPath: dir, name: "Repo", mode: "general", summary: "Test" });
  // two finished runs with cost, one still-null (no usage reported)
  const t1 = hub.addTask({ type: "feature", projectPath: dir, title: "A", status: "ready" });
  const r1 = hub.startRun({ taskId: t1.id, agent: "claude-code" });
  hub.finishRun({ id: r1.id, outcome: "success", model: "opus", tokens: 1000, costUsd: 0.5 });
  const t2 = hub.addTask({ type: "chore", projectPath: dir, title: "B", status: "ready" });
  const r2 = hub.startRun({ taskId: t2.id, agent: "claude-code" });
  hub.finishRun({ id: r2.id, outcome: "success", model: "sonnet", tokens: 400, costUsd: 0.1 });
  const server = createCortexServer({ hub, staticDir });
  try {
    const address = await server.start();
    const base = `http://${address.host}:${address.port}/api/v1`;
    const costs = await (await fetch(`${base}/costs`)).json();
    assert.equal(Number(costs.total.costUsd.toFixed(2)), 0.6);
    assert.equal(costs.total.runs, 2);
    // opus is the biggest spender and sorts first
    assert.equal(costs.byModel[0].key, "opus");
    assert.equal(costs.byModel[0].costUsd, 0.5);
    assert.equal(costs.byProject[0].key, hub.storage.getTask(t1.id).projectPath);
    assert.deepEqual(costs.byType.map((r) => r.key).sort(), ["chore", "feature"]);
  } finally {
    await server.stop();
    hub.close();
    await rm(dir, { recursive: true, force: true });
    delete process.env.CORTEX_TOKEN;
  }
});

// Fix 1: fail-closed auth for proxied requests. `tailscale serve` proxies to
// loopback (so allowRemote never fires) and always adds x-forwarded-for; a
// forgotten token would otherwise expose every read and write to the tailnet.
async function withApiServer(run) {
  const dir = await mkdtemp(join(tmpdir(), "cortex-auth-"));
  const hub = createCortex({ dbPath: join(dir, "auth.sqlite") });
  const staticDir = join(dir, "dist");
  await mkdir(staticDir);
  await writeFile(join(staticDir, "index.html"), "<main>UI</main>");
  hub.upsertProjectProfile({ projectPath: dir, name: "Repo", mode: "general", summary: "Test" });
  const server = createCortexServer({ hub, staticDir });
  const address = await server.start();
  const base = `http://${address.host}:${address.port}`;
  const proxied = { "x-forwarded-for": "100.101.102.103" }; // tailscale serve always adds this
  try { await run({ base, dir, proxied }); }
  finally { await server.stop(); hub.close(); await rm(dir, { recursive: true, force: true }); delete process.env.CORTEX_TOKEN; }
}

test("proxied read WITHOUT the token header is 401 when CORTEX_TOKEN is set", async () => {
  process.env.CORTEX_TOKEN = "secret";
  await withApiServer(async ({ base, proxied }) => {
    const res = await fetch(`${base}/api/v1/projects`, { headers: proxied });
    assert.equal(res.status, 401);
  });
});

test("proxied read WITH a valid bearer is 200", async () => {
  process.env.CORTEX_TOKEN = "secret";
  await withApiServer(async ({ base, proxied }) => {
    const res = await fetch(`${base}/api/v1/projects`, { headers: { ...proxied, authorization: "Bearer secret" } });
    assert.equal(res.status, 200);
    assert.equal(Array.isArray(await res.json()), true);
  });
});

test("proxied request with NO token configured is 401 with the must-be-set message", async () => {
  delete process.env.CORTEX_TOKEN;
  await withApiServer(async ({ base, proxied }) => {
    const res = await fetch(`${base}/api/v1/projects`, { headers: proxied });
    assert.equal(res.status, 401);
    assert.match((await res.json()).error.message, /CORTEX_TOKEN must be set/);
  });
});

test("direct loopback read without a token is 200 (existing behavior unchanged)", async () => {
  delete process.env.CORTEX_TOKEN;
  await withApiServer(async ({ base }) => {
    const res = await fetch(`${base}/api/v1/projects`);
    assert.equal(res.status, 200);
  });
});

test("dispatcher enrollment dedupes projects and silently filters a NEVER_AUTOPILOT repo", async () => {
  process.env.CORTEX_TOKEN = "api-secret"; // writes are default-deny without a configured token
  NEVER_AUTOPILOT.add(autopilotKey(normalizeProjectPath("/protected/repo"))); // key as the server computes it
  await withApiServer(async ({ base, dir }) => {
    const post = (projects) => fetch(`${base}/api/v1/dispatcher`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer api-secret" },
      body: JSON.stringify({ agent: "human", projects }),
    });
    const ok = await post([dir, dir, dir]);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).projects.length, 1);

    // fail-closed FILTER, not a batch rejection: clients send the whole selection array, so a
    // banned repo in the list must not 400 every enrollment — it just never lands.
    const withBanned = await post([dir, "/protected/repo"]);
    assert.equal(withBanned.status, 200);
    const enrolled = (await withBanned.json()).projects;
    assert.equal(enrolled.length, 1);
    assert.equal(enrolled.some((p) => /protected/i.test(p)), false);

    // a banned-only batch yields an empty enrollment, never a banned one
    const bannedOnly = await post(["/protected/repo"]);
    assert.equal(bannedOnly.status, 200);
    assert.deepEqual((await bannedOnly.json()).projects, []);
  });
});

test("proxied /api/v1/health stays open with no auth so a phone shows a clear state", async () => {
  process.env.CORTEX_TOKEN = "secret";
  await withApiServer(async ({ base, proxied }) => {
    const res = await fetch(`${base}/api/v1/health`, { headers: proxied });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    // static SPA also stays open so api.js's 401 prompt can collect the token
    const spa = await fetch(`${base}/`, { headers: proxied });
    assert.equal(spa.status, 200);
  });
});

// Control Center overview KPIs: capturedToday (fixes+research created since local
// midnight), durableMemories (total fixes), blockedTasks (workflow_tasks blocked).
test("overview reports captured-today, durable memories, and blocked tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-api-overview-"));
  const hub = createCortex({ dbPath: join(dir, "overview.sqlite") });
  const staticDir = join(dir, "dist");
  await mkdir(staticDir);
  await writeFile(join(staticDir, "index.html"), "<main>UI</main>");
  hub.upsertProjectProfile({ projectPath: dir, name: "Repo", mode: "general", summary: "Test" });
  // two fixes captured today (also count toward durable memories)
  hub.storage.insertFix({ id: "fix-a", projectPath: dir, agent: "codex", summary: "Fix A", filesChanged: ["a.js"] });
  hub.storage.insertFix({ id: "fix-b", projectPath: dir, agent: "codex", summary: "Fix B", filesChanged: ["b.js"] });
  // one research note today
  hub.storage.insertResearch({ id: "res-a", projectPath: dir, agent: "codex", question: "Q?", sources: ["s"], evidence: "e", finding: "f", reuseTags: ["t"] });
  // one OLD fix (durable, but not captured today) — set created_at to a past date directly
  hub.storage.insertFix({ id: "fix-old", projectPath: dir, agent: "codex", summary: "Old fix", filesChanged: ["c.js"] });
  hub.storage.db.prepare("UPDATE fix_entries SET created_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", "fix-old");
  // one blocked task
  const blocked = hub.addTask({ type: "chore", projectPath: dir, title: "Blocked task" });
  hub.blockTask({ id: blocked.id, reason: "waiting" });
  const server = createCortexServer({ hub, staticDir });
  try {
    const address = await server.start();
    const body = await (await fetch(`http://${address.host}:${address.port}/api/v1/overview`)).json();
    assert.equal(body.capturedToday, 3); // 2 fixes + 1 research today (old fix excluded)
    assert.equal(body.durableMemories, 3); // all 3 fixes, regardless of date
    assert.equal(body.blockedTasks, 1);
  } finally {
    await server.stop();
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// Config the Control Center persists (capture policy + token budgets). Allowlisted
// keys only; unknown keys are rejected. Not yet consumed by the capture pipeline.
test("settings GET returns allowlisted keys and POST validates + persists", async () => {
  process.env.CORTEX_TOKEN = "api-secret"; // writes are default-deny without a configured token
  const dir = await mkdtemp(join(tmpdir(), "cortex-api-settings-"));
  const hub = createCortex({ dbPath: join(dir, "settings.sqlite") });
  const staticDir = join(dir, "dist");
  await mkdir(staticDir);
  await writeFile(join(staticDir, "index.html"), "<main>UI</main>");
  const server = createCortexServer({ hub, staticDir });
  try {
    const address = await server.start();
    const base = `http://${address.host}:${address.port}/api/v1`;
    const post = (body) => fetch(`${base}/settings`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer api-secret" }, body: JSON.stringify(body),
    });

    // GET returns defaults for the allowlisted capture-policy keys
    const initial = await (await fetch(`${base}/settings`)).json();
    assert.equal(initial["capturePolicy.durableFixes"], true);
    assert.equal(initial["capturePolicy.genericChatter"], false);
    assert.equal(typeof initial["capturePolicy.signalThreshold"], "number");

    // POST a boolean toggle
    const toggle = await post({ agent: "human", key: "capturePolicy.decisions", value: false });
    assert.equal(toggle.status, 200);

    // POST a per-project token budget (dynamic key under the tokenBudget. prefix)
    const budget = await post({ agent: "human", key: `tokenBudget.${dir}`, value: 40000 });
    assert.equal(budget.status, 200);

    // reject a key outside the allowlist
    const bad = await post({ agent: "human", key: "dispatcher.enabled", value: true });
    assert.equal(bad.status, 400);

    // persisted values come back on the next GET
    const after = await (await fetch(`${base}/settings`)).json();
    assert.equal(after["capturePolicy.decisions"], false);
    assert.equal(after[`tokenBudget.${dir}`], 40000);
  } finally {
    await server.stop();
    hub.close();
    await rm(dir, { recursive: true, force: true });
    delete process.env.CORTEX_TOKEN;
  }
});

test("PATCH /tasks/:id edits dependsOn and notBefore, rejecting cycles", async () => {
  process.env.CORTEX_TOKEN = "api-secret";
  const dir = await mkdtemp(join(tmpdir(), "sched-edit-"));
  const hub = createCortex({ dbPath: join(dir, "d.sqlite") });
  const staticDir = join(dir, "dist"); await mkdir(staticDir); await writeFile(join(staticDir, "index.html"), "<main>UI</main>");
  const a = hub.addTask({ projectPath: dir, title: "A", type: "feature" });
  const b = hub.addTask({ projectPath: dir, title: "B", type: "feature" });
  const server = createCortexServer({ hub, staticDir });
  try {
    const address = await server.start();
    const base = `http://${address.host}:${address.port}/api/v1`;
    const patch = (id, body) => fetch(`${base}/tasks/${id}`, { method: "PATCH", headers: { "content-type": "application/json", authorization: "Bearer api-secret" }, body: JSON.stringify(body) });
    const ok = await patch(b.id, { agent: "human", action: "edit", dependsOn: [a.id], notBefore: "2026-07-09T02:00:00.000Z" });
    assert.equal(ok.status, 200);
    assert.deepEqual(hub.storage.getTask(b.id).dependsOn, [a.id]);
    assert.equal(hub.storage.getTask(b.id).notBefore, "2026-07-09T02:00:00.000Z");
    const bad = await patch(a.id, { agent: "human", action: "edit", dependsOn: [b.id] }); // would cycle A->B->A
    assert.equal(bad.status >= 400, true);
    assert.equal(hub.storage.getTask(a.id).dependsOn.length, 0); // unchanged
  } finally { await server.stop(); hub.close(); await rm(dir, { recursive: true, force: true }); delete process.env.CORTEX_TOKEN; }
});
