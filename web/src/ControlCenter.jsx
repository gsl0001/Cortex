import { useEffect, useState } from "react";
import { api } from "./api.js";
import { Evidence } from "./evidence.jsx";

const HUMAN = "human"; // UI-origin writes; server requires an agent field

// Autonomy tiers (src/tiers.js), lowest first, each with the one line that says what granting
// it actually costs you. The dial replaced a binary ON/OFF that could only mean "auto or not".
const TIERS = ["watch", "plan", "assist", "auto"];
const TIER_MEANING = {
  watch: "observe only — no agent is launched",
  plan: "propose plans and flag stalls",
  assist: "do work, a human merges",
  auto: "full auto within confinement",
};

// ---- small time/date helpers (mirror the server's local-calendar math) ----
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// relative "Xs/Xm ago"; null-safe
function agoLabel(iso) {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
// elapsed startedAt→(endedAt||now) as "12s" / "4m" / "1h 5m"
function elapsed(startedAt, endedAt) {
  if (!startedAt) return "";
  const seconds = Math.max(0, Math.floor((new Date(endedAt || Date.now()) - new Date(startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
function basename(path) {
  return String(path || "").split(/[\\/]/).filter(Boolean).pop() || path || "—";
}
function ticker(text) {
  if (!text) return null;
  const clean = text.replace(/\s+/g, " ");
  return clean.length > 80 ? `${clean.slice(0, 77)}…` : clean;
}
function fmtUsd(n) {
  return n == null ? "—" : n === 0 ? "$0" : `$${n.toFixed(2)}`;
}
function fmtTok(n) {
  if (n == null) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

// Horizontal bars ranking spend within a breakdown (by model / project / type).
function CostBars({ title, rows, label }) {
  if (!rows?.length) return null;
  const max = Math.max(...rows.map((r) => r.costUsd), 1e-9);
  return (
    <div className="cc-cost-group">
      <p className="cc-cost-group-title">{title}</p>
      {rows.map((r) => (
        <div key={r.key} className="cc-cost-row">
          <span className="cc-cost-label">{label(r.key)}</span>
          <span className="cc-cost-bar-track">
            <span className="cc-cost-bar" style={{ width: `${Math.max(4, (r.costUsd / max) * 100)}%` }} />
          </span>
          <span className="cc-cost-val mono">{fmtUsd(r.costUsd)}</span>
        </div>
      ))}
    </div>
  );
}

// agent · type · model chips shared by the history / blocked cards (model = what a
// past run actually reported).
function AgentChips({ agent, type, model }) {
  return (
    <span className="cc-chips">
      {agent && <span className="cc-chip cc-chip-agent">{agent}</span>}
      {type && <span className="cc-chip cc-chip-type">{type}</span>}
      {model && <span className={`cc-chip cc-chip-model cc-chip-model-${model}`}>{model}</span>}
    </span>
  );
}

// Cost/run project paths arrive slash- and case-normalized; the projects list keeps raw
// Windows paths (mixed \ and /). Compare on this key — mirrors src/tiers.js autopilotKey.
const autopilotKey = (path) => String(path || "").toLowerCase().replaceAll("\\", "/");

export default function ControlCenter({ projects }) {
  const [data, setData] = useState(null);       // /needs-you
  const [runs, setRuns] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [overview, setOverview] = useState(null); // /overview KPIs
  const [settings, setSettings] = useState(null); // /settings config
  const [costs, setCosts] = useState(null); // /costs spend analytics
  // Re-read on this panel's own poll (the prop is fetched once at app boot): a tier write has
  // to show its new value back, and another session's change has to land here too.
  const [projectRows, setProjectRows] = useState(null);
  const [error, setError] = useState("");
  const [rejectingId, setRejectingId] = useState("");
  const [reason, setReason] = useState("");
  const [recheckAt, setRecheckAt] = useState("");
  const [editingId, setEditingId] = useState(""); // memory-guard "Edit" inline editor
  const [editCriteria, setEditCriteria] = useState("");
  const [busy, setBusy] = useState(false);
  const [logRun, setLogRun] = useState(null);     // run whose log drawer is open
  const [logLines, setLogLines] = useState(null); // null = loading

  const fetchLog = (run) =>
    api(`/runs/${encodeURIComponent(run.id)}/log?lines=200`)
      .then((d) => setLogLines(d.missing ? ["(no log recorded for this run)"] : d.lines))
      .catch((e) => setLogLines([`Failed to load log: ${e.message}`]));
  const openLog = (run) => { setLogRun(run); setLogLines(null); fetchLog(run); };

  // live tail: refresh the open drawer every 5s while its run is still going
  useEffect(() => {
    if (!logRun || logRun.endedAt) return undefined;
    const timer = setInterval(() => fetchLog(logRun), 5_000);
    return () => clearInterval(timer);
  }, [logRun]);

  // Spread into fresh objects so setState always sees a new reference — some callers
  // return/mutate a shared object across polls, which would make React bail via Object.is.
  const refresh = () => Promise.all([
    api("/needs-you"), api("/runs"), api("/tasks"), api("/overview"), api("/settings"),
    // non-fatal: an older backend without /costs must not blank the whole dashboard
    api("/costs").catch(() => null),
    api("/projects"),
  ])
    .then(([d, r, t, o, s, c, p]) => { setData({ ...d }); setRuns(r); setTasks(t); setOverview({ ...o }); setSettings({ ...s }); setCosts(c); setProjectRows(p); })
    .catch((e) => setError(e.message));
  useEffect(() => { refresh(); }, []);

  // Live refresh: poll every 15s. Skip while busy or mid-reject (don't clobber a
  // half-typed reason), and pause when the tab is hidden to spare phone battery.
  useEffect(() => {
    const timer = setInterval(() => {
      if (busy || rejectingId || document.visibilityState === "hidden") return;
      refresh();
    }, 15_000);
    return () => clearInterval(timer);
  }, [busy, rejectingId]);

  const act = async (fn) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await fn(); await refresh(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const patchTask = (id, body) => api(`/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: HUMAN, ...body }),
  });
  // optimistic-free: settings persist through /settings then refresh reads them back
  const saveSetting = (key, value) => act(() => api("/settings", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: HUMAN, key, value }),
  }));

  if (!data) return <section className="cc"><p className="cc-loading">{error || "Loading…"}</p></section>;

  const { reviews = [], inbox = [], guard = [] } = data;
  // Guard verdicts get their own card; drop them from the plain Decisions/Failed lists so a
  // memory-governance block or warn shows once, with its reason and matched memory context.
  const guardIds = new Set(guard.map((g) => g.id));
  // Match on autopilotKey: cost/run project paths arrive slash-normalized, the projects list
  // keeps raw Windows paths, so an exact === would miss and fall back to a bare basename.
  const allProjects = projectRows || projects || [];
  const projectName = (path) => allProjects.find((p) => autopilotKey(p.projectPath) === autopilotKey(path))?.name || basename(path);
  const titleForTask = (id) => tasks.find((t) => t.id === id)?.title;
  const tierOf = (p) => p.tier || "watch";
  const autoCount = allProjects.filter((p) => tierOf(p) === "auto").length;

  // Run states: no endedAt = RUNNING (legacy open rows only); ended success = DONE; else FAILED.
  const runState = (run) => (!run.endedAt ? "running" : run.outcome === "success" ? "done" : "failed");

  // History = every finished run, newest first (done + failed). The right-hand archive;
  // each is a collapsible <details> so a long night of runs stays scannable.
  const finishedRuns = runs
    .filter((r) => runState(r) !== "running")
    .sort((a, b) => new Date(b.endedAt || 0) - new Date(a.endedAt || 0));
  // Grouped so success and failures each collapse independently.
  const succeededRuns = finishedRuns.filter((r) => runState(r) === "done");
  const failedRuns = finishedRuns.filter((r) => runState(r) === "failed");

  // One history entry — reused by both the Succeeded and Failed groups.
  const renderHistRun = (run) => {
    const state = runState(run);
    const task = tasks.find((t) => t.id === run.taskId);
    const title = titleForTask(run.taskId) || run.taskId || "Agent run";
    const meta = [run.agent, task?.type, run.model || task?.model, basename(run.projectPath || task?.projectPath), elapsed(run.startedAt, run.endedAt), run.tokens != null ? `${run.tokens.toLocaleString()} tok` : null].filter(Boolean);
    return (
      <details key={run.id} className={`cc-hist cc-hist-${state}`}>
        <summary className="cc-hist-sum">
          <span className={`cc-dot cc-dot-${state}`} aria-hidden="true" />
          <span className="cc-hist-title">{title}</span>
          <span className="cc-hist-ago mono">{agoLabel(run.endedAt)}</span>
        </summary>
        <div className="cc-hist-body">
          <div className="cc-hist-meta mono">{meta.join(" · ")}</div>
          {run.notes && <p className="cc-hist-notes">{run.notes}</p>}
          <button className="cc-btn cc-btn-sm" aria-label={`View log for ${title}`} onClick={() => openLog(run)}>View log</button>
          {run.prUrl && <a className="cc-run-pr" href={run.prUrl} target="_blank" rel="noreferrer">PR ↗</a>}
        </div>
      </details>
    );
  };

  // Blocked = tasks currently blocked (one row each, newest-touched first), actionable via Retry.
  // Guard blocks are shown in the Memory Guard card instead, so exclude them here.
  const failedTasks = tasks
    .filter((t) => t.status === "blocked" && !guardIds.has(t.id))
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

  const visibleReviews = reviews.filter((r) => !guardIds.has(r.id));

  // KPI strip figures (all real; capturedToday/durableMemories from /overview, "—" if unavailable)
  const decisionsQueued = visibleReviews.length + inbox.length;
  const capturedToday = overview ? overview.capturedToday : null;
  const durableMemories = overview ? overview.durableMemories : null;

  // Autonomy is written per project as a tier. The server rejects a pinned project per item.
  const setTier = (projectPath, tier) => act(() => api("/projects/tier", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: HUMAN, projectPath, tier }),
  }));

  // ---- capture-policy toggle rows (persist to /settings; not yet consumed by the pipeline) ----
  const policy = settings || {};
  const toggleRows = [
    { key: "capturePolicy.durableFixes", label: "Durable fixes", sub: "Resolved bugs & root causes" },
    { key: "capturePolicy.researchNotes", label: "Research notes", sub: "Findings, benchmarks, sources" },
    { key: "capturePolicy.decisions", label: "Decisions", sub: "Architecture & trade-off calls" },
    { key: "capturePolicy.genericChatter", label: "Generic chatter", sub: "Off by default — 'tests pass' etc." },
  ];
  const threshold = typeof policy["capturePolicy.signalThreshold"] === "number" ? policy["capturePolicy.signalThreshold"] : 60;

  return (
    <section className="cc">
      {/* ---------- Header bar ---------- */}
      <header className="cc-header">
        <div className="cc-brand">
          <span className="cc-logo" aria-hidden="true">C</span>
          <span className="cc-brand-text">
            <strong>Control Center</strong>
            <span className="cc-brand-sub">Cortex · decisions &amp; capture</span>
          </span>
        </div>

        <div className="cc-header-right">
          <div className="cc-stat">
            <strong className="mono">{decisionsQueued}</strong>
            <span className="cc-stat-label">decisions / AWAITING YOU</span>
          </div>
        </div>
      </header>

      {error && <p className="error" role="alert">{error}</p>}

      {/* ---------- KPI strip ---------- */}
      <div className="cc-kpis">
        <div className="cc-kpi">
          <span className="cc-kpi-num mono">{decisionsQueued} <em className="act">action</em></span>
          <span className="cc-kpi-label">Decisions queued</span>
        </div>
        <div className="cc-kpi">
          <span className="cc-kpi-num mono">{failedTasks.length} <em className="neg">attention</em></span>
          <span className="cc-kpi-label">Tasks blocked</span>
        </div>
        <div className="cc-kpi">
          <span className="cc-kpi-num mono">{capturedToday == null ? "—" : capturedToday}</span>
          <span className="cc-kpi-label">Captured today</span>
        </div>
        <div className="cc-kpi">
          <span className="cc-kpi-num mono">{durableMemories == null ? "—" : durableMemories}</span>
          <span className="cc-kpi-label">Durable memories</span>
        </div>
      </div>

      {/* ---------- Grid: main + sidebar ---------- */}
      <div className="cc-grid">
        <main className="cc-main">
          {/* 1. Decisions — top: the human-in-the-loop gate */}
          <section className="cc-card cc-card-decision" aria-label="Decision inbox">
            <div className="cc-card-head">
              <span className="cc-card-mark" aria-hidden="true" />
              <h2>Decisions</h2>
              <span className="cc-pill cc-pill-orange">{decisionsQueued} awaiting you</span>
              <span className="cc-card-meta">held for human sign-off</span>
            </div>
            {decisionsQueued === 0 && <p className="cc-empty">Nothing needs your sign-off.</p>}

            {visibleReviews.map((task) => (
              <article key={task.id} className="cc-decision cc-decision-capture">
                <div className="cc-decision-row1">
                  <span className="cc-badge cc-badge-capture">CAPTURE</span>
                  <strong className="cc-decision-title">{task.title}</strong>
                  {rejectingId === task.id ? null : (
                    <span className="cc-decision-actions">
                      <button
                        className="cc-btn cc-btn-approve"
                        aria-label={`Approve ${task.title}`}
                        disabled={busy}
                        onClick={() => act(() => patchTask(task.id, { action: "complete", evidence: task.evidence || "Approved from Control Center" }))}
                      >Approve</button>
                      <button
                        className="cc-btn cc-btn-sm"
                        aria-label={`Reject ${task.title}`}
                        disabled={busy}
                        onClick={() => setRejectingId(task.id)}
                      >Reject</button>
                    </span>
                  )}
                </div>
                <Evidence text={task.evidence} />
                {rejectingId === task.id && (
                  <div className="cc-reject">
                    <input aria-label="Reject reason" value={reason} placeholder="Why?" onChange={(e) => setReason(e.target.value)} />
                    <input aria-label="Recheck date" type="date" value={recheckAt} onChange={(e) => setRecheckAt(e.target.value)} />
                    <button className="cc-btn cc-btn-sm" disabled={busy || !reason.trim()} onClick={() => act(async () => {
                      await patchTask(task.id, { action: "block", reason, ...(recheckAt ? { recheckAt } : {}) });
                      setRejectingId(""); setReason(""); setRecheckAt("");
                    })}>Confirm reject</button>
                    <button className="cc-btn cc-btn-sm" disabled={busy} onClick={() => { setRejectingId(""); setReason(""); setRecheckAt(""); }}>Cancel</button>
                  </div>
                )}
                <div className="cc-decision-meta mono">{task.assignedAgent || "agent"} · {projectName(task.projectPath)}</div>
              </article>
            ))}

            {inbox.map((item) => (
              <article key={item.id} className="cc-decision cc-decision-note">
                <div className="cc-decision-row1">
                  <span className="cc-badge cc-badge-note">NOTE</span>
                  <strong className="cc-decision-title">{item.author}</strong>
                  <span className="cc-decision-actions">
                    <button
                      className="cc-btn cc-btn-sm"
                      aria-label={`Resolve inbox item from ${item.author}`}
                      disabled={busy}
                      onClick={() => act(() => api(`/inbox/${encodeURIComponent(item.id)}`, {
                        method: "PATCH", headers: { "content-type": "application/json" },
                        body: JSON.stringify({ agent: HUMAN, action: "resolve", projectPath: item.projectPath }),
                      }))}
                    >Resolve</button>
                  </span>
                </div>
                <div className="cc-decision-body">{item.message}</div>
                <div className="cc-decision-meta mono">{item.author} · {projectName(item.projectPath)} · {agoLabel(item.createdAt || item.updatedAt)}</div>
              </article>
            ))}
          </section>

          {/* 1b. Memory Guard — governance blocks/warns, with the memory context that fired them */}
          {guard.length > 0 && (
            <section className="cc-card cc-card-guard" aria-label="Memory Guard">
              <div className="cc-card-head">
                <span className="cc-card-mark" aria-hidden="true" />
                <h2>Memory Guard</h2>
                <span className="cc-pill cc-pill-purple">{guard.length} flagged</span>
                <span className="cc-card-meta">memory governance — approve, edit, retry, or leave blocked</span>
              </div>
              {guard.map((task) => {
                const g = task.guard || {};
                const isBlock = g.kind !== "warn";
                // Approve = override the guard and accept the task as resolved.
                const approve = () => act(() => patchTask(task.id, {
                  action: "complete",
                  evidence: `Memory Guard override — approved by human. ${g.reason || ""}`.trim(),
                }));
                // Retry = send it back to run again as-is (recheck cleared).
                const retry = () => act(() => patchTask(task.id, { action: "edit", status: "ready", recheckAt: null }));
                // Leave blocked = keep (or move) the task blocked with the guard's reason.
                const leaveBlocked = () => act(() => patchTask(task.id, {
                  action: "block", reason: task.blockReason || `Memory Guard [${g.kind || "block"}]: ${g.reason || "held"}`,
                }));
                return (
                  <article key={task.id} className={`cc-guard cc-guard-${isBlock ? "block" : "warn"}`}>
                    <div className="cc-decision-row1">
                      <span className={`cc-badge ${isBlock ? "cc-badge-guard-block" : "cc-badge-guard-warn"}`}>
                        {isBlock ? "BLOCK" : "WARN"}
                      </span>
                      <strong className="cc-decision-title">{task.title}</strong>
                      <span className="cc-decision-actions">
                        <button className="cc-btn cc-btn-approve" aria-label={`Approve ${task.title}`} disabled={busy} onClick={approve}>Approve</button>
                        <button className="cc-btn cc-btn-sm" aria-label={`Edit ${task.title}`} disabled={busy}
                          onClick={() => { setEditingId(editingId === task.id ? "" : task.id); setEditCriteria(task.acceptanceCriteria || ""); }}>Edit</button>
                        <button className="cc-btn cc-btn-sm" aria-label={`Retry ${task.title}`} disabled={busy} onClick={retry}>Retry</button>
                        <button className="cc-btn cc-btn-sm" aria-label={`Leave ${task.title} blocked`} disabled={busy} onClick={leaveBlocked}>Leave blocked</button>
                      </span>
                    </div>
                    <p className="cc-guard-reason">{g.reason || "held by memory governance"}</p>
                    {editingId === task.id && (
                      <div className="cc-reject">
                        <input aria-label="Edit acceptance criteria" value={editCriteria} placeholder="Revise acceptance criteria" onChange={(e) => setEditCriteria(e.target.value)} />
                        <button className="cc-btn cc-btn-sm" disabled={busy} onClick={() => act(async () => {
                          await patchTask(task.id, { action: "edit", acceptanceCriteria: editCriteria, status: "ready", recheckAt: null });
                          setEditingId(""); setEditCriteria("");
                        })}>Save &amp; retry</button>
                        <button className="cc-btn cc-btn-sm" disabled={busy} onClick={() => { setEditingId(""); setEditCriteria(""); }}>Cancel</button>
                      </div>
                    )}
                    {g.memories?.length > 0 && (
                      <div className="cc-guard-mem" aria-label="Matched memory context">
                        <p className="cc-guard-mem-head">Matched memory</p>
                        {g.memories.map((m) => (
                          <div key={m.id} className="cc-guard-mem-row">
                            <span className="cc-badge cc-badge-mem">{m.recordType}</span>
                            <span className="cc-guard-mem-text">
                              <strong>{m.title}</strong>
                              {m.excerpt && m.excerpt !== m.title && <span className="cc-guard-mem-excerpt">{ticker(m.excerpt)}</span>}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="cc-decision-meta mono">{task.assignedAgent || "agent"} · {projectName(task.projectPath)}</div>
                  </article>
                );
              })}
            </section>
          )}

          {/* 2. Blocked tasks — needing a decision or retry */}
          <section className="cc-card cc-card-failed" aria-label="Blocked tasks">
            <div className="cc-card-head">
              <span className="cc-card-mark" aria-hidden="true" />
              <h2>Blocked tasks</h2>
              <span className="cc-pill cc-pill-red">{failedTasks.length} need attention</span>
            </div>
            {failedTasks.length === 0 && <p className="cc-empty">Nothing blocked. All clear.</p>}
            {failedTasks.map((task) => (
              <article key={task.id} className="cc-run cc-run-failed">
                <div className="cc-run-row1">
                  <span className="cc-badge cc-badge-failed">BLOCKED</span>
                  <span className="cc-run-title">{task.title}</span>
                  <span className="cc-run-right">
                    <button
                      className="cc-btn cc-btn-sm"
                      disabled={busy}
                      onClick={() => act(() => patchTask(task.id, { action: "edit", status: "ready", recheckAt: null }))}
                    >Retry</button>
                  </span>
                </div>
                {task.blockReason && <div className="cc-run-reason">{ticker(task.blockReason)}</div>}
                {/* A block with no way back was the failure mode: show the date it comes back,
                    and say so loudly once that date has arrived. */}
                {task.recheckAt && (
                  <div className={`cc-run-recheck mono ${task.recheckAt <= today() ? "due" : ""}`}>
                    {task.recheckAt <= today() ? `recheck due ${task.recheckAt}` : `rechecks ${task.recheckAt}`}
                  </div>
                )}
                <AgentChips agent={task.assignedAgent} type={task.type} model={task.model} />
                <div className="cc-run-meta mono">{projectName(task.projectPath)}</div>
              </article>
            ))}
          </section>
        </main>

        {/* ---------- Right sidebar ---------- */}
        <aside className="cc-sidebar">
          {/* Projects — one autonomy tier per project, collapsible so a long list doesn't crowd */}
          <details className="cc-panel cc-projects">
            <summary className="cc-projects-sum">
              <span className="cc-caps">Autonomy</span>
              <span className="cc-projects-count mono">{autoCount} / {allProjects.length} auto</span>
            </summary>
            <div className="cc-projects-list">
              <dl className="cc-tier-legend">
                {TIERS.map((t) => (
                  <div key={t} className="cc-tier-legend-row">
                    <dt className="mono">{t}</dt>
                    <dd>{TIER_MEANING[t]}</dd>
                  </div>
                ))}
              </dl>
              {allProjects.map((p) => {
                const tier = tierOf(p);
                return (
                  <div key={p.projectPath} className="cc-project-row">
                    <span className={`cc-project-dot ${tier === "auto" ? "on" : ""}`} aria-hidden="true" />
                    <span className="cc-project-name mono">
                      {p.name}
                      {p.pinned && <span className="cc-project-lock" aria-hidden="true"> 🔒</span>}
                    </span>
                    <select
                      className={`cc-tier-select cc-tier-${tier}`}
                      aria-label={`Autonomy tier for ${p.name}`}
                      value={tier}
                      title={TIER_MEANING[tier]}
                      disabled={busy || !!p.pinned}
                      onChange={(e) => setTier(p.projectPath, e.target.value)}
                    >
                      {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                    {p.pinned && <p className="cc-project-pinned-note">Live-money repo — pinned at watch; it can never be promoted here.</p>}
                  </div>
                );
              })}
              {allProjects.length === 0 && <p className="cc-empty">No projects.</p>}
            </div>
          </details>

          {/* Run history — every finished run, collapsible */}
          <div className="cc-panel" aria-label="Run history" role="region">
            <div className="cc-panel-head">
              <p className="cc-caps">Run history</p>
              <span className="cc-caps-val mono">{finishedRuns.length}</span>
            </div>
            {finishedRuns.length === 0 && <p className="cc-empty">No finished runs yet.</p>}
            {failedRuns.length > 0 && (
              <details className="cc-hist-group" open>
                <summary className="cc-hist-group-sum">
                  <span className="cc-dot cc-dot-failed" aria-hidden="true" />
                  <span className="cc-hist-group-label">Failed</span>
                  <span className="cc-hist-group-count mono">{failedRuns.length}</span>
                </summary>
                <div className="cc-hist-group-body">{failedRuns.map(renderHistRun)}</div>
              </details>
            )}
            {succeededRuns.length > 0 && (
              <details className="cc-hist-group">
                <summary className="cc-hist-group-sum">
                  <span className="cc-dot cc-dot-done" aria-hidden="true" />
                  <span className="cc-hist-group-label">Succeeded</span>
                  <span className="cc-hist-group-count mono">{succeededRuns.length}</span>
                </summary>
                <div className="cc-hist-group-body">{succeededRuns.map(renderHistRun)}</div>
              </details>
            )}
          </div>

          {/* Token spend — where the money goes, so the model routing can be validated */}
          <details className="cc-panel cc-costs" open>
            <summary className="cc-projects-sum">
              <span className="cc-caps">Token spend</span>
              <span className="cc-projects-count mono">{costs?.total ? fmtUsd(costs.total.costUsd) : "—"}</span>
            </summary>
            <div className="cc-costs-body">
              {!costs?.total || costs.total.runs === 0 ? (
                <p className="cc-empty">No cost data yet — completed runs will populate this.</p>
              ) : (
                <>
                  <div className="cc-cost-headline mono">{fmtUsd(costs.total.costUsd)} · {fmtTok(costs.total.tokens)} tok · {costs.total.runs} runs</div>
                  <CostBars title="By model" rows={costs.byModel} label={(k) => k} />
                  <CostBars title="Top projects" rows={costs.byProject.slice(0, 5)} label={(k) => projectName(k)} />
                  <CostBars title="By task type" rows={costs.byType} label={(k) => k} />
                </>
              )}
            </div>
          </details>

          {/* Capture policy — what the hub keeps vs. discards */}
          <div className="cc-panel">
            <p className="cc-caps">Capture policy</p>
            <p className="cc-panel-sub">What the hub keeps vs. discards</p>
            {toggleRows.map((row) => {
              const on = policy[row.key] !== undefined ? !!policy[row.key] : row.key !== "capturePolicy.genericChatter";
              return (
                <label key={row.key} className="cc-toggle-row">
                  <span className="cc-toggle-text">
                    <strong>{row.label}</strong>
                    <span className="cc-toggle-sub">{row.sub}</span>
                  </span>
                  <span className={`cc-switch ${on ? "on" : ""}`}>
                    <input
                      type="checkbox"
                      aria-label={row.label}
                      checked={on}
                      disabled={busy}
                      onChange={(e) => saveSetting(row.key, e.target.checked)}
                    />
                    <span className="cc-switch-knob" aria-hidden="true" />
                  </span>
                </label>
              );
            })}
          </div>

          <div className="cc-panel">
            <div className="cc-panel-head">
              <p className="cc-caps">Signal threshold</p>
              <span className="cc-caps-val pos mono">{threshold}%</span>
            </div>
            <input
              className="cc-range"
              type="range"
              min="0"
              max="100"
              step="5"
              aria-label="Signal threshold"
              value={threshold}
              disabled={busy}
              onChange={(e) => saveSetting("capturePolicy.signalThreshold", Number(e.target.value))}
            />
            <div className="cc-range-legend">
              <span>keep more</span>
              <span>keep only high-signal</span>
            </div>
          </div>
        </aside>
      </div>

      {/* Run log drawer — tail of the run's .jsonl, live-refreshed while the run is going */}
      {logRun && (
        <div className="cc-drawer-scrim" onClick={() => setLogRun(null)}>
          <aside className="cc-drawer" role="dialog" aria-label="Run log" onClick={(e) => e.stopPropagation()}>
            <div className="cc-drawer-head">
              <h3>Run log · {titleForTask(logRun.taskId) || logRun.id}</h3>
              <button className="cc-btn cc-btn-sm" onClick={() => setLogRun(null)}>Close</button>
            </div>
            <pre className="cc-drawer-log mono">{logLines == null ? "Loading…" : logLines.join("\n")}</pre>
          </aside>
        </div>
      )}
    </section>
  );
}
