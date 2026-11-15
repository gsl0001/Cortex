import { DISTILL_GOAL_PREFIX, normalizeProjectPath } from "./storage.js";
import { basename } from "node:path";

// Recall economics: which sessions actually pulled from memory, which spun up cold, which
// burned brief tokens repeatedly with nothing to show, and how much of each session's context
// the hub accounts for. Everything here is a join over metrics the hooks already write
// (recall_injected / recall_skipped / jit_recall / recall_cited / recall_useful /
// session_usage / recall_contradicted / recall_unregistered) keyed on the Claude session id.
//
// Verdicts, per session:
//   hit     — a served record was cited ([m:id] in the final message) or a fix landed on a file
//             the brief surfaced (recall_useful). Memory earned its tokens.
//   cold    — briefs fired but served no record: the relevance gate withheld memory, or nothing
//             matched. Cheap, and the honest "spun up fresh" bucket.
//   thrash  — memory was served in ≥3 full briefs (or >2× the cap in tokens) and none of it
//             was ever used. This is the bucket that burns budget on old context. A normal
//             session gets exactly two briefs (SessionStart + first UserPromptSubmit), so two
//             is the baseline, not thrash.
//   quiet   — memory was served once, unused. A single cheap miss.
//   silent  — a session row exists but no recall event was ever written: the hooks did not fire.

const RECALL_KINDS = [
  "recall_injected", "recall_skipped", "jit_recall", "recall_cited", "recall_useful",
  "session_usage", "recall_contradicted",
];

const DAY_MS = 86_400_000;
const FATIGUE_SESSIONS = Number(process.env.CORTEX_BRIEF_FATIGUE_EXCLUDE || 10);

// The hub's own headless distill jobs (distill.js) run claude inside this repo, so the hooks
// fire and they land as sessions. Nobody is pulling from memory there — drop them from the report.
const isDistill = (s) => String(s.goal || "").startsWith(DISTILL_GOAL_PREFIX);

function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

const pct = (num, den) => (den ? Math.round((num / den) * 100) : null);
const safeParse = (json) => { try { return JSON.parse(json || "{}"); } catch { return {}; } };

// `since` accepts an ISO timestamp or a "<n>d" day window; default 14 days.
export function resolveSince(since, now = new Date()) {
  if (!since) return new Date(now.getTime() - 14 * DAY_MS).toISOString();
  const days = /^(\d+)d$/i.exec(String(since).trim());
  if (days) return new Date(now.getTime() - Number(days[1]) * DAY_MS).toISOString();
  const parsed = Date.parse(since);
  if (Number.isNaN(parsed)) throw new Error(`since must be an ISO timestamp or <n>d, got: ${since}`);
  return new Date(parsed).toISOString();
}

function emptySession(sessionId, projectPath) {
  return {
    sessionId, projectPath, agent: null, goal: null, startedAt: null, status: null,
    briefsInjected: 0, briefsSkipped: 0, briefsGated: 0, jitNotes: 0,
    servedRecords: 0, tokensInjected: 0, briefTokens: 0, jitTokens: 0, dropped: 0, maxTokens: 0,
    cited: 0, citedUnserved: 0, useful: 0, staleMarks: 0,
    servedAgeDays: [], usage: null, servedIds: new Set(),
  };
}

export function classifySession(session) {
  if (session.cited > 0 || session.useful > 0) return "hit";
  if (!session.briefsInjected && !session.jitNotes) return "silent";
  if (session.servedRecords === 0) return "cold";
  const cap = session.maxTokens || 600;
  const fullBriefs = session.briefsInjected;
  if (fullBriefs >= 3 || session.briefTokens > 2 * cap) return "thrash";
  return "quiet";
}

function rollupProject(projectPath, name, sessions, unkeyed, isFatigued = () => false) {
  const byVerdict = { hit: 0, cold: 0, thrash: 0, quiet: 0, silent: 0 };
  let tokensInjected = 0, tokensOnHits = 0, tokensWasted = 0, briefsInjected = 0, briefsSkipped = 0, briefsGated = 0;
  let staleMarks = 0, citedUnserved = 0;
  const ages = [];
  const usageHit = [], usageMiss = [];
  let contextTokens = 0, hubTokensWithUsage = 0;
  let slots = 0, fatiguedSlots = 0;
  for (const s of sessions) {
    for (const id of s.servedIds) { slots += 1; if (isFatigued(id)) fatiguedSlots += 1; }
    byVerdict[s.verdict] += 1;
    tokensInjected += s.tokensInjected;
    if (s.verdict === "hit") tokensOnHits += s.tokensInjected;
    if (s.verdict === "thrash" || s.verdict === "quiet") tokensWasted += s.tokensInjected;
    briefsInjected += s.briefsInjected;
    briefsSkipped += s.briefsSkipped;
    briefsGated += s.briefsGated;
    staleMarks += s.staleMarks;
    citedUnserved += s.citedUnserved;
    ages.push(...s.servedAgeDays);
    if (s.usage) {
      contextTokens += s.usage.contextTokens;
      hubTokensWithUsage += s.tokensInjected;
      (s.verdict === "hit" ? usageHit : usageMiss).push(s.usage.contextTokens);
    }
  }
  const served = sessions.length - byVerdict.cold - byVerdict.silent;
  const avg = (list) => (list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null);
  return {
    projectPath, name: name || basename(projectPath),
    sessions: sessions.length, ...byVerdict,
    // of the sessions memory was actually served to, how many used it
    hitRatePct: pct(byVerdict.hit, served),
    tokensInjected: tokensInjected + unkeyed.tokens, tokensOnHits, tokensWasted,
    // recall_injected rows with no session id (older hooks, manual runs) — counted, not attributed
    unkeyedInjections: unkeyed.count, unkeyedTokens: unkeyed.tokens,
    briefsInjected, briefsSkipped, briefsGated,
    // delta suppression working = high skip rate; a session re-injecting every prompt shows here
    skipRatePct: pct(briefsSkipped, briefsSkipped + briefsInjected),
    medianServedAgeDays: median(ages),
    // share of (session, record) slots held by records served to ≥10 sessions and never cited —
    // the number the fatigue exclusion exists to drive down. Per session, so a delta-skip fix
    // cannot fake an improvement by re-serving the same record fewer times.
    fatiguedSlotPct: pct(fatiguedSlots, slots), slots, fatiguedSlots,
    staleMarks, citedUnserved,
    usage: {
      sessionsWithUsage: usageHit.length + usageMiss.length,
      contextTokens,
      // hub-injected tokens as a share of everything the model processed, over sessions with usage
      hubSharePct: contextTokens ? Math.round((hubTokensWithUsage / contextTokens) * 1000) / 10 : null,
      // correlational only: do sessions that used memory process less context than those that didn't?
      avgContextHit: avg(usageHit), avgContextMiss: avg(usageMiss),
    },
  };
}

export function computeRecallEconomics(storage, { projectPath = null, since, sessionLimit = 50, now = new Date() } = {}) {
  const sinceIso = resolveSince(since, now);
  const scope = projectPath ? normalizeProjectPath(projectPath) : null;
  const db = storage.db;

  // Recall events for the scoped project(s). Citations are credited to the CITED record's
  // project (captureService.recordCitations), so they are read machine-wide and joined on
  // session id — otherwise a cross-project citation would vanish from the session that made it.
  const placeholders = RECALL_KINDS.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT id, project_path AS projectPath, kind, payload_json AS payloadJson, created_at AS createdAt
    FROM metrics_events
    WHERE created_at >= ? AND (kind IN (${placeholders}) ${scope ? "AND project_path = ?" : ""})
    ORDER BY created_at ASC
  `).all(sinceIso, ...RECALL_KINDS, ...(scope ? [scope] : []));
  const citedRows = scope
    ? db.prepare(`
        SELECT project_path AS projectPath, kind, payload_json AS payloadJson, created_at AS createdAt
        FROM metrics_events WHERE kind = 'recall_cited' AND created_at >= ? AND project_path != ?
      `).all(sinceIso, scope)
    : [];

  const sessionRows = db.prepare(`
    SELECT id, project_path AS projectPath, agent, goal, status, created_at AS createdAt
    FROM agent_sessions WHERE created_at >= ? ${scope ? "AND project_path = ?" : ""}
    ORDER BY created_at DESC
  `).all(sinceIso, ...(scope ? [scope] : []));

  const sessions = new Map();
  const sessionFor = (id, project) => {
    if (!sessions.has(id)) sessions.set(id, emptySession(id, project));
    return sessions.get(id);
  };
  for (const row of sessionRows) {
    const s = sessionFor(row.id, row.projectPath);
    Object.assign(s, { agent: row.agent, goal: row.goal, startedAt: row.createdAt, status: row.status });
  }
  const unkeyed = new Map(); // projectPath -> { count, tokens }
  const recordSessions = new Map(); // record id -> Set(session id) it was served to
  const citedPrefixes = new Set();
  const injectionSession = new Map(); // recall_injected metric id -> session id
  // where a session ran, whatever the window: a session older than `since` can still cite
  const sessionOwner = { get: (id) => db.prepare("SELECT project_path AS projectPath FROM agent_sessions WHERE id = ?").get(id) };
  const isFatigued = (id) => (recordSessions.get(id)?.size || 0) >= FATIGUE_SESSIONS && !citedPrefixes.has(String(id).replace(/-/g, "").slice(0, 6));
  const bumpUnkeyed = (project, tokens) => {
    const entry = unkeyed.get(project) || { count: 0, tokens: 0 };
    entry.count += 1; entry.tokens += tokens; unkeyed.set(project, entry);
  };

  for (const row of [...rows, ...citedRows]) {
    const payload = safeParse(row.payloadJson);
    // recall_useful rows written before they carried a session id point at their injection
    const sessionId = payload.sessionId
      || (row.kind === "recall_useful" ? injectionSession.get(payload.recallMetricId) : null);
    if (row.kind === "recall_injected" && !sessionId) { bumpUnkeyed(row.projectPath, Number(payload.usedTokens || 0)); continue; }
    if (!sessionId) continue;
    if (row.kind === "recall_injected") injectionSession.set(row.id, sessionId);
    // A citation is stored under the CITED record's project, which says nothing about where
    // the citing session ran. A session not seen yet is placed by its own row; in a scoped
    // report a citation whose session cannot be placed in the scope is someone else's.
    let project = sessions.get(sessionId)?.projectPath;
    if (!project && row.kind === "recall_cited") {
      project = sessionOwner.get(sessionId)?.projectPath;
      if (scope && project !== scope) continue;
    }
    const s = sessionFor(sessionId, project || row.projectPath);
    if (!s.agent && payload.agent) s.agent = payload.agent;
    if (!s.startedAt) s.startedAt = row.createdAt;
    switch (row.kind) {
      case "recall_injected": {
        const tokens = Number(payload.usedTokens || 0);
        s.briefsInjected += 1;
        s.briefTokens += tokens;
        s.tokensInjected += tokens;
        s.dropped += Number(payload.dropped || 0);
        s.maxTokens = Math.max(s.maxTokens, Number(payload.maxTokens || 0));
        if (payload.gated) s.briefsGated += 1;
        const served = (payload.injectedFixIds || []).length + (payload.injectedResearchIds || []).length
          + (payload.injectedDecisionIds || []).length;
        s.servedRecords += served;
        for (const id of [...(payload.injectedFixIds || []), ...(payload.injectedResearchIds || []), ...(payload.injectedDecisionIds || [])]) {
          s.servedIds.add(id);
          if (!recordSessions.has(id)) recordSessions.set(id, new Set());
          recordSessions.get(id).add(sessionId);
        }
        s.servedAgeDays.push(...(payload.servedAgeDays || []));
        break;
      }
      case "recall_skipped": s.briefsSkipped += 1; break;
      case "jit_recall": {
        const tokens = Number(payload.noteTokens || 0);
        s.jitNotes += 1; s.jitTokens += tokens; s.tokensInjected += tokens;
        s.servedRecords += (payload.servedFixIds || []).length || 1;
        break;
      }
      case "recall_cited":
        if (payload.resolved === false) break;
        if (payload.idPrefix) citedPrefixes.add(payload.idPrefix);
        if (payload.source === "unserved") { s.citedUnserved += 1; break; }
        s.cited += 1;
        break;
      case "recall_useful": s.useful += 1; break;
      case "recall_contradicted": s.staleMarks += 1; break;
      case "session_usage":
        // rows are ascending by time; the last one is the session's running total
        s.usage = {
          turns: Number(payload.turns || 0), contextTokens: Number(payload.contextTokens || 0),
          outputTokens: Number(payload.outputTokens || 0),
        };
        break;
      default: break;
    }
  }

  // recall_cited without a session key (legacy) can only be counted project-wide; expose it so
  // the per-session hit count is not mistaken for the project's whole citation history.
  const allSessions = [...sessions.values()];
  const distillExcluded = allSessions.filter(isDistill).length;
  const sessionList = allSessions.filter((s) => !isDistill(s)).map((s) => ({
    ...s,
    verdict: classifySession(s),
    medianServedAgeDays: median(s.servedAgeDays),
  }));
  sessionList.sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));

  const names = new Map(storage.listProjectProfiles().map((p) => [p.projectPath, p.name]));
  const byProject = new Map();
  for (const s of sessionList) {
    if (!byProject.has(s.projectPath)) byProject.set(s.projectPath, []);
    byProject.get(s.projectPath).push(s);
  }
  for (const project of unkeyed.keys()) if (!byProject.has(project)) byProject.set(project, []);
  const projects = [...byProject.entries()]
    .map(([project, list]) => rollupProject(project, names.get(project), list, unkeyed.get(project) || { count: 0, tokens: 0 }, isFatigued))
    .sort((a, b) => b.tokensWasted - a.tokensWasted || b.tokensInjected - a.tokensInjected);

  // sessions that started outside any registered project: the "spun up fresh" count
  const unregisteredRows = db.prepare(`
    SELECT payload_json AS payloadJson FROM metrics_events
    WHERE kind = 'recall_unregistered' AND created_at >= ?
  `).all(sinceIso);
  const unregisteredDirs = new Map();
  for (const row of unregisteredRows) {
    const cwd = safeParse(row.payloadJson).cwd || "?";
    unregisteredDirs.set(cwd, (unregisteredDirs.get(cwd) || 0) + 1);
  }

  const totals = projects.reduce((acc, p) => ({
    sessions: acc.sessions + p.sessions, hit: acc.hit + p.hit, cold: acc.cold + p.cold,
    thrash: acc.thrash + p.thrash, quiet: acc.quiet + p.quiet, silent: acc.silent + p.silent,
    tokensInjected: acc.tokensInjected + p.tokensInjected, tokensOnHits: acc.tokensOnHits + p.tokensOnHits,
    tokensWasted: acc.tokensWasted + p.tokensWasted, briefsSkipped: acc.briefsSkipped + p.briefsSkipped,
    briefsInjected: acc.briefsInjected + p.briefsInjected, slots: acc.slots + p.slots, fatiguedSlots: acc.fatiguedSlots + p.fatiguedSlots,
  }), { sessions: 0, hit: 0, cold: 0, thrash: 0, quiet: 0, silent: 0, tokensInjected: 0, tokensOnHits: 0, tokensWasted: 0, briefsSkipped: 0, briefsInjected: 0, slots: 0, fatiguedSlots: 0 });
  const servedTotal = totals.sessions - totals.cold - totals.silent;

  return {
    since: sinceIso,
    projectPath: scope,
    totals: {
      ...totals,
      hitRatePct: pct(totals.hit, servedTotal),
      skipRatePct: pct(totals.briefsSkipped, totals.briefsSkipped + totals.briefsInjected),
      fatiguedSlotPct: pct(totals.fatiguedSlots, totals.slots),
      unregisteredStarts: unregisteredRows.length,
      distillExcluded,
    },
    unregistered: [...unregisteredDirs.entries()]
      .map(([cwd, count]) => ({ cwd, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    projects,
    sessions: sessionList.slice(0, sessionLimit).map((s) => ({
      sessionId: s.sessionId, projectPath: s.projectPath, agent: s.agent, goal: s.goal,
      startedAt: s.startedAt, status: s.status, verdict: s.verdict,
      briefsInjected: s.briefsInjected, briefsSkipped: s.briefsSkipped, briefsGated: s.briefsGated,
      jitNotes: s.jitNotes, servedRecords: s.servedRecords, tokensInjected: s.tokensInjected,
      dropped: s.dropped, cited: s.cited, citedUnserved: s.citedUnserved, useful: s.useful,
      staleMarks: s.staleMarks, medianServedAgeDays: s.medianServedAgeDays, usage: s.usage,
      servedIds: undefined,
    })),
  };
}

const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
const pad = (value, width, right = false) => {
  const s = String(value ?? "—");
  return right ? s.padStart(width) : s.padEnd(width);
};

function table(headers, rows, isRight = (i) => i >= 1) {
  const widths = headers.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i] ?? "—").length)));
  const line = (cells) => cells.map((c, i) => pad(c, widths[i], isRight(i))).join("  ").trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

export function renderRecallEconomicsText(report) {
  const t = report.totals;
  const out = [
    `Recall economics since ${report.since.slice(0, 10)}${report.projectPath ? ` — ${report.projectPath}` : " — all projects"}`,
    `Sessions ${fmt(t.sessions)}: hit ${fmt(t.hit)} · cold ${fmt(t.cold)} · thrash ${fmt(t.thrash)} · quiet ${fmt(t.quiet)} · silent ${fmt(t.silent)}`
      + ` | hit rate ${t.hitRatePct == null ? "—" : `${t.hitRatePct}%`} of served sessions`,
    `Tokens injected ${fmt(t.tokensInjected)}: on hits ${fmt(t.tokensOnHits)} · wasted (thrash+quiet) ${fmt(t.tokensWasted)}`
      + ` | delta-skip rate ${t.skipRatePct == null ? "—" : `${t.skipRatePct}%`} | fatigued slots ${t.fatiguedSlotPct == null ? "—" : `${t.fatiguedSlotPct}%`} | unregistered starts ${fmt(t.unregisteredStarts)}`,
    "",
    table(
      ["Project", "Sess", "Hit", "Cold", "Thrash", "Quiet", "Hit%", "Injected", "Wasted", "Skip%", "Fatig%", "MedAge(d)", "Hub%ctx"],
      report.projects.map((p) => [
        p.name, p.sessions, p.hit, p.cold, p.thrash, p.quiet,
        p.hitRatePct == null ? "—" : `${p.hitRatePct}%`, fmt(p.tokensInjected), fmt(p.tokensWasted),
        p.skipRatePct == null ? "—" : `${p.skipRatePct}%`, p.fatiguedSlotPct == null ? "—" : `${p.fatiguedSlotPct}%`, p.medianServedAgeDays ?? "—",
        p.usage.hubSharePct == null ? "—" : `${p.usage.hubSharePct}%`,
      ]),
    ),
  ];
  if (report.unregistered.length) {
    out.push("", "Unregistered directories (sessions started, no brief):",
      ...report.unregistered.map((u) => `  ${u.count}× ${u.cwd}`));
  }
  if (report.sessions.length) {
    out.push("", table(
      ["Started", "Project", "Verdict", "Briefs", "Skip", "Served", "Tokens", "Cited", "Age(d)", "Ctx tokens", "Goal"],
      report.sessions.map((s) => [
        String(s.startedAt || "").slice(0, 16).replace("T", " "), basename(s.projectPath), s.verdict,
        s.briefsInjected, s.briefsSkipped, s.servedRecords, fmt(s.tokensInjected), s.cited,
        s.medianServedAgeDays ?? "—", s.usage ? fmt(s.usage.contextTokens) : "—",
        String(s.goal || "").slice(0, 48),
      ]),
      (i) => i >= 3 && i <= 9,
    ));
  }
  return out.join("\n");
}
