import { normalizeProjectPath } from "./storage.js";
import { rebuildSearchIndex } from "./indexer.js";

function issue(code, severity, projectPath, recordIds, message) {
  return { code, severity, projectPath, recordIds, message };
}

// File extensions that mark a bare token in a free-text lesson as a real path (no slash needed).
// Keeps "e.g"/"i.e"/"3am" out while catching "storage.js" mentioned inline in a lesson.
const CODE_EXT = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "php",
  "c", "h", "cpp", "cs", "sql", "sh", "ps1", "md", "json", "yml", "yaml", "toml",
  "css", "scss", "html", "vue", "svelte", "txt",
]);
const PATH_RE = /[\w][\w.\-/\\]*\.[A-Za-z][\w]{0,4}/g;

function extractPaths(text) {
  const out = new Set();
  for (const match of String(text || "").matchAll(PATH_RE)) {
    const token = match[0];
    if (token.includes("/") || token.includes("\\") || CODE_EXT.has(token.split(".").pop().toLowerCase())) {
      out.add(token);
    }
  }
  return out;
}

function parseFileList(json) {
  try { const value = JSON.parse(json || "[]"); return Array.isArray(value) ? value : []; }
  catch { return []; }
}

function fragileReason({ fixCount, blockedCount, lessonCount }) {
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return [
    fixCount && plural(fixCount, "fix").replace("fixs", "fixes"),
    blockedCount && plural(blockedCount, "blocked task"),
    lessonCount && plural(lessonCount, "lesson"),
  ].filter(Boolean).join(", ");
}

// Files that keep coming back in fixes, blocked tasks, and lessons are the fragile ones — the
// spots that repeatedly break or trip agents up. Purely SQL/JS over existing records: no vector
// store. Each record contributes at most 1 per file, so `count` is "how many distinct records
// flagged this file". `threshold` is that record count; a file at or above it is fragile.
export function computeFragilePaths(storage, { projectPath = null, threshold = 3 } = {}) {
  const db = storage.db;
  const scope = projectPath ? " WHERE project_path = ?" : "";
  const params = projectPath ? [normalizeProjectPath(projectPath)] : [];
  const files = new Map(); // `${projectPath}\n${lowercased path}` -> tallies

  const bump = (pp, rawFile, kind) => {
    const file = String(rawFile).trim();
    if (!file) return;
    const key = `${pp}\n${file.replaceAll("\\", "/").toLowerCase()}`;
    let entry = files.get(key);
    if (!entry) {
      entry = { projectPath: pp, file, fixCount: 0, blockedCount: 0, lessonCount: 0 };
      files.set(key, entry);
    }
    entry[kind] += 1;
  };

  for (const row of db.prepare(`SELECT project_path AS pp, files_changed AS files FROM fix_entries${scope}`).all(...params)) {
    for (const file of new Set(parseFileList(row.files))) bump(row.pp, file, "fixCount");
  }
  const blockedScope = projectPath ? " AND project_path = ?" : "";
  for (const row of db.prepare(`SELECT project_path AS pp, related_files AS files FROM workflow_tasks WHERE status = 'blocked'${blockedScope}`).all(...params)) {
    for (const file of new Set(parseFileList(row.files))) bump(row.pp, file, "blockedCount");
  }
  for (const row of db.prepare(`SELECT project_path AS pp, statement FROM lessons${scope}`).all(...params)) {
    for (const file of extractPaths(row.statement)) bump(row.pp, file, "lessonCount");
  }

  return [...files.values()]
    .map((entry) => ({ ...entry, count: entry.fixCount + entry.blockedCount + entry.lessonCount }))
    .filter((entry) => entry.count >= threshold)
    .map((entry) => ({ ...entry, reason: fragileReason(entry) }))
    .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
}

export function auditDatabase(storage, { now = new Date(), platform = process.platform } = {}) {
  const issues = [];
  const db = storage.db;

  for (const row of db.prepare(`
    SELECT project_path AS projectPath, summary, COUNT(*) AS count, GROUP_CONCAT(id) AS ids
    FROM fix_entries GROUP BY project_path, summary HAVING COUNT(*) > 1
  `).all()) {
    issues.push(issue("duplicate_fix_summary", "warning", row.projectPath, row.ids.split(","), `${row.count} fixes share the same summary: ${row.summary}`));
  }

  for (const row of db.prepare(`
    SELECT id, project_path AS projectPath FROM fix_entries
    WHERE verification IS NULL OR TRIM(verification) = ''
  `).all()) {
    issues.push(issue("fix_missing_verification", "warning", row.projectPath, [row.id], "Fix has no verification evidence."));
  }

  for (const row of db.prepare(`
    SELECT id, project_path AS projectPath FROM research_entries
    WHERE sources = '[]' AND evidence = '[]'
  `).all()) {
    issues.push(issue("research_missing_evidence", "warning", row.projectPath, [row.id], "Research has neither sources nor evidence."));
  }

  for (const row of db.prepare(`
    SELECT p.project_path AS projectPath FROM project_profiles p
    WHERE NOT EXISTS (SELECT 1 FROM workflow_tasks t WHERE t.project_path = p.project_path)
      AND NOT EXISTS (SELECT 1 FROM research_entries r WHERE r.project_path = p.project_path)
      AND NOT EXISTS (SELECT 1 FROM fix_entries f WHERE f.project_path = p.project_path)
  `).all()) {
    issues.push(issue("profile_without_knowledge", "info", row.projectPath, [], "Project profile has no tasks or durable knowledge."));
  }

  for (const row of db.prepare(`
    SELECT t.id, t.project_path AS projectPath FROM workflow_tasks t
    WHERE t.assigned_agent IS NOT NULL AND t.status != 'done'
      AND NOT EXISTS (
        SELECT 1 FROM agent_sessions s
        WHERE s.project_path = t.project_path AND s.agent = t.assigned_agent AND s.status = 'active'
      )
  `).all()) {
    issues.push(issue("assigned_task_without_session", "warning", row.projectPath, [row.id], "Assigned task has no active session for its agent."));
  }

  for (const row of db.prepare(`
    SELECT id, project_path AS projectPath, status FROM workflow_tasks
    WHERE status != 'blocked' AND block_reason IS NOT NULL AND TRIM(block_reason) != ''
  `).all()) {
    issues.push(issue("stale_block_reason", "warning", row.projectPath, [row.id], `Task is '${row.status}' but still carries a block reason.`));
  }

  const staleBefore = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  for (const row of db.prepare(`
    SELECT id, project_path AS projectPath FROM workflow_tasks
    WHERE status != 'done' AND updated_at < ?
  `).all(staleBefore)) {
    issues.push(issue("stale_task", "info", row.projectPath, [row.id], "Active task has not changed in more than 30 days."));
  }

  for (const row of db.prepare(`
    SELECT id, project_path AS projectPath FROM session_events WHERE expires_at < ?
  `).all(now.toISOString())) {
    issues.push(issue("expired_session_event", "info", row.projectPath, [row.id], "Session event is past its retention deadline."));
  }

  for (const row of db.prepare(`
    SELECT j.id, j.record_id AS recordId, j.status, j.attempts, j.last_error AS lastError,
      COALESCE(f.project_path, r.project_path, d.project_path) AS projectPath
    FROM index_jobs j
    LEFT JOIN fix_entries f ON j.record_type = 'fix' AND f.id = j.record_id
    LEFT JOIN research_entries r ON j.record_type = 'research' AND r.id = j.record_id
    LEFT JOIN decision_entries d ON j.record_type = 'decision' AND d.id = j.record_id
    WHERE j.status IN ('pending', 'failed')
  `).all()) {
    issues.push(issue(
      `${row.status}_index_job`,
      row.status === "failed" ? "warning" : "info",
      row.projectPath,
      [row.id, row.recordId],
      row.status === "failed"
        ? `Index job failed after ${row.attempts} attempt(s): ${row.lastError}`
        : "Index job is pending.",
    ));
  }

  if (platform === "win32") {
    for (const row of db.prepare(`
      SELECT id, project_path AS projectPath, verification_command AS command
      FROM workflow_tasks WHERE LOWER(verification_command) LIKE 'python3 %'
    `).all()) {
      issues.push(issue("platform_incompatible_command", "warning", row.projectPath, [row.id], `Windows task uses '${row.command}'.`));
    }
  }

  for (const fragile of computeFragilePaths(storage, {})) {
    issues.push(issue("fragile_file", "warning", fragile.projectPath, [],
      `${fragile.file} is fragile — touched in ${fragile.reason}.`));
  }

  const bySeverity = issues.reduce((counts, current) => {
    counts[current.severity] = (counts[current.severity] || 0) + 1;
    return counts;
  }, {});
  return { summary: { totalIssues: issues.length, bySeverity }, issues };
}

export function auditProject(storage, projectPath, options = {}) {
  const normalized = normalizeProjectPath(projectPath);
  const result = auditDatabase(storage, options);
  const issues = result.issues.filter((entry) => entry.projectPath === normalized);
  return {
    summary: {
      totalIssues: issues.length,
      bySeverity: issues.reduce((counts, current) => {
        counts[current.severity] = (counts[current.severity] || 0) + 1;
        return counts;
      }, {}),
    },
    issues,
  };
}

function deleteRecordGraph(storage, id) {
  const entityIds = storage.db.prepare(
    "SELECT entity_id AS id FROM record_entities WHERE record_id = ? AND role = 'subject'",
  ).all(id).map((row) => row.id);
  storage.db.prepare("DELETE FROM links WHERE origin_record_id = ?").run(id);
  for (const entityId of entityIds) {
    storage.db.prepare("DELETE FROM links WHERE from_entity_id = ? OR to_entity_id = ?").run(entityId, entityId);
    storage.db.prepare("DELETE FROM entities WHERE id = ?").run(entityId);
  }
  storage.db.prepare("DELETE FROM record_entities WHERE record_id = ?").run(id);
}

export function remediateAudit(storage, { projectPath, apply = false } = {}) {
  const normalized = projectPath ? normalizeProjectPath(projectPath) : null;
  const scope = normalized ? " AND project_path = ?" : "";
  const params = normalized ? [normalized] : [];
  const docs = storage.db.prepare(`SELECT * FROM fix_entries WHERE agent = 'doc-ingest'${scope}`).all(...params);
  const chatter = storage.db.prepare(`
    SELECT id FROM fix_entries
    WHERE LOWER(TRIM(summary)) = 'claude code session completed.'${scope}
  `).all(...params);
  const result = { applied: Boolean(apply), docsReclassified: docs.length, chatterDeleted: chatter.length };
  if (!apply) return result;

  storage.transaction(() => {
    for (const row of docs) {
      storage.db.prepare(`
        INSERT INTO research_entries (
          id, project_path, agent, question, sources, evidence, finding, fix_made,
          verification, residual_risk, reuse_tags, created_at, capture_source,
          quality_status, fingerprint, supersedes_id
        ) VALUES (?, ?, ?, ?, ?, '[]', ?, NULL, ?, ?, '[]', ?, ?, ?, ?, ?)
      `).run(
        row.id, row.project_path, row.agent, row.summary, row.files_changed, row.summary,
        row.verification, row.residual_risk, row.created_at, row.capture_source,
        row.quality_status, row.fingerprint, row.supersedes_id,
      );
      storage.db.prepare("UPDATE record_entities SET record_type = 'research' WHERE record_id = ?").run(row.id);
      storage.db.prepare(`
        UPDATE entities SET canonical_key = ?, metadata = json_set(metadata, '$.recordType', 'research')
        WHERE id IN (SELECT entity_id FROM record_entities WHERE record_id = ? AND role = 'subject')
      `).run(`research:${row.id}`, row.id);
      storage.db.prepare("DELETE FROM fix_entries WHERE id = ?").run(row.id);
    }
    for (const { id } of chatter) {
      deleteRecordGraph(storage, id);
      storage.db.prepare("DELETE FROM fix_entries WHERE id = ?").run(id);
    }
  });
  rebuildSearchIndex(storage);
  return result;
}
