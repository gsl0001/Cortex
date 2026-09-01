// Evening brief: deterministic SQL over existing tables, no LLM.
// Each section is built independently — one bad table/query marks that
// section { error } instead of killing the whole report.

import { execFileSync } from "node:child_process";

function localDayStartIso(now) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return start.toISOString();
}

function localDateStamp(now) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function section(fn) {
  try {
    return fn();
  } catch (error) {
    return { error: String(error.message || error) };
  }
}

export function buildEodReport({ db, now = new Date(), drift = null }) {
  const dayStart = localDayStartIso(now);
  const staleBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const done = section(() => ({
    tasks: db.prepare(
      "SELECT project_path, title, evidence, verification_command FROM workflow_tasks WHERE status = 'done' AND updated_at >= ? ORDER BY project_path, updated_at"
    ).all(dayStart),
    fixes: db.prepare(
      "SELECT project_path, summary, verification FROM fix_entries WHERE created_at >= ? AND quality_status != 'quarantined' AND id NOT IN (SELECT supersedes_id FROM fix_entries WHERE supersedes_id IS NOT NULL) ORDER BY project_path, created_at"
    ).all(dayStart),
    decisions: db.prepare(
      "SELECT project_path, decision, rationale FROM decision_entries WHERE created_at >= ? AND quality_status = 'accepted' AND id NOT IN (SELECT supersedes_id FROM decision_entries WHERE supersedes_id IS NOT NULL) ORDER BY project_path"
    ).all(dayStart),
    research: db.prepare(
      "SELECT project_path, question, finding FROM research_entries WHERE created_at >= ? AND quality_status != 'quarantined' AND id NOT IN (SELECT supersedes_id FROM research_entries WHERE supersedes_id IS NOT NULL) ORDER BY project_path"
    ).all(dayStart),
    sessions: db.prepare(
      "SELECT project_path, agent, goal FROM agent_sessions WHERE status = 'finished' AND updated_at >= ? ORDER BY project_path"
    ).all(dayStart),
  }));

  const needsEyes = section(() => ({
    inbox: db.prepare(
      "SELECT project_path, author, message, created_at FROM inbox_items WHERE resolved_at IS NULL ORDER BY created_at"
    ).all(),
    blocked: db.prepare(
      "SELECT project_path, title, block_reason FROM workflow_tasks WHERE status = 'blocked' ORDER BY project_path"
    ).all(),
    proposals: db.prepare(
      "SELECT project_path, created_at FROM roadmap_proposals WHERE status = 'pending' ORDER BY created_at"
    ).all(),
    failedRuns: db.prepare(
      "SELECT agent, task_id, outcome, notes FROM runs WHERE started_at >= ? AND (outcome = 'failed' OR verification_exit NOT IN (0) ) ORDER BY started_at"
    ).all(dayStart),
  }));

  const verifyQueue = section(() => ({
    tasks: db.prepare(
      "SELECT project_path, title, verification_command FROM workflow_tasks WHERE status = 'done' AND verification_command IS NOT NULL AND (evidence IS NULL OR evidence = '') ORDER BY updated_at DESC"
    ).all(),
    fixes: db.prepare(
      "SELECT project_path, summary FROM fix_entries WHERE created_at >= ? AND (verification IS NULL OR verification = '') ORDER BY created_at"
    ).all(dayStart),
    drift: drift ?? [],
  }));

  const tonight = section(() => ({
    open: db.prepare(
      "SELECT project_path, title, priority FROM workflow_tasks WHERE status = 'open' ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at"
    ).all(),
    staleClaims: db.prepare(
      "SELECT project_path, title, assigned_agent, updated_at FROM workflow_tasks WHERE status = 'in_progress' AND updated_at < ? ORDER BY updated_at"
    ).all(staleBefore),
  }));

  return { date: localDateStamp(now), generatedAt: now.toISOString(), done, needsEyes, verifyQueue, tonight };
}

export function parseDrift({ project, porcelain, aheadBehind }) {
  const dirtyFiles = porcelain.split("\n").filter((line) => line.trim()).length;
  const [ahead = 0, behind = 0] = aheadBehind.trim().split("\t").map(Number);
  return { project, dirtyFiles, ahead, behind };
}

// runGit injectable for tests; default shells out. A project with no upstream or
// no .git is "unavailable", never an exception — the report must always render.
export function collectDrift(projectPaths, {
  runGit = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 5000 }),
} = {}) {
  return projectPaths.map((project) => {
    try {
      const porcelain = runGit(project, ["status", "--porcelain"]);
      let aheadBehind = "0\t0";
      try {
        aheadBehind = runGit(project, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
      } catch { /* no upstream — treat as in sync */ }
      return parseDrift({ project, porcelain, aheadBehind });
    } catch {
      return { project, unavailable: true };
    }
  });
}

const TG_LIMIT = 4096;

function projName(p) {
  return String(p || "").replace(/\\/g, "/").split("/").filter(Boolean).pop() || p;
}

function counts(report) {
  const val = (s, keys) => (s.error ? 0 : keys.reduce((n, k) => n + (s[k]?.length || 0), 0));
  const driftCount = (report.verifyQueue.drift || []).filter((d) => d.unavailable || d.dirtyFiles > 0 || d.behind > 0 || d.ahead > 0).length;
  return {
    done: val(report.done, ["tasks", "fixes", "decisions", "research", "sessions"]),
    eyes: val(report.needsEyes, ["inbox", "blocked", "proposals", "failedRuns"]),
    verify: val(report.verifyQueue, ["tasks", "fixes"]) + driftCount,
    open: report.tonight.error ? 0 : (report.tonight.open?.length || 0),
  };
}

// Per-project rollup of everything finished today: "demo: 2 tasks, 1 fix".
// The done section is by far the largest (100+ rows on a busy day) and item-level
// detail belongs in the HTML attachment, not the phone notification.
function doneByProject(done) {
  const kinds = [["tasks", "task", "tasks"], ["fixes", "fix", "fixes"], ["decisions", "decision", "decisions"], ["research", "research", "research"], ["sessions", "session", "sessions"]];
  const perProject = new Map();
  for (const [key, singular, plural] of kinds) {
    for (const row of done[key] || []) {
      const name = projName(row.project_path);
      if (!perProject.has(name)) perProject.set(name, new Map());
      const tally = perProject.get(name);
      tally.set(singular, { n: (tally.get(singular)?.n || 0) + 1, plural });
    }
  }
  return [...perProject].map(([name, tally]) => ({
    project: name,
    summary: [...tally].map(([singular, { n, plural }]) => `${n} ${n === 1 ? singular : plural}`).join(", "),
  }));
}

const clip = (s, n = 90) => (String(s ?? "").length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ""));

export function renderEodText(report) {
  const MAX_ITEMS = 5; // per section — the HTML attachment has everything
  const c = counts(report);
  const lines = [`Evening brief ${report.date}`, `${c.done} done · ${c.eyes} need eyes · ${c.verify} to verify`];
  if (c.done === 0 && c.eyes === 0 && c.verify === 0) {
    lines.push(`Quiet day, ${c.open} open task${c.open === 1 ? "" : "s"} for tonight.`);
  }
  if (report.story) lines.push("", clip(report.story, 320));
  const item = (project, text) => `- ${project} — ${clip(text)}`;
  const sections = [
    ["DONE TODAY", report.done.error ? [] : doneByProject(report.done).map(({ project, summary }) => `- ${project}: ${summary}`), report.done.error],
    ["NEEDS YOUR EYES", [
      ...(report.needsEyes.inbox || []).map((i) => item(projName(i.project_path), `inbox: ${i.message}`)),
      ...(report.needsEyes.blocked || []).map((t) => item(projName(t.project_path), t.summary_plain || `blocked: ${t.title} (${t.block_reason})`)),
      ...(report.needsEyes.proposals || []).map((p) => item(projName(p.project_path), "roadmap proposal pending")),
      ...(report.needsEyes.failedRuns || []).map((r) => `- run failed (${r.agent}): ${clip(r.notes || r.outcome)}`),
    ], report.needsEyes.error],
    ["VERIFY", [
      ...(report.verifyQueue.tasks || []).map((t) => item(projName(t.project_path), t.summary_plain || `${t.title} — run: ${t.verification_command}`)),
      ...(report.verifyQueue.fixes || []).map((f) => item(projName(f.project_path), `fix unverified: ${f.summary}`)),
      ...(report.verifyQueue.drift || []).filter((d) => d.unavailable || d.dirtyFiles || d.behind || d.ahead).map((d) =>
        d.unavailable ? item(projName(d.project), "repo unavailable")
          : item(projName(d.project), `${d.dirtyFiles} dirty, ${d.ahead} ahead, ${d.behind} behind`)),
    ], report.verifyQueue.error],
    ["TONIGHT", [
      ...(report.tonight.open || []).map((t) => item(projName(t.project_path), t.summary_plain || `(${t.priority}) ${t.title}`)),
      ...(report.tonight.staleClaims || []).map((t) => item(projName(t.project_path), `stale claim (${t.assigned_agent}): ${t.title}`)),
    ], report.tonight.error],
  ].map(([title, items, error]) => {
    if (error || items.length <= MAX_ITEMS) return [title, items, error];
    return [title, [...items.slice(0, MAX_ITEMS), `…+${items.length - MAX_ITEMS} more, see attached`], error];
  });
  // Single running budget across the whole render, so a hard cut can never land
  // mid-line: every push is only made once it's confirmed to fit. The health
  // footer is reserved up front (as if already appended) so it always makes
  // it into the final output, no matter how much section content is cut.
  const RESERVE = 40; // headroom for a possible trailing "…+N sections omitted" marker
  const healthBlock = report.health ? ["", report.health] : [];
  const healthCost = healthBlock.reduce((n, l) => n + 1 + l.length, 0);
  let used = lines.join("\n").length;
  let omittedSections = 0;
  const fits = (line) => used + 1 + line.length <= TG_LIMIT - RESERVE - healthCost;
  const push = (line) => { lines.push(line); used += 1 + line.length; };

  sectionLoop: for (const [title, items, error] of sections) {
    if (error) {
      const line = `${title}: unavailable (${error})`;
      if (!fits("") || !fits(line)) { omittedSections += 1; continue; }
      push(""); push(line);
      continue;
    }
    if (!items.length) continue;
    if (!fits("") || !fits(title)) { omittedSections += 1; continue sectionLoop; }
    push(""); push(title);
    let shown = 0;
    for (const item of items) {
      if (!fits(item)) break;
      push(item);
      shown += 1;
    }
    if (shown < items.length) {
      const marker = `…+${items.length - shown} more, see attached`;
      if (fits(marker)) push(marker);
    }
  }
  if (omittedSections > 0) {
    const marker = `…+${omittedSections} section${omittedSections === 1 ? "" : "s"} omitted, see attached`;
    if (fits(marker)) push(marker);
  }
  for (const line of healthBlock) push(line);
  // Pure backstop — the loop above already guarantees this is a no-op.
  return lines.join("\n").slice(0, TG_LIMIT);
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderEodHtml(report) {
  const c = counts(report);
  // Three-column table rows: [project, what, note]. Every cell escaped.
  const table = (rows) => rows.length
    ? `<table><tr><th>Project</th><th>What</th><th>Note</th></tr>${rows.map(([p, w, n]) =>
        `<tr><td class="proj">${esc(p)}</td><td>${esc(w)}</td><td class="muted">${esc(n)}</td></tr>`).join("")}</table>`
    : "";
  const sec = (title, body, error) =>
    `<section><h2>${title}</h2>${error ? `<p class="err">unavailable: ${esc(error)}</p>` : body || "<p class=\"muted\">none</p>"}</section>`;

  // Done today: per-project count table up top, full item list behind a native
  // <details> fold so 100+ rows never hit the reader unasked.
  const doneRollup = report.done.error ? "" : (() => {
    const rollup = doneByProject(report.done);
    if (!rollup.length) return "";
    const detail = [
      ...(report.done.tasks || []).map((t) => [projName(t.project_path), t.summary_plain || t.title, t.evidence || ""]),
      ...(report.done.fixes || []).map((f) => [projName(f.project_path), f.summary_plain || `fix: ${f.summary}`, f.verification || ""]),
      ...(report.done.decisions || []).map((d) => [projName(d.project_path), d.summary_plain || `decision: ${d.decision}`, d.rationale || ""]),
      ...(report.done.research || []).map((r) => [projName(r.project_path), r.summary_plain || `research: ${r.question}`, r.finding || ""]),
      ...(report.done.sessions || []).map((s) => [projName(s.project_path), `session (${s.agent})`, s.goal || ""]),
    ];
    return `<table><tr><th>Project</th><th>Finished today</th></tr>${rollup.map(({ project, summary }) =>
      `<tr><td class="proj">${esc(project)}</td><td>${esc(summary)}</td></tr>`).join("")}</table>
<details><summary>All ${detail.length} items</summary>${table(detail)}</details>`;
  })();

  const eyesRows = report.needsEyes.error ? [] : [
    ...(report.needsEyes.inbox || []).map((i) => [projName(i.project_path), i.message, `inbox · ${i.author}`]),
    ...(report.needsEyes.blocked || []).map((t) => [projName(t.project_path), t.summary_plain || t.title, `blocked: ${t.block_reason}`]),
    ...(report.needsEyes.proposals || []).map((p) => [projName(p.project_path), "roadmap proposal", `pending since ${p.created_at}`]),
    ...(report.needsEyes.failedRuns || []).map((r) => ["—", r.notes || r.outcome || "run failed", `run failed · ${r.agent}`]),
  ];
  const verifyRows = report.verifyQueue.error ? [] : [
    ...(report.verifyQueue.tasks || []).map((t) => [projName(t.project_path), t.summary_plain || t.title, `run: ${t.verification_command}`]),
    ...(report.verifyQueue.fixes || []).map((f) => [projName(f.project_path), f.summary, "fix unverified"]),
    ...(report.verifyQueue.drift || []).filter((d) => d.unavailable || d.dirtyFiles || d.behind || d.ahead).map((d) =>
      d.unavailable ? [projName(d.project), "repo unavailable", ""]
        : [projName(d.project), "repo drift", `${d.dirtyFiles} dirty · ${d.ahead} ahead · ${d.behind} behind`]),
  ];
  const tonightRows = report.tonight.error ? [] : [
    ...(report.tonight.open || []).map((t) => [projName(t.project_path), t.summary_plain || t.title, t.priority]),
    ...(report.tonight.staleClaims || []).map((t) => [projName(t.project_path), t.title, `stale claim · ${t.assigned_agent}`]),
  ];

  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Evening brief ${esc(report.date)}</title>
<style>
  body{font:15px/1.5 system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fafafa}
  h1{font-size:1.3rem} h2{font-size:1rem;border-bottom:1px solid #ddd;padding-bottom:.3rem;margin-top:1.5rem}
  .counts{color:#555;font-size:1.05rem} .muted{color:#999} .err{color:#b00}
  .story{background:#eef4fb;border-left:3px solid #0b5cad;padding:.6rem .8rem;border-radius:0 6px 6px 0}
  table{border-collapse:collapse;width:100%;margin:.5rem 0}
  th{font-size:.8rem;text-transform:uppercase;letter-spacing:.03em;color:#888}
  td,th{padding:.35rem .5rem;border-bottom:1px solid #e5e5e5;text-align:left;vertical-align:top}
  .proj{color:#0b5cad;font-weight:600;white-space:nowrap}
  details{margin:.5rem 0} summary{cursor:pointer;color:#555}
  @media(prefers-color-scheme:dark){body{color:#eee;background:#111}h2{border-color:#333}td,th{border-color:#2a2a2a}.proj{color:#6cb2ff}.story{background:#16202c}}
</style>
<h1>Evening brief — ${esc(report.date)}</h1>
<p class="counts"><b>${c.done}</b> done · <b>${c.eyes}</b> need eyes · <b>${c.verify}</b> to verify · <b>${c.open}</b> open tonight</p>
${report.story ? `<p class="story">${esc(report.story)}</p>` : ""}
${sec("Done today", doneRollup, report.done.error)}
${sec("Needs your eyes", table(eyesRows), report.needsEyes.error)}
${sec("Verify queue", table(verifyRows), report.verifyQueue.error)}
${sec("Tonight", table(tonightRows), report.tonight.error)}
<p class="muted">Generated ${esc(report.generatedAt)}${report.health ? ` · ${esc(report.health)}` : ""}${report.digestError ? ` · plain-English digest unavailable (${esc(clip(report.digestError, 80))})` : ""}</p>`;
}
