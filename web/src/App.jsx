import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import CommandCenter from "./CommandCenter.jsx";
import ControlCenter from "./ControlCenter.jsx";
import Goals, { addDays, mondayOf, today } from "./Goals.jsx";
import PortfolioDoctor from "./PortfolioDoctor.jsx";

const NAV_ICONS = {
  "Command center": "⊞",
  "Control Center": "☑",
  "Goals": "◉",
  "Search": "⌕",
  "Tasks": "☰",
  "Knowledge graph": "◎",
  "Activity log": "▤",
};
const MAIN_VIEWS = ["Command center", "Control Center", "Goals", "Search", "Tasks", "Knowledge graph", "Activity log"];
// Short single-word labels for the mobile bottom bar (full names overflow a ~64px cell).
// aria-label/title keep the full name; only the visible text shortens.
const SHORT_LABELS = { "Command center": "Home", "Control Center": "Control", "Knowledge graph": "Graph", "Activity log": "Activity" };
// "Runs" lived here as a bare name/status card list, fully superseded by Control Center's
// live agents + run history — deleted with its generic ListView renderer.
const MORE_VIEWS = ["Portfolio", "Health & audit"];
const VIEWS = [...MAIN_VIEWS, ...MORE_VIEWS];

function SearchEmptyState() {
  return (
    <div className="empty">
      <svg className="empty-icon" viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="22" cy="22" r="14" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
        <path d="M32 32l10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
        <path d="M17 22h10M22 17v10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
      </svg>
      <h2>Ask across durable project memory</h2>
      <p>Results stay connected to inspectable evidence and ranking reasons.</p>
    </div>
  );
}

function TokenMeter({ used, max }) {
  const pct = max > 0 ? Math.min((used / max) * 100, 100) : 0;
  const fillClass = pct > 90 ? "danger" : pct > 70 ? "warn" : "";
  return (
    <div className="token-meter">
      <div className="token-header">
        <strong className="metric">{used.toLocaleString()}</strong>
        <span className="metric-max">/ {max.toLocaleString()} tokens</span>
      </div>
      <div className="progress-track">
        <div className={`progress-fill ${fillClass}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function SearchView({ projects }) {
  const [project, setProject] = useState("");
  const [query, setQuery] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!project && projects[0]) setProject(projects[0].projectPath);
  }, [projects, project]);

  async function search(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      setResult(await api(`/search?project=${encodeURIComponent(project)}&query=${encodeURIComponent(query)}`));
    } catch (caught) {
      setError(caught.message);
    } finally {
      setLoading(false);
    }
  }

  const usedTokens = result?.context.usedTokens ?? 0;
  const maxTokens = result?.context.maxTokens ?? 1500;
  const topResult = result?.results[0];

  return (
    <div className="workspace">
      <aside className="panel filters">
        <div className="filter-section">
          <p className="eyebrow">Scope</p>
          <label htmlFor="project-scope">Project</label>
          <select id="project-scope" value={project} onChange={(e) => setProject(e.target.value)}>
            {projects.map((item) => (
              <option key={item.projectPath} value={item.projectPath}>{item.name}</option>
            ))}
          </select>
        </div>
      </aside>

      <main className="content">
        <form onSubmit={search} className="search-form">
          <label htmlFor="memory-query">Search project memory</label>
          <div className="search-row">
            <input
              id="memory-query"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Why did close fills fail?"
              required
            />
            <button disabled={loading || !project}>{loading ? "Searching…" : "Search"}</button>
          </div>
        </form>

        {error && (
          <div role="alert" className="error">
            {error}
            <span>Check that the local server is running.</span>
          </div>
        )}

        {!result && !error && <SearchEmptyState />}

        {result && (
          <>
            <section className="answer">
              <p className="eyebrow">Context answer</p>
              <h2>{topResult?.title || "No matching evidence"}</h2>
              <p>{result.context.text || "Try a broader query."}</p>
            </section>

            <section>
              <div className="evidence-header">
                <p className="eyebrow" style={{ margin: 0 }}>Ranked evidence</p>
                <span className="evidence-count">{result.results.length} result{result.results.length !== 1 ? "s" : ""}</span>
              </div>
              {result.results.map((item, index) => (
                <article className="evidence" key={item.id}>
                  <span className="rank">{index + 1}</span>
                  <div className="evidence-body">
                    <h3>{item.title}</h3>
                    <p>{item.excerpt}</p>
                    <div className="evidence-meta">
                      <span className={`badge ${item.verification ? "badge-verified" : "badge-unverified"}`}>
                        {item.verification ? "✓ Verified" : "Unverified"}
                      </span>
                      <span className="evidence-score">score {item.score.toFixed(3)}</span>
                    </div>
                  </div>
                </article>
              ))}
            </section>
          </>
        )}
      </main>

      <aside className="panel context">
        <p className="eyebrow">Context pack</p>
        <TokenMeter used={usedTokens} max={maxTokens} />
        <hr />
        <p className="eyebrow">Why this ranked</p>
        {topResult ? (
          <div className="score-list">
            {Object.entries(topResult.scoreComponents).map(([name, value]) => (
              <div className="score" key={name}>
                <span>{name}</span>
                <strong>{value.toFixed(2)}</strong>
              </div>
            ))}
          </div>
        ) : (
          <p className="hint">Run a search to inspect ranking.</p>
        )}
      </aside>
    </div>
  );
}

const TASK_STATUS_LABELS = {
  backlog: "Backlog",
  ready: "Ready",
  in_progress: "In progress",
  review: "Review",
  blocked: "Blocked",
  done: "Done",
};

// DB priorities are urgent/high/normal/low (medium kept as a defensive alias)
const TASK_PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, medium: 2, low: 3 };

// Controlled task-type vocabulary; mirrors TASK_TYPES in src/commands.js (server validates).
const TASK_TYPES = ["feature", "bug", "chore", "docs", "test", "research", "infra"];

const PROJECT_COLORS = ["#3b82f6", "#f59e0b", "#4ade80", "#a78bfa", "#ef4444", "#06b6d4"];

function taskStats(list) {
  const s = { total: list.length, done: 0, in_progress: 0, review: 0, blocked: 0 };
  for (const t of list) if (s[t.status] !== undefined) s[t.status] += 1;
  return s;
}

// segmented done/review/in-progress/blocked/todo bar; segment widths are proportional via flex-grow
function TaskProgress({ stats, className = "" }) {
  if (!stats.total) return <div className={`task-progress ${className}`} aria-hidden="true" />;
  const todo = stats.total - stats.done - stats.review - stats.in_progress - stats.blocked;
  const seg = (n, cls) => (n > 0 ? <span key={cls} className={`prog-seg ${cls}`} style={{ flexGrow: n }} /> : null);
  return (
    <div className={`task-progress ${className}`} role="img" aria-label={`${stats.done} of ${stats.total} tasks done`}>
      {seg(stats.done, "done")}
      {seg(stats.review, "review")}
      {seg(stats.in_progress, "in_progress")}
      {seg(stats.blocked, "blocked")}
      {seg(todo, "todo")}
    </div>
  );
}

// strip a trailing "; log: <path>" (or "log: <path>") so the visible summary stays one clean line
function stripLogPath(text) {
  return String(text || "").replace(/[;,]?\s*log:\s*\S+\s*$/i, "").trim();
}

// one-voice run phrase: "failed in 5s", "running · 12s", "done in 2m"
function runPhrase(run) {
  const when = elapsed(run.startedAt, run.endedAt);
  if (run.status === "running") return when ? `running · ${when}` : "starting";
  if (run.status === "failed") return when ? `failed in ${when}` : "failed";
  if (run.status === "succeeded") return when ? `done in ${when}` : "done";
  return run.status || "";
}

// Merge block reason + latest run state into a single detail line.
// Returns { summary, full, tone } or null when there's nothing to show.
function taskDetail(task, run) {
  const reason = stripLogPath(task.blockReason);
  const parts = [];
  let tone = "muted";
  if (run) {
    parts.push(runPhrase(run));
    if (run.status === "failed") tone = "danger";
    else if (run.status === "running") tone = "accent";
  }
  const why = reason || (run && run.status !== "succeeded" ? stripLogPath(run.lastEvent) : "");
  if (task.status === "blocked" && reason) tone = "danger";
  if (why && why !== parts[0]) parts.push(why);
  if (!parts.length) return null;
  const icon = tone === "danger" ? "⚠ " : "";
  // expanded view keeps the raw, untruncated text (block reason incl. log path, else last event)
  const full = task.blockReason || (run && run.lastEvent) || parts.join(" — ");
  return { summary: icon + parts.join(" — "), full, tone };
}

function TaskRow({ task, tag, showProject, projects, tasks, run, menuOpen, onToggleMenu, onEdit, onRemove, onLaunch, onAssignAgent, onEditFields }) {
  const canContinue = task.status === "in_progress" && run?.sessionId;
  const priority = task.priority || "normal";
  const showPriority = priority === "urgent" || priority === "high"; // normal/low is the default; badging it adds nothing
  const detail = taskDetail(task, run);
  const openHref = run?.sessionId && (run.agent === "codex"
    ? `codex://threads/${encodeURIComponent(run.sessionId)}`
    : claudeHandoffUrl(task, run));
  const openLabel = run?.agent === "codex" ? "Open in Codex" : "Open in Claude";
  return (
    <article className={`task-row${task.status === "blocked" ? " blocked" : ""}`}>
      <div className="task-row-title">
        {tag && (
          <span
            className={`origin-dot origin-${tag}`}
            title={tag === "roadmap" ? "Roadmap task" : "User request"}
            aria-label={tag === "roadmap" ? "Roadmap task" : "User request"}
          />
        )}
        <span className="task-title-text">{task.title}</span>
        {task.type && <span className="type-badge">{task.type}</span>}
        {showPriority && <span className={`priority-badge priority-${priority}`}>{priority.toUpperCase()}</span>}
      </div>

      <div className="task-row-meta">
        <span className={`status-pill status-${task.status}`}>{TASK_STATUS_LABELS[task.status] || task.status}</span>
        {showProject && <span className="task-meta-project">{projectName(projects, task.projectPath)}</span>}
        {task.leaseAgent ? (
          <span className="task-meta-agent" title="Leased by an active run">{task.leaseAgent}</span>
        ) : (
          <select
            className="task-meta-agent task-agent-select"
            aria-label={`Assign agent for ${task.title}`}
            value={task.assignedAgent || ""}
            onChange={(e) => onAssignAgent(e.target.value)}
          >
            <option value="">unassigned</option>
            <option value="codex">codex</option>
            <option value="claude-code">claude-code</option>
          </select>
        )}
        <select
          className="task-meta-agent task-agent-select"
          aria-label={`Depends on for ${task.title}`}
          value={(task.dependsOn || [])[0] || ""}
          onChange={(e) => onEditFields({ dependsOn: e.target.value ? [e.target.value] : [] })}
        >
          <option value="">No dependency</option>
          {tasks
            .filter((t) => t.id !== task.id && t.projectPath === task.projectPath)
            .map((t) => <option key={t.id} value={t.id}>{t.title.slice(0, 40)}</option>)}
        </select>
        <input
          className="task-meta-agent task-agent-select"
          aria-label={`Earliest start for ${task.title}`}
          type="time"
          value={task.notBefore ? new Date(task.notBefore).toTimeString().slice(0, 5) : ""}
          onChange={(e) => onEditFields({
            notBefore: e.target.value
              ? new Date(`${task.scheduledFor || new Date().toISOString().slice(0, 10)}T${e.target.value}:00`).toISOString()
              : null,
          })}
        />
        <span className="task-meta-time" title={task.updatedAt ? new Date(task.updatedAt).toLocaleString() : ""}>
          {task.updatedAt || task.createdAt ? relativeTime(task.updatedAt || task.createdAt) : "—"}
        </span>
      </div>

      {detail && (
        <div className={`task-row-detail tone-${detail.tone}`}>
          <details>
            <summary title={detail.summary}>{detail.summary}</summary>
            <p className="task-detail-full">{detail.full}</p>
          </details>
          {openHref && <a className="task-detail-open" href={openHref}>{openLabel}</a>}
        </div>
      )}

      <div className="task-actions">
        {canContinue ? (
          <a
            className="task-launch"
            aria-label="Continue"
            title="Continue in agent session"
            href={run.agent === "codex" ? `codex://threads/${encodeURIComponent(run.sessionId)}` : claudeHandoffUrl(task, run)}
          ><span aria-hidden="true">▶</span> Continue</a>
        ) : (
          <button
            className="task-launch"
            aria-label={`Launch ${task.title}`}
            title="Launch with an agent"
            disabled={!["backlog", "ready"].includes(task.status)}
            onClick={onLaunch}
          ><span aria-hidden="true">▶</span> Launch</button>
        )}
        <button
          className="task-more"
          aria-label={`More actions for ${task.title}`}
          aria-haspopup="menu"
          onClick={onToggleMenu}
        >⋯</button>
        {menuOpen && (
          <div className="task-menu" role="menu">
            <button role="menuitem" onClick={onEdit}><span aria-hidden="true">✎</span> Edit</button>
            <button role="menuitem" disabled={task.status === "in_progress"} onClick={onRemove}><span aria-hidden="true">✕</span> Remove</button>
          </div>
        )}
      </div>
    </article>
  );
}

function TasksView({ projects }) {
  const [tasks, setTasks] = useState(null);
  const [runs, setRuns] = useState([]);
  const [error, setError] = useState("");
  const [view, setView] = useState("week");
  const [status, setStatus] = useState("active");
  const [launchTask, setLaunchTask] = useState(null);
  const [selectedAgent, setSelectedAgent] = useState("codex");
  const [menuTask, setMenuTask] = useState(null);
  const [editingTask, setEditingTask] = useState(null);
  const [removingTask, setRemovingTask] = useState(null);
  const [addingRequest, setAddingRequest] = useState(false);

  async function refresh() {
    const [nextTasks, nextRuns] = await Promise.all([api("/tasks"), api("/runs")]);
    setTasks(nextTasks);
    setRuns(nextRuns);
  }

  useEffect(() => {
    setError("");
    refresh().catch((e) => setError(e.message));
  }, []);

  // poll while any run is live; runs is the dependency so the timer stops once none are running
  useEffect(() => {
    if (!runs.some((run) => run.status === "running")) return undefined;
    const timer = setInterval(() => refresh().catch(() => {}), 2000);
    return () => clearInterval(timer);
  }, [runs]);

  async function runAction(action, onSuccess) {
    setError("");
    try {
      await action();
      onSuccess();
      await refresh();
    } catch (caught) {
      setError(caught.message);
    }
  }

  function saveEdit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    return runAction(
      () => api(`/tasks/${editingTask.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: "human",
          action: "edit",
          title: form.get("title"),
          type: form.get("type"),
          priority: form.get("priority"),
          status: form.get("status"),
          acceptanceCriteria: form.get("acceptanceCriteria"),
          verificationCommand: form.get("verificationCommand"),
        }),
      }),
      () => setEditingTask(null),
    );
  }

  function patchTask(task, fields) {
    return runAction(
      () => api(`/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "human", action: "edit", ...fields }),
      }),
      () => {},
    );
  }

  function assignAgent(task, assignedAgent) {
    if ((task.assignedAgent || "") === assignedAgent) return undefined;
    return patchTask(task, { assignedAgent });
  }

  function removeTask() {
    return runAction(
      () => api(`/tasks/${removingTask.id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "human" }),
      }),
      () => setRemovingTask(null),
    );
  }

  function addUserRequest(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    return runAction(
      () => api("/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "human", projectPath: form.get("projectPath"), title: form.get("title"), type: form.get("type") }),
      }),
      () => setAddingRequest(false),
    );
  }

  const allTasks = (tasks || []).slice().sort((a, b) => {
    const p = (TASK_PRIORITY_RANK[a.priority] ?? 9) - (TASK_PRIORITY_RANK[b.priority] ?? 9);
    if (p !== 0) return p;
    return String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""));
  });

  const visible = allTasks.filter((task) => {
    if (status === "active") return !["done", "review"].includes(task.status);
    return true;
  });

  const grouped = new Map();
  for (const task of visible) {
    const key = task.projectPath || "Unknown";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(task);
  }

  // progress counts over ALL tasks (incl. done); grouping over the active/all filter
  const statsByProject = new Map();
  for (const t of allTasks) {
    const key = t.projectPath || "Unknown";
    if (!statsByProject.has(key)) statsByProject.set(key, []);
    statsByProject.get(key).push(t);
  }

  // /runs is already sorted newest-first, so the first hit per task is the latest run
  const latestRunByTask = new Map();
  for (const run of runs) if (!latestRunByTask.has(run.taskId)) latestRunByTask.set(run.taskId, run);

  const projectPaths = [...grouped.keys()];
  const portfolio = taskStats(allTasks);
  const pct = portfolio.total ? Math.round((portfolio.done / portfolio.total) * 100) : 0;
  const activeTasks = allTasks.filter((t) => !["done", "review"].includes(t.status));
  const activeCount = activeTasks.length;

  // this-week workbench: split active work into scheduled roadmap tasks vs. unscheduled user requests
  const weekStart = mondayOf(today());
  const weekEnd = addDays(weekStart, 6);
  const roadmapWeekTasks = activeTasks
    .filter((t) => t.milestoneId && t.scheduledFor && t.scheduledFor >= weekStart && t.scheduledFor <= weekEnd)
    .sort((a, b) => {
      const d = String(a.scheduledFor).localeCompare(String(b.scheduledFor));
      if (d !== 0) return d;
      const p = (TASK_PRIORITY_RANK[a.priority] ?? 9) - (TASK_PRIORITY_RANK[b.priority] ?? 9);
      if (p !== 0) return p;
      return String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""));
    });
  // user requests = any active task outside the roadmap (added ad-hoc by the user or an agent), scheduled or not
  const userReqTasks = activeTasks.filter((t) => !t.milestoneId);

  const roadmapGrouped = new Map();
  for (const t of roadmapWeekTasks) {
    const key = t.projectPath || "Unknown";
    if (!roadmapGrouped.has(key)) roadmapGrouped.set(key, []);
    roadmapGrouped.get(key).push(t);
  }

  return (
    <div className="tasks-layout">
      <main className="tasks-center">
        <div className="tasks-head">
          <div className="tasks-head-top">
            <div>
              <h1 className="tasks-title">Tasks</h1>
              <p className="tasks-subtitle">{portfolio.done} of {portfolio.total} done · {activeCount} active across {statsByProject.size} project{statsByProject.size !== 1 ? "s" : ""}</p>
            </div>
            <div className="tasks-tabs" role="group" aria-label="Tasks view">
              <button className={view === "week" ? "active" : ""} aria-pressed={view === "week"} onClick={() => setView("week")}>This week</button>
              <button className={view === "all" ? "active" : ""} aria-pressed={view === "all"} onClick={() => setView("all")}>All tasks</button>
            </div>
          </div>
          {portfolio.total > 0 && (
            <div className="tasks-progress-block">
              <TaskProgress stats={portfolio} className="lg" />
              <div className="tasks-progress-legend">
                <span className="pct">{pct}%</span>
                <span className="leg done">{portfolio.done} done</span>
                {portfolio.in_progress > 0 && <span className="leg in_progress">{portfolio.in_progress} in progress</span>}
                {portfolio.review > 0 && <span className="leg review">{portfolio.review} review</span>}
                {portfolio.blocked > 0 && <span className="leg blocked">{portfolio.blocked} blocked</span>}
              </div>
            </div>
          )}
        </div>

        {error && <div role="alert" className="error">{error}</div>}

        {view === "week" ? (
          <div className="tasks-workbench">
            <aside className="workbench-pane workbench-pane-userreq" aria-label="User requests">
              <details open className="userreq-details">
                <summary className="workbench-pane-header">
                  <h2>User requests · Outside roadmap ({userReqTasks.length})</h2>
                  {/* preventDefault so the button doesn't also toggle the details */}
                  <button type="button" onClick={(e) => { e.preventDefault(); setAddingRequest(true); }}>Add user request</button>
                </summary>
                {userReqTasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    tag="user-req"
                    showProject
                    projects={projects}
                    tasks={allTasks}
                    run={latestRunByTask.get(task.id)}
                    menuOpen={menuTask?.id === task.id}
                    onToggleMenu={() => setMenuTask(menuTask?.id === task.id ? null : task)}
                    onEdit={() => { setMenuTask(null); setEditingTask(task); }}
                    onRemove={() => { setMenuTask(null); setRemovingTask(task); }}
                    onLaunch={() => { setMenuTask(null); setSelectedAgent("codex"); setLaunchTask(task); }}
                    onAssignAgent={(value) => assignAgent(task, value)}
                    onEditFields={(fields) => patchTask(task, fields)}
                  />
                ))}
                {userReqTasks.length === 0 && (
                  <div className="empty">
                    <h2>No user requests</h2>
                    <p>Add one to track work outside the roadmap.</p>
                  </div>
                )}
              </details>
            </aside>

            <section className="workbench-pane" aria-label="Roadmap, this week">
              <header className="workbench-pane-header"><h2>Roadmap · This week</h2></header>
              {[...roadmapGrouped.keys()].map((path, pi) => {
                const groupTasks = roadmapGrouped.get(path);
                const color = PROJECT_COLORS[pi % PROJECT_COLORS.length];
                return (
                  <section className="project-group" key={path}>
                    <header className="project-header">
                      <span className="project-dot" style={{ background: color }} />
                      <span className="project-name">{projectName(projects, path)}</span>
                      <span className="project-count">{groupTasks.length} task{groupTasks.length !== 1 ? "s" : ""}</span>
                    </header>
                    {groupTasks.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        tasks={allTasks}
                        run={latestRunByTask.get(task.id)}
                        menuOpen={menuTask?.id === task.id}
                        onToggleMenu={() => setMenuTask(menuTask?.id === task.id ? null : task)}
                        onEdit={() => { setMenuTask(null); setEditingTask(task); }}
                        onRemove={() => { setMenuTask(null); setRemovingTask(task); }}
                        onLaunch={() => { setMenuTask(null); setSelectedAgent("codex"); setLaunchTask(task); }}
                        onAssignAgent={(value) => assignAgent(task, value)}
                        onEditFields={(fields) => patchTask(task, fields)}
                      />
                    ))}
                  </section>
                );
              })}
              {roadmapWeekTasks.length === 0 && (
                <div className="empty">
                  <h2>No roadmap tasks scheduled this week</h2>
                  <p>Nothing due this week. <button type="button" onClick={() => setView("all")}>View all tasks</button></p>
                </div>
              )}
            </section>

          </div>
        ) : (
          <>
            <div className="tasks-tabs" role="group" aria-label="Filter tasks by status">
              <button className={status === "active" ? "active" : ""} aria-pressed={status === "active"} onClick={() => setStatus("active")}>Active</button>
              <button className={status === "all" ? "active" : ""} aria-pressed={status === "all"} onClick={() => setStatus("all")}>All</button>
            </div>

            {projectPaths.map((path, pi) => {
              const groupTasks = grouped.get(path);
              const color = PROJECT_COLORS[pi % PROJECT_COLORS.length];
              const pstats = taskStats(statsByProject.get(path) || []);
              return (
                <section className="project-group" key={path}>
                  <header className="project-header">
                    <span className="project-dot" style={{ background: color }} />
                    <span className="project-name">{projectName(projects, path)}</span>
                    <span className="project-count">{pstats.done}/{pstats.total} done</span>
                    <TaskProgress stats={pstats} className="sm" />
                  </header>
                  {groupTasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      tag={task.milestoneId ? "roadmap" : "user-req"}
                      tasks={allTasks}
                      run={latestRunByTask.get(task.id)}
                      menuOpen={menuTask?.id === task.id}
                      onToggleMenu={() => setMenuTask(menuTask?.id === task.id ? null : task)}
                      onEdit={() => { setMenuTask(null); setEditingTask(task); }}
                      onRemove={() => { setMenuTask(null); setRemovingTask(task); }}
                      onLaunch={() => { setMenuTask(null); setSelectedAgent("codex"); setLaunchTask(task); }}
                      onAssignAgent={(value) => assignAgent(task, value)}
                      onEditFields={(fields) => patchTask(task, fields)}
                    />
                  ))}
                </section>
              );
            })}

            {tasks && visible.length === 0 && (
              <div className="empty">
                <h2>No tasks match</h2>
                <p>Change the filters or add work to this project.</p>
              </div>
            )}
          </>
        )}
      </main>

      {launchTask && (
        <div className="modal-backdrop" onClick={() => setLaunchTask(null)}>
          <div className="task-modal" role="dialog" aria-modal="true" aria-label="Launch task" onClick={(e) => e.stopPropagation()}>
            <h2>Launch task</h2>
            <p className="modal-sub">{launchTask.title}</p>
            <label><input type="radio" name="agent" value="codex" checked={selectedAgent === "codex"} onChange={() => setSelectedAgent("codex")} /> Codex</label>
            <label><input type="radio" name="agent" value="claude-code" checked={selectedAgent === "claude-code"} onChange={() => setSelectedAgent("claude-code")} /> Claude Code</label>
            <div className="modal-actions">
              <button onClick={() => setLaunchTask(null)}>Cancel</button>
              <a className="primary" href={taskHandoffUrl(launchTask, selectedAgent)} onClick={() => setLaunchTask(null)}>
                Open in {selectedAgent === "codex" ? "Codex" : "Claude"}
              </a>
            </div>
          </div>
        </div>
      )}

      {editingTask && (
        <div className="modal-backdrop" onClick={() => setEditingTask(null)}>
          <form className="task-modal" role="dialog" aria-modal="true" aria-label="Edit task" onSubmit={saveEdit} onClick={(e) => e.stopPropagation()}>
            <h2>Edit task</h2>
            <label>Title<input name="title" defaultValue={editingTask.title} required /></label>
            <label>Type<select name="type" defaultValue={editingTask.type || "chore"} required>{TASK_TYPES.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <label>Priority<select name="priority" defaultValue={editingTask.priority || "normal"}><option>urgent</option><option>high</option><option>normal</option><option>low</option></select></label>
            <label>Status<select name="status" defaultValue={editingTask.status}>{Object.keys(TASK_STATUS_LABELS).map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <label>Acceptance criteria<textarea name="acceptanceCriteria" defaultValue={editingTask.acceptanceCriteria || ""} /></label>
            <label>Verification command<input name="verificationCommand" defaultValue={editingTask.verificationCommand || ""} /></label>
            <div className="modal-actions">
              <button type="button" onClick={() => setEditingTask(null)}>Cancel</button>
              <button type="submit" className="primary">Save task</button>
            </div>
          </form>
        </div>
      )}

      {removingTask && (
        <div className="modal-backdrop" onClick={() => setRemovingTask(null)}>
          <div className="task-modal" role="dialog" aria-modal="true" aria-label="Remove task" onClick={(e) => e.stopPropagation()}>
            <h2>Remove task?</h2>
            <p className="modal-sub">{removingTask.title}</p>
            <p>Completed run history for this task will also be removed.</p>
            <div className="modal-actions">
              <button onClick={() => setRemovingTask(null)}>Cancel</button>
              <button className="danger" onClick={removeTask}>Remove task</button>
            </div>
          </div>
        </div>
      )}

      {addingRequest && (
        <div className="modal-backdrop" onClick={() => setAddingRequest(false)}>
          <form className="task-modal" role="dialog" aria-modal="true" aria-label="Add user request" onSubmit={addUserRequest} onClick={(e) => e.stopPropagation()}>
            <h2>Add user request</h2>
            <label>Project
              <select name="projectPath" defaultValue={projects[0]?.projectPath || ""} required>
                {projects.map((p) => <option key={p.projectPath} value={p.projectPath}>{p.name}</option>)}
              </select>
            </label>
            <label>Title<input name="title" required /></label>
            <label>Type
              <select name="type" defaultValue="" required>
                <option value="" disabled>Select a type…</option>
                {TASK_TYPES.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <div className="modal-actions">
              <button type="button" onClick={() => setAddingRequest(false)}>Cancel</button>
              <button type="submit" className="primary">Add request</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function elapsed(startedAt, endedAt) {
  if (!startedAt) return "";
  const seconds = Math.max(0, Math.floor((new Date(endedAt || Date.now()) - new Date(startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function claudeHandoffUrl(task, run) {
  const prompt = `Continue task: ${task.title}\nAutomated session: ${run.sessionId}\nStatus: ${run.status}\nLatest activity: ${run.lastEvent || "unknown"}`;
  return `claude://code/new?q=${encodeURIComponent(prompt)}&folder=${encodeURIComponent(task.projectPath)}`;
}

function taskHandoffUrl(task, agent) {
  const cli = "cortex";
  const prompt = [
    `Task ID: ${task.id}`,
    `Goal: ${task.title}`,
    task.acceptanceCriteria && `Acceptance criteria: ${task.acceptanceCriteria}`,
    task.relatedFiles?.length && `Related files: ${task.relatedFiles.join(", ")}`,
    task.verificationCommand && `Verification: ${task.verificationCommand}`,
    `Before work: ${cli} task claim --id "${task.id}" --agent ${agent}`,
    `When complete: ${cli} task done --id "${task.id}" --evidence "<verification evidence>"`,
    "Preserve unrelated changes.",
  ].filter(Boolean).join("\n\n");
  const encodedPrompt = encodeURIComponent(prompt);
  const encodedPath = encodeURIComponent(task.projectPath);
  return agent === "codex"
    ? `codex://threads/new?prompt=${encodedPrompt}&path=${encodedPath}`
    : `claude://code/new?q=${encodedPrompt}&folder=${encodedPath}`;
}

const STRUCTURAL_LINK_TYPES = new Set(["belongs_to_project", "belongs_to", "part_of", "changes_file", "implements_task", "fixed_by_commit"]);

// edge colour by semantic family
const EDGE_COLORS = {
  // causal
  caused_by: "#f59e0b", triggers: "#f59e0b", precedes: "#fbbf24", follows: "#fbbf24",
  // epistemic
  supported_by: "#22d3a5", verified_by: "#22d3a5", cites: "#6ee7cf",
  contradicts: "#ef4444", refutes: "#ef4444",
  // project
  blocked_by: "#f87171", depends_on: "#fb923c",
  supersedes: "#a78bfa", replaces: "#a78bfa", duplicates: "#c4b5fd",
  // semantic
  related_to: "#4f6fff", similar_to: "#6b84ff", derived_from: "#818cf8",
  generalizes: "#93c5fd", specializes: "#93c5fd",
  // risk/decision
  mitigates: "#34d399", escalates: "#f87171", decided_by: "#e879f9", influences: "#c084fc",
};

function GraphView() {
  const container = useRef(null);
  const [links, setLinks] = useState([]);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState("");
  const [entities, setEntities] = useState([]);
  const [fromEntityId, setFromEntityId] = useState("");
  const [toEntityId, setToEntityId] = useState("");
  const [linkType, setLinkType] = useState("related_to");
  const [refresh, setRefresh] = useState(0);
  const [showStructural, setShowStructural] = useState(false);

  useEffect(() => {
    api("/links").then(setLinks).catch((caught) => setError(caught.message));
  }, [refresh]);

  useEffect(() => {
    api("/entities").then((items) => {
      setEntities(items);
      setFromEntityId(items[0]?.id || "");
      setToEntityId(items[1]?.id || items[0]?.id || "");
    }).catch((caught) => setError(caught.message));
  }, []);

  async function createLink(event) {
    event.preventDefault();
    setError("");
    try {
      await api("/links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fromEntityId, toEntityId, linkType }),
      });
      setRefresh((v) => v + 1);
    } catch (caught) {
      setError(caught.message);
    }
  }

  const visibleLinks = showStructural
    ? links
    : links.filter((l) => !STRUCTURAL_LINK_TYPES.has(l.linkType));

  const structuralCount = links.length - visibleLinks.length;

  useEffect(() => {
    if (!container.current || visibleLinks.length === 0) return undefined;
    let graph;
    let cancelled = false;
    const nodes = new Map();
    for (const link of visibleLinks) {
      nodes.set(link.fromEntityId, { data: { id: link.fromEntityId, label: link.fromLabel, type: link.fromType } });
      nodes.set(link.toEntityId, { data: { id: link.toEntityId, label: link.toLabel, type: link.toType } });
    }
    import("cytoscape").then(({ default: cytoscape }) => {
      if (cancelled) return;
      graph = cytoscape({
        container: container.current,
        elements: [
          ...nodes.values(),
          ...visibleLinks.map((link) => ({
            data: {
              id: link.id,
              source: link.fromEntityId,
              target: link.toEntityId,
              label: link.linkType.replace(/_/g, " "),
              confidence: link.confidence,
              color: EDGE_COLORS[link.linkType] ?? "#4f6fff",
            },
          })),
        ],
        layout: {
          name: "cose",
          animate: true,
          animationDuration: 800,
          animationEasing: "ease-out",
          randomize: false,
          nodeRepulsion: () => 180000,
          nodeOverlap: 40,
          idealEdgeLength: () => 160,
          edgeElasticity: () => 45,
          nestingFactor: 1.2,
          gravity: 0.15,
          numIter: 1200,
          initialTemp: 200,
          coolingFactor: 0.97,
          minTemp: 1,
          fit: true,
          padding: 48,
        },
        style: [
          {
            selector: "node",
            style: {
              "background-color": "#4f6fff",
              "background-gradient-stop-colors": "#7b5fff #4f6fff",
              "background-gradient-direction": "to-bottom-right",
              label: "data(label)",
              color: "#e8f0ff",
              "font-size": 11,
              "font-weight": 600,
              "text-wrap": "ellipsis",
              "text-max-width": 100,
              "text-valign": "bottom",
              "text-margin-y": 9,
              "text-shadow-blur": 4,
              "text-shadow-color": "#000",
              "text-shadow-opacity": 0.8,
              "text-shadow-offset-x": 0,
              "text-shadow-offset-y": 1,
              width: 42,
              height: 42,
              "border-width": 2,
              "border-color": "#8fa8ff",
              "border-opacity": 0.7,
              "overlay-opacity": 0,
            },
          },
          {
            selector: "node[type='memory']",
            style: { "background-color": "#22d3a5", "border-color": "#6effd9" },
          },
          {
            selector: "node[type='task']",
            style: { "background-color": "#f59e0b", "border-color": "#fcd34d" },
          },
          {
            selector: "node[type='risk']",
            style: { "background-color": "#ef4444", "border-color": "#fca5a5" },
          },
          {
            selector: "edge",
            style: {
              width: "mapData(confidence, 0, 1, 1, 4)",
              "line-color": "data(color)",
              "line-opacity": 0.6,
              "target-arrow-color": "data(color)",
              "target-arrow-shape": "triangle",
              "arrow-scale": 1.1,
              "curve-style": "bezier",
              label: "data(label)",
              "font-size": 9,
              "font-weight": 500,
              color: "data(color)",
              "text-rotation": "autorotate",
              "text-margin-y": -7,
              "text-background-color": "#080e1e",
              "text-background-opacity": 0.85,
              "text-background-padding": "2px",
            },
          },
          {
            selector: "node:selected",
            style: {
              "background-color": "#f472b6",
              "border-color": "#fbcfe8",
              "border-width": 3,
            },
          },
          {
            selector: "edge:selected",
            style: { "line-color": "#f472b6", "target-arrow-color": "#f472b6", "line-opacity": 1 },
          },
          {
            selector: "node:active",
            style: { "overlay-color": "#fff", "overlay-opacity": 0.06 },
          },
        ],
      });
      graph.on("tap", "node", (event) => setSelected(event.target.data()));
      graph.on("tap", (event) => { if (event.target === graph) setSelected(null); });
    }).catch((caught) => setError(caught.message));
    return () => { cancelled = true; graph?.destroy(); };
  }, [visibleLinks]);

  return (
    <main className="page graph-page">
      <p className="eyebrow">Connected evidence</p>
      <h1>Relationship graph</h1>
      <p className="hint">Select a node to inspect how project knowledge is connected.</p>
      {error && <div role="alert" className="error">{error}</div>}
      <details className="link-editor">
        <summary>Create a manual link</summary>
        <form className="link-form" onSubmit={createLink}>
          <label htmlFor="link-from">From</label>
          <select id="link-from" value={fromEntityId} onChange={(e) => setFromEntityId(e.target.value)}>
            {entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.entityType}: {entity.label}</option>)}
          </select>
          <label htmlFor="link-type">Relationship</label>
          <select id="link-type" value={linkType} onChange={(e) => setLinkType(e.target.value)}>
            <optgroup label="Causal / Temporal">
              {["caused_by","triggers","precedes","follows"].map((t) => <option key={t}>{t}</option>)}
            </optgroup>
            <optgroup label="Epistemic">
              {["supported_by","verified_by","cites","contradicts","refutes"].map((t) => <option key={t}>{t}</option>)}
            </optgroup>
            <optgroup label="Project / Work">
              {["blocked_by","depends_on","supersedes","replaces","duplicates"].map((t) => <option key={t}>{t}</option>)}
            </optgroup>
            <optgroup label="Semantic">
              {["related_to","similar_to","derived_from","generalizes","specializes"].map((t) => <option key={t}>{t}</option>)}
            </optgroup>
            <optgroup label="Risk / Decision">
              {["mitigates","escalates","decided_by","influences"].map((t) => <option key={t}>{t}</option>)}
            </optgroup>
          </select>
          <label htmlFor="link-to">To</label>
          <select id="link-to" value={toEntityId} onChange={(e) => setToEntityId(e.target.value)}>
            {entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.entityType}: {entity.label}</option>)}
          </select>
          <button disabled={!fromEntityId || !toEntityId}>Add relationship</button>
        </form>
      </details>
      {visibleLinks.length === 0 && !error ? (
        <div className="empty">
          <svg className="empty-icon" viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="12" cy="26" r="6" stroke="currentColor" strokeWidth="2.5"/>
            <circle cx="40" cy="12" r="6" stroke="currentColor" strokeWidth="2.5"/>
            <circle cx="40" cy="40" r="6" stroke="currentColor" strokeWidth="2.5"/>
            <path d="M18 26l16-11M18 26l16 11" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          <h2>No links yet</h2>
          <p>No relationships have been captured yet.</p>
        </div>
      ) : (
        <div className="graph-shell">
          <div ref={container} className="graph-canvas" aria-label="Memory relationship graph" />
          <aside className="graph-detail">
            <p className="eyebrow">Selection</p>
            {selected ? (
              <>
                <span className="node-type-chip">{selected.type || "node"}</span>
                <h2>{selected.label}</h2>
              </>
            ) : (
              <p className="hint">Click a node to inspect it.</p>
            )}
            <hr />
            <div className="graph-stat">
              <strong>{visibleLinks.length}</strong>
              <span>relationship{visibleLinks.length !== 1 ? "s" : ""} shown</span>
            </div>
            <label className="graph-toggle">
              <input
                type="checkbox"
                checked={showStructural}
                onChange={(e) => setShowStructural(e.target.checked)}
              />
              Show project links{structuralCount > 0 ? ` (${structuralCount})` : ""}
            </label>
            <hr />
            <p className="eyebrow" style={{ marginBottom: 8 }}>Edge types</p>
            <div className="graph-legend">
              <div className="legend-item"><span className="legend-dot" style={{ background: "#4f6fff", color: "#4f6fff" }} />Semantic</div>
              <div className="legend-item"><span className="legend-dot" style={{ background: "#22d3a5", color: "#22d3a5" }} />Epistemic</div>
              <div className="legend-item"><span className="legend-dot" style={{ background: "#f59e0b", color: "#f59e0b" }} />Causal</div>
              <div className="legend-item"><span className="legend-dot" style={{ background: "#ef4444", color: "#ef4444" }} />Conflict</div>
              <div className="legend-item"><span className="legend-dot" style={{ background: "#fb923c", color: "#fb923c" }} />Project</div>
              <div className="legend-item"><span className="legend-dot" style={{ background: "#c084fc", color: "#c084fc" }} />Decision</div>
            </div>
          </aside>
        </div>
      )}
    </main>
  );
}

function StatsView({ projects }) {
  const [project, setProject] = useState("");
  const [stats, setStats] = useState(null);
  const [audit, setAudit] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => { if (!project && projects[0]) setProject(projects[0].projectPath); }, [projects, project]);
  useEffect(() => {
    if (!project) return;
    api(`/stats?project=${encodeURIComponent(project)}`).then(setStats).catch((e) => setError(e.message));
    api(`/audit?project=${encodeURIComponent(project)}`).then(setAudit).catch((e) => setError(e.message));
  }, [project]);

  return (
    <main className="page">
      <p className="eyebrow">Observability</p>
      <div className="page-header">
        <h1>Health &amp; audit</h1>
        {projects.length > 0 && (
          <select value={project} onChange={(e) => setProject(e.target.value)} style={{ width: "auto", minWidth: 220 }}>
            {projects.map((p) => <option key={p.projectPath} value={p.projectPath}>{p.name}</option>)}
          </select>
        )}
      </div>
      {error && <div role="alert" className="error">{error}</div>}
      {stats && (
        <div className="cards">
          <article className="card"><h2>{stats.avgTokens}</h2><p>avg tokens / recall ({stats.recallCount} recalls)</p></article>
          <article className="card"><h2>{stats.tokensP95}</h2><p>p95 tokens / recall</p></article>
          <article className="card"><h2>{stats.records.fix} / {stats.records.research}</h2><p>fixes / research stored</p></article>
          <article className="card"><h2>{stats.supersededFixes}</h2><p>superseded fixes</p></article>
          <article className="card"><h2>{stats.captureTotal}</h2><p>capture candidates</p></article>
          <article className="card">
            <h2>{stats.captureByReason.discarded_near_duplicate || 0}</h2><p>near-duplicates discarded</p>
          </article>
        </div>
      )}
      {audit && (
        <section className="audit-section">
          <h2>Audit findings</h2>
          <div className="cards">
            {audit.issues.map((issue, index) => <article className="card" key={`${issue.code}-${index}`}><h3>{issue.code}</h3><p>{issue.message}</p></article>)}
            {audit.issues.length === 0 && <article className="card"><h3>All clear</h3><p>No data-quality issues found.</p></article>}
          </div>
        </section>
      )}
    </main>
  );
}

const LOG_TYPES = ["fix", "research", "decision", "task", "session", "inbox", "metric"];
const TIME_RANGES = [
  { label: "All time", value: "" },
  { label: "Last 24h", value: 1 },
  { label: "Last 7d", value: 7 },
  { label: "Last 30d", value: 30 },
];

function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d ago` : new Date(iso).toLocaleDateString();
}

function projectName(projects, path) {
  return projects.find((p) => p.projectPath === path)?.name || path?.split(/[\\/]/).pop() || "—";
}

function ActivityLogView({ projects }) {
  const [project, setProject] = useState("");          // "" = all projects
  const [types, setTypes] = useState(new Set());        // empty = all types
  const [range, setRange] = useState("");
  const [query, setQuery] = useState("");
  const [live, setLive] = useState(true);
  const [rows, setRows] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const load = () => {
      const params = new URLSearchParams({ limit: "300" });
      if (project) params.set("project", project);
      if (types.size) params.set("types", [...types].join(","));
      if (query.trim()) params.set("q", query.trim());
      if (range) params.set("since", new Date(Date.now() - range * 86400000).toISOString());
      api(`/activity-log?${params}`).then(setRows).catch((e) => setError(e.message));
    };
    load();
    if (!live) return undefined;
    const timer = setInterval(load, 5000); // ponytail: poll; SSE is YAGNI for a local tool
    return () => clearInterval(timer);
  }, [project, types, range, query, live]);

  const toggleType = (t) => setTypes((prev) => {
    const next = new Set(prev);
    next.has(t) ? next.delete(t) : next.add(t);
    return next;
  });

  return (
    <main className="page">
      <p className="eyebrow">Observability</p>
      <div className="page-header">
        <h1>Activity log</h1>
        <label className="live-toggle">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
          Live
        </label>
      </div>

      <div className="log-filters">
        <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
          <option value="">All projects</option>
          {projects.map((p) => <option key={p.projectPath} value={p.projectPath}>{p.name}</option>)}
        </select>
        <select value={range} onChange={(e) => setRange(e.target.value)} aria-label="Time range">
          {TIME_RANGES.map((r) => <option key={r.label} value={r.value}>{r.label}</option>)}
        </select>
        <input
          className="log-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter text…"
          aria-label="Filter text"
        />
        <div className="type-chips" role="group" aria-label="Filter by type">
          {LOG_TYPES.map((t) => (
            <button
              key={t}
              className={`type-chip log-type-${t} ${types.has(t) ? "active" : ""}`}
              aria-pressed={types.has(t)}
              onClick={() => toggleType(t)}
            >
              {t}
            </button>
          ))}
          {types.size > 0 && (
            <button className="type-chip clear" onClick={() => setTypes(new Set())}>clear</button>
          )}
        </div>
      </div>

      {error && <div role="alert" className="error">{error}</div>}

      <div className="log-count">{rows.length} event{rows.length !== 1 ? "s" : ""}{rows.length === 300 ? " (showing latest 300)" : ""}</div>

      <table className="activity log-table">
        <thead><tr><th>When</th><th>Type</th><th>Project</th><th>Agent</th><th>Summary</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.type}-${r.id}`} className="log-row" onClick={() => setExpanded(expanded === `${r.type}-${r.id}` ? null : `${r.type}-${r.id}`)}>
              <td title={new Date(r.ts).toLocaleString()} className="log-when">{relativeTime(r.ts)}</td>
              <td><span className={`type-badge log-type-${r.type}`}>{r.type}</span></td>
              <td className="log-project">{projectName(projects, r.project)}</td>
              <td className="log-agent">{r.agent || "—"}</td>
              <td className="log-summary">
                {r.title || "—"}
                {expanded === `${r.type}-${r.id}` && r.detail && <span className="log-detail">{r.detail}</span>}
              </td>
            </tr>
          ))}
          {rows.length === 0 && !error && (
            <tr><td colSpan={5} className="log-empty">No activity matches these filters.</td></tr>
          )}
        </tbody>
      </table>
    </main>
  );
}

export default function App() {
  const [view, setView] = useState("Command center");
  const [projects, setProjects] = useState([]);
  const [mobile, setMobile] = useState(() => window.innerWidth < 700);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    api("/projects").then(setProjects).catch(() => setProjects([]));
  }, []);
  useEffect(() => {
    const resize = () => setMobile(window.innerWidth < 700);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  const projectPath = projects[0]?.projectPath || "";
  const navigate = (name) => { setView(name); setMoreOpen(false); };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <aside className="app-sidebar">
        <div className="brand"><span className="logo">M</span><strong className="brand-name">Cortex</strong></div>
        <nav aria-label="Primary">
          {(mobile ? MAIN_VIEWS.slice(0, 5) : MAIN_VIEWS).map((name) => (
            <button
              key={name}
              aria-current={view === name ? "page" : undefined}
              aria-label={name}
              title={name}
              onClick={() => navigate(name)}
            >
              <span className="nav-icon" aria-hidden="true">{NAV_ICONS[name]}</span>
              <span className="nav-label">{name}</span>
              <span className="nav-label-short" aria-hidden="true">{SHORT_LABELS[name] || name}</span>
            </button>
          ))}
          <button
            aria-label="More"
            aria-expanded={moreOpen}
            className={!mobile && MORE_VIEWS.includes(view) ? "active" : ""}
            title="More views"
            onClick={() => setMoreOpen((o) => !o)}
          >
            <span className="nav-icon" aria-hidden="true">⋯</span>
            <span className="nav-label">More</span>
            <span className="nav-label-short" aria-hidden="true">More</span>
          </button>
        </nav>
      </aside>
      {moreOpen && (
        <div className="more-menu" role="menu" aria-label="More destinations">
          {MORE_VIEWS.map((name) => (
            <button role="menuitem" key={name} onClick={() => navigate(name)}>{name}</button>
          ))}
        </div>
      )}
      <div className="app-content" id="main-content">
      {view === "Command center" ? (
        <CommandCenter projectPath={projectPath} projects={projects} onNavigate={navigate} />
      ) : view === "Control Center" ? (
        <ControlCenter projects={projects} />
      ) : view === "Goals" ? (
        <Goals />
      ) : view === "Search" ? (
        <SearchView projects={projects} />
      ) : view === "Tasks" ? (
        <TasksView projects={projects} />
      ) : view === "Knowledge graph" ? (
        <GraphView />
      ) : view === "Portfolio" ? (
        <PortfolioDoctor />
      ) : view === "Health & audit" ? (
        <StatsView projects={projects} />
      ) : (
        <ActivityLogView projects={projects} />
      )}
      </div>
    </div>
  );
}
