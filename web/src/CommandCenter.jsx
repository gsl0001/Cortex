import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";

export function attentionItems({ inbox = [], tasks = [], audit = [] }) {
  const groupedAudit = [...audit.reduce((groups, item) => {
    const key = item.code || item.message;
    const existing = groups.get(key);
    groups.set(key, existing ? { ...existing, count: existing.count + 1 } : { ...item, count: 1 });
    return groups;
  }, new Map()).values()];
  return [
    ...inbox.map((item) => ({ priority: 2, kind: "inbox", item })),
    ...tasks.filter((item) => ["blocked", "review"].includes(item.status)).map((item) => ({ priority: 3, kind: "task", item })),
    ...groupedAudit.map((item) => ({ priority: 4, kind: "audit", item })),
  ].sort((a, b) => a.priority - b.priority);
}

// last 14 days of activity, bucketed by day and record type, newest last
export function pulseDays(rows = [], now = Date.now()) {
  const days = [];
  for (let i = 13; i >= 0; i -= 1) {
    const date = new Date(now - i * 86400000);
    days.push({ key: date.toISOString().slice(0, 10), label: date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }), total: 0, byType: {} });
  }
  const index = new Map(days.map((day) => [day.key, day]));
  for (const row of rows) {
    const day = index.get(String(row.ts).slice(0, 10));
    if (!day) continue;
    day.total += 1;
    day.byType[row.type] = (day.byType[row.type] || 0) + 1;
  }
  return days;
}

const PULSE_TYPES = ["fix", "research", "decision", "task", "session", "inbox", "metric"];

function relativeTime(iso) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d ago` : new Date(iso).toLocaleDateString();
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function taskStats(list) {
  const s = { total: list.length, done: 0, in_progress: 0, review: 0, blocked: 0 };
  for (const t of list) if (s[t.status] !== undefined) s[t.status] += 1;
  return s;
}

function MiniProgress({ stats }) {
  if (!stats.total) return <div className="cc-progress" aria-hidden="true" />;
  const todo = stats.total - stats.done - stats.review - stats.in_progress - stats.blocked;
  const seg = (n, cls) => (n > 0 ? <span key={cls} className={`prog-seg ${cls}`} style={{ flexGrow: n }} /> : null);
  return (
    <div className="cc-progress" role="img" aria-label={`${stats.done} of ${stats.total} tasks done`}>
      {seg(stats.done, "done")}{seg(stats.review, "review")}{seg(stats.in_progress, "in_progress")}{seg(stats.blocked, "blocked")}{seg(todo, "todo")}
    </div>
  );
}

function MemoryPulse({ rows, onNavigate }) {
  const days = pulseDays(rows);
  const max = Math.max(1, ...days.map((day) => day.total));
  const total = days.reduce((sum, day) => sum + day.total, 0);
  return (
    <section className="pulse" aria-label="Memory pulse, last 14 days">
      <header className="pulse-head">
        <div>
          <h2>Memory pulse</h2>
          <p>{total ? `${rows.length >= 300 ? "300+" : total} memories captured in the last 14 days` : "Nothing captured in the last 14 days — activity will show up here as agents work."}</p>
        </div>
        <button type="button" className="pulse-open" onClick={() => onNavigate?.("Activity log")}>Open activity log</button>
      </header>
      <div className="pulse-strip">
        {days.map((day) => (
          <button
            key={day.key}
            type="button"
            className="pulse-day"
            title={`${day.label} — ${day.total} event${day.total !== 1 ? "s" : ""}`}
            aria-label={`${day.label}, ${day.total} event${day.total !== 1 ? "s" : ""}`}
            onClick={() => onNavigate?.("Activity log")}
          >
            <span className="pulse-bar" style={{ height: `${Math.max(day.total / max * 100, 4)}%` }}>
              {PULSE_TYPES.map((type) => day.byType[type] ? (
                <span key={type} className={`pulse-seg log-type-${type}`} style={{ flexGrow: day.byType[type] }} />
              ) : null)}
            </span>
            <span className="pulse-tick">{day.label.split(",")[0].slice(0, 2)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

const titles = {
  inbox: "Resolve human inbox item",
};
const actionLabels = { inbox: "Resolve", task: "Open task", audit: "Open issue" };

function ActionDrawer({ title, trigger, onClose, children }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    dialogRef.current?.focus();
    return () => trigger?.focus();
  }, [trigger]);
  return (
    <div className="drawer-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="action-drawer"
        onKeyDown={(event) => event.key === "Escape" && onClose()}
      >
        <button className="drawer-close" type="button" onClick={onClose} aria-label={`Close ${title}`}>×</button>
        {children}
      </aside>
    </div>
  );
}

export default function CommandCenter({ projectPath, projects = [], onNavigate }) {
  const [panels, setPanels] = useState({});
  const [selected, setSelected] = useState(null);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [reason, setReason] = useState("");
  const project = encodeURIComponent(projectPath || "");
  const sources = {
    stats: `/stats?project=${project}`,
    tasks: "/tasks",
    inbox: `/inbox?project=${project}`,
    activity: `/activity-log?limit=300`,
    workflows: "/workflows",
    health: "/health",
    audit: `/audit?project=${project}`,
    runs: "/runs",
  };

  function loadPanel(name) {
    setPanels((old) => ({ ...old, [name]: {} }));
    api(sources[name]).then(
      (data) => setPanels((old) => ({ ...old, [name]: { data } })),
      (error) => setPanels((old) => ({ ...old, [name]: { error: error.message } })),
    );
  }

  async function mutate(path, body, panel) {
    setSaving(true);
    setActionError("");
    try {
      await api(path, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "human", ...body }),
      });
      setAnnouncement("Action completed");
      setSelected(null);
      loadPanel(panel);
      loadPanel("activity");
    } catch (error) {
      setActionError(error.message);
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!projectPath) return;
    let current = true;
    setPanels({});
    Object.entries(sources).forEach(([name, endpoint]) => {
      api(endpoint).then(
        (data) => current && setPanels((old) => ({ ...old, [name]: { data } })),
        (error) => current && setPanels((old) => ({ ...old, [name]: { error: error.message } })),
      );
    });
    return () => { current = false; };
  }, [projectPath]);

  const stats = panels.stats?.data;
  const tasks = panels.tasks?.data || [];
  const inbox = panels.inbox?.data || [];
  const audit = panels.audit?.data?.issues || [];
  const activity = panels.activity?.data || [];
  const runs = panels.runs?.data || [];
  const actions = attentionItems({ inbox, tasks, audit });
  const runningAgents = runs.filter((run) => run.status === "running").length;

  const projectName = (path) => projects.find((p) => p.projectPath === path)?.name || path?.split(/[\\/]/).pop() || "—";

  // group all tasks per project for the portfolio cards
  const tasksByProject = new Map();
  for (const task of tasks) {
    const key = task.projectPath || "Unknown";
    if (!tasksByProject.has(key)) tasksByProject.set(key, []);
    tasksByProject.get(key).push(task);
  }
  const portfolio = projects.map((p) => {
    const list = tasksByProject.get(p.projectPath) || [];
    const lastEvent = activity.find((row) => row.project === p.projectPath);
    return { ...p, stats: taskStats(list), lastEvent };
  });

  return (
    <main className="command-center">
      <section className="command-head">
        <div>
          <h1>{greeting()}</h1>
          <p>{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })} · Here’s what your memory system needs from you.</p>
        </div>
        <span className="system-ready">
          {panels.health?.data?.ok ? "● System ready" : panels.health?.error ? "● Server unreachable" : "● Connecting…"}
        </span>
      </section>
      <button className="command-search" type="button" onClick={() => onNavigate?.("Search")}>Search memories, decisions, tasks, and runs… <kbd>Ctrl K</kbd></button>

      <MemoryPulse rows={activity} onNavigate={onNavigate} />

      <section className="command-metrics" aria-label="System summary">
        <article><strong>{stats?.records?.fix ?? "—"}</strong><span>Durable memories</span></article>
        <article><strong>{tasks.filter((item) => item.status === "in_progress").length}</strong><span>Active tasks</span></article>
        <article><strong>{runningAgents}</strong><span>Agents running now</span></article>
        <article className="metric-attention"><strong>{actions.length}</strong><span>Need attention</span></article>
      </section>

      <div className="command-columns">
        <div className="command-main">
          <section className="attention-panel" aria-label="Needs your attention">
            <header><h2>Needs your attention</h2><span>Highest impact first</span></header>
            {actions.map(({ kind, item }) => (
              <article className="attention-row" key={`${kind}-${item.id || item.code}`}>
                <span className={`attention-dot ${kind}`} />
                <div><h3>{titles[kind] || item.title || item.message}</h3><p>{item.message || item.blockReason || item.results?.reason || item.code}{item.count > 1 ? ` (${item.count} findings)` : ""}</p></div>
                <button
                  type="button"
                  aria-label={titles[kind] || item.title || item.message}
                  onClick={(event) => { setReason(""); setSelected({ kind, item, trigger: event.currentTarget }); }}
                >{actionLabels[kind]}</button>
              </article>
            ))}
            {actions.length === 0 && <div className="empty"><h2>Nothing needs you</h2><p>The system has no pending actions.</p></div>}
          </section>

          <section className="portfolio" aria-label="Projects">
            <header className="portfolio-head"><h2>Projects</h2><span>{projects.length} tracked</span></header>
            <div className="portfolio-grid">
              {portfolio.map((entry) => (
                <article className="portfolio-card" key={entry.projectPath}>
                  <h3>{entry.name}</h3>
                  <p className="portfolio-sub">
                    {entry.stats.total
                      ? `${entry.stats.done} of ${entry.stats.total} tasks done${entry.stats.blocked ? ` · ${entry.stats.blocked} blocked` : ""}`
                      : "No tasks yet"}
                  </p>
                  <MiniProgress stats={entry.stats} />
                  <p className="portfolio-last">
                    {entry.lastEvent ? `Last: ${entry.lastEvent.title || entry.lastEvent.type} · ${relativeTime(entry.lastEvent.ts)}` : "No recent activity"}
                  </p>
                  <div className="portfolio-actions">
                    <button type="button" onClick={() => onNavigate?.("Tasks")}>Tasks</button>
                    <button type="button" onClick={() => onNavigate?.("Search")}>Search memory</button>
                  </div>
                </article>
              ))}
              {projects.length === 0 && <div className="empty"><h2>No projects yet</h2><p>Wire a repo into the hub to see it here.</p></div>}
            </div>
          </section>
        </div>

        <aside className="command-rail">
          <h2>Recent activity</h2>
          {activity.slice(0, 8).map((event) => (
            <article key={`${event.type}-${event.id}`}>
              <span className={`type-badge log-type-${event.type}`}>{event.type}</span>
              <strong>{event.title || event.type}</strong>
              <time>{relativeTime(event.ts)} · {projectName(event.project)}</time>
            </article>
          ))}
          {activity.length === 0 && !panels.activity?.error && <p className="rail-empty">Agent activity lands here as it happens.</p>}
          <h2>System health</h2>
          <p><span>Database</span><strong>{panels.health?.data?.ok ? "Healthy" : "Loading"}</strong></p>
          <p><span>Search index</span><strong>{audit.length ? "Review" : "Current"}</strong></p>
          <h2>Go deeper</h2>
          <nav className="rail-links" aria-label="Shortcuts">
            <button type="button" onClick={() => onNavigate?.("Goals")}>Goals &amp; roadmap</button>
            <button type="button" onClick={() => onNavigate?.("Knowledge graph")}>Knowledge graph</button>
            <button type="button" onClick={() => onNavigate?.("Health & audit")}>Health &amp; audit</button>
          </nav>
          {Object.entries(panels).filter(([, value]) => value.error).map(([name, value]) => (
            <div role="alert" className="panel-error" key={name}>
              <strong>{name}</strong><span>{value.error}</span>
              <button type="button" aria-label={`Retry ${name}`} onClick={() => loadPanel(name)}>Retry</button>
            </div>
          ))}
        </aside>
      </div>
      {selected && (
        <ActionDrawer title={titles[selected.kind] || "Review item"} trigger={selected.trigger} onClose={() => setSelected(null)}>
          <p className="eyebrow">{selected.kind}</p>
          <h2>{titles[selected.kind] || selected.item.title || selected.item.message}</h2>
          <p>{selected.item.message || selected.item.blockReason || selected.item.results?.reason}</p>
          {actionError && <div role="alert" className="panel-error">{actionError}</div>}
          {selected.kind === "inbox" && (
            <div className="drawer-actions">
              <button type="button" disabled={saving} onClick={() => mutate(`/inbox/${selected.item.id}`, { projectPath, action: "resolve" }, "inbox")}>Resolve inbox item</button>
              <button type="button" disabled={saving} onClick={() => setSelected(null)}>Cancel</button>
            </div>
          )}
          {selected.kind === "task" && selected.item.status === "blocked" && (
            <div className="drawer-actions">
              <button type="button" disabled={saving} onClick={() => mutate(`/tasks/${selected.item.id}`, { action: "review" }, "tasks")}>Move task to review</button>
              <button type="button" disabled={saving} onClick={() => setSelected(null)}>Cancel</button>
            </div>
          )}
        </ActionDrawer>
      )}
      <div className="sr-only" aria-live="polite">{announcement}</div>
    </main>
  );
}
