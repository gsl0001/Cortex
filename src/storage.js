import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { assertLinkType } from "./linkTypes.js";

// Normalized once: an OS temp directory is scratch space, never a real project, even if it
// happens to be nested under a git-initialized ancestor (e.g. a stray .git at $HOME, which
// every mkdtemp'd Windows temp dir sits under) — walking up from inside it must never resolve
// to that unrelated ancestor repo.
const TMPDIR_PREFIX_RAW = resolve(tmpdir()) + sep;
const TMPDIR_PREFIX = process.platform === "win32" ? TMPDIR_PREFIX_RAW.toLowerCase() : TMPDIR_PREFIX_RAW;

function isUnderTmpdir(absPath) {
  // Windows paths are case-insensitive at the filesystem level — a case-sensitive prefix check
  // would treat listFixes(dir) and listFixes(dir.toUpperCase()) as different directories here,
  // even though every other lookup in this file already collates them as the same one.
  const compare = process.platform === "win32" ? absPath.toLowerCase() : absPath;
  return compare.startsWith(TMPDIR_PREFIX);
}

const LIST_FIELDS = new Set([
  "standardCommands",
  "risks",
  "externalMemoryDirs",
  "relatedFiles",
  "sources",
  "reuseTags",
  "filesChanged",
  "dirtyFiles",
  "dependsOn",
]);

// A git worktree lives in its own directory (often an auto-generated name like
// .claude/worktrees/<random-id>) but shares its main repository's .git — without this, every
// worktree session fragments one project's memory into a separate, meaninglessly-named
// "project" (confirmed live: a worktree path with no registered profile showed up in the UI
// as a bare directory-basename, e.g. a random worktree id instead of the real project name).
function hasGitAncestor(dir) {
  let current = dir;
  for (let hop = 0; hop < 50; hop += 1) { // bounded walk-up, never loops forever
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false; // reached filesystem root
    current = parent;
  }
  return false;
}

const gitRootCache = new Map();

function resolveGitRoot(absPath) {
  if (gitRootCache.has(absPath)) return gitRootCache.get(absPath);
  // cheap in-process check first: only shell out to git when the path is actually inside SOME
  // git-tracked tree (a `.git` FILE, not a directory, marks a linked worktree — hasGitAncestor
  // catches both). Skips the subprocess entirely for the common non-repo case (e.g. every
  // mkdtemp'd test/temp directory), which is most calls in this codebase's own test suite.
  let resolved = absPath;
  if (hasGitAncestor(absPath)) {
    try {
      const commonDir = execFileSync(
        "git", ["-C", absPath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
        { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      // git-common-dir is "<repo-root>/.git" for both the main worktree and any linked
      // worktree (it's the one shared .git) — its parent is the canonical project identity.
      if (commonDir) resolved = dirname(commonDir);
    } catch {
      // git missing/unavailable, or genuinely not a repo despite the .git-shaped entry — keep the raw path
    }
  }
  gitRootCache.set(absPath, resolved);
  return resolved;
}

export function normalizeProjectPath(projectPath) {
  const resolved = resolve(projectPath || process.cwd());
  // One separator spelling everywhere: git rev-parse emits forward slashes, resolve()
  // emits backslashes on Windows — mixing them split one project into two identities.
  const canonical = (p) => p.replaceAll("\\", "/");
  if (isUnderTmpdir(resolved)) return canonical(resolved); // scratch space — never git-root it
  return canonical(resolveGitRoot(resolved));
}

// Single source of truth for the default DB location: a global, cwd-independent
// path so the server, the CLI, and the capture hooks all open the SAME database
// when CORTEX_DB is unset. (A cwd-relative default would split the hub's memory
// across whatever directory each component happened to run from.)
export function defaultDbPath() {
  return resolve(process.env.CORTEX_DB || join(homedir(), ".cortex", "cortex.sqlite"));
}

// local calendar date, not UTC: at UTC-7 the UTC date flips at 5pm local and
// dispatched scheduled work a day early (and surfaced rechecks early).
// Optional `now` lets the scheduler ask "what's the local date at this instant?"
// (e.g. dispatcher ticks with an injected clock); defaults to real now for all
// existing callers, which pass nothing.
export const localToday = (now = new Date()) => {
  const d = now;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function nowIso() {
  return new Date().toISOString();
}

function roadmapProjectPredicate(alias = "") {
  const column = alias ? `${alias}.project_path` : "project_path";
  // Stored rows mix separators: git-derived roots use "/", resolve()-derived paths use "\".
  // Compare slash-insensitively on Windows so old backslash rows still match.
  // ponytail: read-side tolerance; a one-off migration rewriting project_path is the upgrade path.
  return process.platform === "win32"
    ? `REPLACE(${column}, '\\', '/') = REPLACE(?, '\\', '/') COLLATE NOCASE`
    : `${column} = ?`;
}

function safeParse(json) {
  try { return JSON.parse(json || "{}"); }
  catch { return { _parseError: true }; } // ponytail: one corrupt row shouldn't break the whole feed/stats
}

function inboxTtlDays() {
  const raw = Number(process.env.CORTEX_INBOX_TTL_DAYS);
  return Number.isInteger(raw) && raw > 0 ? raw : 14; // NaN/0/negative/float -> 14
}

function leaseTtlMinutes() {
  const raw = Number(process.env.CORTEX_LEASE_TTL_MIN);
  return Number.isInteger(raw) && raw > 0 ? raw : 30;
}

function encodeList(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value === undefined || value === null || value === "") return JSON.stringify([]);
  return JSON.stringify([String(value)]);
}

function decodeRow(row) {
  if (!row) return row;
  const decoded = { ...row };
  for (const field of LIST_FIELDS) {
    if (field in decoded) {
      decoded[field] = JSON.parse(decoded[field] || "[]");
    }
  }
  return decoded;
}

function decodeRows(rows) {
  return rows.map((row) => decodeRow(row));
}

function decodeResearchRow(row) {
  const decoded = decodeRow(row);
  if (!decoded) return decoded;
  decoded.evidence = JSON.parse(decoded.evidence || "[]");
  return decoded;
}

function decodeResearchRows(rows) {
  return rows.map((row) => decodeResearchRow(row));
}

export class CortexStorage {
  constructor({ dbPath = defaultDbPath() } = {}) {
    this.dbPath = resolve(dbPath);
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    // ponytail: WAL+busy_timeout make the server-writer / CLI-maintenance-writer
    // overlap safe instead of SQLITE_BUSY. Must run before migrate()'s transactions.
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;");
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_profiles (
        project_path TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mode TEXT NOT NULL,
        summary TEXT NOT NULL,
        standard_commands TEXT NOT NULL,
        risks TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workflow_tasks (
        id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        assigned_agent TEXT,
        related_files TEXT NOT NULL,
        acceptance_criteria TEXT,
        verification_command TEXT,
        evidence TEXT,
        branch TEXT,
        commit_sha TEXT,
        block_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS research_entries (
        id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        agent TEXT NOT NULL,
        question TEXT NOT NULL,
        sources TEXT NOT NULL,
        evidence TEXT NOT NULL,
        finding TEXT NOT NULL,
        fix_made TEXT,
        verification TEXT,
        residual_risk TEXT,
        reuse_tags TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fix_entries (
        id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        agent TEXT NOT NULL,
        summary TEXT NOT NULL,
        files_changed TEXT NOT NULL,
        commit_sha TEXT,
        verification TEXT,
        residual_risk TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        agent TEXT NOT NULL,
        source TEXT NOT NULL,
        goal TEXT NOT NULL,
        branch TEXT,
        dirty_files TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const currentVersion = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get().version;
    if (currentVersion < 2) this.migrateCaptureSchema();
    if (currentVersion < 3) this.migrateLinkedSchema();
    if (currentVersion < 4) this.migrateSearchSchema();
    if (currentVersion < 5) this.migrateMetricsSchema();
    if (currentVersion < 6) this.migrateDecisionsInboxSchema();
    if (currentVersion < 7) this.migrateSelfImprovementSchema();
    if (currentVersion < 8) this.migrateRoadmapSchema();
    if (currentVersion < 9) this.migrateTaskCompletionSchema();
    if (currentVersion < 10) this.migrateGoalAchievementSchema();
    if (currentVersion < 11) this.migrateAgentLaunchSchema();
    if (currentVersion < 12) this.migrateRecordIndexSchema();
    if (currentVersion < 13) this.migrateAgenticOsSchema();
    if (currentVersion < 14) this.migrateTaskTypeSchema();
    if (currentVersion < 15) this.migrateRunCostSchema();
    if (currentVersion < 16) this.migrateSchedulerSchema();
    if (currentVersion < 17) this.migrateRunWorktreeSchema();
    if (currentVersion < 18) this.migrateCanonicalProjectPathSchema();
    if (currentVersion < 19) this.migrateDistillSchema();
  }

  // Queue for transcript distillation: the Stop hook (10s budget) enqueues; the server drains
  // asynchronously, running a cheap model over the transcript to extract structured records.
  // Same shape as index_jobs — a queue row per session stop, processed best-effort.
  migrateDistillSchema() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS distill_jobs (
          id TEXT PRIMARY KEY,
          project_path TEXT NOT NULL,
          transcript_path TEXT NOT NULL,
          agent TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          error TEXT,
          created_at TEXT NOT NULL,
          processed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS distill_jobs_pending_idx ON distill_jobs(status, created_at);
      `);
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(19, nowIso());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  enqueueDistillJob({ projectPath, transcriptPath, agent = null }) {
    const id = randomUUID();
    // one pending job per transcript: a session's Stop can fire more than once
    const existing = this.db.prepare(
      "SELECT id FROM distill_jobs WHERE transcript_path = ? AND status = 'pending'",
    ).get(transcriptPath);
    if (existing) return { id: existing.id, deduped: true };
    this.db.prepare(
      "INSERT INTO distill_jobs (id, project_path, transcript_path, agent, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
    ).run(id, normalizeProjectPath(projectPath), transcriptPath, agent, nowIso());
    return { id, deduped: false };
  }

  nextDistillJob() {
    return this.db.prepare(`
      SELECT id, project_path AS projectPath, transcript_path AS transcriptPath, agent
      FROM distill_jobs WHERE status = 'pending' ORDER BY created_at LIMIT 1
    `).get() ?? null;
  }

  sweepProcessedDistillJobs(now = new Date(), retentionDays = 30) {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
    return this.db.prepare(
      "DELETE FROM distill_jobs WHERE status != 'pending' AND created_at < ?",
    ).run(cutoff).changes;
  }

  finishDistillJob(id, { status = "done", error = null } = {}) {
    this.db.prepare("UPDATE distill_jobs SET status = ?, error = ?, processed_at = ? WHERE id = ?")
      .run(status, error, nowIso(), id);
  }

  // Rows written before normalizeProjectPath canonicalized separators hold 'C:\x' next to
  // 'C:/x', splitting one project into two identities everywhere paths are grouped or matched.
  // Canonicalize in place across every table carrying a project_path column.
  migrateCanonicalProjectPathSchema() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const tables = this.db.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      ).all();
      for (const { name: table, sql } of tables) {
        const hasColumn = this.db.prepare(`PRAGMA table_info(${table})`).all()
          .some(({ name }) => name === "project_path");
        if (!hasColumn) continue;
        // OR IGNORE keeps the existing row where the canonical form is already present
        // (project_profiles keys on project_path); fts5 tables have no constraints to
        // conflict with and reject conflict clauses, so they get a plain UPDATE.
        const orIgnore = /^CREATE VIRTUAL/i.test(sql || "") ? "" : "OR IGNORE ";
        this.db.exec(`UPDATE ${orIgnore}${table} SET project_path = REPLACE(project_path, '\\', '/') WHERE project_path LIKE '%\\%'`);
      }
      // ponytail: on a profile collision the canonical row wins regardless of edit recency —
      // current code maintains the canonical one, the backslash duplicate is the stale copy.
      this.db.exec(`DELETE FROM project_profiles WHERE project_path LIKE '%\\%'`);
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(18, nowIso());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // Per-run model, token usage, and cost so the dashboard can show where spend concentrates.
  // claude's stream-json `result` event reports total_cost_usd + usage + modelUsage exactly;
  // codex reports none yet, so these stay null for codex runs (tracked, just not costed).
  migrateRunCostSchema() {
    const hasTable = (name) => Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
    const hasColumn = (table, column) => this.db.prepare(`PRAGMA table_info(${table})`).all().some(({ name }) => name === column);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (hasTable("runs")) {
        for (const [col, type] of [["model", "TEXT"], ["input_tokens", "INTEGER"], ["output_tokens", "INTEGER"], ["cost_usd", "REAL"]]) {
          if (!hasColumn("runs", col)) this.db.exec(`ALTER TABLE runs ADD COLUMN ${col} ${type}`);
        }
      }
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(15, nowIso());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // Scheduler ordering primitives: depends_on (JSON array of producer task ids) and
  // not_before (per-task earliest-start ISO datetime). Both nullable; existing rows
  // predate them and default to no constraint.
  migrateSchedulerSchema() {
    const hasTable = (name) => Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
    const hasColumn = (table, column) => this.db.prepare(`PRAGMA table_info(${table})`).all().some(({ name }) => name === column);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (hasTable("workflow_tasks")) {
        if (!hasColumn("workflow_tasks", "depends_on")) this.db.exec("ALTER TABLE workflow_tasks ADD COLUMN depends_on TEXT");
        if (!hasColumn("workflow_tasks", "not_before")) this.db.exec("ALTER TABLE workflow_tasks ADD COLUMN not_before TEXT");
      }
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(16, nowIso());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // Per-run isolation + integration artifacts (parallel worktree runs): the worktree the
  // agent ran in, the autopilot/<task-id> branch it committed to, and the PR url (if any).
  migrateRunWorktreeSchema() {
    const hasTable = (name) => Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
    const hasColumn = (table, column) => this.db.prepare(`PRAGMA table_info(${table})`).all().some(({ name }) => name === column);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (hasTable("runs")) {
        for (const [col, type] of [["worktree_path", "TEXT"], ["branch", "TEXT"], ["pr_url", "TEXT"]]) {
          if (!hasColumn("runs", col)) this.db.exec(`ALTER TABLE runs ADD COLUMN ${col} ${type}`);
        }
      }
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(17, nowIso());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // Adds the required task `type` classification (feature/bug/chore/...). The vocabulary is
  // enforced at the command layer, not by a DB CHECK, matching how status/priority are handled.
  // Required-on-create is new, so existing rows predate it: backfill them to the neutral 'chore'
  // bucket to keep the invariant true without guessing a category.
  migrateTaskTypeSchema() {
    const hasColumn = (table, column) =>
      this.db.prepare(`PRAGMA table_info(${table})`).all().some(({ name }) => name === column);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!hasColumn("workflow_tasks", "type")) {
        this.db.exec("ALTER TABLE workflow_tasks ADD COLUMN type TEXT");
      }
      this.db.exec("UPDATE workflow_tasks SET type = 'chore' WHERE type IS NULL");
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(14, nowIso());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // audit finding: fix/research/decision list queries had no index on project_path, forcing a
  // full table scan (measured 115ms unscoped at 30K-row scale) instead of an index seek. Also
  // indexes supersedes_id, used by the exclude-superseded subquery and listSupersededFixes' join.
  migrateRecordIndexSchema() {
    const hasTable = (name) => Boolean(
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
    );
    const hasColumn = (table, column) =>
      this.db.prepare(`PRAGMA table_info(${table})`).all().some(({ name }) => name === column);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // guarded the same way migrateAgentLaunchSchema guards `runs`: synthetic/partial test
      // fixtures that start mid-chain don't create every table a real v2+ database would have.
      // fix_entries itself is created unconditionally (outside version-gating) without
      // supersedes_id — that column is only added by the v3 migration — so a fixture claiming
      // to start at v8+ (skipping v3) can have the table but not yet that column.
      if (hasTable("fix_entries")) {
        this.db.exec("CREATE INDEX IF NOT EXISTS fix_entries_project_created ON fix_entries(project_path, created_at DESC);");
        if (hasColumn("fix_entries", "supersedes_id")) {
          this.db.exec("CREATE INDEX IF NOT EXISTS fix_entries_supersedes ON fix_entries(supersedes_id);");
        }
      }
      if (hasTable("research_entries")) {
        this.db.exec("CREATE INDEX IF NOT EXISTS research_entries_project_created ON research_entries(project_path, created_at DESC);");
      }
      if (hasTable("decision_entries")) {
        this.db.exec("CREATE INDEX IF NOT EXISTS decision_entries_project_created ON decision_entries(project_path, created_at DESC);");
      }
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (12, ?)").run(nowIso());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  migrateAgenticOsSchema() {
    const hasColumn = (table, column) =>
      this.db.prepare(`PRAGMA table_info(${table})`).all().some(({ name }) => name === column);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS hub_settings (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      if (!hasColumn("workflow_tasks", "recheck_at")) this.db.exec("ALTER TABLE workflow_tasks ADD COLUMN recheck_at TEXT");
      if (!hasColumn("agent_sessions", "outcome")) this.db.exec("ALTER TABLE agent_sessions ADD COLUMN outcome TEXT");
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (13, ?)").run(nowIso());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  migrateAgentLaunchSchema() {
    const columns = new Set(this.db.prepare("PRAGMA table_info(runs)").all().map(({ name }) => name));
    // runs is created by the v7 self-improvement migration; guard so partial
    // schemas (e.g. synthetic test fixtures that skip v7) still version cleanly.
    const hasRuns = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (hasRuns) {
        if (!columns.has("session_id")) this.db.exec("ALTER TABLE runs ADD COLUMN session_id TEXT");
        if (!columns.has("log_path")) this.db.exec("ALTER TABLE runs ADD COLUMN log_path TEXT");
        if (!columns.has("last_event")) this.db.exec("ALTER TABLE runs ADD COLUMN last_event TEXT");
      }
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (11, ?)").run(nowIso());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  migrateRoadmapSchema() {
    const hasColumn = (table, column) =>
      this.db.prepare(`PRAGMA table_info(${table})`).all().some(({ name }) => name === column);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS project_goals (
          id TEXT PRIMARY KEY,
          project_path TEXT NOT NULL,
          title TEXT NOT NULL,
          outcome TEXT NOT NULL,
          success_criteria_json TEXT NOT NULL CHECK (json_valid(success_criteria_json)),
          target_date TEXT NOT NULL,
          weekly_capacity INTEGER NOT NULL CHECK (weekly_capacity > 0),
          status TEXT NOT NULL CHECK (status IN ('active','paused','achieved','abandoned')),
          active_rank INTEGER CHECK (active_rank IS NULL OR active_rank BETWEEN 1 AND 5),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS one_active_goal_per_project
          ON project_goals(project_path) WHERE status = 'active';
        CREATE UNIQUE INDEX IF NOT EXISTS one_active_goal_per_rank
          ON project_goals(active_rank) WHERE status = 'active';
        CREATE TABLE IF NOT EXISTS roadmap_milestones (
          id TEXT PRIMARY KEY,
          goal_id TEXT NOT NULL,
          title TEXT NOT NULL,
          sort_order INTEGER NOT NULL CHECK (sort_order > 0),
          due_date TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(goal_id, sort_order),
          FOREIGN KEY (goal_id) REFERENCES project_goals(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS roadmap_proposals (
          id TEXT PRIMARY KEY,
          project_path TEXT NOT NULL,
          created_by TEXT NOT NULL,
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
          status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
          applied_goal_id TEXT,
          resolution_reason TEXT,
          created_at TEXT NOT NULL,
          resolved_at TEXT,
          FOREIGN KEY (applied_goal_id) REFERENCES project_goals(id)
        );
        CREATE INDEX IF NOT EXISTS roadmap_proposals_project_status
          ON roadmap_proposals(project_path, status, created_at);
      `);
      for (const definition of [
        "milestone_id TEXT",
        "task_number TEXT",
        "roadmap_order INTEGER",
        "scheduled_for TEXT",
      ]) {
        const [column] = definition.split(" ");
        if (!hasColumn("workflow_tasks", column)) {
          this.db.exec(`ALTER TABLE workflow_tasks ADD COLUMN ${definition}`);
        }
      }
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(8, nowIso());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  migrateTaskCompletionSchema() {
    const hasColumn = this.db.prepare("PRAGMA table_info(workflow_tasks)").all()
      .some(({ name }) => name === "completed_at");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!hasColumn) this.db.exec("ALTER TABLE workflow_tasks ADD COLUMN completed_at TEXT");
      this.db.exec("UPDATE workflow_tasks SET completed_at = updated_at WHERE status = 'done' AND completed_at IS NULL");
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(9, nowIso());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  migrateGoalAchievementSchema() {
    const hasColumn = this.db.prepare("PRAGMA table_info(project_goals)").all()
      .some(({ name }) => name === "achieved_at");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!hasColumn) this.db.exec("ALTER TABLE project_goals ADD COLUMN achieved_at TEXT");
      this.db.exec("UPDATE project_goals SET achieved_at = updated_at WHERE status = 'achieved' AND achieved_at IS NULL");
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(10, nowIso());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  migrateSelfImprovementSchema() {
    const hasColumn = (table, column) =>
      this.db.prepare(`PRAGMA table_info(${table})`).all().some(({ name }) => name === column);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // ponytail: A/B workflow-experiment subsystem (workflows/versions/eval_tasks/
      // experiments/runs). Schema + storage + CLI + HTTP are wired, but nothing PRODUCES
      // data — it needs an agent orchestrator (spawn N runs per version, capture tokens)
      // that doesn't exist yet. Parked, not dead. Lightweight per-recall telemetry already
      // lives in metrics_events. Activate when you actually want to A/B prompts.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS workflows (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          active_version_id TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workflow_versions (
          id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          content TEXT NOT NULL CHECK (json_valid(content)),
          status TEXT NOT NULL CHECK (status IN ('draft','archived','candidate')),
          created_at TEXT NOT NULL,
          UNIQUE(workflow_id, version),
          FOREIGN KEY (workflow_id) REFERENCES workflows(id)
        );
        CREATE TABLE IF NOT EXISTS eval_tasks (
          id TEXT PRIMARY KEY,
          project_path TEXT NOT NULL,
          name TEXT NOT NULL,
          goal TEXT NOT NULL,
          setup TEXT,
          verification_command TEXT NOT NULL,
          created_at TEXT NOT NULL,
          archived_at TEXT
        );
        CREATE TABLE IF NOT EXISTS experiments (
          id TEXT PRIMARY KEY,
          project_path TEXT NOT NULL,
          workflow_id TEXT NOT NULL,
          baseline_version_id TEXT NOT NULL,
          candidate_version_id TEXT NOT NULL,
          objective TEXT NOT NULL CHECK (objective IN ('tokens','time')),
          min_repetitions_per_task INTEGER NOT NULL CHECK (min_repetitions_per_task >= 1),
          min_improvement REAL NOT NULL DEFAULT 0.05 CHECK (min_improvement >= 0),
          status TEXT NOT NULL CHECK (status IN ('proposed','evaluated','approved','rejected','promoted')),
          results_json TEXT CHECK (results_json IS NULL OR json_valid(results_json)),
          recommendation TEXT CHECK (recommendation IS NULL OR recommendation IN ('hold','reject','promote')),
          created_at TEXT NOT NULL,
          decided_at TEXT,
          decided_by TEXT,
          FOREIGN KEY (workflow_id) REFERENCES workflows(id),
          FOREIGN KEY (baseline_version_id) REFERENCES workflow_versions(id),
          FOREIGN KEY (candidate_version_id) REFERENCES workflow_versions(id)
        );
        CREATE TABLE IF NOT EXISTS experiment_eval_tasks (
          experiment_id TEXT NOT NULL,
          eval_task_id TEXT NOT NULL,
          verification_command TEXT NOT NULL,
          PRIMARY KEY (experiment_id, eval_task_id),
          FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE CASCADE,
          FOREIGN KEY (eval_task_id) REFERENCES eval_tasks(id)
        );
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY,
          experiment_id TEXT,
          task_id TEXT,
          eval_task_id TEXT,
          repetition INTEGER,
          agent TEXT NOT NULL,
          workflow_version_id TEXT,
          verification_command TEXT,
          verification_exit INTEGER,
          tokens INTEGER,
          tool_calls INTEGER,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          outcome TEXT,
          notes TEXT,
          CHECK ((task_id IS NULL) != (eval_task_id IS NULL)),
          CHECK (experiment_id IS NULL OR eval_task_id IS NOT NULL),
          CHECK (experiment_id IS NULL OR repetition IS NOT NULL),
          CHECK (repetition IS NULL OR repetition > 0),
          UNIQUE (experiment_id, workflow_version_id, eval_task_id, repetition),
          FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE SET NULL,
          FOREIGN KEY (workflow_version_id) REFERENCES workflow_versions(id)
        );
        CREATE INDEX IF NOT EXISTS runs_experiment_idx
          ON runs(experiment_id, workflow_version_id, eval_task_id);
        CREATE TABLE IF NOT EXISTS lessons (
          id TEXT PRIMARY KEY,
          project_path TEXT NOT NULL,
          statement TEXT NOT NULL,
          experiment_id TEXT,
          status TEXT,
          sample_counts TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (experiment_id) REFERENCES experiments(id)
        );
      `);
      if (!hasColumn("workflow_tasks", "lease_agent")) this.db.exec("ALTER TABLE workflow_tasks ADD COLUMN lease_agent TEXT");
      if (!hasColumn("workflow_tasks", "lease_expires_at")) this.db.exec("ALTER TABLE workflow_tasks ADD COLUMN lease_expires_at TEXT");
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(7, nowIso());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  migrateDecisionsInboxSchema() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS decision_entries (
          id TEXT PRIMARY KEY,
          project_path TEXT NOT NULL,
          agent TEXT NOT NULL,
          decision TEXT NOT NULL,
          rationale TEXT NOT NULL,
          alternatives TEXT,
          supersedes_id TEXT,
          capture_source TEXT,
          quality_status TEXT NOT NULL DEFAULT 'accepted',
          fingerprint TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (supersedes_id) REFERENCES decision_entries(id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS decision_entries_fingerprint_unique
          ON decision_entries(fingerprint) WHERE fingerprint IS NOT NULL;
        CREATE INDEX IF NOT EXISTS decision_entries_supersedes
          ON decision_entries(project_path, supersedes_id);
        CREATE TABLE IF NOT EXISTS inbox_items (
          id TEXT PRIMARY KEY,
          project_path TEXT NOT NULL,
          author TEXT NOT NULL,
          message TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          resolved_at TEXT
        );
        CREATE INDEX IF NOT EXISTS inbox_items_project_resolved
          ON inbox_items(project_path, resolved_at);
      `);
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(6, nowIso());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  migrateCaptureSchema() {
    const hasColumn = (table, column) =>
      this.db.prepare(`PRAGMA table_info(${table})`).all().some(({ name }) => name === column);
    const addColumn = (table, definition) => {
      const [column] = definition.split(" ");
      if (!hasColumn(table, column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    };

    this.db.exec("BEGIN IMMEDIATE");
    try {
      addColumn("project_profiles", "external_memory_dirs TEXT NOT NULL DEFAULT '[]'");
      for (const table of ["fix_entries", "research_entries"]) {
        addColumn(table, "capture_source TEXT");
        addColumn(table, "quality_status TEXT NOT NULL DEFAULT 'unverified'");
        addColumn(table, "fingerprint TEXT");
        addColumn(table, "supersedes_id TEXT");
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS session_events (
          id TEXT PRIMARY KEY,
          project_path TEXT NOT NULL,
          agent TEXT NOT NULL,
          source TEXT NOT NULL,
          summary TEXT NOT NULL,
          fingerprint TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS fix_entries_fingerprint_unique
          ON fix_entries(fingerprint) WHERE fingerprint IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS research_entries_fingerprint_unique
          ON research_entries(fingerprint) WHERE fingerprint IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS session_events_fingerprint_unique
          ON session_events(fingerprint) WHERE fingerprint IS NOT NULL;
      `);
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(2, nowIso());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  migrateLinkedSchema() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS entities (
          id TEXT PRIMARY KEY,
          entity_type TEXT NOT NULL,
          canonical_key TEXT NOT NULL,
          label TEXT NOT NULL,
          project_path TEXT,
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(entity_type, canonical_key)
        );
        CREATE TABLE IF NOT EXISTS record_entities (
          record_id TEXT NOT NULL,
          record_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          role TEXT NOT NULL,
          PRIMARY KEY(record_id, record_type, entity_id, role)
        );
        CREATE TABLE IF NOT EXISTS links (
          id TEXT PRIMARY KEY,
          from_entity_id TEXT NOT NULL,
          to_entity_id TEXT NOT NULL,
          link_type TEXT NOT NULL,
          source TEXT NOT NULL,
          confidence REAL NOT NULL,
          origin_record_id TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS index_jobs (
          id TEXT PRIMARY KEY,
          record_id TEXT NOT NULL,
          record_type TEXT NOT NULL,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS links_from_index ON links(from_entity_id);
        CREATE INDEX IF NOT EXISTS links_to_index ON links(to_entity_id);
      `);
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(3, nowIso());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  migrateMetricsSchema() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS metrics_events (
          id TEXT PRIMARY KEY,
          project_path TEXT NOT NULL,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS metrics_events_project_time
          ON metrics_events(project_path, created_at);
      `);
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(5, nowIso());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  migrateSearchSchema() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS search_chunks USING fts5(
          record_id UNINDEXED,
          project_path UNINDEXED,
          record_type UNINDEXED,
          title,
          body,
          tags
        );
      `);
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(4, nowIso());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  // ponytail: WAL grows unbounded without an explicit checkpoint (it sat at 2.6MB).
  // TRUNCATE folds it back into the main DB and resets the file.
  checkpoint() {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // checkpoint is best-effort maintenance — never block on a busy writer
    }
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertProjectProfile(profile) {
    const timestamp = nowIso();
    const projectPath = normalizeProjectPath(profile.projectPath);
    this.db.prepare(`
      INSERT INTO project_profiles (
        project_path, name, mode, summary, standard_commands, risks,
        external_memory_dirs, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_path) DO UPDATE SET
        name = excluded.name,
        mode = excluded.mode,
        summary = excluded.summary,
        standard_commands = excluded.standard_commands,
        risks = excluded.risks,
        external_memory_dirs = excluded.external_memory_dirs,
        updated_at = excluded.updated_at
    `).run(
      projectPath,
      profile.name || "Unnamed Project",
      profile.mode || "general",
      profile.summary || "",
      encodeList(profile.standardCommands),
      encodeList(profile.risks),
      encodeList(profile.externalMemoryDirs),
      timestamp,
      timestamp,
    );
    return this.getProjectProfile(projectPath);
  }

  getProjectProfile(projectPath) {
    return decodeRow(this.db.prepare(`
      SELECT
        project_path AS projectPath,
        name,
        mode,
        summary,
        standard_commands AS standardCommands,
        risks,
        external_memory_dirs AS externalMemoryDirs,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM project_profiles
      WHERE project_path = ?
    `).get(normalizeProjectPath(projectPath)));
  }

  insertTask(task) {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO workflow_tasks (
        id, project_path, title, status, priority, assigned_agent, related_files,
        acceptance_criteria, verification_command, evidence, branch, commit_sha,
        block_reason, type, milestone_id, task_number, roadmap_order, scheduled_for,
        depends_on, not_before, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      normalizeProjectPath(task.projectPath),
      task.title,
      task.status,
      task.priority,
      task.assignedAgent || null,
      encodeList(task.relatedFiles),
      task.acceptanceCriteria || null,
      task.verificationCommand || null,
      task.evidence || null,
      task.branch || null,
      task.commitSha || null,
      task.blockReason || null,
      task.type ?? null,
      task.milestoneId ?? null,
      task.taskNumber ?? null,
      task.roadmapOrder ?? null,
      task.scheduledFor ?? null,
      encodeList(task.dependsOn),
      task.notBefore ?? null,
      task.status === "done" ? timestamp : null,
      timestamp,
      timestamp,
    );
    return this.getTask(task.id);
  }

  updateTask(id, patch) {
    const current = this.getTask(id);
    if (!current) throw new Error(`Task not found: ${id}`);
    const next = { ...current, ...patch, id };
    // block_reason describes why status is 'blocked'; leaving that state clears it
    // unless the patch itself asserts a reason (blockTask always does).
    if (next.status !== "blocked" && patch.blockReason === undefined) next.blockReason = null;
    const timestamp = nowIso();
    const params = [
      next.title,
      next.status,
      next.priority,
      next.assignedAgent || null,
      encodeList(next.relatedFiles),
      next.acceptanceCriteria || null,
      next.verificationCommand || null,
      next.evidence || null,
      next.branch || null,
      next.commitSha || null,
      next.blockReason || null,
      next.type ?? null,
      next.milestoneId ?? null,
      next.taskNumber ?? null,
      next.roadmapOrder ?? null,
      next.scheduledFor ?? null,
      next.recheckAt ?? null,
      encodeList(next.dependsOn),
      next.notBefore ?? null,
      next.status === "done" ? current.completedAt ?? timestamp : null,
      timestamp,
      id,
    ].map((value) => value === undefined ? null : value);

    this.db.prepare(`
      UPDATE workflow_tasks SET
        title = ?,
        status = ?,
        priority = ?,
        assigned_agent = ?,
        related_files = ?,
        acceptance_criteria = ?,
        verification_command = ?,
        evidence = ?,
        branch = ?,
        commit_sha = ?,
        block_reason = ?,
        type = ?,
        milestone_id = ?,
        task_number = ?,
        roadmap_order = ?,
        scheduled_for = ?,
        recheck_at = ?,
        depends_on = ?,
        not_before = ?,
        completed_at = ?,
        updated_at = ?
      WHERE id = ?
    `).run(...params);
    return this.getTask(id);
  }

  deleteTask(id) {
    if (!this.getTask(id)) throw new Error(`Task not found: ${id}`);
    const active = this.db.prepare("SELECT 1 FROM runs WHERE task_id = ? AND ended_at IS NULL").get(id);
    if (active) throw new Error("Task has an unfinished run");
    return this.transaction(() => {
      this.db.prepare("DELETE FROM runs WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM workflow_tasks WHERE id = ?").run(id);
      // Strip the deleted task out of dependents' depends_on — a dangling producer id
      // reads as "stuck" forever and silently keeps the consumer from ever dispatching.
      for (const row of this.db.prepare("SELECT id, depends_on AS deps FROM workflow_tasks WHERE depends_on LIKE ?").all(`%${id}%`)) {
        const deps = JSON.parse(row.deps || "[]").filter((d) => d !== id);
        this.db.prepare("UPDATE workflow_tasks SET depends_on = ? WHERE id = ?").run(JSON.stringify(deps), row.id);
      }
      return { id, deleted: true };
    });
  }

  getTask(id) {
    return decodeRow(this.db.prepare(`
      SELECT
        id,
        project_path AS projectPath,
        title,
        status,
        priority,
        assigned_agent AS assignedAgent,
        related_files AS relatedFiles,
        acceptance_criteria AS acceptanceCriteria,
        verification_command AS verificationCommand,
        evidence,
        branch,
        commit_sha AS commitSha,
        block_reason AS blockReason,
        type,
        lease_agent AS leaseAgent,
        lease_expires_at AS leaseExpiresAt,
        milestone_id AS milestoneId,
        task_number AS taskNumber,
        roadmap_order AS roadmapOrder,
        scheduled_for AS scheduledFor,
        recheck_at AS recheckAt,
        depends_on AS dependsOn,
        not_before AS notBefore,
        completed_at AS completedAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM workflow_tasks
      WHERE id = ?
    `).get(id));
  }

  listTasks(projectPath, { statuses } = {}) {
    const normalized = normalizeProjectPath(projectPath);
    const rows = this.db.prepare(`
      SELECT
        id,
        project_path AS projectPath,
        title,
        status,
        priority,
        assigned_agent AS assignedAgent,
        related_files AS relatedFiles,
        acceptance_criteria AS acceptanceCriteria,
        verification_command AS verificationCommand,
        evidence,
        branch,
        commit_sha AS commitSha,
        block_reason AS blockReason,
        type,
        lease_agent AS leaseAgent,
        lease_expires_at AS leaseExpiresAt,
        milestone_id AS milestoneId,
        task_number AS taskNumber,
        roadmap_order AS roadmapOrder,
        scheduled_for AS scheduledFor,
        recheck_at AS recheckAt,
        depends_on AS dependsOn,
        not_before AS notBefore,
        completed_at AS completedAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM workflow_tasks
      WHERE ${roadmapProjectPredicate()}
      ORDER BY
        CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        updated_at DESC
    `).all(normalized);
    const decoded = decodeRows(rows);
    return statuses ? decoded.filter((task) => statuses.includes(task.status)) : decoded;
  }

  insertRoadmapProposal({ id, projectPath, createdBy, payload }) {
    this.db.prepare(`
      INSERT INTO roadmap_proposals (
        id, project_path, created_by, payload_json, status, created_at
      ) VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(id, normalizeProjectPath(projectPath), createdBy, JSON.stringify(payload), nowIso());
    return this.getRoadmapProposal(id);
  }

  getRoadmapProposal(id) {
    const row = this.db.prepare(`
      SELECT id, project_path AS projectPath, created_by AS createdBy,
        payload_json AS payloadJson, status, applied_goal_id AS appliedGoalId,
        resolution_reason AS resolutionReason, created_at AS createdAt,
        resolved_at AS resolvedAt
      FROM roadmap_proposals WHERE id = ?
    `).get(id);
    if (!row) return null;
    const { payloadJson, ...proposal } = row;
    return { ...proposal, payload: JSON.parse(payloadJson) };
  }

  listRoadmapProposals(projectPath, { status } = {}) {
    const rows = status
      ? this.db.prepare(`SELECT id FROM roadmap_proposals WHERE ${roadmapProjectPredicate()} AND status = ? ORDER BY created_at`).all(normalizeProjectPath(projectPath), status)
      : this.db.prepare(`SELECT id FROM roadmap_proposals WHERE ${roadmapProjectPredicate()} ORDER BY created_at`).all(normalizeProjectPath(projectPath));
    return rows.map(({ id }) => this.getRoadmapProposal(id));
  }

  getGoal(id) {
    const row = this.db.prepare(`
      SELECT id, project_path AS projectPath, title, outcome,
        success_criteria_json AS successCriteriaJson, target_date AS targetDate,
        weekly_capacity AS weeklyCapacity, status, active_rank AS activeRank,
        achieved_at AS achievedAt, created_at AS createdAt, updated_at AS updatedAt
      FROM project_goals WHERE id = ?
    `).get(id);
    if (!row) return null;
    const { successCriteriaJson, ...goal } = row;
    return { ...goal, successCriteria: JSON.parse(successCriteriaJson) };
  }

  getActiveGoal(projectPath) {
    const row = this.db.prepare(`SELECT id FROM project_goals WHERE ${roadmapProjectPredicate()} AND status = 'active'`).get(normalizeProjectPath(projectPath));
    return row ? this.getGoal(row.id) : null;
  }

  listActiveGoals() {
    return this.db.prepare("SELECT id FROM project_goals WHERE status = 'active' ORDER BY active_rank").all()
      .map(({ id }) => this.getGoal(id));
  }

  listGoals({ status } = {}) {
    const rows = status
      ? this.db.prepare("SELECT id FROM project_goals WHERE status = ? ORDER BY COALESCE(active_rank, 999), title, project_path, id").all(status)
      : this.db.prepare("SELECT id FROM project_goals ORDER BY COALESCE(active_rank, 999), title, project_path, id").all();
    return rows.map(({ id }) => this.getGoal(id));
  }

  getRoadmap(projectPath, goalId = null) {
    const normalized = normalizeProjectPath(projectPath);
    const row = goalId
      ? this.db.prepare(`SELECT id FROM project_goals WHERE id = ? AND ${roadmapProjectPredicate()}`).get(goalId, normalized)
      : this.db.prepare(`SELECT id FROM project_goals WHERE ${roadmapProjectPredicate()} ORDER BY status = 'active' DESC, created_at DESC LIMIT 1`).get(normalized);
    if (!row) return { goal: null, milestones: [], tasks: [] };
    const milestones = this.db.prepare(`
      SELECT id, goal_id AS goalId, title, sort_order AS sortOrder, due_date AS dueDate,
        created_at AS createdAt, updated_at AS updatedAt
      FROM roadmap_milestones WHERE goal_id = ? ORDER BY sort_order
    `).all(row.id);
    const tasks = this.db.prepare(`
      SELECT id FROM workflow_tasks
      WHERE milestone_id IN (SELECT id FROM roadmap_milestones WHERE goal_id = ?)
      ORDER BY roadmap_order, task_number, id
    `).all(row.id).map(({ id }) => this.getTask(id));
    return { goal: this.getGoal(row.id), milestones, tasks };
  }

  insertGoal(goal) {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO project_goals (
        id, project_path, title, outcome, success_criteria_json, target_date,
        weekly_capacity, status, active_rank, achieved_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      goal.id, normalizeProjectPath(goal.projectPath), goal.title, goal.outcome,
      JSON.stringify(goal.successCriteria || []), goal.targetDate, goal.weeklyCapacity,
      goal.status, goal.activeRank ?? null, goal.achievedAt ?? null, timestamp, timestamp,
    );
    return this.getGoal(goal.id);
  }

  updateGoal(id, patch) {
    const current = this.getGoal(id);
    if (!current) throw new Error(`Goal not found: ${id}`);
    const next = { ...current, ...patch };
    this.db.prepare(`
      UPDATE project_goals SET title = ?, outcome = ?, success_criteria_json = ?,
        target_date = ?, weekly_capacity = ?, status = ?, active_rank = ?, achieved_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.title, next.outcome, JSON.stringify(next.successCriteria), next.targetDate,
      next.weeklyCapacity, next.status, next.activeRank ?? null, next.achievedAt ?? null, nowIso(), id,
    );
    return this.getGoal(id);
  }

  insertMilestone(milestone) {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO roadmap_milestones (
        id, goal_id, title, sort_order, due_date, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(milestone.id, milestone.goalId, milestone.title, milestone.sortOrder, milestone.dueDate, timestamp, timestamp);
    return this.db.prepare(`
      SELECT id, goal_id AS goalId, title, sort_order AS sortOrder, due_date AS dueDate,
        created_at AS createdAt, updated_at AS updatedAt
      FROM roadmap_milestones WHERE id = ?
    `).get(milestone.id);
  }

  getMilestone(id) {
    return this.db.prepare(`
      SELECT id, goal_id AS goalId, title, sort_order AS sortOrder, due_date AS dueDate,
        created_at AS createdAt, updated_at AS updatedAt
      FROM roadmap_milestones WHERE id = ?
    `).get(id) ?? null;
  }

  updateMilestone(id, patch) {
    const current = this.getMilestone(id);
    if (!current) throw new Error(`Milestone not found: ${id}`);
    const next = { ...current, ...patch };
    this.db.prepare(`UPDATE roadmap_milestones SET title = ?, sort_order = ?, due_date = ?, updated_at = ? WHERE id = ?`)
      .run(next.title, next.sortOrder, next.dueDate, nowIso(), id);
    return this.getMilestone(id);
  }

  resolveRoadmapProposal(id, { status, appliedGoalId = null, reason = null }) {
    const result = this.db.prepare(`
      UPDATE roadmap_proposals SET status = ?, applied_goal_id = ?,
        resolution_reason = ?, resolved_at = ? WHERE id = ? AND status = 'pending'
    `).run(status, appliedGoalId, reason, nowIso(), id);
    return result.changes === 1;
  }

  insertResearch(entry) {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO research_entries (
        id, project_path, agent, question, sources, evidence, finding, fix_made,
        verification, residual_risk, reuse_tags, created_at, capture_source,
        quality_status, fingerprint, supersedes_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      normalizeProjectPath(entry.projectPath),
      entry.agent,
      entry.question,
      encodeList(entry.sources),
      encodeList(entry.evidence),
      entry.finding,
      entry.fixMade || null,
      entry.verification || null,
      entry.residualRisk || null,
      encodeList(entry.reuseTags),
      timestamp,
      entry.captureSource || null,
      entry.qualityStatus || "unverified",
      entry.fingerprint || null,
      entry.supersedesId || null,
    );
    return this.getResearch(entry.id);
  }

  getResearch(id) {
    return decodeResearchRow(this.db.prepare(`
      SELECT
        id,
        project_path AS projectPath,
        agent,
        question,
        sources,
        evidence,
        finding,
        fix_made AS fixMade,
        verification,
        residual_risk AS residualRisk,
        reuse_tags AS reuseTags,
        capture_source AS captureSource,
        quality_status AS qualityStatus,
        fingerprint,
        supersedes_id AS supersedesId,
        created_at AS createdAt
      FROM research_entries
      WHERE id = ?
    `).get(id));
  }

  listResearch(projectPath, { limit = 5, excludeSuperseded = false, maxAgeDays = null } = {}) {
    const clauses = [roadmapProjectPredicate()];
    const params = [normalizeProjectPath(projectPath)];
    if (excludeSuperseded) {
      clauses.push("id NOT IN (SELECT supersedes_id FROM research_entries WHERE supersedes_id IS NOT NULL)");
    }
    if (maxAgeDays != null) {
      clauses.push("(created_at >= ? OR quality_status = 'verified' OR verification IS NOT NULL)");
      params.push(new Date(Date.now() - maxAgeDays * 86400000).toISOString());
    }
    params.push(limit);
    return decodeResearchRows(this.db.prepare(`
      SELECT
        id, project_path AS projectPath, agent, question, sources, evidence, finding,
        fix_made AS fixMade, verification, residual_risk AS residualRisk, reuse_tags AS reuseTags,
        capture_source AS captureSource, quality_status AS qualityStatus, fingerprint,
        supersedes_id AS supersedesId, created_at AS createdAt
      FROM research_entries
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params));
  }

  insertFix(entry) {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO fix_entries (
        id, project_path, agent, summary, files_changed, commit_sha,
        verification, residual_risk, created_at, capture_source, quality_status,
        fingerprint, supersedes_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      normalizeProjectPath(entry.projectPath),
      entry.agent,
      entry.summary,
      encodeList(entry.filesChanged),
      entry.commitSha || null,
      entry.verification || null,
      entry.residualRisk || null,
      timestamp,
      entry.captureSource || null,
      entry.qualityStatus || "unverified",
      entry.fingerprint || null,
      entry.supersedesId || null,
    );
    return this.getFix(entry.id);
  }

  getFix(id) {
    return decodeRow(this.db.prepare(`
      SELECT
        id,
        project_path AS projectPath,
        agent,
        summary,
        files_changed AS filesChanged,
        commit_sha AS commitSha,
        verification,
        residual_risk AS residualRisk,
        capture_source AS captureSource,
        quality_status AS qualityStatus,
        fingerprint,
        supersedes_id AS supersedesId,
        created_at AS createdAt
      FROM fix_entries
      WHERE id = ?
    `).get(id));
  }

  listFixes(projectPath, { limit = 5, excludeSuperseded = false, maxAgeDays = null } = {}) {
    const clauses = [roadmapProjectPredicate()];
    const params = [normalizeProjectPath(projectPath)];
    if (excludeSuperseded) {
      clauses.push("id NOT IN (SELECT supersedes_id FROM fix_entries WHERE supersedes_id IS NOT NULL)");
    }
    if (maxAgeDays != null) {
      clauses.push("(created_at >= ? OR quality_status = 'verified' OR verification IS NOT NULL)");
      params.push(new Date(Date.now() - maxAgeDays * 86400000).toISOString());
    }
    params.push(limit);
    return decodeRows(this.db.prepare(`
      SELECT
        id, project_path AS projectPath, agent, summary, files_changed AS filesChanged,
        commit_sha AS commitSha, verification, residual_risk AS residualRisk,
        capture_source AS captureSource, quality_status AS qualityStatus, fingerprint,
        supersedes_id AS supersedesId, created_at AS createdAt
      FROM fix_entries
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params));
  }

  countRecords(projectPath) {
    const p = normalizeProjectPath(projectPath);
    return {
      fix: this.db.prepare("SELECT COUNT(*) AS c FROM fix_entries WHERE project_path = ?").get(p).c,
      research: this.db.prepare("SELECT COUNT(*) AS c FROM research_entries WHERE project_path = ?").get(p).c,
    };
  }

  countSupersededFixes(projectPath) {
    return this.db.prepare(
      "SELECT COUNT(DISTINCT supersedes_id) AS c FROM fix_entries WHERE supersedes_id IS NOT NULL AND project_path = ?",
    ).get(normalizeProjectPath(projectPath)).c;
  }

  findSupersedableFix({ projectPath, filesChanged = [], excludeId = null } = {}) {
    if (!filesChanged.length) return null;
    const wanted = new Set(filesChanged.map((file) => String(file).toLowerCase()));
    // ponytail: was capped at 50 (silently missed real matches past a project's most recent 50
    // fixes — measured on real data). JS-side scan over even several thousand rows costs single
    // milliseconds (storage audit), so scanning effectively "all" is cheap; raise this again
    // (or move to a normalized files-changed join table) only if a project's fix count outgrows it.
    for (const fix of this.listFixes(projectPath, { limit: 5000 })) {
      if (excludeId && fix.id === excludeId) continue;
      if ((fix.filesChanged || []).some((file) => wanted.has(String(file).toLowerCase()))) return fix;
    }
    return null;
  }

  setRecordVerification(recordType, id, verification) {
    const table = recordType === "fix" ? "fix_entries" : "research_entries";
    this.db.prepare(`UPDATE ${table} SET verification = ?, quality_status = 'verified' WHERE id = ?`)
      .run(verification, id);
  }

  // "Stale: [m:xxxxxx]" correction: quarantine the record the prefix points at, so briefs stop
  // re-injecting a memory an agent had to argue with. The record survives (searchable, reviewable
  // in the dashboard) — only its brief eligibility is revoked. Returns the record type hit, or null.
  quarantineRecordByPrefix(projectPath, idPrefix) {
    const prefix = String(idPrefix || "").toLowerCase();
    // ≥6 hex required: briefs emit 6, and a 4-hex LIKE could collide with (and quarantine)
    // an innocent record at realistic store sizes
    if (!/^[0-9a-f]{6,8}$/.test(prefix)) return null;
    const project = normalizeProjectPath(projectPath);
    for (const [table, recordType] of [
      ["fix_entries", "fix"],
      ["research_entries", "research"],
      ["decision_entries", "decision"],
    ]) {
      const changed = this.db.prepare(
        `UPDATE ${table} SET quality_status = 'quarantined'
         WHERE project_path = ? AND replace(id, '-', '') LIKE ? || '%'`,
      ).run(project, prefix).changes;
      if (changed > 0) return recordType;
    }
    return null;
  }

  findCaptureByFingerprint(fingerprint) {
    for (const [table, recordType] of [
      ["fix_entries", "fix"],
      ["research_entries", "research"],
      ["decision_entries", "decision"],
      ["session_events", "session_event"],
    ]) {
      const row = this.db.prepare(`SELECT id FROM ${table} WHERE fingerprint = ?`).get(fingerprint);
      if (row) return { ...row, recordType };
    }
    return undefined;
  }

  insertDecision(entry) {
    this.db.prepare(`
      INSERT INTO decision_entries (
        id, project_path, agent, decision, rationale, alternatives,
        supersedes_id, capture_source, quality_status, fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id, normalizeProjectPath(entry.projectPath), entry.agent,
      entry.decision, entry.rationale, entry.alternatives || null,
      entry.supersedesId || null, entry.captureSource || null,
      entry.qualityStatus || "accepted", entry.fingerprint || null, nowIso(),
    );
    return this.getDecision(entry.id);
  }

  getDecision(id) {
    return this.db.prepare(`
      SELECT id, project_path AS projectPath, agent, decision, rationale, alternatives,
        supersedes_id AS supersedesId, capture_source AS captureSource,
        quality_status AS qualityStatus, fingerprint, created_at AS createdAt
      FROM decision_entries WHERE id = ?
    `).get(id);
  }

  listDecisions(projectPath, { limit = 5, excludeSuperseded = false, maxAgeDays = null } = {}) {
    const clauses = [roadmapProjectPredicate()];
    const params = [normalizeProjectPath(projectPath)];
    if (excludeSuperseded) {
      clauses.push("id NOT IN (SELECT supersedes_id FROM decision_entries WHERE supersedes_id IS NOT NULL)");
    }
    if (maxAgeDays != null) {
      clauses.push("created_at >= ?");
      params.push(new Date(Date.now() - maxAgeDays * 86400000).toISOString());
    }
    params.push(limit);
    return this.db.prepare(`
      SELECT id, project_path AS projectPath, agent, decision, rationale, alternatives,
        supersedes_id AS supersedesId, capture_source AS captureSource,
        quality_status AS qualityStatus, fingerprint, created_at AS createdAt
      FROM decision_entries WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC LIMIT ?
    `).all(...params);
  }

  // superseded (old) fixes joined to the fix that replaced them.
  // filesChanged is included (not just summary/supersededBy) so callers can rank
  // by relevance to the files currently being worked on, same as listFixes/listResearch.
  listSupersededFixes(projectPath, { limit = 20 } = {}) {
    return decodeRows(this.db.prepare(`
      SELECT old.id, old.summary, old.files_changed AS filesChanged, old.created_at AS createdAt, repl.summary AS supersededBy
      FROM fix_entries repl
      JOIN fix_entries old ON repl.supersedes_id = old.id
      WHERE ${roadmapProjectPredicate("old")}
      ORDER BY repl.created_at DESC LIMIT ?
    `).all(normalizeProjectPath(projectPath), limit));
  }

  insertInboxItem(item) {
    const id = item.id || randomUUID();
    const days = inboxTtlDays();
    this.db.prepare(`
      INSERT INTO inbox_items (id, project_path, author, message, created_at, expires_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run(
      id, normalizeProjectPath(item.projectPath), item.author, item.message,
      nowIso(), new Date(Date.now() + days * 86400000).toISOString(),
    );
    return this.getInboxItem(id);
  }

  getInboxItem(id) {
    return this.db.prepare(`
      SELECT id, project_path AS projectPath, author, message,
        created_at AS createdAt, expires_at AS expiresAt, resolved_at AS resolvedAt
      FROM inbox_items WHERE id = ?
    `).get(id);
  }

  listInboxItems(projectPath, { includeResolved = false, limit = 5 } = {}) {
    const clauses = ["project_path = ?", "expires_at > ?"]; // self-filter expiry; never rely on sweep
    const params = [normalizeProjectPath(projectPath), nowIso()];
    if (!includeResolved) clauses.push("resolved_at IS NULL");
    params.push(limit);
    return this.db.prepare(`
      SELECT id, project_path AS projectPath, author, message,
        created_at AS createdAt, expires_at AS expiresAt, resolved_at AS resolvedAt
      FROM inbox_items WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC LIMIT ?
    `).all(...params);
  }

  resolveInboxItem(projectPath, id) {
    const result = this.db.prepare(
      "UPDATE inbox_items SET resolved_at = ? WHERE id = ? AND project_path = ?",
    ).run(nowIso(), id, normalizeProjectPath(projectPath));
    if (result.changes === 0) throw new Error(`Inbox item not found: ${id}`);
    return this.getInboxItem(id);
  }

  sweepExpiredInbox(now = new Date()) {
    return this.db.prepare("DELETE FROM inbox_items WHERE expires_at < ?").run(now.toISOString()).changes;
  }

  // ---- hub settings (dispatcher state etc.) ----
  getSetting(key, fallback = null) {
    const row = this.db.prepare("SELECT value_json AS v FROM hub_settings WHERE key = ?").get(key);
    return row ? JSON.parse(row.v) : fallback;
  }

  setSetting(key, value) {
    this.db.prepare(`
      INSERT INTO hub_settings (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), nowIso());
    return value;
  }

  // ---- runs ----
  startRun({ experimentId = null, taskId = null, evalTaskId = null, repetition = null, agent, workflowVersionId = null, verificationCommand = null, model = null }) {
    let vc = verificationCommand;
    if (experimentId && evalTaskId) {
      const frozen = this.db.prepare("SELECT verification_command AS vc FROM experiment_eval_tasks WHERE experiment_id = ? AND eval_task_id = ?").get(experimentId, evalTaskId);
      if (!frozen) throw new Error("eval_task is not in the experiment's frozen set");
      vc = frozen.vc; // oracle cannot be overridden for experiment runs
    }
    const id = randomUUID();
    // model here is the INTENDED model (routing at launch) so running cards can show it;
    // finishRun overwrites it with the model the CLI actually reported, when it reports one.
    this.db.prepare(`
      INSERT INTO runs (id, experiment_id, task_id, eval_task_id, repetition, agent, workflow_version_id, verification_command, model, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, experimentId, taskId, evalTaskId, repetition, agent, workflowVersionId, vc, model, nowIso());
    return this.getRun(id);
  }

  getRun(id) {
    const row = this.db.prepare(`
      SELECT id, experiment_id AS experimentId, task_id AS taskId, eval_task_id AS evalTaskId,
        repetition, agent, workflow_version_id AS workflowVersionId,
        verification_command AS verificationCommand, verification_exit AS verificationExit,
        tokens, tool_calls AS toolCalls, started_at AS startedAt, ended_at AS endedAt, outcome, notes,
        session_id AS sessionId, log_path AS logPath, last_event AS lastEvent,
        model, input_tokens AS inputTokens, output_tokens AS outputTokens, cost_usd AS costUsd,
        worktree_path AS worktreePath, branch, pr_url AS prUrl
      FROM runs WHERE id = ?
    `).get(id);
    if (row) {
      row.verificationPassed = row.verificationExit === 0; // derived, never stored
      row.status = row.endedAt ? (row.outcome === "success" ? "succeeded" : "failed") : "running";
    }
    return row;
  }

  updateRunProgress(id, { sessionId, logPath, lastEvent, worktreePath, branch, prUrl } = {}) {
    const current = this.getRun(id);
    if (!current) throw new Error(`Run not found: ${id}`);
    this.db.prepare("UPDATE runs SET session_id = ?, log_path = ?, last_event = ?, worktree_path = ?, branch = ?, pr_url = ? WHERE id = ?")
      .run(
        sessionId ?? current.sessionId,
        logPath ?? current.logPath,
        lastEvent ?? current.lastEvent,
        worktreePath ?? current.worktreePath,
        branch ?? current.branch,
        prUrl ?? current.prUrl,
        id,
      );
    return this.getRun(id);
  }

  // Task ids of runs still open (no ended_at) -- used by the startup worktree sweep to tell a
  // legitimately in-flight run's worktree apart from one orphaned by a crash/kill. Called after
  // interruptOpenRuns(), which closes every previously-open run, so this is normally empty at boot.
  listOpenRunTaskIds() {
    return this.db.prepare("SELECT task_id AS taskId FROM runs WHERE ended_at IS NULL AND task_id IS NOT NULL").all().map((r) => r.taskId);
  }

  interruptOpenRuns() {
    const rows = this.db.prepare("SELECT id, task_id AS taskId FROM runs WHERE ended_at IS NULL").all();
    return this.transaction(() => {
      for (const row of rows) {
        this.finishRun(row.id, { outcome: "fail", notes: "Interrupted by an unclean server restart" });
        if (row.taskId) {
          // recheck_at = today so restart-orphaned work surfaces in the Needs-you Recheck
          // bucket instead of rotting per-project until someone opens that exact project.
          this.updateTask(row.taskId, { status: "blocked", blockReason: "Automated run was interrupted by a server restart", recheckAt: localToday() });
          this.clearLease(row.taskId);
        }
      }
      return rows.length;
    });
  }

  finishRun(id, { verificationExit = null, tokens = null, toolCalls = null, outcome = null, notes = null, model = null, inputTokens = null, outputTokens = null, costUsd = null, prUrl = null } = {}) {
    const current = this.getRun(id);
    const result = this.db.prepare("UPDATE runs SET verification_exit = ?, tokens = ?, tool_calls = ?, outcome = ?, notes = ?, model = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?, pr_url = ?, ended_at = ? WHERE id = ?")
      .run(verificationExit, tokens, toolCalls, outcome, notes, model, inputTokens, outputTokens, costUsd, prUrl ?? current?.prUrl ?? null, nowIso(), id);
    if (result.changes === 0) throw new Error(`Run not found: ${id}`);
    return this.getRun(id);
  }

  // Spend analytics: totals plus breakdowns by model, project, and task type, newest days first.
  // Only runs that carry a cost (claude today) are counted; `since` is an ISO lower-bound on started_at.
  costSummary({ since = null } = {}) {
    const clause = since ? "AND r.started_at >= ?" : "";
    const params = since ? [since] : [];
    const breakdown = (expr) => this.db.prepare(`
      SELECT ${expr} AS key,
        COALESCE(SUM(r.cost_usd), 0) AS costUsd, COALESCE(SUM(r.tokens), 0) AS tokens, COUNT(*) AS runs
      FROM runs r LEFT JOIN workflow_tasks t ON t.id = r.task_id
      WHERE r.cost_usd IS NOT NULL ${clause}
      GROUP BY key ORDER BY costUsd DESC
    `).all(...params).map((row) => ({ ...row, key: row.key ?? "unknown" }));
    const total = this.db.prepare(`
      SELECT COALESCE(SUM(r.cost_usd), 0) AS costUsd, COALESCE(SUM(r.tokens), 0) AS tokens, COUNT(*) AS runs
      FROM runs r WHERE r.cost_usd IS NOT NULL ${clause}
    `).get(...params);
    const byDay = this.db.prepare(`
      SELECT substr(r.started_at, 1, 10) AS key,
        COALESCE(SUM(r.cost_usd), 0) AS costUsd, COALESCE(SUM(r.tokens), 0) AS tokens, COUNT(*) AS runs
      FROM runs r WHERE r.cost_usd IS NOT NULL ${clause}
      GROUP BY key ORDER BY key DESC LIMIT 30
    `).all(...params);
    return { total, byModel: breakdown("r.model"), byProject: breakdown("t.project_path"), byType: breakdown("t.type"), byDay };
  }

  // One-time: populate cost/tokens/model for finished runs from their on-disk logs, so the
  // spend dashboard reflects history captured before this feature existed. `parse(logPath)`
  // returns { model, inputTokens, outputTokens, tokens, costUsd } | null (injected: keeps fs out of storage).
  backfillRunCosts({ parse }) {
    const rows = this.db.prepare("SELECT id, log_path AS logPath FROM runs WHERE cost_usd IS NULL AND log_path IS NOT NULL").all();
    let updated = 0;
    for (const { id, logPath } of rows) {
      const u = parse(logPath);
      if (!u || u.costUsd == null) continue;
      this.db.prepare("UPDATE runs SET model = ?, input_tokens = ?, output_tokens = ?, tokens = ?, cost_usd = ? WHERE id = ?")
        .run(u.model ?? null, u.inputTokens ?? null, u.outputTokens ?? null, u.tokens ?? null, u.costUsd, id);
      updated += 1;
    }
    return updated;
  }

  listRuns(projectPath, { limit = 100 } = {}) {
    return this.db.prepare(`
      SELECT r.id FROM runs r
      LEFT JOIN workflow_tasks t ON t.id = r.task_id
      LEFT JOIN experiments e ON e.id = r.experiment_id
      WHERE COALESCE(t.project_path, e.project_path) = ?
      ORDER BY r.started_at DESC LIMIT ?
    `).all(normalizeProjectPath(projectPath), limit).map(({ id }) => this.getRun(id));
  }

  // "machine" is a reserved lesson scope, not a directory: environmental truths (CLI auth
  // expiry, sqlite NUL truncation) are true machine-wide, and normalizing the literal would
  // silently resolve it against cwd and strand them in a fake project.
  static lessonScope(projectPath) {
    return projectPath === "machine" ? "machine" : normalizeProjectPath(projectPath);
  }

  insertLesson({ projectPath, statement, status = "learned", sampleCounts = null }) {
    const id = randomUUID();
    const scope = CortexStorage.lessonScope(projectPath);
    this.db.prepare("INSERT INTO lessons (id, project_path, statement, experiment_id, status, sample_counts, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)")
      .run(id, scope, statement, status, sampleCounts ? JSON.stringify(sampleCounts) : null, nowIso());
    return { id, projectPath: scope, statement, status };
  }

  listLessons(projectPath, { limit = 5 } = {}) {
    return this.db.prepare("SELECT id, statement, experiment_id AS experimentId, status, created_at AS createdAt FROM lessons WHERE project_path = ? ORDER BY created_at DESC LIMIT ?")
      .all(CortexStorage.lessonScope(projectPath), limit);
  }

  // ---- task lease (atomic claim) ----
  claimTaskLease(id, agent, branch = null, ttlMinutes = leaseTtlMinutes()) {
    const expires = new Date(Date.now() + ttlMinutes * 60000).toISOString();
    const result = this.db.prepare(`
      UPDATE workflow_tasks
      SET lease_agent = ?, lease_expires_at = ?, assigned_agent = ?, status = 'in_progress', branch = COALESCE(?, branch), updated_at = ?
      WHERE id = ? AND status IN ('backlog','ready') AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
    `).run(agent, expires, agent, branch, nowIso(), id, nowIso());
    if (result.changes === 0) throw new Error("Task not claimable (already leased, missing, or not in backlog/ready)");
    return this.getTask(id);
  }

  clearLease(id) {
    this.db.prepare("UPDATE workflow_tasks SET lease_agent = NULL, lease_expires_at = NULL WHERE id = ?").run(id);
  }

  releaseLease(id, agent) {
    const result = this.db.prepare("UPDATE workflow_tasks SET lease_agent = NULL, lease_expires_at = NULL WHERE id = ? AND lease_agent = ?").run(id, agent);
    if (result.changes === 0) throw new Error("Lease not held by this agent (or not leased)");
    return this.getTask(id);
  }

  insertSessionEvent(event) {
    const createdAt = nowIso();
    this.db.prepare(`
      INSERT INTO session_events (
        id, project_path, agent, source, summary, fingerprint, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      normalizeProjectPath(event.projectPath),
      event.agent,
      event.source,
      event.summary,
      event.fingerprint || null,
      createdAt,
      event.expiresAt,
    );
    return this.db.prepare(`
      SELECT id, project_path AS projectPath, agent, source, summary, fingerprint,
        created_at AS createdAt, expires_at AS expiresAt
      FROM session_events WHERE id = ?
    `).get(event.id);
  }

  listSessionEvents(projectPath) {
    return this.db.prepare(`
      SELECT id, project_path AS projectPath, agent, source, summary, fingerprint,
        created_at AS createdAt, expires_at AS expiresAt
      FROM session_events WHERE project_path = ? ORDER BY created_at DESC
    `).all(normalizeProjectPath(projectPath));
  }

  recordMetric(kind, projectPath, payload = {}) {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO metrics_events (id, project_path, kind, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, normalizeProjectPath(projectPath), kind, JSON.stringify(payload), nowIso());
    return id;
  }

  listMetrics(projectPath, { since, kind, limit } = {}) {
    const clauses = ["project_path = ?"];
    const params = [normalizeProjectPath(projectPath)];
    if (since) { clauses.push("created_at >= ?"); params.push(since); }
    if (kind) { clauses.push("kind = ?"); params.push(kind); }
    // ponytail: limit defaults to unbounded so computeStats keeps all events; only the activity feed clamps it.
    let sql = `
      SELECT id, project_path AS projectPath, kind, payload_json AS payloadJson, created_at AS createdAt
      FROM metrics_events WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`;
    if (limit) { sql += " LIMIT ?"; params.push(limit); }
    return this.db.prepare(sql).all(...params).map((row) => ({ ...row, payload: safeParse(row.payloadJson) }));
  }

  // Unified activity feed across the whole DB (every timestamped table), filtered in SQL.
  // ponytail: DB does the merge/filter; the UI just renders rows.
  activityLog({ projectPath = null, types = null, agent = null, since = null, query = null, limit = 200 } = {}) {
    const union = `
      SELECT created_at AS ts, 'fix' AS type, project_path AS project, agent,
        substr(summary,1,160) AS title, capture_source AS detail, id FROM fix_entries
      UNION ALL SELECT created_at, 'research', project_path, agent,
        substr(question,1,160), substr(finding,1,200), id FROM research_entries
      UNION ALL SELECT created_at, 'decision', project_path, agent,
        substr(decision,1,160), substr(rationale,1,200), id FROM decision_entries
      UNION ALL SELECT updated_at, 'task', project_path, COALESCE(assigned_agent,''),
        substr(title,1,160), status, id FROM workflow_tasks
      UNION ALL SELECT created_at, 'session', project_path, agent,
        substr(summary,1,160), source, id FROM session_events
      UNION ALL SELECT created_at, 'inbox', project_path, author,
        substr(message,1,160), '', id FROM inbox_items
      UNION ALL SELECT created_at, 'metric', project_path,
        COALESCE(json_extract(payload_json,'$.agent'),''), kind,
        COALESCE(json_extract(payload_json,'$.reason'), json_extract(payload_json,'$.action'), ''),
        id FROM metrics_events
    `;
    const clauses = [];
    const params = [];
    if (projectPath) { clauses.push("project = ?"); params.push(normalizeProjectPath(projectPath)); }
    if (types?.length) { clauses.push(`type IN (${types.map(() => "?").join(",")})`); params.push(...types); }
    if (agent) { clauses.push("agent LIKE ?"); params.push(`%${agent}%`); }
    if (since) { clauses.push("ts >= ?"); params.push(since); }
    if (query) { clauses.push("(title LIKE ? OR detail LIKE ?)"); params.push(`%${query}%`, `%${query}%`); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(Math.min(Math.max(Number(limit) || 200, 1), 1000));
    return this.db.prepare(`SELECT * FROM (${union}) ${where} ORDER BY ts DESC LIMIT ?`).all(...params);
  }

  sweepExpiredSessionEvents(now = new Date()) {
    return this.db.prepare("DELETE FROM session_events WHERE expires_at < ?")
      .run(now.toISOString()).changes;
  }

  sweepExpiredMetrics(now = new Date(), retentionDays = 90) {
    const cutoff = new Date(now.getTime() - retentionDays * 86400000).toISOString();
    return this.db.prepare("DELETE FROM metrics_events WHERE created_at < ?")
      .run(cutoff).changes;
  }

  // ponytail: a crashed/killed agent never fires Stop, so its session would stay
  // 'active' forever and clutter the brief. Reap stale ones during the session-start sweep.
  sweepStaleSessions(now = new Date(), ttlHours = 12) {
    const cutoff = new Date(now.getTime() - ttlHours * 3600000).toISOString();
    return this.db.prepare(
      "UPDATE agent_sessions SET status = 'finished', updated_at = ? WHERE status = 'active' AND updated_at < ?",
    ).run(now.toISOString(), cutoff).changes;
  }

  upsertEntity(entity) {
    const timestamp = nowIso();
    const id = entity.id || randomUUID();
    this.db.prepare(`
      INSERT INTO entities (
        id, entity_type, canonical_key, label, project_path, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_type, canonical_key) DO UPDATE SET
        label = excluded.label,
        project_path = excluded.project_path,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `).run(
      id,
      entity.entityType,
      entity.canonicalKey,
      entity.label || entity.canonicalKey,
      entity.projectPath ? normalizeProjectPath(entity.projectPath) : null,
      JSON.stringify(entity.metadata || {}),
      timestamp,
      timestamp,
    );
    return this.db.prepare(`
      SELECT id, entity_type AS entityType, canonical_key AS canonicalKey, label,
        project_path AS projectPath, metadata, created_at AS createdAt, updated_at AS updatedAt
      FROM entities WHERE entity_type = ? AND canonical_key = ?
    `).get(entity.entityType, entity.canonicalKey);
  }

  linkRecords(link) {
    assertLinkType(link.linkType);
    if (!Number.isFinite(link.confidence) || link.confidence < 0 || link.confidence > 1) {
      throw new Error("Link confidence must be between 0 and 1");
    }
    const id = link.id || randomUUID();
    this.db.prepare(`
      INSERT INTO links (
        id, from_entity_id, to_entity_id, link_type, source, confidence,
        origin_record_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, link.fromEntityId, link.toEntityId, link.linkType, link.source,
      link.confidence, link.originRecordId || null, nowIso(),
    );
    return { ...link, id };
  }

  attachRecordEntity(attachment) {
    this.db.prepare(`
      INSERT OR IGNORE INTO record_entities (record_id, record_type, entity_id, role)
      VALUES (?, ?, ?, ?)
    `).run(
      attachment.recordId,
      attachment.recordType,
      attachment.entityId,
      attachment.role,
    );
  }

  listLinks(entityId) {
    return this.db.prepare(`
      SELECT id, from_entity_id AS fromEntityId, to_entity_id AS toEntityId,
        link_type AS linkType, source, confidence, origin_record_id AS originRecordId,
        created_at AS createdAt
      FROM links WHERE from_entity_id = ? OR to_entity_id = ? ORDER BY created_at, id
    `).all(entityId, entityId);
  }

  unlink(id) {
    return this.db.prepare("DELETE FROM links WHERE id = ?").run(id).changes > 0;
  }

  insertSession(session) {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO agent_sessions (
        id, project_path, agent, source, goal, branch, dirty_files,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      normalizeProjectPath(session.projectPath),
      session.agent,
      session.source,
      session.goal,
      session.branch || null,
      encodeList(session.dirtyFiles),
      session.status,
      timestamp,
      timestamp,
    );
    return this.getSession(session.id);
  }

  getSession(id) {
    return decodeRow(this.db.prepare(`
      SELECT
        id,
        project_path AS projectPath,
        agent,
        source,
        goal,
        outcome,
        branch,
        dirty_files AS dirtyFiles,
        status,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM agent_sessions
      WHERE id = ?
    `).get(id));
  }

  finishSession(id, { outcome } = {}) {
    const current = this.getSession(id);
    if (!current) throw new Error(`Session not found: ${id}`);
    this.db.prepare(`
      UPDATE agent_sessions
      SET status = 'finished', outcome = COALESCE(?, outcome), updated_at = ?
      WHERE id = ?
    `).run(outcome ?? null, nowIso(), id);
    return this.getSession(id);
  }

  updateSessionGoal(id, goal) {
    const result = this.db.prepare("UPDATE agent_sessions SET goal = ?, updated_at = ? WHERE id = ?")
      .run(goal, nowIso(), id);
    if (result.changes === 0) throw new Error(`Session not found: ${id}`);
    return this.getSession(id);
  }

  listActiveSessions(projectPath) {
    return decodeRows(this.db.prepare(`
      SELECT
        id,
        project_path AS projectPath,
        agent,
        source,
        goal,
        outcome,
        branch,
        dirty_files AS dirtyFiles,
        status,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM agent_sessions
      WHERE project_path = ? AND status = 'active'
      ORDER BY updated_at DESC
    `).all(normalizeProjectPath(projectPath)));
  }
}
