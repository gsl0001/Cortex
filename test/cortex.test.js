import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createCortex,
  normalizeProjectPath,
} from "../src/index.js";

async function withHub(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cortex-test-"));
  const dbPath = join(dir, "cortex.sqlite");
  const hub = createCortex({ dbPath });

  try {
    await fn(hub, dir);
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("normalizes project paths for stable project identity", () => {
  const normalized = normalizeProjectPath(".");

  assert.equal(typeof normalized, "string");
  assert.ok(normalized.length > 1);
  assert.equal(normalized.includes(".."), false);
});

test("a linked git worktree normalizes to the same project identity as its main repo", async () => {
  // Note: this fixture repo/worktree live OUTSIDE the OS temp dir on purpose (unlike every
  // other test's mkdtemp'd `dir`) — normalizeProjectPath deliberately skips git-root
  // resolution for anything under the temp dir (scratch space, see storage.js), so a fixture
  // meant to exercise that resolution can't live there.
  const dir = await mkdtemp(join(process.cwd(), ".cortex-worktree-test-"));
  const repo = join(dir, "repo");
  const worktree = join(dir, "worktree");
  try {
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "feature", worktree]);

    const mainId = normalizeProjectPath(repo);
    const worktreeId = normalizeProjectPath(worktree);
    assert.equal(worktreeId, mainId, "worktree must resolve to the main repo's project identity, not its own directory");
    // sanity: it resolved to the repo itself, not some unrelated ancestor (e.g. the outer test run's own repo)
    assert.ok(/[\\/]repo$/.test(mainId), `expected the repo root, got ${mainId}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findSupersedableFix finds a match past the old 50-row scan cap", async () => {
  await withHub(async (hub, dir) => {
    // 60 unrelated fixes, then one touching the target file, all older than the cap used to allow
    for (let i = 0; i < 59; i += 1) {
      hub.storage.insertFix({ id: crypto.randomUUID(), projectPath: dir, agent: "a", summary: `unrelated fix ${i}`, filesChanged: [`unrelated${i}.js`] });
    }
    const oldest = hub.storage.insertFix({ id: crypto.randomUUID(), projectPath: dir, agent: "a", summary: "the real target fix", filesChanged: ["target.js"] });

    const found = hub.storage.findSupersedableFix({ projectPath: dir, filesChanged: ["target.js"] });
    assert.equal(found?.id, oldest.id);
  });
});

if (process.platform === "win32") {
  test("listFixes/listResearch/listDecisions match project paths case-insensitively on Windows", async () => {
    await withHub(async (hub, dir) => {
      hub.storage.insertFix({ id: crypto.randomUUID(), projectPath: dir, agent: "a", summary: "case test fix", filesChanged: [] });
      hub.addResearchEntry({ projectPath: dir, agent: "a", question: "q?", finding: "f" });
      hub.captureCandidate({ projectPath: dir, agent: "a", message: "Decision: use X. Rationale: simplest." });

      const upper = dir.toUpperCase();
      assert.equal(hub.storage.listFixes(upper).length, 1);
      assert.equal(hub.storage.listResearch(upper).length, 1);
      assert.equal(hub.storage.listDecisions(upper).length, 1);
    });
  });
}

test("tracks workflow tasks through claim and done states", async () => {
  await withHub(async (hub, projectPath) => {
    const task = hub.addTask({ type: "chore",
      projectPath,
      title: "Fix report export photo edge cases",
      priority: "high",
      relatedFiles: ["src/reports/ExportLogsService.ts"],
      acceptanceCriteria: "Zero-photo and many-photo reports export correctly",
      verificationCommand: "npm run release:check",
    });

    const claimed = hub.claimTask({
      id: task.id,
      agent: "claude-code",
      branch: "feature/report-export",
    });
    const done = hub.completeTask({
      id: task.id,
      evidence: "npm run release:check passed",
      commitSha: "abc1234",
    });

    assert.equal(claimed.status, "in_progress");
    assert.equal(claimed.assignedAgent, "claude-code");
    assert.equal(done.status, "done");
    assert.equal(done.evidence, "npm run release:check passed");
    assert.ok(done.completedAt);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const completedAgain = hub.completeTask({
      id: task.id,
      evidence: "npm test passed too",
    });
    assert.equal(completedAgain.completedAt, done.completedAt);
    assert.equal(completedAgain.evidence, "npm test passed too");
  });
});

test("leaving 'blocked' clears the stale block reason", async () => {
  await withHub(async (hub, projectPath) => {
    const task = hub.addTask({ type: "chore", projectPath, title: "Flaky migration" });
    hub.blockTask({ id: task.id, reason: "Agent exited with code 1" });

    const reopened = hub.editTask({ id: task.id, status: "ready" });
    assert.equal(reopened.status, "ready");
    assert.equal(reopened.blockReason, null);

    // re-blocking records the new reason; completing clears it again
    const reblocked = hub.blockTask({ id: task.id, reason: "still failing" });
    assert.equal(reblocked.blockReason, "still failing");
    const done = hub.completeTask({ id: task.id, evidence: "fixed and verified" });
    assert.equal(done.blockReason, null);
  });
});

test("records research findings and fixes for project recall", async () => {
  await withHub(async (hub, projectPath) => {
    hub.upsertProjectProfile({
      projectPath,
      name: "SitesLog",
      mode: "Expo release hardening",
      summary: "Preserve dirty UI edits and validate with release:check.",
      standardCommands: ["npm run release:check"],
      risks: ["Android e2e may be blocked by missing adb or Java."],
    });

    const research = hub.addResearchEntry({
      projectPath,
      agent: "codex",
      question: "Why did Android e2e fail?",
      sources: ["terminal", "Expo logs"],
      evidence: ["adb was not recognized"],
      finding: "Host Android tooling is missing.",
      fixMade: "Documented tunnel fallback and Mac handoff.",
      verification: "npx expo start --tunnel --clear works as fallback",
      residualRisk: "Native Android e2e still needs SDK setup.",
      reuseTags: ["SitesLog", "Expo", "device-test"],
    });

    const fix = hub.addFixEntry({
      projectPath,
      agent: "claude-code",
      summary: "Added release security gate.",
      filesChanged: ["package.json", "scripts/security-audit.mjs"],
      commitSha: "def5678",
      verification: "npm run security:audit passed",
      residualRisk: "Audit thresholds may need review after Expo upgrades.",
    });

    assert.equal(research.finding, "Host Android tooling is missing.");
    assert.deepEqual(research.evidence, ["adb was not recognized"]);
    assert.equal(fix.filesChanged[0], "package.json");
  });
});

test("builds compact coordination brief with profile, tasks, sessions, research, and fixes", async () => {
  await withHub(async (hub, projectPath) => {
    hub.upsertProjectProfile({
      projectPath,
      name: "SPY Master",
      mode: "paper-trading ops",
      summary: "Audit logs, DB, and orchestrator state before changing live behavior.",
      standardCommands: ["python scripts/eod_audit.py YYYY-MM-DD"],
      risks: ["Running orchestrator state can lag file edits."],
    });
    hub.addTask({ type: "chore",
      projectPath,
      title: "Review orphan recorded trade reconciliation",
      status: "ready",
      priority: "high",
      verificationCommand: "pytest tests/reconciler -q",
    });
    hub.startSession({
      projectPath,
      agent: "claude-code",
      source: "remote-control",
      goal: "Inspect live paper-trading health",
      branch: "main",
      dirtyFiles: [],
    });
    hub.addResearchEntry({
      projectPath,
      agent: "codex",
      question: "What is the standard audit path?",
      finding: "Use health snapshot, eod_audit, rolled logs, then DB/journal.",
      evidence: ["prior ops audit"],
      reuseTags: ["paper-trading", "audit"],
    });
    hub.addFixEntry({
      projectPath,
      agent: "codex",
      summary: "Fixed shared-leg overlap reconciliation.",
      verification: "817 passed, 2 skipped",
    });

    const brief = hub.buildBrief({ projectPath });

    assert.match(brief.text, /paper-trading ops/);
    assert.match(brief.text, /Review orphan recorded trade reconciliation/);
    assert.match(brief.text, /remote-control/);
    assert.match(brief.text, /Use health snapshot/);
    assert.match(brief.text, /817 passed, 2 skipped/);
    assert.match(brief.text, /python scripts\/eod_audit\.py YYYY-MM-DD/);
  });
});

test("editTask changes only supported fields", async () => {
  await withHub((hub, dir) => {
    const task = hub.addTask({ type: "chore", projectPath: dir, title: "Old", status: "ready", priority: "normal" });
    const edited = hub.editTask({ id: task.id, title: "New", priority: "high", agent: "human" });
    assert.equal(edited.title, "New");
    assert.equal(edited.priority, "high");
    assert.equal(edited.projectPath, task.projectPath);
  });
});

test("deleteTask refuses active runs and removes an idle task", async () => {
  await withHub((hub, dir) => {
    const idle = hub.addTask({ type: "chore", projectPath: dir, title: "Idle", status: "ready" });
    assert.deepEqual(hub.deleteTask({ id: idle.id, agent: "human" }), { id: idle.id, deleted: true });

    const active = hub.addTask({ type: "chore", projectPath: dir, title: "Active", status: "ready" });
    hub.startRun({ taskId: active.id, agent: "codex" });
    assert.throws(() => hub.deleteTask({ id: active.id, agent: "human" }), /unfinished run/i);
  });
});
