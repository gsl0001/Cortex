import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createCortex } from "../src/index.js";
import { buildEodReport, parseDrift, collectDrift, renderEodText, renderEodHtml } from "../src/eod.js";

// Same convention as test/cli.test.js's `run` helper: spawn the real CLI against a --db path.
// CORTEX_HUB_URL defaults to a closed port so the health check fails fast and deterministically
// instead of depending on whatever (if anything) is listening on 127.0.0.1:4317 on this machine.
function invokeCliRaw(args, { dbPath, env = {} } = {}) {
  const result = spawnSync(process.execPath, ["src/cli.js", ...args, "--db", dbPath], {
    encoding: "utf8",
    env: { ...process.env, CORTEX_HUB_URL: "http://127.0.0.1:9", ...env },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function invokeCli(args, options) {
  const result = invokeCliRaw(args, options);
  if (result.code !== 0) throw new Error(result.err || `cli exited ${result.code}`);
  return result.out;
}

async function withHub(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cortex-eod-test-"));
  const hub = createCortex({ dbPath: join(dir, "cortex.sqlite") });
  try {
    await fn(hub, dir);
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// One row per section; a fixed "now" so today-boundaries are deterministic.
const NOW = new Date("2026-08-07T17:45:00");

test("buildEodReport places each record in its section", async () => {
  await withHub(async (hub, dir) => {
    const db = hub.storage.db;
    const today = "2026-08-07T10:00:00.000Z";
    const lastWeek = "2026-08-01T10:00:00.000Z";
    const id = () => crypto.randomUUID();

    hub.upsertProjectProfile({ projectPath: dir, name: "Demo", mode: "tooling", summary: "s", standardCommands: [], risks: [] });

    // Done today: task with evidence + one missing evidence (verify queue)
    db.prepare(`INSERT INTO workflow_tasks (id, project_path, title, status, priority, related_files, verification_command, evidence, created_at, updated_at)
      VALUES (?, ?, 'shipped thing', 'done', 'high', '[]', 'npm test', 'npm test passed', ?, ?)`).run(id(), dir, lastWeek, today);
    db.prepare(`INSERT INTO workflow_tasks (id, project_path, title, status, priority, related_files, verification_command, evidence, created_at, updated_at)
      VALUES (?, ?, 'unverified thing', 'done', 'high', '[]', 'npm test', NULL, ?, ?)`).run(id(), dir, lastWeek, today);
    // Fix today without verification (verify queue) and one verified (done)
    db.prepare(`INSERT INTO fix_entries (id, project_path, agent, summary, files_changed, verification, created_at)
      VALUES (?, ?, 'a', 'verified fix', '[]', 'npm test passed', ?)`).run(id(), dir, today);
    db.prepare(`INSERT INTO fix_entries (id, project_path, agent, summary, files_changed, verification, created_at)
      VALUES (?, ?, 'a', 'unverified fix', '[]', NULL, ?)`).run(id(), dir, today);
    // Quarantined fix today: must never surface in done.fixes
    db.prepare(`INSERT INTO fix_entries (id, project_path, agent, summary, files_changed, verification, quality_status, created_at)
      VALUES (?, ?, 'a', 'quarantined fix', '[]', 'npm test passed', 'quarantined', ?)`).run(id(), dir, today);
    // Decision + research today (done section)
    const decisionAId = id();
    db.prepare(`INSERT INTO decision_entries (id, project_path, agent, decision, rationale, created_at)
      VALUES (?, ?, 'a', 'use X', 'simplest', ?)`).run(decisionAId, dir, today);
    // Superseding decision: only this one (not the superseded original) should appear
    db.prepare(`INSERT INTO decision_entries (id, project_path, agent, decision, rationale, supersedes_id, created_at)
      VALUES (?, ?, 'a', 'use Y instead', 'better fit', ?, ?)`).run(id(), dir, decisionAId, today);
    db.prepare(`INSERT INTO research_entries (id, project_path, agent, question, sources, evidence, finding, reuse_tags, created_at)
      VALUES (?, ?, 'a', 'why?', '[]', '[]', 'because', '[]', ?)`).run(id(), dir, today);
    // Needs eyes: unresolved inbox item from LAST WEEK (any age counts), blocked task
    db.prepare(`INSERT INTO inbox_items (id, project_path, author, message, created_at, expires_at)
      VALUES (?, ?, 'human', 'look at this', ?, '2099-01-01')`).run(id(), dir, lastWeek);
    db.prepare(`INSERT INTO workflow_tasks (id, project_path, title, status, priority, related_files, block_reason, created_at, updated_at)
      VALUES (?, ?, 'stuck thing', 'blocked', 'high', '[]', 'missing adb', ?, ?)`).run(id(), dir, lastWeek, lastWeek);
    // Tonight: open task + stale claim (claimed, updated >24h ago)
    db.prepare(`INSERT INTO workflow_tasks (id, project_path, title, status, priority, related_files, created_at, updated_at)
      VALUES (?, ?, 'open thing', 'open', 'medium', '[]', ?, ?)`).run(id(), dir, lastWeek, lastWeek);
    db.prepare(`INSERT INTO workflow_tasks (id, project_path, title, status, priority, assigned_agent, related_files, created_at, updated_at)
      VALUES (?, ?, 'stale claim', 'in_progress', 'high', 'codex', '[]', ?, ?)`).run(id(), dir, lastWeek, lastWeek);

    const report = buildEodReport({ db, now: NOW });

    assert.deepEqual(report.done.tasks.map((t) => t.title), ["shipped thing", "unverified thing"]);
    assert.deepEqual(report.done.fixes.map((f) => f.summary), ["verified fix", "unverified fix"]);
    assert.equal(report.done.decisions.length, 1);
    assert.equal(report.done.decisions[0].decision, "use Y instead");
    assert.equal(report.done.research.length, 1);
    assert.deepEqual(report.needsEyes.inbox.map((i) => i.message), ["look at this"]);
    assert.deepEqual(report.needsEyes.blocked.map((t) => t.block_reason), ["missing adb"]);
    assert.deepEqual(report.verifyQueue.tasks.map((t) => t.title), ["unverified thing"]);
    assert.deepEqual(report.verifyQueue.fixes.map((f) => f.summary), ["unverified fix"]);
    assert.deepEqual(report.tonight.open.map((t) => t.title), ["open thing"]);
    assert.deepEqual(report.tonight.staleClaims.map((t) => t.title), ["stale claim"]);
    assert.equal(report.date, "2026-08-07");
  });
});

test("a failing section reports an error without killing the rest", async () => {
  await withHub(async (hub) => {
    const db = hub.storage.db;
    db.exec("DROP TABLE inbox_items"); // sabotage one section
    const report = buildEodReport({ db, now: NOW });
    assert.ok(report.needsEyes.error, "sabotaged section carries an error");
    assert.ok(Array.isArray(report.tonight.open), "other sections still render");
  });
});

test("parseDrift reads porcelain + ahead/behind counts", () => {
  const drift = parseDrift({
    project: "C:/work/demo",
    porcelain: " M SETUP.md\n?? new.md\n",
    aheadBehind: "0\t2", // rev-list --left-right --count HEAD...@{upstream}: ahead \t behind
  });
  assert.deepEqual(drift, {
    project: "C:/work/demo",
    dirtyFiles: 2,
    ahead: 0,
    behind: 2,
  });
});

test("parseDrift with clean output returns zeros", () => {
  const drift = parseDrift({ project: "p", porcelain: "", aheadBehind: "0\t0" });
  assert.deepEqual(drift, { project: "p", dirtyFiles: 0, ahead: 0, behind: 0 });
});

test("collectDrift marks non-repo paths unavailable instead of throwing", () => {
  const results = collectDrift(["C:/definitely/not/a/repo"], {
    runGit: () => { throw new Error("not a git repository"); },
  });
  assert.equal(results[0].unavailable, true);
});

const SAMPLE = {
  date: "2026-08-07",
  generatedAt: "2026-08-07T17:45:00.000Z",
  done: { tasks: [{ project_path: "C:/work/demo", title: "shipped thing", evidence: "npm test passed" }], fixes: [], decisions: [], research: [], sessions: [] },
  needsEyes: { inbox: [{ project_path: "C:/work/demo", author: "human", message: "look at this" }], blocked: [], proposals: [], failedRuns: [] },
  verifyQueue: { tasks: [{ project_path: "C:/work/demo", title: "unverified thing", verification_command: "npm test" }], fixes: [], drift: [{ project: "C:/work/demo", dirtyFiles: 1, ahead: 0, behind: 2 }] },
  tonight: { open: [{ project_path: "C:/work/demo", title: "open thing", priority: "high" }], staleClaims: [] },
};

test("renderEodText leads with headline counts and includes every section", () => {
  const text = renderEodText(SAMPLE);
  assert.match(text, /1 done · 1 need eyes · 2 to verify/); // verify = 1 task + 1 drifted repo
  assert.match(text, /- demo: 1 task/); // done is a per-project rollup, not item lines
  assert.match(text, /look at this/);
  assert.match(text, /unverified thing — run: npm test/);
  assert.match(text, /2 behind/);
  assert.match(text, /open thing/);
});

test("renderEodText stays under the Telegram limit and truncates with a marker", () => {
  const big = { ...SAMPLE, tonight: { staleClaims: [], open: Array.from({ length: 300 }, (_, i) => ({ project_path: "p", title: `task ${i} ${"x".repeat(40)}`, priority: "low" })) } };
  const text = renderEodText(big);
  assert.ok(text.length <= 4096, `got ${text.length}`);
  assert.match(text, /\+\d+ more, see attached/);
});

test("renderEodHtml is self-contained and escapes content", () => {
  const html = renderEodHtml({ ...SAMPLE, done: { ...SAMPLE.done, tasks: [{ project_path: "p", title: "<script>x</script>", evidence: "" }] } });
  assert.match(html, /<style>/);
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("an empty day still renders the quiet-day line", () => {
  const empty = { date: "2026-08-07", generatedAt: "", done: { tasks: [], fixes: [], decisions: [], research: [], sessions: [] }, needsEyes: { inbox: [], blocked: [], proposals: [], failedRuns: [] }, verifyQueue: { tasks: [], fixes: [], drift: [] }, tonight: { open: [{ project_path: "p", title: "t", priority: "low" }], staleClaims: [] } };
  assert.match(renderEodText(empty), /quiet day, 1 open task/i);
});

test("cli eod --json emits the report", async () => {
  await withHub(async (hub, dir) => {
    // seed one open task so output is non-empty
    hub.storage.db.prepare(`INSERT INTO workflow_tasks (id, project_path, title, status, priority, related_files, created_at, updated_at)
      VALUES ('t1', ?, 'open thing', 'open', 'high', '[]', '2026-08-01', '2026-08-01')`).run(dir);
    const out = invokeCli(["eod", "--json"], { dbPath: join(dir, "cortex.sqlite") });
    const report = JSON.parse(out);
    assert.equal(report.tonight.open[0].title, "open thing");
  });
});

test("cli eod --date banana fails with a clean message, not a raw RangeError", async () => {
  await withHub(async (hub, dir) => {
    const result = invokeCliRaw(["eod", "--date", "banana"], { dbPath: join(dir, "cortex.sqlite") });
    assert.notEqual(result.code, 0);
    assert.match(result.err, /date must be a valid YYYY-MM-DD date/);
    assert.doesNotMatch(result.err, /RangeError|Invalid time value/);
  });
});

test("renderEodText and renderEodHtml render finished sessions in Done today", () => {
  const withSession = { ...SAMPLE, done: { ...SAMPLE.done, sessions: [{ project_path: "C:/work/demo", agent: "codex", goal: "ship thing" }] } };
  const text = renderEodText(withSession);
  assert.match(text, /- demo: 1 task, 1 session/); // sessions count in the rollup line
  const html = renderEodHtml(withSession);
  assert.match(html, /session \(codex\)/);
  assert.match(html, /ship thing/);
});

function buildHugeReport(extra = {}) {
  const longItem = (i) => `task ${i} ${"x".repeat(60)}`;
  return {
    date: "2026-08-07",
    generatedAt: "2026-08-07T17:45:00.000Z",
    done: {
      tasks: Array.from({ length: 120 }, (_, i) => ({ project_path: "p", title: longItem(i), evidence: "x".repeat(40) })),
      fixes: [], decisions: [], research: [], sessions: [],
    },
    needsEyes: {
      inbox: Array.from({ length: 120 }, (_, i) => ({ project_path: "p", author: "human", message: longItem(i) })),
      blocked: [], proposals: [], failedRuns: [],
    },
    verifyQueue: {
      tasks: Array.from({ length: 120 }, (_, i) => ({ project_path: "p", title: longItem(i), verification_command: "npm test" })),
      fixes: [], drift: [],
    },
    tonight: {
      open: Array.from({ length: 120 }, (_, i) => ({ project_path: "p", title: longItem(i), priority: "low" })),
      staleClaims: [],
    },
    ...extra,
  };
}

test("renderEodText never overflows or cuts mid-line when every section is oversized", () => {
  const text = renderEodText(buildHugeReport());
  assert.ok(text.length <= 4096, `got ${text.length}`);
  const lastLine = text.split("\n").at(-1);
  assert.ok(/see attached$/.test(lastLine) || lastLine.length < 200, `last line looked cut off: ${JSON.stringify(lastLine)}`);
});

test("renderEodText always includes the health line, even when every section is oversized", () => {
  const huge = buildHugeReport({ health: "server up · db 12.3MB" });
  const text = renderEodText(huge);
  assert.ok(text.length <= 4096, `got ${text.length}`);
  assert.ok(text.includes(huge.health));
});
