import "./helpers/pinEnv.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCortex } from "../src/index.js";
import { createCortexServer } from "../src/server.js";

// hermetic: a developer machine may have CORTEX_TOKEN set globally (real hub auth);
// these tests assume no token unless a test sets one itself.
delete process.env.CORTEX_TOKEN;

test("serves health, search, projects, tasks, links, and audit on loopback", async () => {
  process.env.CORTEX_TOKEN = "api-secret"; // writes are default-deny without a configured token
  const dir = await mkdtemp(join(tmpdir(), "cortex-api-"));
  const hub = createCortex({ dbPath: join(dir, "api.sqlite") });
  const staticDir = join(dir, "dist");
  await mkdir(staticDir);
  await writeFile(join(staticDir, "index.html"), "<main>Cortex UI</main>");
  hub.upsertProjectProfile({ projectPath: dir, name: "Repo", mode: "general", summary: "Test" });
  hub.captureCandidate({ projectPath: dir, agent: "codex", message: "Fixed close reconciliation. Verification: npm test passed." });
  const server = createCortexServer({ hub, staticDir });
  try {
    const address = await server.start();
    assert.equal(address.host, "127.0.0.1");
    assert.match(await (await fetch(`http://${address.host}:${address.port}/`)).text(), /Cortex UI/);
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

test("GET /runs/:id/log tails the run log and is safe when the log is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-api-runlog-"));
  const hub = createCortex({ dbPath: join(dir, "log.sqlite") });
  hub.upsertProjectProfile({ projectPath: dir, name: "Repo", mode: "general", summary: "" });
  const task = hub.addTask({ type: "chore", projectPath: dir, title: "logged", status: "ready" });
  const run = hub.storage.startRun({ taskId: task.id, agent: "claude-code" });
  const logPath = join(dir, "run.jsonl");
  await writeFile(logPath, Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n"));
  hub.storage.updateRunProgress(run.id, { logPath });
  const bare = hub.storage.startRun({ taskId: task.id, agent: "claude-code" }); // never got a logPath
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
  await writeFile(join(staticDir, "index.html"), "<main>Cortex UI</main>");
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

test("needs-you aggregation surfaces reviews, inbox, and due rechecks", async () => {
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

    const needs = await (await fetch(`${base}/needs-you`)).json();
    assert.equal(needs.reviews.length, 1);
    assert.equal(needs.reviews[0].title, "Reviewable");
    assert.equal(needs.inbox.length, 1);
    assert.equal(needs.rechecks.length, 1); // only the past-due recheck
    assert.equal(needs.rechecks[0].title, "Recheck due");
  } finally {
    await server.stop();
    hub.close();
    await rm(dir, { recursive: true, force: true });
    delete process.env.CORTEX_TOKEN;
  }
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
  const r1 = hub.storage.startRun({ taskId: t1.id, agent: "claude-code" });
  hub.storage.finishRun(r1.id, { outcome: "success", model: "opus", tokens: 1000, costUsd: 0.5 });
  const t2 = hub.addTask({ type: "chore", projectPath: dir, title: "B", status: "ready" });
  const r2 = hub.storage.startRun({ taskId: t2.id, agent: "claude-code" });
  hub.storage.finishRun(r2.id, { outcome: "success", model: "sonnet", tokens: 400, costUsd: 0.1 });
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

test("POST /projects/tier sets an autonomy tier, and /projects reads it back", async () => {
  process.env.CORTEX_TOKEN = "api-secret";
  await withApiServer(async ({ base, dir }) => {
    const setTier = (body) => fetch(`${base}/api/v1/projects/tier`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer api-secret" },
      body: JSON.stringify({ agent: "human", ...body }),
    });
    const projects = async () => (await (await fetch(`${base}/api/v1/projects`)).json());

    // default is watch, and the read carries tier/pinned so the UI needs no second endpoint
    assert.equal((await projects())[0].tier, "watch");
    assert.equal((await projects())[0].pinned, false);

    const assist = await setTier({ projectPath: dir, tier: "assist" });
    assert.equal(assist.status, 200);
    assert.deepEqual((await assist.json()).rejected, []);
    assert.equal((await projects())[0].tier, "assist");

    const auto = await setTier({ projectPath: dir, tier: "auto" });
    assert.equal((await auto.json()).updated.length, 1);
    assert.equal((await projects())[0].tier, "auto");

    const bogus = await setTier({ projectPath: dir, tier: "turbo" });
    assert.equal(bogus.status, 400);
    assert.match((await bogus.json()).error.message, /unknown tier/);
    assert.equal((await projects())[0].tier, "auto"); // nothing persisted
  });
});

test("POST /projects/tier rejects the pinned live-money repo per item, never per batch", async () => {
  process.env.CORTEX_TOKEN = "api-secret";
  await withApiServer(async ({ base, dir }) => {
    const setTier = (body) => fetch(`${base}/api/v1/projects/tier`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer api-secret" },
      body: JSON.stringify({ agent: "human", ...body }),
    });

    // a batch carrying the pinned repo still lands the rest of the selection (the mobile
    // Control screen sends its whole list; a throw used to 400 every enrollment)
    const batch = await setTier({ projects: [{ projectPath: dir, tier: "auto" }, { projectPath: "C:/work/master", tier: "auto" }] });
    assert.equal(batch.status, 200);
    const body = await batch.json();
    assert.deepEqual(body.updated, [{ projectPath: dir.replaceAll("\\", "/"), tier: "auto" }]);
    assert.equal(body.rejected.length, 1);
    assert.match(body.rejected[0].reason, /pinned at watch/);

    // the pinned repo alone is a client error, with the reason named
    const pinnedOnly = await setTier({ projectPath: "C:/work/master", tier: "assist" });
    assert.equal(pinnedOnly.status, 400);
    assert.match((await pinnedOnly.json()).error.message, /pinned at watch/);

    // ...and it can still be set to its own floor, so the row is not a dead control
    const toWatch = await setTier({ projectPath: "C:/work/master", tier: "watch" });
    assert.equal(toWatch.status, 200);
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
