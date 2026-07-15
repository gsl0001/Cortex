import { useEffect, useState } from "react";
import { api } from "./api.js";
import { Evidence } from "./evidence.jsx";

const HUMAN = "human"; // UI-origin writes; server requires an agent field
const DISPATCH_AGENTS = new Set(["codex", "claude-code"]);
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, medium: 2, low: 3 };

// ---- small time/date helpers (mirror the server's local-calendar math) ----
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// relative "Xs/Xm ago"; null-safe for a dispatcher that never ticked
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
function shortId(id) {
  return id ? String(id).slice(0, 8) : null;
}
function fmtUsd(n) {
  return n == null ? "—" : n === 0 ? "$0" : `$${n.toFixed(2)}`;
}
// Why a queued task hasn't dispatched yet, beyond "on deck": an unmet dependency
// (producer not yet review/done) or a notBefore earliest-start time still in the future.
function gateReason(task, tasksById) {
  const unmet = (task.dependsOn || []).filter((id) => {
    const p = tasksById.get(id); return !p || (p.status !== "review" && p.status !== "done");
  });
  if (unmet.length) return `waiting on: ${unmet.map((id) => tasksById.get(id)?.title || id).slice(0, 2).join(", ")}`;
  if (task.notBefore && new Date(task.notBefore) > new Date()) return `not before ${new Date(task.notBefore).toTimeString().slice(0, 5)}`;
  return null;
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

// agent · type · model chips shared by the running / queued / failed cards. The model
// comes from the read model (task.model = settings-resolved routing, run.model =
// intended-then-actual) — no mirrored routing map in the UI.
function AgentChips({ agent, type, model }) {
  return (
    <span className="cc-chips">
      {agent && <span className="cc-chip cc-chip-agent">{agent}</span>}
      {type && <span className="cc-chip cc-chip-type">{type}</span>}
      {model && <span className={`cc-chip cc-chip-model cc-chip-model-${model}`}>{model}</span>}
    </span>
  );
}

// Enrolled paths return slash- and case-normalized; the projects list keeps raw Windows
// paths (mixed \ and /). Compare on this key so enrollment state matches — mirrors
// src/agentLauncher.js autopilotKey.
const autopilotKey = (path) => String(path || "").toLowerCase().replaceAll("\\", "/");

// Autopilot will actually pick this up next: ready + agent-assigned + due + enrolled.
// Mirrors src/dispatcher.js isDispatchable, plus the enrollment gate.
function isQueued(task, enrolled) {
  return task.status === "ready"
    && DISPATCH_AGENTS.has(task.assignedAgent)
    && (!task.scheduledFor || task.scheduledFor <= today())
    && enrolled.has(autopilotKey(task.projectPath));
}

export default function ControlCenter({ projects }) {
  const [data, setData] = useState(null);       // /needs-you
  const [runs, setRuns] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [overview, setOverview] = useState(null); // /overview KPIs
  const [settings, setSettings] = useState(null); // /settings config
  const [costs, setCosts] = useState(null); // /costs spend analytics
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
  ])
    .then(([d, r, t, o, s, c]) => { setData({ ...d }); setRuns(r); setTasks(t); setOverview({ ...o }); setSettings({ ...s }); setCosts(c); })
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

  const { reviews = [], inbox = [], guard = [], dispatcher = {} } = data;
  // Guard verdicts get their own card; drop them from the plain Decisions/Failed lists so a
  // memory-governance block or warn shows once, with its reason and matched memory context.
  const guardIds = new Set(guard.map((g) => g.id));
  // Match on autopilotKey: cost/run project paths arrive slash-normalized, the projects list
  // keeps raw Windows paths, so an exact === would miss and fall back to a bare basename.
  const projectName = (path) => projects?.find((p) => autopilotKey(p.projectPath) === autopilotKey(path))?.name || basename(path);
  const titleForTask = (id) => tasks.find((t) => t.id === id)?.title;
  const enrolledSet = new Set((dispatcher.projects || []).map(autopilotKey));
  const enrolledCount = (projects || []).filter((p) => enrolledSet.has(autopilotKey(p.projectPath))).length;

  // Run states: no endedAt = RUNNING; ended success = DONE; ended fail = FAILED.
  const runState = (run) => (!run.endedAt ? "running" : run.outcome === "success" ? "done" : "failed");
  const running = runs.filter((r) => runState(r) === "running");
  const activeRuns = running.length;

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
          {run.prUrl
            ? <a className="cc-run-pr" href={run.prUrl} target="_blank" rel="noreferrer">PR ↗</a>
            : run.branch
              ? <button className="cc-btn cc-btn-sm" disabled={busy} title={`Merge ${run.branch}`}
                  onClick={() => act(() => api(`/runs/${encodeURIComponent(run.id)}/merge`, {
                    method: "POST", headers: { "content-type": "application/json" },
                    body: JSON.stringify({ agent: HUMAN }),
                  }))}>Merge</button>
              : null}
        </div>
      </details>
    );
  };

  // Lookup for resolving dependsOn ids to their task (status/title) when annotating gate reasons.
  const tasksById = new Map(tasks.map((t) => [t.id, t]));

  // Queued = tasks Autopilot will dispatch next, in a stable priority-then-date order so the
  // numbering reflects a real "on deck" sequence, not render order.
  const queuedTasks = tasks
    .filter((t) => isQueued(t, enrolledSet))
    .sort((a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9)
      || String(a.scheduledFor || "").localeCompare(String(b.scheduledFor || "")));

  // Failed = tasks currently blocked (one row each, newest-touched first), actionable via Retry.
  // Guard blocks are shown in the Memory Guard card instead, so exclude them here.
  const failedTasks = tasks
    .filter((t) => t.status === "blocked" && !guardIds.has(t.id))
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

  const visibleReviews = reviews.filter((r) => !guardIds.has(r.id));

  // KPI strip figures (all real; capturedToday/durableMemories from /overview, "—" if unavailable)
  const decisionsQueued = visibleReviews.length + inbox.length;
  const capturedToday = overview ? overview.capturedToday : null;
  const durableMemories = overview ? overview.durableMemories : null;

  const enabled = !!dispatcher.enabled;
  const setDispatcher = (patch) => act(() => api("/dispatcher", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: HUMAN, ...patch }),
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
          <span className="cc-logo" aria-hidden="true">OMH</span>
          <span className="cc-brand-text">
            <strong>Autopilot Control</strong>
            <span className="cc-brand-sub">Cortex · agent orchestration</span>
          </span>
        </div>

        <span className={`cc-status-pill ${enabled ? "armed" : "paused"}`}>
          <span className="cc-status-dot" aria-hidden="true" />
          {enabled ? "Autopilot armed" : "Autopilot paused"}
        </span>

        <div className="cc-header-right">
          <div className="cc-stat">
            <strong className="mono">{activeRuns}</strong>
            <span className="cc-stat-label">live / AGENTS</span>
          </div>
          <div className="cc-stat">
            <strong className="mono">{queuedTasks.length}</strong>
            <span className="cc-stat-label">queued / TO DISPATCH</span>
          </div>
          <button
            className="cc-btn cc-btn-pause"
            disabled={busy}
            onClick={() => setDispatcher({ enabled: !enabled })}
          >{enabled ? "‖ Pause" : "▶ Resume"}</button>
          <button
            className="cc-btn cc-btn-stop"
            disabled={busy}
            title="Pauses dispatch and kills any running agents"
            onClick={() => setDispatcher({ enabled: false, stopActive: true })}
          >■ EMERGENCY STOP</button>
        </div>
      </header>

      {error && <p className="error" role="alert">{error}</p>}

      {/* ---------- KPI strip ---------- */}
      <div className="cc-kpis">
        <div className="cc-kpi">
          <span className="cc-kpi-num mono">{activeRuns} <em className="pos">live</em></span>
          <span className="cc-kpi-label">Agents running</span>
        </div>
        <div className="cc-kpi">
          <span className="cc-kpi-num mono">{decisionsQueued} <em className="act">action</em></span>
          <span className="cc-kpi-label">Decisions queued</span>
        </div>
        <div className="cc-kpi">
          <span className="cc-kpi-num mono">{failedTasks.length} <em className="neg">attention</em></span>
          <span className="cc-kpi-label">Runs blocked</span>
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

          {/* 2. Running agents — live work */}
          <section className="cc-card cc-card-running" aria-label="Running agents">
            <div className="cc-card-head">
              <span className={`cc-card-mark ${running.length ? "live" : ""}`} aria-hidden="true" />
              <h2>Running agents</h2>
              <span className="cc-pill cc-pill-green">● {running.length} live</span>
            </div>
            {running.length === 0 && <p className="cc-empty">No agents running right now.</p>}
            {running.map((run) => {
              const task = tasks.find((t) => t.id === run.taskId);
              const title = titleForTask(run.taskId) || run.taskId || "Agent run";
              const meta = [
                basename(run.projectPath || task?.projectPath),
                elapsed(run.startedAt),
                run.sessionId ? `session ${shortId(run.sessionId)}` : null,
              ].filter(Boolean);
              return (
                <article key={run.id} className="cc-run cc-run-running">
                  <div className="cc-run-row1">
                    <span className="cc-badge cc-badge-running">RUNNING</span>
                    <span className="cc-run-title">{title}</span>
                    <span className="cc-run-right">
                      {run.prUrl
                        ? <a className="cc-run-pr" href={run.prUrl} target="_blank" rel="noreferrer">PR ↗</a>
                        : run.branch
                          ? <button className="cc-btn cc-btn-sm" disabled={busy} title={`Merge ${run.branch}`}
                              onClick={() => act(() => api(`/runs/${encodeURIComponent(run.id)}/merge`, {
                                method: "POST", headers: { "content-type": "application/json" },
                                body: JSON.stringify({ agent: HUMAN }),
                              }))}>Merge</button>
                          : null}
                      <button
                        className="cc-btn cc-btn-sm"
                        aria-label={`View log for ${title}`}
                        onClick={() => openLog(run)}
                      >View log</button>
                      <button
                        className="cc-btn cc-btn-sm"
                        disabled={busy}
                        title="Kill this agent; its task moves to Failed"
                        onClick={() => act(() => api(`/runs/${encodeURIComponent(run.id)}/stop`, {
                          method: "POST", headers: { "content-type": "application/json" },
                          body: JSON.stringify({ agent: HUMAN }),
                        }))}
                      >Stop</button>
                    </span>
                  </div>
                  <AgentChips agent={run.agent} type={task?.type} model={run.model || task?.model} />
                  <div className="cc-run-meta mono">{meta.join(" · ")}</div>
                  {ticker(run.lastEvent) && <div className="cc-run-ticker mono">{ticker(run.lastEvent)}</div>}
                  <div className="cc-run-track"><div className="cc-run-fill cc-run-fill-running" /></div>
                </article>
              );
            })}
          </section>

          {/* 3. Queued to dispatch — the on-deck sequence Autopilot pulls next */}
          <section className="cc-card cc-card-queued" aria-label="Queued to dispatch">
            <div className="cc-card-head">
              <span className="cc-card-mark" aria-hidden="true" />
              <h2>Queued to dispatch</h2>
              <span className="cc-pill cc-pill-blue">{queuedTasks.length} waiting</span>
              <span className="cc-card-meta">ready · agent-assigned · due · enrolled</span>
            </div>
            {queuedTasks.length === 0 && <p className="cc-empty">Nothing queued — assign an agent and enroll the project.</p>}
            {queuedTasks.map((task, i) => (
              <article key={task.id} className="cc-queue-row">
                <span className="cc-queue-num mono" aria-hidden="true">{i + 1}</span>
                <span className="cc-queue-body">
                  <span className="cc-queue-title">{task.title}</span>
                  <AgentChips agent={task.assignedAgent} type={task.type} model={task.model} />
                  <span className="cc-queue-meta mono">{projectName(task.projectPath)}{task.scheduledFor ? ` · ${task.scheduledFor}` : ""}</span>
                  {gateReason(task, tasksById) && <span className="cc-queue-gate">{gateReason(task, tasksById)}</span>}
                </span>
                {task.priority && task.priority !== "normal" && <span className={`cc-prio cc-prio-${task.priority}`}>{task.priority}</span>}
              </article>
            ))}
          </section>

          {/* 4. Failed runs — blocked tasks needing a decision or retry */}
          <section className="cc-card cc-card-failed" aria-label="Failed runs">
            <div className="cc-card-head">
              <span className="cc-card-mark" aria-hidden="true" />
              <h2>Failed runs</h2>
              <span className="cc-pill cc-pill-red">{failedTasks.length} need attention</span>
            </div>
            {failedTasks.length === 0 && <p className="cc-empty">No failed runs. All clear.</p>}
            {failedTasks.map((task) => (
              <article key={task.id} className="cc-run cc-run-failed">
                <div className="cc-run-row1">
                  <span className="cc-badge cc-badge-failed">FAILED</span>
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
                <AgentChips agent={task.assignedAgent} type={task.type} model={task.model} />
                <div className="cc-run-meta mono">{projectName(task.projectPath)}</div>
              </article>
            ))}
          </section>
        </main>

        {/* ---------- Right sidebar ---------- */}
        <aside className="cc-sidebar">
          {/* Projects — collapsible dropdown so a long enrollment list doesn't crowd the sidebar */}
          <details className="cc-panel cc-projects">
            <summary className="cc-projects-sum">
              <span className="cc-caps">Projects</span>
              <span className="cc-projects-count mono">{enrolledCount} / {(projects || []).length} on</span>
            </summary>
            <div className="cc-projects-list">
              {(projects || []).map((p) => {
                const on = enrolledSet.has(autopilotKey(p.projectPath));
                return (
                  <div key={p.projectPath} className="cc-project-row">
                    <span className={`cc-project-dot ${on ? "on" : ""}`} aria-hidden="true" />
                    <span className="cc-project-name mono">{p.name}</span>
                    <button
                      className={`cc-toggle-btn ${on ? "on" : ""}`}
                      aria-label={`${on ? "Unenroll" : "Enroll"} ${p.name}`}
                      aria-pressed={on}
                      disabled={busy}
                      onClick={() => {
                        // POST the full updated projects array; never auto-add a NEVER_AUTOPILOT repo.
                        // Compare on autopilotKey so a differently-cased/separated path still matches.
                        const next = on
                          ? (dispatcher.projects || []).filter((x) => autopilotKey(x) !== autopilotKey(p.projectPath))
                          : [...(dispatcher.projects || []), p.projectPath];
                        setDispatcher({ projects: next });
                      }}
                    >{on ? "ON" : "OFF"}</button>
                  </div>
                );
              })}
              {(projects || []).length === 0 && <p className="cc-empty">No projects.</p>}
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

          {/* Scheduler — run window (Memory Guard enforcement lives in the launcher) */}
          <details className="cc-panel cc-sched">
            <summary className="cc-projects-sum">
              <span className="cc-caps">Scheduler</span>
              <span className="cc-projects-count mono">{dispatcher.window ? (dispatcher.windowOpen ? "window open" : "window closed") : "always-on"}</span>
            </summary>
            <div className="cc-sched-body">
              <label className="cc-toggle-row">
                <span className="cc-toggle-text"><strong>Run window</strong><span className="cc-toggle-sub">Only dispatch during these hours</span></span>
                <span className={`cc-switch ${dispatcher.window ? "on" : ""}`}>
                  <input type="checkbox" aria-label="Enable run window" checked={!!dispatcher.window} disabled={busy}
                    onChange={(e) => setDispatcher({ window: e.target.checked ? { start: "22:00", end: "07:00", days: [0,1,2,3,4,5,6] } : null })} />
                  <span className="cc-switch-knob" aria-hidden="true" />
                </span>
              </label>
              {dispatcher.window && (
                <div className="cc-sched-window mono">
                  <input aria-label="Window start" type="time" value={dispatcher.window.start}
                    onChange={(e) => setDispatcher({ window: { ...dispatcher.window, start: e.target.value } })} />
                  <span>→</span>
                  <input aria-label="Window end" type="time" value={dispatcher.window.end}
                    onChange={(e) => setDispatcher({ window: { ...dispatcher.window, end: e.target.value } })} />
                </div>
              )}
              <div className="cc-sched-conc">
                <label className="cc-toggle-row">
                  <span className="cc-toggle-text"><strong>Max concurrent runs</strong><span className="cc-toggle-sub">Across all projects</span></span>
                  <input className="cc-num" type="number" min="1" max="10" aria-label="Max concurrent runs"
                    value={dispatcher.maxConcurrent ?? 1} disabled={busy}
                    onChange={(e) => setDispatcher({ maxConcurrent: Math.max(1, Number(e.target.value) || 1) })} />
                </label>
                <label className="cc-toggle-row">
                  <span className="cc-toggle-text"><strong>Max per project</strong><span className="cc-toggle-sub">Parallel runs in one project</span></span>
                  <input className="cc-num" type="number" min="1" max="5" aria-label="Max per project"
                    value={dispatcher.maxPerProject ?? 1} disabled={busy}
                    onChange={(e) => setDispatcher({ maxPerProject: Math.max(1, Number(e.target.value) || 1) })} />
                </label>
              </div>
            </div>
          </details>

          {/* Capture policy — what autopilot keeps vs. discards */}
          <div className="cc-panel">
            <p className="cc-caps">Capture policy</p>
            <p className="cc-panel-sub">What autopilot keeps vs. discards</p>
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
