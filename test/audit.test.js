import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createCortex } from "../src/index.js";
import { auditDatabase, computeFragilePaths } from "../src/audit.js";
import { drainIndexJobs, enqueueRecord } from "../src/indexer.js";

test("flags a non-blocked task still carrying a block reason", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-audit-stale-block-"));
  const hub = createCortex({ dbPath: join(dir, "audit.sqlite") });
  try {
    const task = hub.addTask({ type: "chore", projectPath: join(dir, "proj"), title: "Once blocked" });
    // legacy row: transitioned off 'blocked' before the updater started clearing reasons
    hub.storage.db.prepare("UPDATE workflow_tasks SET status = 'done', block_reason = 'Agent exited with code 1' WHERE id = ?").run(task.id);

    const { issues } = auditDatabase(hub.storage, {});
    const found = issues.find(({ code }) => code === "stale_block_reason");
    assert.ok(found, "expected a stale_block_reason issue");
    assert.equal(found.severity, "warning");
    assert.deepEqual(found.recordIds, [task.id]);
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reports actionable database quality issues without mutation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-audit-"));
  const hub = createCortex({ dbPath: join(dir, "audit.sqlite") });
  try {
    const activeProject = join(dir, "active");
    const emptyProject = join(dir, "empty");
    for (const [projectPath, name] of [[activeProject, "Active"], [emptyProject, "Empty"]]) {
      hub.upsertProjectProfile({ projectPath, name, mode: "general", summary: "" });
    }
    const task = hub.addTask({ type: "chore",
      projectPath: activeProject,
      title: "Run tests",
      assignedAgent: "claude-code",
      verificationCommand: "python3 -m pytest tests/ -q",
    });
    hub.storage.db.prepare("UPDATE workflow_tasks SET updated_at = ? WHERE id = ?")
      .run("2025-01-01T00:00:00.000Z", task.id);
    for (let index = 0; index < 2; index += 1) {
      hub.addFixEntry({ projectPath: activeProject, agent: "claude-code", summary: "Claude Code session completed." });
    }
    const research = hub.addResearchEntry({
      projectPath: activeProject,
      agent: "codex",
      question: "What happened?",
      finding: "Unknown.",
    });
    hub.storage.insertSessionEvent({
      id: "expired", projectPath: activeProject, agent: "codex", source: "test",
      summary: "old", fingerprint: "expired", expiresAt: "2025-01-01T00:00:00.000Z",
    });
    enqueueRecord(hub.storage, research.id, "unknown");
    // addFixEntry/addResearchEntry now auto-enqueue their own valid jobs — drain those (and this
    // deliberately-invalid "unknown" one, which fails) first, then enqueue a second "unknown"
    // job fresh so one genuinely-pending job remains for the pending_index_job check below.
    drainIndexJobs(hub.storage);
    enqueueRecord(hub.storage, research.id, "unknown");
    const before = hub.storage.db.prepare("SELECT COUNT(*) AS count FROM fix_entries").get().count;

    const result = auditDatabase(hub.storage, {
      now: new Date("2026-06-18T00:00:00.000Z"),
      platform: "win32",
    });
    const codes = new Set(result.issues.map(({ code }) => code));

    for (const code of [
      "duplicate_fix_summary", "fix_missing_verification", "research_missing_evidence",
      "profile_without_knowledge", "assigned_task_without_session", "stale_task",
      "expired_session_event", "platform_incompatible_command", "pending_index_job",
      "failed_index_job",
    ]) assert.equal(codes.has(code), true, code);
    assert.equal(result.summary.totalIssues, result.issues.length);
    assert.equal(hub.storage.db.prepare("SELECT COUNT(*) AS count FROM fix_entries").get().count, before);
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("flags files that recur across fixes, blocked tasks, and lessons as fragile", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-fragile-"));
  const hub = createCortex({ dbPath: join(dir, "audit.sqlite") });
  try {
    const project = join(dir, "app");
    hub.upsertProjectProfile({ projectPath: project, name: "App", mode: "general", summary: "" });
    for (const summary of ["patch A", "patch B"]) {
      hub.addFixEntry({ projectPath: project, agent: "claude-code", summary, filesChanged: ["src/storage.js"] });
    }
    hub.addTask({
      type: "bug", projectPath: project, title: "Blocked work",
      status: "blocked", relatedFiles: ["src/storage.js"], blockReason: "flaky",
    });
    hub.addLesson({ projectPath: project, lesson: "Watch path casing in src/storage.js on Windows." });
    // A file touched once must not be flagged.
    hub.addFixEntry({ projectPath: project, agent: "claude-code", summary: "one-off", filesChanged: ["README.md"] });

    const fragile = computeFragilePaths(hub.storage, { projectPath: project, threshold: 3 });
    assert.equal(fragile.length, 1, "only the recurring file is fragile");
    assert.equal(fragile[0].file, "src/storage.js");
    assert.deepEqual(
      { fix: fragile[0].fixCount, blocked: fragile[0].blockedCount, lesson: fragile[0].lessonCount },
      { fix: 2, blocked: 1, lesson: 1 },
    );

    const audit = auditDatabase(hub.storage);
    const warning = audit.issues.find(({ code }) => code === "fragile_file");
    assert.ok(warning, "audit surfaces a fragile_file issue");
    assert.match(warning.message, /src\/storage\.js/);

    const brief = hub.buildBrief({ projectPath: project });
    assert.match(brief.text, /Fragile Files/);
    assert.match(brief.text, /src\/storage\.js/);
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("exposes read-only audit as JSON through the CLI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-audit-cli-"));
  const dbPath = join(dir, "audit.sqlite");
  const hub = createCortex({ dbPath });
  hub.upsertProjectProfile({ projectPath: dir, name: "Empty", mode: "general", summary: "" });
  hub.close();
  try {
    const result = spawnSync(
      process.execPath,
      [resolve("src/cli.js"), "--db", dbPath, "audit", "--all", "--json"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.issues.some(({ code }) => code === "profile_without_knowledge"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("audit --fix previews, then applies doc reclassification and chatter cleanup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-audit-fix-"));
  const hub = createCortex({ dbPath: join(dir, "audit.sqlite") });
  try {
    const doc = hub.storage.insertFix({
      id: "doc-1", projectPath: dir, agent: "doc-ingest", summary: "Setup guide",
      filesChanged: ["SETUP.md"], verification: "ingested",
    });
    hub.storage.insertFix({
      id: "chatter-1", projectPath: dir, agent: "claude-code",
      summary: "Claude Code session completed.", filesChanged: [],
    });
    hub.rebuildIndex();

    const preview = hub.audit({ fix: true });
    assert.deepEqual(preview.remediation, { applied: false, docsReclassified: 1, chatterDeleted: 1 });
    assert.ok(hub.storage.getFix(doc.id), "preview must not mutate");

    const applied = hub.audit({ fix: true, apply: true });
    assert.deepEqual(applied.remediation, { applied: true, docsReclassified: 1, chatterDeleted: 1 });
    assert.equal(hub.storage.getFix("doc-1"), undefined);
    assert.equal(hub.storage.getFix("chatter-1"), undefined);
    assert.equal(hub.storage.getResearch("doc-1").finding, "Setup guide");
    assert.equal(
      hub.storage.db.prepare("SELECT record_type AS type FROM search_chunks WHERE record_id = 'doc-1'").get().type,
      "research",
    );
    assert.equal(hub.storage.db.prepare("SELECT COUNT(*) AS count FROM search_chunks WHERE record_id = 'chatter-1'").get().count, 0);
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
});
