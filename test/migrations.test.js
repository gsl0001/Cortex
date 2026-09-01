import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { CortexStorage } from "../src/storage.js";

async function legacyDatabase() {
  const dir = await mkdtemp(join(tmpdir(), "cortex-migration-"));
  const dbPath = join(dir, "legacy.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE project_profiles (
      project_path TEXT PRIMARY KEY, name TEXT NOT NULL, mode TEXT NOT NULL,
      summary TEXT NOT NULL, standard_commands TEXT NOT NULL, risks TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE research_entries (
      id TEXT PRIMARY KEY, project_path TEXT NOT NULL, agent TEXT NOT NULL,
      question TEXT NOT NULL, sources TEXT NOT NULL, evidence TEXT NOT NULL,
      finding TEXT NOT NULL, fix_made TEXT, verification TEXT, residual_risk TEXT,
      reuse_tags TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE fix_entries (
      id TEXT PRIMARY KEY, project_path TEXT NOT NULL, agent TEXT NOT NULL,
      summary TEXT NOT NULL, files_changed TEXT NOT NULL, commit_sha TEXT,
      verification TEXT, residual_risk TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE workflow_tasks (
      id TEXT PRIMARY KEY, project_path TEXT NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL, priority TEXT NOT NULL, assigned_agent TEXT,
      related_files TEXT NOT NULL, acceptance_criteria TEXT,
      verification_command TEXT, evidence TEXT, branch TEXT, commit_sha TEXT,
      block_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO workflow_tasks VALUES (
      'legacy-done', 'C:\\repo', 'Already done', 'done', 'normal', NULL,
      '[]', NULL, NULL, 'verified', NULL, NULL, NULL,
      '2026-06-16T00:00:00.000Z', '2026-06-17T00:00:00.000Z'
    );
    INSERT INTO fix_entries VALUES (
      'legacy', 'C:\\repo', 'claude-code', 'old fix', '[]', NULL,
      NULL, NULL, '2026-06-17T00:00:00.000Z'
    );
  `);
  db.close();
  return { dir, dbPath };
}

async function version8Database() {
  const dir = await mkdtemp(join(tmpdir(), "cortex-v8-migration-"));
  const dbPath = join(dir, "version8.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES (8, '2026-06-27T00:00:00.000Z');
    CREATE TABLE project_goals (
      id TEXT PRIMARY KEY, project_path TEXT NOT NULL, title TEXT NOT NULL,
      outcome TEXT NOT NULL, success_criteria_json TEXT NOT NULL, target_date TEXT NOT NULL,
      weekly_capacity INTEGER NOT NULL, status TEXT NOT NULL, active_rank INTEGER,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE workflow_tasks (
      id TEXT PRIMARY KEY, project_path TEXT NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL, priority TEXT NOT NULL, assigned_agent TEXT,
      related_files TEXT NOT NULL, acceptance_criteria TEXT,
      verification_command TEXT, evidence TEXT, branch TEXT, commit_sha TEXT,
      block_reason TEXT, lease_agent TEXT, lease_expires_at TEXT,
      milestone_id TEXT, task_number TEXT, roadmap_order INTEGER,
      scheduled_for TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO workflow_tasks (
      id, project_path, title, status, priority, related_files, evidence,
      created_at, updated_at
    ) VALUES (
      'v8-done', 'C:\\repo', 'Completed before v9', 'done', 'normal', '[]',
      'verified', '2026-06-20T00:00:00.000Z', '2026-06-21T00:00:00.000Z'
    );
  `);
  db.close();
  return { dir, dbPath };
}

async function version9Database() {
  const dir = await mkdtemp(join(tmpdir(), "cortex-v9-migration-"));
  const dbPath = join(dir, "version9.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES (9, '2026-06-27T00:00:00.000Z');
    CREATE TABLE project_goals (
      id TEXT PRIMARY KEY, project_path TEXT NOT NULL, title TEXT NOT NULL,
      outcome TEXT NOT NULL, success_criteria_json TEXT NOT NULL, target_date TEXT NOT NULL,
      weekly_capacity INTEGER NOT NULL, status TEXT NOT NULL, active_rank INTEGER,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO project_goals VALUES (
      'achieved', 'C:\\repo', 'Done', 'Done', '[]', '2026-06-30', 1,
      'achieved', NULL, '2026-06-20T00:00:00.000Z', '2026-06-25T00:00:00.000Z'
    );
  `);
  db.close();
  return { dir, dbPath };
}

test("migrates the legacy schema without losing records", async () => {
  const { dir, dbPath } = await legacyDatabase();
  let storage;
  let reopened;
  try {
    storage = new CortexStorage({ dbPath });
    const version = storage.db
      .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
      .get();
    const fixColumns = storage.db.prepare("PRAGMA table_info(fix_entries)").all();
    const profileColumns = storage.db.prepare("PRAGMA table_info(project_profiles)").all();
    const sessionEvents = storage.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_events'")
      .get();

    const metricsTable = storage.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metrics_events'")
      .get();
    const roadmapTables = storage.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('project_goals', 'roadmap_milestones', 'roadmap_proposals')
    `).all();
    const taskColumns = storage.db.prepare("PRAGMA table_info(workflow_tasks)").all();
    const goalColumns = storage.db.prepare("PRAGMA table_info(project_goals)").all();
    const milestoneColumns = storage.db.prepare("PRAGMA table_info(roadmap_milestones)").all();
    const runColumns = storage.db.prepare("PRAGMA table_info(runs)").all().map(({ name }) => name);

    assert.equal(version.version, 23);
    assert.equal(runColumns.includes("session_id"), true);
    assert.equal(runColumns.includes("log_path"), true);
    assert.equal(runColumns.includes("last_event"), true);
    assert.equal(runColumns.includes("cost_usd"), true); // v15: per-run spend tracking
    assert.equal(runColumns.includes("model"), true);
    assert.equal(runColumns.includes("worktree_path"), true); // v17: parallel runs
    assert.equal(runColumns.includes("branch"), true);
    assert.equal(runColumns.includes("pr_url"), true);
    const taskColumns2 = storage.db.prepare("PRAGMA table_info(workflow_tasks)").all().map(({ name }) => name);
    assert.equal(taskColumns2.includes("depends_on"), true); // v16: scheduler ordering
    assert.equal(taskColumns2.includes("not_before"), true);
    assert.equal(storage.db.prepare("SELECT summary FROM fix_entries WHERE id = 'legacy'").get().summary, "old fix");
    assert.equal(fixColumns.some(({ name }) => name === "quality_status"), true);
    assert.equal(fixColumns.some(({ name }) => name === "fingerprint"), true);
    assert.equal(profileColumns.some(({ name }) => name === "external_memory_dirs"), true);
    assert.equal(sessionEvents.name, "session_events");
    assert.equal(metricsTable.name, "metrics_events");
    assert.equal(storage.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'links'").get().name, "links");
    assert.deepEqual(roadmapTables.map(({ name }) => name).sort(), [
      "project_goals",
      "roadmap_milestones",
      "roadmap_proposals",
    ]);
    const indexNames = new Set(storage.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name));
    for (const name of [
      "fix_entries_project_created", "fix_entries_supersedes",
      "research_entries_project_created", "decision_entries_project_created",
    ]) assert.equal(indexNames.has(name), true, name);
    for (const name of ["milestone_id", "task_number", "roadmap_order", "scheduled_for", "completed_at"]) {
      assert.equal(taskColumns.some((column) => column.name === name), true);
    }
    assert.equal(storage.getTask("legacy-done").completedAt, "2026-06-17T00:00:00.000Z");
    assert.equal(goalColumns.find(({ name }) => name === "target_date").notnull, 1);
    assert.equal(milestoneColumns.find(({ name }) => name === "due_date").notnull, 1);
    assert.equal(storage.db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'index' AND name = 'roadmap_proposals_project_status'
    `).get().count, 1);
    storage.insertTask({
      id: "planned",
      projectPath: "C:\\repo",
      title: "Planned task",
      status: "open",
      priority: "normal",
      milestoneId: "milestone-1",
      taskNumber: "1.1",
      roadmapOrder: 1,
      scheduledFor: "2026-07-01",
    });
    storage.updateTask("planned", { status: "in_progress" });
    assert.deepEqual(
      storage.listTasks("C:\\repo").find(({ id }) => id === "planned"),
      storage.getTask("planned"),
    );
    assert.deepEqual(
      {
        milestoneId: storage.getTask("planned").milestoneId,
        taskNumber: storage.getTask("planned").taskNumber,
        roadmapOrder: storage.getTask("planned").roadmapOrder,
        scheduledFor: storage.getTask("planned").scheduledFor,
      },
      { milestoneId: "milestone-1", taskNumber: "1.1", roadmapOrder: 1, scheduledFor: "2026-07-01" },
    );
    const profile = storage.upsertProjectProfile({
      projectPath: "C:\\repo",
      name: "Repo",
      mode: "general",
      summary: "",
      externalMemoryDirs: ["C:\\memory"],
    });
    assert.deepEqual(profile.externalMemoryDirs, ["C:\\memory"]);
    storage.close();
    storage = undefined;

    reopened = new CortexStorage({ dbPath });
    assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 22);
    assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM fix_entries").get().count, 1);
    reopened.close();
    reopened = undefined;
  } finally {
    storage?.close();
    reopened?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("upgrades a version 8 database with immutable task completion time", async () => {
  const { dir, dbPath } = await version8Database();
  let storage;
  try {
    storage = new CortexStorage({ dbPath });
    assert.equal(storage.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 23);
    assert.equal(
      storage.db.prepare("PRAGMA table_info(workflow_tasks)").all().some(({ name }) => name === "completed_at"),
      true,
    );
    assert.equal(storage.getTask("v8-done").completedAt, "2026-06-21T00:00:00.000Z");
    // migrateTaskTypeSchema backfills pre-type rows to the neutral 'chore' bucket
    assert.equal(storage.getTask("v8-done").type, "chore");
    assert.equal(storage.updateTask("v8-done", { evidence: "still verified" }).completedAt, "2026-06-21T00:00:00.000Z");

    storage.insertTask({
      id: "v9-ready",
      projectPath: "C:\\repo",
      title: "Created after v9",
      status: "ready",
      priority: "normal",
    });
    assert.equal(storage.getTask("v9-ready").completedAt, null);
  } finally {
    storage?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("canonicalizes legacy backslash project paths and merges duplicate profiles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cortex-slash-migration-"));
  const dbPath = join(dir, "legacy-paths.sqlite");
  const db = new DatabaseSync(dbPath);
  // rows written before normalizeProjectPath canonicalized separators: the same project
  // exists under both 'C:\repo' and 'C:/repo', splitting one identity into two.
  db.exec(`
    CREATE TABLE project_profiles (
      project_path TEXT PRIMARY KEY, name TEXT NOT NULL, mode TEXT NOT NULL,
      summary TEXT NOT NULL, standard_commands TEXT NOT NULL, risks TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE workflow_tasks (
      id TEXT PRIMARY KEY, project_path TEXT NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL, priority TEXT NOT NULL, assigned_agent TEXT,
      related_files TEXT NOT NULL, acceptance_criteria TEXT,
      verification_command TEXT, evidence TEXT, branch TEXT, commit_sha TEXT,
      block_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE fix_entries (
      id TEXT PRIMARY KEY, project_path TEXT NOT NULL, agent TEXT NOT NULL,
      summary TEXT NOT NULL, files_changed TEXT NOT NULL, commit_sha TEXT,
      verification TEXT, residual_risk TEXT, created_at TEXT NOT NULL
    );
    INSERT INTO project_profiles VALUES
      ('C:\\repo', 'Legacy', 'general', '', '[]', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('C:/repo', 'Canonical', 'general', '', '[]', '[]', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
    INSERT INTO workflow_tasks VALUES (
      'slash-task', 'C:\\repo', 'Legacy path task', 'ready', 'normal', NULL,
      '[]', NULL, NULL, NULL, NULL, NULL, NULL,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO fix_entries VALUES (
      'slash-fix', 'C:\\repo', 'claude-code', 'legacy path fix', '[]', NULL,
      NULL, NULL, '2026-01-01T00:00:00.000Z'
    );
  `);
  db.close();

  let storage;
  try {
    storage = new CortexStorage({ dbPath });
    const profiles = storage.db.prepare("SELECT project_path AS path, name FROM project_profiles").all();
    assert.deepEqual(profiles.map(({ path, name }) => ({ path, name })), [{ path: "C:/repo", name: "Canonical" }]);
    assert.equal(storage.db.prepare("SELECT project_path AS path FROM workflow_tasks WHERE id = 'slash-task'").get().path, "C:/repo");
    assert.equal(storage.db.prepare("SELECT project_path AS path FROM fix_entries WHERE id = 'slash-fix'").get().path, "C:/repo");
  } finally {
    storage?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("upgrades a version 9 database with immutable goal achievement time", async () => {
  const { dir, dbPath } = await version9Database();
  let storage;
  try {
    storage = new CortexStorage({ dbPath });
    assert.equal(storage.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 23);
    assert.equal(storage.db.prepare("PRAGMA table_info(project_goals)").all().some(({ name }) => name === "achieved_at"), true);
    assert.equal(storage.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'embedding_vectors'").get()?.["1"], 1);
    assert.equal(storage.getGoal("achieved").achievedAt, "2026-06-25T00:00:00.000Z");
    assert.equal(storage.updateGoal("achieved", { targetDate: "2026-07-01" }).achievedAt, "2026-06-25T00:00:00.000Z");
  } finally {
    storage?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
