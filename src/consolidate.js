// Weekly consolidation: promote what recurs instead of re-injecting it. The records that earn
// their keep in a brief are a handful of standing rules re-served week after week. Those belong
// in the files agents already read (a repo's CLAUDE.md, a skill's SKILL.md). This finds what
// recurred in a window and writes proposal files for a human to accept. It never edits a
// target file.
//
// Recurrence is counted in distinct DAYS, from three signals: a record restated (its
// supersede chain), captured again (a duplicate capture pointing at it), or cited in a
// session. A one-off fix appears on one day and is not a candidate.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { containment, keyTokens } from "./capturePolicy.js";
import { runModel } from "./distill.js";
import { resolveSince } from "./recallEconomics.js";
import { normalizeProjectPath } from "./storage.js";

const RECORD_SQL = `
  SELECT id, project_path AS projectPath, 'fix' AS type, summary AS text, created_at AS createdAt,
         supersedes_id AS supersedesId, quality_status AS qualityStatus FROM fix_entries
  UNION ALL SELECT id, project_path, 'decision', decision, created_at, supersedes_id, quality_status
         FROM decision_entries
  UNION ALL SELECT id, project_path, 'research', question || ' — ' || finding, created_at, supersedes_id,
         quality_status FROM research_entries`;
const DUPLICATE_REASONS = new Set(["discarded_duplicate", "discarded_near_duplicate"]);
// share of a record's key tokens a file paragraph must hold to count as already written down
const COVERED = Number(process.env.CORTEX_CONSOLIDATE_COVERED || 0.6);
// overlap at which two records under one target are the same rule worded twice
const MERGE = Number(process.env.CORTEX_CONSOLIDATE_MERGE || 0.6);

// A session's own report of what it did ("I rendered the video and marked it rendered",
// "Sent the follow-up to nine creators") recurs because sessions repeat the task, not because
// it states a rule. Rules are not written in the first person, and do not report a run's end.
const isStatusReport = (text) =>
  /^\s*(?:i|we)\s+[a-z']+/i.test(text)
  || /^\s*(?:sent|shipped|done|finished|completed|both|all|scan complete|there (?:are|is) no)\b/i.test(text)
  || /\b(?:report is saved|is (?:finished|made|done)|marked \**rendered)\b/i.test(text);

const prefixOf = (id) => String(id).replace(/-/g, "").slice(0, 6);
const day = (iso) => String(iso).slice(0, 10);
const oneLine = (text, n = 220) => {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

function coverage(recordTokens, paragraphTokens) {
  if (!recordTokens.size) return 0;
  let hit = 0;
  for (const token of recordTokens) if (paragraphTokens.has(token)) hit += 1;
  return hit / recordTokens.size;
}

// Paragraphs and list items of a markdown file, each with its key tokens. Short fragments
// (headings, "---") are dropped: a three-word line covers almost nothing yet matches everything.
function fileParagraphs(path) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  return text.replace(/\r\n/g, "\n").split(/\n\s*\n|\n(?=\s*[-*] )/)
    .map((raw) => raw.trim())
    .filter((raw) => raw && !raw.startsWith("#"))
    .map((raw) => ({ raw, tokens: keyTokens(raw) }))
    .filter((p) => p.tokens.size >= 5);
}

function listSkills(skillsDir) {
  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(skillsDir, d.name, "SKILL.md")))
      .map((d) => d.name)
      .sort((a, b) => b.length - a.length);
  } catch { return []; }
}

// A record that names a skill ("/weekly-report", "the weekly-report template") is a rule for
// that skill, not for whichever repo the session happened to run in. Short names ("ship",
// "mac") only match in slash form; they are ordinary words otherwise.
function targetFor(record, skills, skillsDir) {
  const text = record.text.toLowerCase();
  for (const name of skills) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const slash = new RegExp(`(^|\\s)/${escaped}\\b`).test(text);
    const word = (name.length >= 6 || name.includes("-")) && new RegExp(`\\b${escaped}\\b`).test(text);
    if (slash || word) return { kind: "skill", key: `skill-${name}`, path: join(skillsDir, name, "SKILL.md") };
  }
  return { kind: "repo", key: basename(record.projectPath) || "project", path: join(record.projectPath, "CLAUDE.md") };
}

export function mineCandidates(storage, { projectPath = null, since = "7d", now = new Date(), minDays = 2,
  limit = 8, skillsDir = join(homedir(), ".claude", "skills") } = {}) {
  const from = resolveSince(since, now);
  const until = now.toISOString();
  const scope = projectPath ? normalizeProjectPath(projectPath) : null;
  const records = storage.db.prepare(RECORD_SQL).all();
  const byId = new Map(records.map((r) => [r.id, r]));
  const byPrefix = new Map(records.map((r) => [prefixOf(r.id), r]));
  const supersededBy = new Map();
  for (const r of records) if (r.supersedesId && byId.has(r.supersedesId)) supersededBy.set(r.supersedesId, r.id);
  // The live end of a supersede chain stands for the whole chain; the hop cap guards a cycle.
  const headOf = (id) => {
    let current = id;
    for (let hops = 0; supersededBy.has(current) && hops < 100; hops += 1) current = supersededBy.get(current);
    return byId.get(current);
  };

  const evidence = new Map(); // head id -> { days: Set, signals: Map(kind -> count) }
  const note = (record, when, kind) => {
    const head = record && headOf(record.id);
    if (!head || when < from || when > until) return;
    if (!evidence.has(head.id)) evidence.set(head.id, { days: new Set(), signals: new Map() });
    const entry = evidence.get(head.id);
    entry.days.add(day(when));
    entry.signals.set(kind, (entry.signals.get(kind) || 0) + 1);
  };
  for (const r of records) note(r, r.createdAt, r.supersedesId ? "restated" : "captured");
  const metrics = storage.db.prepare(`SELECT kind, payload_json AS p, created_at AS at FROM metrics_events
    WHERE kind IN ('capture_outcome', 'recall_cited', 'recall_contradicted') AND created_at >= ? AND created_at <= ?`).all(from, until);
  const contradicted = [];
  for (const m of metrics) {
    let payload;
    try { payload = JSON.parse(m.p || "{}"); } catch { continue; }
    if (m.kind === "capture_outcome" && DUPLICATE_REASONS.has(payload.reason)) note(byId.get(payload.recordId), m.at, "recaptured");
    else if (m.kind === "recall_cited") note(byPrefix.get(payload.idPrefix), m.at, "cited");
    else if (m.kind === "recall_contradicted" && byPrefix.has(payload.idPrefix)) {
      contradicted.push({ record: byPrefix.get(payload.idPrefix), at: m.at, reason: payload.reason || "" });
    }
  }

  const skills = listSkills(skillsDir);
  const files = new Map(); // target path -> paragraphs | null
  const paragraphsOf = (path) => { if (!files.has(path)) files.set(path, fileParagraphs(path)); return files.get(path); };
  const targets = new Map(); // target path -> { target, projects: Set, candidates: [], outdated: [] }
  const targetEntry = (target, record) => {
    if (!targets.has(target.path)) targets.set(target.path, { target, projects: new Set(), candidates: [], outdated: [], alreadyDocumented: 0 });
    const entry = targets.get(target.path);
    entry.projects.add(record.projectPath);
    return entry;
  };
  const inScope = (record) => (!scope || record.projectPath === scope) && existsSync(record.projectPath);

  // The same rule often lives in several chains (each session restated it in new words), so
  // near-identical heads under one target merge before the day threshold is applied.
  const clusters = new Map(); // target path -> { target, items: [{ members, tokens, days, signals }] }
  for (const [id, entry] of evidence) {
    const record = byId.get(id);
    if (record.qualityStatus === "quarantined" || isStatusReport(record.text) || !inScope(record)) continue;
    const target = targetFor(record, skills, skillsDir);
    if (!clusters.has(target.path)) clusters.set(target.path, { target, items: [] });
    const tokens = keyTokens(record.text);
    const items = clusters.get(target.path).items;
    const home = items.find((c) => containment(c.tokens, tokens) >= MERGE);
    if (!home) { items.push({ members: [record], tokens, days: new Set(entry.days), signals: new Map(entry.signals) }); continue; }
    home.members.push(record);
    for (const d of entry.days) home.days.add(d);
    for (const [k, n] of entry.signals) home.signals.set(k, (home.signals.get(k) || 0) + n);
  }
  for (const { target, items } of clusters.values()) {
    for (const { members, days, signals } of items) {
      if (days.size < minDays) continue;
      // the newest wording speaks for the cluster
      const [record, ...rest] = [...members].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const tokens = keyTokens(record.text);
      const also = rest.map((r) => prefixOf(r.id));
      const slot = targetEntry(target, record);
      if ((paragraphsOf(target.path) || []).some((p) => coverage(tokens, p.tokens) >= COVERED)) { slot.alreadyDocumented += 1; continue; }
      const sorted = [...days].sort();
      slot.candidates.push({ id: record.id, prefix: prefixOf(record.id), type: record.type, projectPath: record.projectPath,
        text: record.text, days: days.size, firstSeen: sorted[0], lastSeen: sorted.at(-1),
        signals: Object.fromEntries(signals), also });
    }
  }
  // A contradicted record only matters here if its claim made it into a file someone reads.
  for (const { record, at, reason } of contradicted) {
    if (!inScope(record)) continue;
    const target = targetFor(record, skills, skillsDir);
    const tokens = keyTokens(record.text);
    const line = (paragraphsOf(target.path) || []).find((p) => coverage(tokens, p.tokens) >= COVERED);
    if (line) targetEntry(target, record).outdated.push({ prefix: prefixOf(record.id), at: day(at), reason, line: line.raw });
  }

  const result = [...targets.values()]
    .map((t) => ({ ...t, projects: [...t.projects], exists: paragraphsOf(t.target.path) !== null,
      candidates: t.candidates.sort((a, b) => b.days - a.days || b.lastSeen.localeCompare(a.lastSeen)).slice(0, limit) }))
    .filter((t) => t.candidates.length || t.outdated.length)
    .sort((a, b) => b.candidates.length - a.candidates.length);
  return { from, until, minDays, targets: result };
}

export function buildDraftPrompt(entry, { from, until }) {
  let current = "(file does not exist yet)";
  try { current = readFileSync(entry.target.path, "utf8").slice(0, 8000); } catch { /* new file */ }
  const records = entry.candidates.map((c) =>
    `${[c.prefix, ...c.also].map((p) => `[m:${p}]`).join(" ")} ${c.type}, seen on ${c.days} days (${c.firstSeen} to ${c.lastSeen}): ${oneLine(c.text, 600)}`).join("\n");
  const outdated = entry.outdated.map((o) => `[m:${o.prefix}] contradicted ${o.at}: ${oneLine(o.reason)}\n  line: ${oneLine(o.line, 400)}`).join("\n");
  return `You maintain an instruction file that coding agents read at the start of every session: ${entry.target.path}

Below are memory records that recurred across several days between ${day(from)} and ${day(until)}. Turn the ones that state a durable rule (how to do something in this project, a constraint, a pitfall to avoid) into short imperative lines for that file. Skip status updates, finished tasks, one-off facts, and anything the current file already says. Propose at most 5 additions; fewer is better. Cite the record ids each line came from.
${outdated ? `\nSome lines in the current file may now be wrong; propose removing them only if the contradiction is clear:\n${outdated}\n` : ""}
Reply in exactly this format and nothing else:
ADD
- <line> [m:xxxxxx]
REMOVE
- <exact existing line>
Leave a section empty if it has nothing. Reply NOTHING if no record is worth promoting.

Current file:
<<<
${current}
>>>

Records:
${records || "(none)"}`;
}

export function parseDraft(output) {
  const text = String(output || "").trim();
  if (!text || /^NOTHING\b/i.test(text)) return { add: [], remove: [] };
  const out = { add: [], remove: [] };
  let section = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*ADD\s*$/i.test(line)) section = "add";
    else if (/^\s*REMOVE\s*$/i.test(line)) section = "remove";
    else if (section && /^\s*[-*]\s+\S/.test(line)) out[section].push(line.replace(/^\s*[-*]\s+/, "").trim());
  }
  return out;
}

function renderProposal(entry, { from, until, minDays, draft }) {
  const lines = [`# Proposal: ${entry.target.path}`, "",
    `Window ${day(from)} to ${day(until)}; a record qualifies when it recurred on ${minDays} or more days.`,
    `Source project(s): ${entry.projects.join(", ")}. ${entry.exists ? "" : "The file does not exist yet. "}Nothing has been changed: copy what you accept into the file.`, ""];
  if (draft?.error) lines.push(`> Draft unavailable: ${draft.error}. The evidence below is complete.`, "");
  if (draft && !draft.error) {
    lines.push("## Suggested lines (model draft)", "");
    lines.push(...(draft.add.length ? draft.add.map((l) => `- ${l}`) : ["- (none proposed)"]), "");
    if (draft.remove.length) lines.push("## Suggested removals (model draft)", "", ...draft.remove.map((l) => `- ${l}`), "");
  }
  if (entry.candidates.length) {
    lines.push("## Recurring records", "", "| Record | Type | Days | Signals | Seen | Text |", "|---|---|---|---|---|---|");
    for (const c of entry.candidates) {
      const signals = Object.entries(c.signals).map(([k, n]) => `${k} ${n}`).join(", ");
      const ids = [c.prefix, ...c.also].map((p) => `m:${p}`).join(", ");
      lines.push(`| ${ids} | ${c.type} | ${c.days} | ${signals} | ${c.firstSeen} to ${c.lastSeen} | ${oneLine(c.text).replace(/\|/g, "\\|")} |`);
    }
    lines.push("");
  }
  if (entry.outdated.length) {
    lines.push("## Lines that may be outdated", "");
    for (const o of entry.outdated) lines.push(`- m:${o.prefix} was contradicted on ${o.at}${o.reason ? ` (${oneLine(o.reason, 120)})` : ""}. Line: "${oneLine(o.line, 300)}"`);
    lines.push("");
  }
  if (entry.alreadyDocumented) lines.push(`${entry.alreadyDocumented} more recurring record(s) were skipped because the file already covers them.`, "");
  return lines.join("\n");
}

// Mine, optionally draft with a model, and write one proposal file per target plus a README.
// Writes only under outDir.
export async function consolidate(hub, { outDir, draft = false, spawnImpl, model, now = new Date(), ...options } = {}) {
  const mined = mineCandidates(hub.storage, { now, ...options });
  const dir = join(outDir || join(dirname(hub.storage.dbPath), "proposals"), day(now.toISOString()));
  mkdirSync(dir, { recursive: true });
  const written = [];
  for (const entry of mined.targets) {
    let drafted = null;
    if (draft) {
      const output = await runModel(buildDraftPrompt(entry, mined), {
        model: model || process.env.CORTEX_CONSOLIDATE_MODEL || "sonnet", ...(spawnImpl ? { spawnImpl } : {}),
      });
      drafted = output === null ? { error: "the model call failed (check `claude -p` auth)" } : parseDraft(output);
    }
    const file = join(dir, `${entry.target.key.replace(/[^a-z0-9._-]+/gi, "-")}.md`);
    writeFileSync(file, renderProposal(entry, { ...mined, draft: drafted }));
    written.push({ file, target: entry.target.path, candidates: entry.candidates.length, outdated: entry.outdated.length,
      alreadyDocumented: entry.alreadyDocumented, drafted: drafted ? (drafted.error ? "failed" : drafted.add.length) : null });
  }
  const summary = [`# Consolidation ${day(mined.from)} to ${day(mined.until)}`, "",
    written.length ? "| Target | Candidates | Possibly outdated | Already covered | Proposal |" : "No record recurred on enough days to propose.",
    ...(written.length ? ["|---|---|---|---|---|"] : []),
    ...written.map((w) => `| ${w.target} | ${w.candidates} | ${w.outdated} | ${w.alreadyDocumented} | ${basename(w.file)} |`), ""].join("\n");
  writeFileSync(join(dir, "README.md"), summary);
  return { outDir: dir, from: mined.from, until: mined.until, targets: written, text: `${summary}\nWritten to ${dir}` };
}
