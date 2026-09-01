import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCortex } from "../src/index.js";
import { createCortexServer } from "../src/server.js";
import { CortexStorage, normalizeProjectPath } from "../src/storage.js";

// hermetic: a developer machine may have CORTEX_TOKEN set globally (real hub auth);
// these tests assume no token unless a test sets one itself.
delete process.env.CORTEX_TOKEN;

async function withServer(run) {
  process.env.CORTEX_TOKEN = "test-token"; // writes are default-deny without a configured token
  const dir = await mkdtemp(join(tmpdir(), "cortex-write-"));
  const hub = createCortex({ dbPath: join(dir, "w.sqlite") });
  const staticDir = join(dir, "dist");
  await mkdir(staticDir);
  await writeFile(join(staticDir, "index.html"), "<main>UI</main>");
  const server = createCortexServer({ hub, staticDir });
  const address = await server.start();
  const base = `http://${address.host}:${address.port}/api/v1`;
  const authed = { "content-type": "application/json", authorization: "Bearer test-token" };
  const post = (path, body, headers = authed) =>
    fetch(`${base}${path}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  const patch = (path, body) =>
    fetch(`${base}${path}`, { method: "PATCH", headers: authed, body: JSON.stringify(body) });
  const del = (path, body) =>
    fetch(`${base}${path}`, { method: "DELETE", headers: authed, body: JSON.stringify(body) });
  try { await run({ base, dir, post, patch, del, hub }); }
  finally { await server.stop(); hub.close(); await rm(dir, { recursive: true, force: true }); delete process.env.CORTEX_TOKEN; }
}

test("WAL is active after opening storage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-wal-"));
  const storage = new CortexStorage({ dbPath: join(dir, "wal.sqlite") });
  assert.equal(storage.db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  storage.close();
  await rm(dir, { recursive: true, force: true });
});

test("portfolio doctor is read-only and lifecycle changes require an explicit authenticated write", async () => {
  await withServer(async ({ base, dir, post, hub }) => {
    hub.upsertProjectProfile({ projectPath: dir, name: "Portfolio app", mode: "product", summary: "Test" });
    hub.addTask({ projectPath: dir, type: "chore", title: "Ship it" });

    const before = await (await fetch(`${base}/portfolio/doctor?today=2026-07-30`)).json();
    const row = before.rows.find(({ name }) => name === "Portfolio app");
    assert.equal(row.lifecycle, "unclassified");
    assert.equal(row.tasks.open, 1);
    assert.ok(row.issues.some(({ code }) => code === "missing-evidence-contract"));

    const changed = await post("/projects/lifecycle", {
      agent: "human",
      projectPath: dir,
      state: "active",
    });
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).state, "active");

    const projects = await (await fetch(`${base}/projects`)).json();
    assert.equal(projects[0].lifecycle, "active");
    const after = await (await fetch(`${base}/portfolio/doctor?today=2026-07-30`)).json();
    assert.ok(after.rows.find(({ name }) => name === "Portfolio app").issues
      .some(({ code }) => code === "missing-active-goal"));

    const bad = await post("/projects/lifecycle", {
      agent: "human",
      projectPath: dir,
      state: "busy",
    });
    assert.equal(bad.status, 400);
  });
});

test("capture endpoint runs the policy (chatter discarded, not raw-inserted)", async () => {
  await withServer(async ({ dir, post }) => {
    const res = await post("/capture", { projectPath: dir, agent: "codex", message: "Fixed close fill. Verification: tests pass." });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).action, "accepted");
    const chatter = await post("/capture", { projectPath: dir, agent: "codex", message: "ok" });
    assert.equal((await chatter.json()).action, "discarded");
  });
});

test("activity feed reflects captures with agent + summary", async () => {
  await withServer(async ({ base, dir, post }) => {
    await post("/capture", { projectPath: dir, agent: "claude", message: "Fixed retry loop. Verification: green." });
    const events = await (await fetch(`${base}/activity?project=${encodeURIComponent(dir)}`)).json();
    const capture = events.find((e) => e.kind === "capture_outcome");
    assert.equal(capture.payload.agent, "claude");
    assert.match(capture.payload.summary, /retry loop/);
  });
});

test("writes require an agent", async () => {
  await withServer(async ({ dir, post }) => {
    const res = await post("/tasks", { projectPath: dir, title: "no agent" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /agent is required/);
  });
});

test("malformed JSON with json content-type is 400", async () => {
  await withServer(async ({ post }) => {
    const res = await post("/tasks", "{", { "content-type": "application/json", authorization: "Bearer test-token" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /Malformed JSON/);
  });
});

test("non-json content-type is rejected", async () => {
  await withServer(async ({ post }) => {
    const res = await post("/tasks", "title=x", { "content-type": "text/plain", authorization: "Bearer test-token" });
    assert.equal(res.status, 400);
  });
});

test("an agent may not complete to done over HTTP; human completion validates evidence", async () => {
  await withServer(async ({ dir, post, patch }) => {
    const created = await post("/tasks", { projectPath: dir, agent: "claude", title: "Ship it", type: "chore", status: "ready" });
    assert.equal(created.status, 201);
    const id = (await created.json()).id;
    // an agent completing to done is refused — agents park in review for human sign-off
    const byAgent = await patch(`/tasks/${id}`, { agent: "claude", action: "complete", evidence: "tests pass" });
    assert.equal(byAgent.status, 400);
    assert.match((await byAgent.json()).error.message, /may not set a task to 'done'/);
    // human sign-off: missing evidence still 400
    const missing = await patch(`/tasks/${id}`, { agent: "human", action: "complete" });
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error.message, /evidence is required/);
    // human sign-off with evidence completes
    const done = await patch(`/tasks/${id}`, { agent: "human", action: "complete", evidence: "tests pass" });
    assert.equal(done.status, 200);
    assert.equal((await done.json()).status, "done");
  });
});

test("a non-string evidence value is rejected, not silently stored as \"[object Object]\"", async () => {
  await withServer(async ({ dir, post, patch }) => {
    const created = await post("/tasks", { projectPath: dir, agent: "claude", title: "Ship it", type: "chore", status: "ready" });
    const id = (await created.json()).id;
    const res = await patch(`/tasks/${id}`, { agent: "human", action: "complete", evidence: { nested: "object" } });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /evidence is required/);
  });
});

test("patching an unknown task id is 404", async () => {
  await withServer(async ({ patch }) => {
    const res = await patch("/tasks/does-not-exist", { agent: "claude", action: "review" });
    assert.equal(res.status, 404);
  });
});

test("a rejected write with a known agent records it on the write_rejected metric", async () => {
  await withServer(async ({ dir, post, hub }) => {
    // agent is present (passes the generic check) but message is missing -> fails inside
    // handleWrite, the path where the agent IS known but wasn't previously recorded
    const res = await post("/inbox", { projectPath: dir, agent: "claude", author: "claude" });
    assert.equal(res.status, 400);
    const rejected = hub.storage.listMetrics(dir, { kind: "write_rejected" });
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].payload.agent, "claude");
  });
});

test("bad bearer token is 401 when CORTEX_TOKEN is set", async () => {
  await withServer(async ({ base, dir }) => {
    const res = await fetch(`${base}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({ projectPath: dir, agent: "claude", title: "x" }),
    });
    assert.equal(res.status, 401);
  });
});

test("loopback write with NO token configured is 401 with an actionable message (default-deny)", async () => {
  await withServer(async ({ base, dir }) => {
    delete process.env.CORTEX_TOKEN;
    const res = await fetch(`${base}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectPath: dir, agent: "claude", title: "x" }),
    });
    assert.equal(res.status, 401);
    assert.match((await res.json()).error.message, /CORTEX_TOKEN/);
  });
});

test("allowRemote without token refuses to start", () => {
  assert.throws(() => createCortexServer({ hub: {}, host: "127.0.0.1", allowRemote: true }), /CORTEX_TOKEN/);
});

test("static path traversal is blocked", async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base.replace("/api/v1", "")}/../../etc/passwd`);
    // server falls back to index.html with html content-type, never serves outside staticDir
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
  });
});

test("corrupt metric payload does not break activity", async () => {
  await withServer(async ({ base, dir, hub }) => {
    hub.storage.db.prepare("INSERT INTO metrics_events (id, project_path, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("bad", normalizeProjectPath(dir), "capture_outcome", "{not json", new Date().toISOString());
    const events = await (await fetch(`${base}/activity?project=${encodeURIComponent(dir)}`)).json();
    const bad = events.find((e) => e.id === "bad");
    assert.equal(bad.payload._parseError, true);
  });
});

test("CLI-vs-server style: two storage handles on one file both write under WAL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-contend-"));
  const path = join(dir, "c.sqlite");
  const a = new CortexStorage({ dbPath: path });
  const b = new CortexStorage({ dbPath: path }); // second writer = the maintenance/CLI handle
  // ponytail: same-process interleave exercises WAL + busy_timeout; true multi-process isn't simulated.
  a.recordMetric("capture_outcome", dir, { action: "accepted" });
  b.recordMetric("capture_outcome", dir, { action: "discarded" });
  a.recordMetric("capture_outcome", dir, { action: "accepted" });
  assert.equal(b.listMetrics(dir).length, 3);
  a.close(); b.close();
  await rm(dir, { recursive: true, force: true });
});

function roadmapPayload(overrides = {}) {
  return {
    version: 1,
    goal: {
      title: "Ship result", outcome: "Verified result", targetDate: "2026-07-31",
      weeklyCapacity: 3, activeRank: 1,
      criteria: [{ key: "c1", text: "Verification passes", taskKeys: ["t1"] }],
      ...overrides.goal,
    },
    milestones: overrides.milestones || [{ key: "m1", title: "Baseline", order: 1, dueDate: "2026-07-05" }],
    tasks: overrides.tasks || [{
      key: "t1", action: "create", milestoneKey: "m1", number: "1.1", order: 1,
      title: "Run verification", type: "feature", priority: "high", acceptanceCriteria: "Evidence saved",
      verificationCommand: "npm test", scheduledFor: "2026-06-29",
    }],
  };
}

test("roadmap proposal lifecycle over HTTP: create, list pending, approve, read portfolio", async () => {
  await withServer(async ({ base, dir, post, patch }) => {
    const created = await post("/roadmap-proposals", { projectPath: dir, agent: "codex", payload: roadmapPayload() });
    assert.equal(created.status, 201);
    const proposalId = (await created.json()).id;

    const pending = await (await fetch(`${base}/roadmap-proposals?project=${encodeURIComponent(dir)}&status=pending`)).json();
    assert.deepEqual(pending.map(({ id }) => id), [proposalId]);

    const approved = await patch(`/roadmap-proposals/${proposalId}`, { agent: "human", action: "approve" });
    assert.equal(approved.status, 200);
    const roadmap = await approved.json();
    assert.equal(roadmap.goal.status, "active");
    assert.equal(roadmap.tasks.length, 1);

    const portfolio = await (await fetch(`${base}/goals?today=2026-06-29`)).json();
    assert.equal(portfolio.projects.length, 1);
    assert.equal(portfolio.nextAction.id, roadmap.tasks[0].id);

    const onlyRoadmap = await (await fetch(`${base}/roadmaps?project=${encodeURIComponent(dir)}`)).json();
    assert.equal(onlyRoadmap.goal.id, roadmap.goal.id);
  });
});

test("weekly plan over HTTP stays within capacity and excludes blocked tasks", async () => {
  await withServer(async ({ base, dir, hub }) => {
    const proposal = hub.createRoadmapProposal({ projectPath: dir, agent: "codex", payload: roadmapPayload() });
    hub.approveRoadmapProposal({ id: proposal.id, agent: "human" });
    const week = await (await fetch(`${base}/weeks?start=2026-06-29&capacity=6`)).json();
    assert.equal(week.totalCapacity, 6);
    assert.equal(week.scheduled.length <= 6, true);
    assert.equal(week.scheduled.every(({ status }) => status !== "blocked"), true);
  });
});

test("auto-plan week over HTTP reschedules and returns the week", async () => {
  await withServer(async ({ dir, hub, post }) => {
    const proposal = hub.createRoadmapProposal({ projectPath: dir, agent: "codex", payload: roadmapPayload() });
    hub.approveRoadmapProposal({ id: proposal.id, agent: "human" });
    const res = await post("/weeks/auto-plan", { agent: "human", weekStart: "2026-06-29", totalCapacity: 6 });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).weekStart, "2026-06-29");
  });
});

test("scheduling a task over HTTP uses the schedule action", async () => {
  await withServer(async ({ dir, hub, patch }) => {
    const task = hub.addTask({ type: "chore", projectPath: dir, title: "Plan me", status: "ready" });
    const res = await patch(`/tasks/${task.id}`, { agent: "human", action: "schedule", scheduledFor: "2026-06-30" });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).scheduledFor, "2026-06-30");
  });
});

test("confirming an eligible goal over HTTP flips it to achieved", async () => {
  await withServer(async ({ dir, hub, patch }) => {
    const proposal = hub.createRoadmapProposal({ projectPath: dir, agent: "codex", payload: roadmapPayload() });
    const roadmap = hub.approveRoadmapProposal({ id: proposal.id, agent: "human" });
    hub.completeTask({ id: roadmap.tasks[0].id, evidence: "npm test passed" });
    const res = await patch(`/goals/${roadmap.goal.id}`, { agent: "human", action: "achieve" });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "achieved");
  });
});

test("updating a milestone deadline over HTTP", async () => {
  await withServer(async ({ dir, hub, patch }) => {
    const proposal = hub.createRoadmapProposal({ projectPath: dir, agent: "codex", payload: roadmapPayload() });
    const roadmap = hub.approveRoadmapProposal({ id: proposal.id, agent: "human" });
    const res = await patch(`/milestones/${roadmap.milestones[0].id}`, { agent: "human", dueDate: "2026-07-09" });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).dueDate, "2026-07-09");
  });
});

test("cross-project roadmap link is rejected with 400", async () => {
  await withServer(async ({ dir, hub, post }) => {
    const foreign = hub.addTask({ type: "chore", projectPath: `${dir}-other`, title: "Foreign" });
    const payload = roadmapPayload({ tasks: [{ key: "t1", action: "link", taskId: foreign.id, milestoneKey: "m1", number: "1.1", order: 1 }] });
    const res = await post("/roadmap-proposals", { projectPath: dir, agent: "codex", payload });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /same project/);
  });
});

test("roadmap proposal write requires an agent", async () => {
  await withServer(async ({ dir, post }) => {
    const res = await post("/roadmap-proposals", { projectPath: dir, payload: roadmapPayload() });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /agent is required/);
  });
});

test("approving an unknown roadmap proposal is 404", async () => {
  await withServer(async ({ patch }) => {
    const res = await patch("/roadmap-proposals/missing", { agent: "human", action: "approve" });
    assert.equal(res.status, 404);
  });
});

test("task edit and guarded delete are exposed", async () => {
  await withServer(async ({ dir, hub, patch, del }) => {
    const task = hub.addTask({ type: "chore", projectPath: dir, title: "Old", status: "ready" });
    const edited = await patch(`/tasks/${task.id}`, { agent: "human", action: "edit", title: "New" });
    assert.equal((await edited.json()).title, "New");
    const removed = await del(`/tasks/${task.id}`, { agent: "human" });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { id: task.id, deleted: true });
  });
});

test("GET routes return 400 (not 500) for bad client input", async () => {
  await withServer(async ({ base }) => {
    const goals = await fetch(`${base}/goals?today=not-a-date`);
    assert.equal(goals.status, 400);
    assert.equal((await goals.json()).error.code, "invalid_request");

    const weeks = await fetch(`${base}/weeks?start=not-a-date`);
    assert.equal(weeks.status, 400);
    assert.equal((await weeks.json()).error.code, "invalid_request");
  });
});

test("a still-healthy connection is not affected by a prior oversized-body request", async () => {
  await withServer(async ({ base, dir }) => {
    const big = await fetch(`${base}/capture`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ agent: "a", projectPath: dir, message: "x".repeat(70_000) }),
    });
    assert.equal(big.status, 400);
    assert.match((await big.json()).error.message, /too large/);

    // the next request must not hang or fail even if it happens to land on the same
    // connection pool — this used to hang for the full client timeout on a kept-alive socket.
    const next = await fetch(`${base}/health`);
    assert.equal(next.status, 200);
  });
});

test("POST /links rejects non-string entity ids cleanly instead of leaking a SQLite error", async () => {
  await withServer(async ({ post }) => {
    const res = await post("/links", { agent: "human", fromEntityId: { nested: "object" }, toEntityId: "x", linkType: "related_to" });
    assert.equal(res.status, 400);
    const message = (await res.json()).error.message;
    assert.match(message, /must be strings/);
    assert.doesNotMatch(message, /SQLite|named parameter/i);
  });
});

test("POST /lessons is exercised over HTTP and stores the lesson (JIT-served, not in the brief)", async () => {
  await withServer(async ({ dir, hub, post }) => {
    const res = await post("/lessons", { agent: "human", projectPath: dir, lesson: "Start the backend before trusting the Vite proxy." });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).action, "accepted");
    // audit III: lessons dropped from the brief (0/70 ever cited); still stored + JIT-served
    assert.equal(hub.storage.listLessons(dir).length, 1);
    assert.doesNotMatch(hub.buildBrief({ projectPath: dir }).text, /Start the backend before trusting the Vite proxy/);
  });
});

test("POST /inbox then PATCH /inbox/:id resolve are exercised over HTTP", async () => {
  await withServer(async ({ dir, post, patch }) => {
    const created = await post("/inbox", { agent: "human", projectPath: dir, message: "Prioritize the auth bug" });
    assert.equal(created.status, 201);
    const item = await created.json();

    const resolved = await patch(`/inbox/${item.id}`, { agent: "human", action: "resolve", projectPath: dir });
    assert.equal(resolved.status, 200);
    assert.equal((await resolved.json()).id, item.id);
  });
});
