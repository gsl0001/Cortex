import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCortex } from "../src/index.js";
import { buildAgentCommand, buildTaskGoal, parseAgentEvent, createAgentLauncher, resolveModel, parseUsage, normalizeModelId, usageFromLog, gradeEvidence, memoryGuard, classifyFailure, diffConfinedTo, NEVER_AUTOPILOT, autopilotKey } from "../src/agentLauncher.js";
import { normalizeProjectPath } from "../src/storage.js";

test("classifyFailure tags auth/transient/permanent/stopped from the failure detail", () => {
  assert.equal(classifyFailure({ stopped: true }), "stopped");
  assert.equal(classifyFailure({ timedOut: true }), "transient"); // a wall-clock timeout is retryable
  assert.equal(classifyFailure({ detail: "API Error: 401 invalid credentials" }), "auth");
  assert.equal(classifyFailure({ detail: "the CLI needs /login; token expired" }), "auth");
  assert.equal(classifyFailure({ detail: "429 rate limit exceeded" }), "transient");
  assert.equal(classifyFailure({ detail: "ECONNRESET socket hang up" }), "transient");
  assert.equal(classifyFailure({ detail: "2 tests failed" }), "permanent");
  assert.equal(classifyFailure({}), "permanent");
});

async function withHub(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cortex-launcher-"));
  const hub = createCortex({ dbPath: join(dir, "hub.sqlite") });
  try { await fn(hub, dir); }
  finally { hub.close(); await rm(dir, { recursive: true, force: true }); }
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => child.emit("close", 143);
  return child;
}

// A stand-in for execFileSync that records every git invocation and returns canned output,
// so launcher unit tests exercise the worktree lifecycle without touching real git. Reports
// staged changes by default (so the success path commits); pass { staged: "" } for a no-op.
function fakeGit({ head = "main", staged = "src/x.js\n" } = {}) {
  const calls = [];
  const run = (_cmd, args) => {
    calls.push(args);
    const sub = args[2]; // args are always ["-C", <repo>, <subcommand>, ...]
    if (sub === "rev-parse") return `${head}\n`;
    if (sub === "diff") return staged;
    return "";
  };
  run.calls = calls;
  run.commits = () => calls.filter((a) => a[2] === "commit");
  run.worktreeAdds = () => calls.filter((a) => a[2] === "worktree" && a[3] === "add");
  run.worktreeRemoves = () => calls.filter((a) => a[2] === "worktree" && a[3] === "remove");
  return run;
}

const task = {
  title: "Fix launch",
  projectPath: "C:/repo",
  acceptanceCriteria: "Tests pass",
  relatedFiles: ["src/server.js"],
  verificationCommand: "npm test",
};

test("runner commands contain no task-controlled shell arguments", () => {
  assert.deepEqual(buildAgentCommand("codex", "sid"), {
    command: process.platform === "win32" ? "codex.cmd" : "codex",
    args: ["exec", "--json", "--sandbox", "workspace-write", "-"],
  });
  assert.deepEqual(buildAgentCommand("claude-code", "sid"), {
    command: process.platform === "win32" ? "claude.cmd" : "claude",
    args: ["-p", "--verbose", "--output-format", "stream-json", "--permission-mode", "auto", "--session-id", "sid"],
  });
  assert.throws(() => buildAgentCommand("other", "sid"), /agent must be/i);
});

test("model routing: defaults by task type, settings override, per-project beats global", () => {
  const settings = new Map();
  const storage = { getSetting: (key, dflt) => (settings.has(key) ? settings.get(key) : dflt) };
  // built-in defaults: heavy-reasoning types → opus, mechanical → sonnet, unknown → CLI default
  assert.equal(resolveModel(storage, { agent: "claude-code", type: "feature" }), "opus");
  assert.equal(resolveModel(storage, { agent: "claude-code", type: "infra" }), "sonnet");
  assert.equal(resolveModel(storage, { agent: "claude-code", type: "nonsense" }), undefined);
  // codex ships without tiers: CLI default model until settings define them
  assert.equal(resolveModel(storage, { agent: "codex", type: "feature" }), undefined);

  settings.set("modelRouting", { "claude-code": { feature: "haiku" }, codex: { feature: "gpt-5-codex" } });
  assert.equal(resolveModel(storage, { agent: "claude-code", type: "feature" }), "haiku");
  assert.equal(resolveModel(storage, { agent: "codex", type: "feature" }), "gpt-5-codex");
  // an agent/type the setting doesn't mention still falls back to the built-in default
  assert.equal(resolveModel(storage, { agent: "claude-code", type: "chore" }), "sonnet");

  // per-project override wins over the global setting (key uses the lowercased /-form path)
  settings.set("modelRouting.c:/repo", { "claude-code": { feature: "opus" } });
  assert.equal(resolveModel(storage, { agent: "claude-code", type: "feature", projectPath: "C:\\repo" }), "opus");

  // non-literal values never reach the CLI
  settings.set("modelRouting", { "claude-code": { feature: "opus --dangerously-skip" } });
  assert.equal(resolveModel(storage, { agent: "claude-code", type: "feature" }), undefined);
});

test("both agent commands take --model; absent model keeps the CLI default", () => {
  assert.deepEqual(buildAgentCommand("claude-code", "sid", "opus").args.slice(-2), ["--model", "opus"]);
  assert.ok(!buildAgentCommand("claude-code", "sid").args.includes("--model"));
  assert.deepEqual(buildAgentCommand("codex", null, "gpt-5-codex").args, ["exec", "--json", "--sandbox", "workspace-write", "--model", "gpt-5-codex", "-"]);
  assert.ok(!buildAgentCommand("codex", null).args.includes("--model"));
});

test("parseUsage pulls exact cost, tokens, and model from claude's result event", () => {
  const event = {
    type: "result", total_cost_usd: 0.52,
    usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 800, output_tokens: 50 },
    modelUsage: { "claude-opus-4-8[1m]": { inputTokens: 100 } }, // real shape: object keyed by model id
  };
  assert.deepEqual(parseUsage(event), { costUsd: 0.52, inputTokens: 920, outputTokens: 50, tokens: 970, model: "opus" });
  assert.equal(parseUsage({ type: "assistant" }), null); // non-terminal events carry no usage
  assert.equal(normalizeModelId("claude-sonnet-4-5"), "sonnet");
});

test("a completed claude run captures cost, tokens, and the model that ran", async () => {
  await withHub(async (hub, dir) => {
    const child = fakeChild();
    const launcher = createAgentLauncher({ hub, spawnImpl: () => child, logRoot: join(dir, "logs"), worktreesDir: join(dir, "wt"), git: fakeGit() });
    const task = hub.addTask({ type: "feature", projectPath: dir, title: "Build it", status: "ready" });
    const launched = await launcher.launch({ taskId: task.id, agent: "claude-code" });
    child.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "done", session_id: "s1", total_cost_usd: 0.5, usage: { input_tokens: 100, output_tokens: 50 }, modelUsage: ["claude-opus-4-8[1m]"] }) + "\n");
    child.emit("close", 0);
    const run = await launched.completed;
    assert.equal(run.costUsd, 0.5);
    assert.equal(run.model, "opus");
    assert.equal(run.tokens, 150);
  });
});

test("a failed run pushes run-fail and a parked review pushes needs-you", async () => {
  await withHub(async (hub, dir) => {
    const pushes = [];
    const notifier = { enabled: true, push: async (key, text) => { pushes.push({ key, text }); return true; } };

    const failChild = fakeChild();
    const launcher = createAgentLauncher({ hub, spawnImpl: () => failChild, logRoot: join(dir, "logs"), worktreesDir: join(dir, "wt"), git: fakeGit(), notifier });
    const failing = hub.addTask({ type: "chore", projectPath: dir, title: "Break it", status: "ready" });
    const launched = await launcher.launch({ taskId: failing.id, agent: "claude-code" });
    failChild.emit("close", 1);
    await launched.completed;
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].key, `run-fail:${failing.projectPath}`);
    assert.match(pushes[0].text, /Break it/);

    const okChild = fakeChild();
    const launcher2 = createAgentLauncher({ hub, spawnImpl: () => okChild, logRoot: join(dir, "logs"), worktreesDir: join(dir, "wt"), git: fakeGit(), notifier });
    const passing = hub.addTask({ type: "chore", projectPath: dir, title: "Ship it", status: "ready" });
    const launched2 = await launcher2.launch({ taskId: passing.id, agent: "claude-code" });
    okChild.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "All done. Verification: npm test passed and everything is green now.", session_id: "s9" }) + "\n");
    okChild.emit("close", 0);
    await launched2.completed;
    assert.equal(pushes.length, 2);
    assert.equal(pushes[1].key, "needs-you");
    assert.match(pushes[1].text, /Ship it/);
  });
});

test("usageFromLog reads the terminal result event off a run's on-disk log", async () => {
  await withHub(async (hub, dir) => {
    const logPath = join(dir, "run.jsonl");
    await writeFile(logPath, [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } }),
      JSON.stringify({ type: "result", total_cost_usd: 0.25, usage: { input_tokens: 200, output_tokens: 40 }, modelUsage: ["claude-sonnet-4-5"] }),
    ].join("\n"));
    assert.deepEqual(usageFromLog(logPath), { costUsd: 0.25, inputTokens: 200, outputTokens: 40, tokens: 240, model: "sonnet" });
    assert.equal(usageFromLog(join(dir, "missing.jsonl")), null); // gone/unreadable → null, never throws
  });
});

test("backfillRunCosts fills cost/model for legacy runs from their logs", async () => {
  await withHub(async (hub, dir) => {
    const task = hub.addTask({ type: "chore", projectPath: dir, title: "old", status: "ready" });
    const run = hub.startRun({ taskId: task.id, agent: "claude-code" });
    hub.updateRunProgress({ id: run.id, logPath: join(dir, "x.jsonl"), lastEvent: "done" });
    hub.finishRun({ id: run.id, outcome: "success", notes: "done" }); // legacy finish: no cost captured
    assert.equal(hub.storage.getRun(run.id).costUsd, null);
    const updated = hub.storage.backfillRunCosts({ parse: () => ({ costUsd: 0.3, inputTokens: 10, outputTokens: 5, tokens: 15, model: "opus" }) });
    assert.equal(updated, 1);
    assert.equal(hub.storage.getRun(run.id).costUsd, 0.3);
    assert.equal(hub.storage.getRun(run.id).model, "opus");
  });
});

test("task goal includes concrete work and verification", () => {
  const goal = buildTaskGoal(task);
  assert.match(goal, /Fix launch/);
  assert.match(goal, /Tests pass/);
  assert.match(goal, /src\/server.js/);
  assert.match(goal, /npm test/);
  assert.match(goal, /Preserve unrelated changes/);
});

test("event parser extracts session and useful activity", () => {
  assert.deepEqual(parseAgentEvent("codex", JSON.stringify({ type: "thread.started", thread_id: "abc" })), { sessionId: "abc", lastEvent: "Session started" });
  assert.equal(parseAgentEvent("claude-code", JSON.stringify({ type: "assistant", session_id: "def", message: { content: [{ type: "text", text: "Editing tests" }] } })).sessionId, "def");
  // claude's terminal event carries the run summary in `result`, not `item`/`message` — this
  // is what becomes task evidence, so it must not fall through to the literal type "result".
  assert.equal(parseAgentEvent("claude-code", JSON.stringify({ type: "result", session_id: "ghi", result: "Added cost ledger; npm test passed." })).lastEvent, "Added cost ledger; npm test passed.");
  // codex's terminal event carries it under item.text via agent_message; guard the codex final too
  assert.equal(parseAgentEvent("codex", JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Deal-score comps done." } })).lastEvent, "Deal-score comps done.");
  assert.equal(parseAgentEvent("codex", "not json"), null);
});

test("gradeEvidence flags thin summaries, missing verification, and lost log path", () => {
  // strong evidence: substantial summary that names the verification, log retained
  assert.deepEqual(gradeEvidence({ summary: "Added the cost ledger and npm test passed, 258/258 green.", verificationCommand: "npm test", logPath: "/logs/run.jsonl" }), { ok: true, problems: [] });
  // thin summary
  assert.deepEqual(gradeEvidence({ summary: "done", verificationCommand: null, logPath: "/x.jsonl" }).problems, ["summary missing or too thin"]);
  // configured verification never mentioned
  assert.ok(gradeEvidence({ summary: "Refactored the launcher and cleaned up the event parser for clarity.", verificationCommand: "npm test", logPath: "/x.jsonl" }).problems.some((p) => /verification/.test(p)));
  // log path retained is a hard check
  assert.ok(gradeEvidence({ summary: "Long enough summary that mentions tests passing fine.", verificationCommand: "npm test", logPath: "" }).problems.includes("run log path missing"));
  // no verification configured → its clause never fires
  assert.ok(gradeEvidence({ summary: "Documented the setup steps thoroughly in the README file.", verificationCommand: null, logPath: "/x.jsonl" }).ok);
});

test("memoryGuard: allow, warn, and block on prior/superseded work and thin metadata", () => {
  const task = { relatedFiles: ["src/server.js"], acceptanceCriteria: "done", verificationCommand: "npm test" };
  // clean project memory, well-specified task → allow
  assert.deepEqual(memoryGuard({ task }), { verdict: "allow", reasons: [] });
  // one prior superseded fix on the same file → warn
  const oneAttempt = memoryGuard({ task, superseded: [{ summary: "old fix", filesChanged: ["src/server.js"] }] });
  assert.equal(oneAttempt.verdict, "warn");
  assert.equal(oneAttempt.reasons[0].code, "prior-superseded");
  // two+ superseded fixes on the same file → block (work has repeatedly failed to stick)
  const many = memoryGuard({ task, superseded: [
    { summary: "a", filesChanged: ["src/server.js"] },
    { summary: "b", filesChanged: ["SRC\\SERVER.JS"] }, // path-shape/casing differences still match
  ] });
  assert.equal(many.verdict, "block");
  assert.equal(many.reasons.some((r) => r.level === "block" && r.code === "repeatedly-superseded"), true);
  // no acceptance criteria and no verification command → warn (unverifiable)
  assert.equal(memoryGuard({ task: { relatedFiles: [] } }).reasons[0].code, "unverifiable");
  // an open lesson and a project risk naming the file → warn
  const flagged = memoryGuard({ task,
    lessons: [{ status: "open", statement: "server.js single-writer, don't parallelize" }],
    risks: ["server.js is single-writer"] });
  assert.equal(flagged.verdict, "warn");
  assert.deepEqual(flagged.reasons.map((r) => r.code).sort(), ["open-lesson", "risk"]);
});

test("launch is blocked by Memory Guard before spawning, leaving a visible reason", async () => {
  await withHub(async (hub, dir) => {
    const task = hub.addTask({ type: "chore", projectPath: dir, title: "Rework server", status: "ready", relatedFiles: ["src/server.js"], acceptanceCriteria: "x", verificationCommand: "npm test" });
    // two prior fixes on the file that were later superseded (tried, didn't stick) → guard blocks
    const insert = (id, summary, supersedesId) => hub.storage.insertFix({ id, projectPath: dir, agent: "codex", summary, filesChanged: ["src/server.js"], supersedesId });
    insert("old-a", "attempt A that didn't stick");
    insert("new-b", "attempt B replacing A", "old-a");
    insert("old-c", "attempt C that didn't stick");
    insert("new-d", "attempt D replacing C", "old-c");
    const launcher = createAgentLauncher({ hub, spawnImpl: () => { throw new Error("must not spawn"); }, logRoot: join(dir, "logs") });
    await assert.rejects(() => launcher.launch({ taskId: task.id, agent: "codex" }), /Memory Guard \[block\]/);
    const blocked = hub.storage.getTask(task.id);
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.blockReason, /repeatedly failed to stick/);
    assert.equal(hub.storage.listRuns(dir).length, 0); // never got as far as a run
  });
});

test("a success with thin evidence enters review flagged, not silently", async () => {
  await withHub(async (hub, dir) => {
    const child = fakeChild();
    const launcher = createAgentLauncher({ hub, spawnImpl: () => child, logRoot: join(dir, "logs"), worktreesDir: join(dir, "wt"), git: fakeGit() });
    const task = hub.addTask({ type: "chore", projectPath: dir, title: "Ship", status: "ready", verificationCommand: "npm test" });
    const launched = await launcher.launch({ taskId: task.id, agent: "codex" });
    child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n');
    child.emit("close", 0);
    await launched.completed;
    const reviewed = hub.storage.getTask(task.id);
    assert.equal(reviewed.status, "review");
    assert.match(reviewed.evidence, /Weak evidence/);
    assert.match(reviewed.evidence, /verification/);
  });
});

test("launch claims task, records session, and moves success to review", async () => {
  await withHub(async (hub, dir) => {
    const child = fakeChild();
    const launcher = createAgentLauncher({ hub, spawnImpl: () => child, logRoot: join(dir, "logs"), worktreesDir: join(dir, "wt"), git: fakeGit() });
    const task = hub.addTask({ type: "chore", projectPath: dir, title: "Ship", status: "ready" });
    const launched = await launcher.launch({ taskId: task.id, agent: "codex" });
    assert.equal(hub.storage.getTask(task.id).status, "in_progress");
    child.stdout.write('{"type":"thread.started","thread_id":"thread-1"}\n');
    child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"Tests pass"}}\n');
    child.emit("close", 0);
    await launched.completed;
    assert.equal(hub.storage.getTask(task.id).status, "review");
    assert.equal(hub.storage.getRun(launched.run.id).sessionId, "thread-1");
  });
});

test("a successful run works inside a fresh per-run worktree, then commits and cleans up", async () => {
  await withHub(async (hub, dir) => {
    const child = fakeChild();
    const git = fakeGit();
    const worktreesDir = join(dir, "wt");
    let spawnOpts;
    const launcher = createAgentLauncher({
      hub,
      spawnImpl: (_cmd, _args, opts) => { spawnOpts = opts; return child; },
      logRoot: join(dir, "logs"), worktreesDir, git,
    });
    const task = hub.addTask({ type: "feature", projectPath: dir, title: "Build it", status: "ready" });
    const launched = await launcher.launch({ taskId: task.id, agent: "claude-code" });
    const wtPath = `${worktreesDir}/autopilot-${task.id}`;
    // worktree forked from the project's default branch (fakeGit rev-parse → "main") onto autopilot/<id>
    // (slice off the "-C <repo>" prefix — the stored projectPath is slash-normalized)
    assert.deepEqual(git.worktreeAdds()[0].slice(2), ["worktree", "add", wtPath, "-B", `autopilot/${task.id}`, "main"]);
    // the agent runs inside the isolated worktree, not the shared checkout
    assert.equal(spawnOpts.cwd, wtPath);
    child.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "Built the feature and npm test passed, all green.", session_id: "s1" }) + "\n");
    child.emit("close", 0);
    const run = await launched.completed;
    // agent's work committed to the run branch, then the worktree dir torn down (branch survives)
    assert.deepEqual(git.commits()[0], ["-C", wtPath, "commit", "-m", `autopilot: ${task.title}`]);
    assert.equal(git.worktreeRemoves().length, 1);
    assert.equal(run.branch, `autopilot/${task.id}`);
    assert.equal(run.worktreePath, wtPath);
    assert.equal(hub.storage.getTask(task.id).status, "review");
  });
});

test("a failed run still tears down the worktree and blocks the task", async () => {
  await withHub(async (hub, dir) => {
    const child = fakeChild();
    const git = fakeGit();
    const launcher = createAgentLauncher({ hub, spawnImpl: () => child, logRoot: join(dir, "logs"), worktreesDir: join(dir, "wt"), git });
    const task = hub.addTask({ type: "chore", projectPath: dir, title: "Flaky", status: "ready" });
    const launched = await launcher.launch({ taskId: task.id, agent: "codex" });
    child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"boom"}}\n');
    child.emit("close", 1);
    await launched.completed;
    // no commit on a failed run; worktree still removed; task blocked (existing behavior preserved)
    assert.equal(git.commits().length, 0);
    assert.equal(git.worktreeRemoves().length, 1);
    assert.equal(hub.storage.getTask(task.id).status, "blocked");
  });
});

test("a spawn/worktree launch failure blocks with a [fail:CLASS] tag the dispatcher can read", async () => {
  await withHub(async (hub, dir) => {
    // Untagged launch failures read as "permanent" to the dispatcher's failureClass(), so a
    // transient spawn error (or a git hiccup creating the worktree) would never be retried.
    const launcher = createAgentLauncher({
      hub,
      spawnImpl: () => { throw new Error("ECONNRESET while starting agent"); },
      logRoot: join(dir, "logs"), worktreesDir: join(dir, "wt"), git: fakeGit(),
    });
    const task = hub.addTask({ type: "chore", projectPath: dir, title: "Doomed", status: "ready" });
    await assert.rejects(() => launcher.launch({ taskId: task.id, agent: "codex" }), /ECONNRESET/);
    const blocked = hub.storage.getTask(task.id);
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.blockReason, /^\[fail:transient\] Agent launch failed/);
  });
});

test("a failed commit preserves the worktree and fails the run instead of faking success", async () => {
  await withHub(async (hub, dir) => {
    const child = fakeChild();
    const git = fakeGit();
    // commit throws (e.g. no user.name/email in a fresh worktree); status reports dirty —
    // the worktree is the only copy of the agent's work, so it must not be force-removed.
    const gitFailCommit = (cmd, args, opts) => {
      if (args[2] === "commit") throw new Error("empty ident name (for <>) not allowed");
      if (args[2] === "status") return " M src/x.js\n";
      return git(cmd, args, opts);
    };
    const launcher = createAgentLauncher({ hub, spawnImpl: () => child, logRoot: join(dir, "logs"), worktreesDir: join(dir, "wt"), git: gitFailCommit });
    const task = hub.addTask({ type: "feature", projectPath: dir, title: "Big change", status: "ready" });
    const launched = await launcher.launch({ taskId: task.id, agent: "codex" });
    child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n');
    child.emit("close", 0);
    const run = await launched.completed;
    assert.equal(run.outcome, "fail");                       // not reported as success
    assert.equal(git.worktreeRemoves().length, 0);           // worktree kept for manual rescue
    const blocked = hub.storage.getTask(task.id);
    assert.equal(blocked.status, "blocked");                 // not moved to review
    assert.match(blocked.blockReason, /^\[fail:permanent\].*work preserved in worktree/);
  });
});

test("a soft guard warn is carried into review evidence under the surfacing sentinel", async () => {
  await withHub(async (hub, dir) => {
    const child = fakeChild();
    const launcher = createAgentLauncher({ hub, spawnImpl: () => child, logRoot: join(dir, "logs"), worktreesDir: join(dir, "wt"), git: fakeGit() });
    // no acceptanceCriteria and no verificationCommand -> memoryGuard "unverifiable" warn;
    // the warn must reach the reviewer via evidence (server.js GUARD_RE parses it off the front)
    const task = hub.addTask({ type: "chore", projectPath: dir, title: "Vague", status: "ready" });
    const launched = await launcher.launch({ taskId: task.id, agent: "codex" });
    child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"done, all tests pass"}}\n');
    child.emit("close", 0);
    await launched.completed;
    const reviewed = hub.storage.getTask(task.id);
    assert.equal(reviewed.status, "review"); // warn still runs — only block refuses
    assert.match(reviewed.evidence, /^Memory Guard \[warn\]: .*no acceptance criteria/);
  });
});

test("a run that never closes is killed by the timeout and the task ends blocked", async () => {
  await withHub(async (hub, dir) => {
    const child = fakeChild();
    child.kill = () => child.emit("close", 143); // kill -> close, like a real child
    const launcher = createAgentLauncher({ hub, spawnImpl: () => child, logRoot: join(dir, "logs"), worktreesDir: join(dir, "wt"), git: fakeGit(), timeoutMs: 50 });
    const task = hub.addTask({ type: "chore", projectPath: dir, title: "Hangs", status: "ready" });
    const launched = await launcher.launch({ taskId: task.id, agent: "codex" });
    // never emit close ourselves — the timer fires, kills the child, and the slot resolves
    await launched.completed;
    const blocked = hub.storage.getTask(task.id);
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.blockReason, /timed out/i);
  });
});

test("launch refuses tasks in a NEVER_AUTOPILOT repo before claiming them", async () => {
  await withHub(async (hub) => {
    const launcher = createAgentLauncher({ hub, spawnImpl: () => { throw new Error("must not spawn"); }, logRoot: join(tmpdir(), "unused-logs") });
    const task = hub.addTask({ type: "chore", projectPath: "/protected/repo", title: "Touch protected repo", status: "ready" });
    NEVER_AUTOPILOT.add(autopilotKey(task.projectPath)); // key exactly as the guard will compute it
    await assert.rejects(() => launcher.launch({ taskId: task.id, agent: "claude-code" }), /human-only/);
    // guard fires before the claim: task untouched, no run recorded
    assert.equal(hub.storage.getTask(task.id).status, "ready");
    assert.equal(hub.storage.listRuns(task.projectPath).length, 0);
  });
});

test("CORTEX_NEVER_AUTOPILOT env string is comma-split, trimmed, and normalized like NEVER_AUTOPILOT itself", () => {
  // NEVER_AUTOPILOT is a module-level constant computed once at import time from
  // process.env.CORTEX_NEVER_AUTOPILOT, so it can't be re-derived by mutating
  // process.env after the module has already loaded. This re-derives the same
  // pipeline the module uses (split -> trim -> filter -> normalize) against a
  // controlled input string, rather than the live env var, so the parsing rules
  // themselves stay covered.
  //
  // Paths are placed under os.tmpdir() so normalizeProjectPath skips git-root
  // resolution entirely (see storage.js's isUnderTmpdir), keeping this
  // deterministic without depending on any real git repo.
  const repoA = join(tmpdir(), "Never-Autopilot-Repo-A");
  const repoB = join(tmpdir(), "never-autopilot-repo-b");

  // Trailing separator (empty final entry) and mixed casing/spacing, exactly
  // the shape the issue calls out.
  const envValue = ` ${repoA} , ${repoB.toUpperCase()},`;

  const derive = (raw) =>
    new Set(
      (raw || "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => autopilotKey(normalizeProjectPath(p))),
    );

  const derived = derive(envValue);

  assert.equal(derived.size, 2); // trailing separator produced no 3rd (empty) entry
  assert.ok(derived.has(autopilotKey(normalizeProjectPath(repoA))));
  // repoB was uppercased in the env string; autopilotKey lowercases, so it
  // must still collapse onto the same key as the canonical-case path.
  assert.ok(derived.has(autopilotKey(normalizeProjectPath(repoB))));
});

test("stopRun kills a running agent and marks its task Stopped by user", async () => {
  await withHub(async (hub, dir) => {
    const child = fakeChild(); // fakeChild.kill emits close(143), like a real killed process
    const launcher = createAgentLauncher({ hub, spawnImpl: () => child, logRoot: join(dir, "logs"), worktreesDir: join(dir, "wt"), git: fakeGit() });
    const task = hub.addTask({ type: "chore", projectPath: dir, title: "Long run", status: "ready" });
    const launched = await launcher.launch({ taskId: task.id, agent: "codex" });
    assert.equal(hub.storage.getTask(task.id).status, "in_progress");
    const killed = await launcher.stopRun(launched.run.id);
    assert.equal(killed, true);
    await launched.completed;
    const blocked = hub.storage.getTask(task.id);
    assert.equal(blocked.status, "blocked");
    // reason must read as a deliberate stop, not "exited with code 143"
    assert.match(blocked.blockReason, /Stopped by user/);
  });
});

test("stopRun returns false when the run is not active", async () => {
  await withHub(async (hub, dir) => {
    const launcher = createAgentLauncher({ hub, spawnImpl: () => fakeChild(), logRoot: join(dir, "logs") });
    assert.equal(await launcher.stopRun("no-such-run"), false);
  });
});

test("a failed run's block reason carries the agent's final message, not just the exit code", async () => {
  await withHub(async (hub, dir) => {
    const child = fakeChild();
    const launcher = createAgentLauncher({ hub, spawnImpl: () => child, logRoot: join(dir, "logs"), worktreesDir: join(dir, "wt"), git: fakeGit() });
    const task = hub.addTask({ type: "chore", projectPath: dir, title: "Auth casualty", status: "ready" });
    const launched = await launcher.launch({ taskId: task.id, agent: "codex" });
    child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"Failed to authenticate. API Error: 401"}}\n');
    child.emit("close", 1);
    await launched.completed;
    const blocked = hub.storage.getTask(task.id);
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.blockReason, /code 1: Failed to authenticate\. API Error: 401/);
  });
});

test("spawn failure blocks the claimed task", async () => {
  await withHub(async (hub, dir) => {
    const git = fakeGit();
    const launcher = createAgentLauncher({ hub, spawnImpl: () => { throw new Error("missing binary"); }, logRoot: join(dir, "logs"), worktreesDir: join(dir, "wt"), git });
    const task = hub.addTask({ type: "chore", projectPath: dir, title: "Ship", status: "ready" });
    await assert.rejects(() => launcher.launch({ taskId: task.id, agent: "claude-code" }), /missing binary/);
    assert.equal(hub.storage.getTask(task.id).status, "blocked");
    // worktree was created before the spawn threw, so it must be torn down on the launch-error path
    assert.equal(git.worktreeRemoves().length, 1);
  });
});

// ---- post-run verification, first-pass review, and the auto-merge tier ----

test("diffConfinedTo: every changed file must be one the task declared", () => {
  assert.equal(diffConfinedTo(["src/x.js"], ["src/x.js"]), true);
  assert.equal(diffConfinedTo(["deep/nested/x.js"], ["src/x.js"]), true); // basename key
  assert.equal(diffConfinedTo(["src/x.js", "src/other.js"], ["src/x.js"]), false);
  assert.equal(diffConfinedTo(["src/x.js"], []), false);       // no declared files -> never confined
  assert.equal(diffConfinedTo([], ["src/x.js"]), false);       // no diff -> nothing to merge
});

function successChild() {
  const child = fakeChild();
  setImmediate(() => {
    child.stdout.write(`${JSON.stringify({ type: "result", result: "All tests pass. Done.", session_id: "s1" })}\n`);
    child.emit("close", 0);
  });
  return child;
}

test("auto-merge: low-risk type + verified green + reviewer clean + confined diff completes the task", async () => {
  await withHub(async (hub, dir) => {
    const merges = [];
    const launcher = createAgentLauncher({
      hub, spawnImpl: successChild, logRoot: join(dir, "logs"), worktreesDir: join(dir, "wt"),
      git: fakeGit(), // diff calls report src/x.js -> changed files = [src/x.js]
      verifyImpl: async () => ({ exit: 0, output: "327 passing" }),
      reviewImpl: async () => ({ verdict: "clean", notes: "no findings" }),
      mergeImpl: async (input) => { merges.push(input); return { merged: true }; },
    });
    const t = hub.addTask({ type: "chore", projectPath: dir, title: "Tidy", status: "ready", relatedFiles: ["src/x.js"], verificationCommand: "npm test" });
    const { completed } = await launcher.launch({ taskId: t.id, agent: "claude-code" });
    const run = await completed;
    assert.equal(run.verificationExit, 0);
    assert.equal(merges.length, 1);
    const after = hub.storage.getTask(t.id);
    assert.equal(after.status, "done");
    assert.match(after.evidence, /Auto-merged/);
    assert.match(after.evidence, /Reviewer \[clean]/);
    assert.match(after.evidence, /Verified: npm test exited 0/);
  });
});

test("failed machine verification parks the task in review with a warning, never auto-merges", async () => {
  await withHub(async (hub, dir) => {
    const merges = [];
    const launcher = createAgentLauncher({
      hub, spawnImpl: successChild, logRoot: join(dir, "logs"), worktreesDir: join(dir, "wt"),
      git: fakeGit(),
      verifyImpl: async () => ({ exit: 1, output: "2 failing" }),
      reviewImpl: async () => ({ verdict: "clean", notes: "no findings" }),
      mergeImpl: async () => { merges.push(1); return { merged: true }; },
    });
    const t = hub.addTask({ type: "chore", projectPath: dir, title: "Tidy", status: "ready", relatedFiles: ["src/x.js"], verificationCommand: "npm test" });
    const { completed } = await launcher.launch({ taskId: t.id, agent: "claude-code" });
    const run = await completed;
    assert.equal(run.verificationExit, 1);
    assert.equal(merges.length, 0);
    const after = hub.storage.getTask(t.id);
    assert.equal(after.status, "review");
    assert.match(after.evidence, /Verification failed \(exit 1\)/);
  });
});

test("non-low-risk task types always go to human review even when every gate is green", async () => {
  await withHub(async (hub, dir) => {
    const merges = [];
    const launcher = createAgentLauncher({
      hub, spawnImpl: successChild, logRoot: join(dir, "logs"), worktreesDir: join(dir, "wt"),
      git: fakeGit(),
      verifyImpl: async () => ({ exit: 0, output: "green" }),
      reviewImpl: async () => ({ verdict: "clean", notes: "no findings" }),
      mergeImpl: async () => { merges.push(1); return { merged: true }; },
    });
    const t = hub.addTask({ type: "feature", projectPath: dir, title: "Big feature", status: "ready", relatedFiles: ["src/x.js"], verificationCommand: "npm test" });
    const { completed } = await launcher.launch({ taskId: t.id, agent: "claude-code" });
    await completed;
    assert.equal(merges.length, 0);
    assert.equal(hub.storage.getTask(t.id).status, "review");
  });
});

test("a reviewer concern blocks auto-merge and rides along in the review evidence", async () => {
  await withHub(async (hub, dir) => {
    const launcher = createAgentLauncher({
      hub, spawnImpl: successChild, logRoot: join(dir, "logs"), worktreesDir: join(dir, "wt"),
      git: fakeGit(),
      verifyImpl: async () => ({ exit: 0, output: "green" }),
      reviewImpl: async () => ({ verdict: "concerns", notes: "hardcoded token in src/x.js VERDICT: concerns" }),
      mergeImpl: async () => ({ merged: true }),
    });
    const t = hub.addTask({ type: "chore", projectPath: dir, title: "Tidy", status: "ready", relatedFiles: ["src/x.js"], verificationCommand: "npm test" });
    const { completed } = await launcher.launch({ taskId: t.id, agent: "claude-code" });
    await completed;
    const after = hub.storage.getTask(t.id);
    assert.equal(after.status, "review");
    assert.match(after.evidence, /Reviewer \[concerns]/);
    assert.match(after.evidence, /hardcoded token/);
  });
});
