import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";

const HEALTH_LABELS = { on_track: "On track", at_risk: "At risk", overdue: "Overdue" };
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const TABS = [{ id: "portfolio", label: "Portfolio" }, { id: "week", label: "This week" }];
const DIFF_LABELS = { create: "Add", link: "Link", update: "Update" };

export const today = () => new Date().toISOString().slice(0, 10);
export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function mondayOf(date) {
  const d = new Date(`${date}T00:00:00Z`);
  return addDays(date, -((d.getUTCDay() + 6) % 7));
}

function HealthBadge({ health }) {
  return <span className={`deadline-badge deadline-${health}`}>{HEALTH_LABELS[health] || health}</span>;
}

function ProposalDialog({ proposal, trigger, onClose, onResolved }) {
  const dialogRef = useRef(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { dialogRef.current?.focus(); return () => trigger?.focus(); }, [trigger]);

  async function resolve(action) {
    setBusy(true);
    setError("");
    try {
      await api(`/roadmap-proposals/${encodeURIComponent(proposal.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "human", action, ...(action === "reject" ? { reason: reason.trim() } : {}) }),
      });
      onResolved(action);
    } catch (caught) {
      setError(caught.message); // approval error leaves the dialog open
    } finally {
      setBusy(false);
    }
  }

  const tasks = proposal.payload?.tasks || [];
  return (
    <div className="drawer-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Review roadmap proposal"
        tabIndex={-1}
        className="action-drawer"
        onKeyDown={(event) => event.key === "Escape" && onClose()}
      >
        <button className="drawer-close" type="button" onClick={onClose} aria-label="Close proposal review">×</button>
        <p className="eyebrow">Proposed by {proposal.createdBy}</p>
        <h2>{proposal.payload?.goal?.title || "Roadmap proposal"}</h2>
        <ul className="proposal-diff">
          {tasks.map((task) => (
            <li key={task.key}>
              <span className={`diff-action diff-${task.action}`}>{DIFF_LABELS[task.action] || task.action}</span>
              <span className="diff-task">{task.number} {task.title || task.taskId}</span>
            </li>
          ))}
        </ul>
        {error && <div role="alert" className="panel-error">{error}</div>}
        <label htmlFor="proposal-reject-reason">Rejection reason</label>
        <input id="proposal-reject-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
        <div className="drawer-actions">
          <button type="button" disabled={busy} onClick={() => resolve("approve")}>Approve roadmap</button>
          <button type="button" disabled={busy || !reason.trim()} onClick={() => resolve("reject")}>Reject</button>
        </div>
      </aside>
    </div>
  );
}

function ProjectDetail({ project, onBack, onChanged, announce }) {
  const [roadmap, setRoadmap] = useState(null);
  const [proposals, setProposals] = useState([]);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(null);
  const path = encodeURIComponent(project.projectPath);

  function loadRoadmap() {
    api(`/roadmaps?project=${path}`).then(setRoadmap).catch((caught) => setError(caught.message));
  }
  useEffect(() => {
    loadRoadmap();
    api(`/roadmap-proposals?project=${path}&status=pending`).then(setProposals).catch(() => setProposals([]));
  }, [project.projectPath]);

  async function patchGoal(body, message) {
    try {
      await api(`/goals/${encodeURIComponent(project.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "human", ...body }),
      });
      announce(message);
      onChanged();
    } catch (caught) { setError(caught.message); }
  }

  async function requestAgent(kind) {
    try {
      await api("/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "human", projectPath: project.projectPath, message: `${kind} roadmap goal ${project.id}` }),
      });
      announce(`${kind} requested`);
    } catch (caught) { setError(caught.message); }
  }

  async function schedule(task, scheduledFor) {
    try {
      await api(`/tasks/${encodeURIComponent(task.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "human", action: "schedule", scheduledFor }),
      });
      loadRoadmap();
    } catch (caught) { setError(caught.message); }
  }

  const goal = roadmap?.goal || project;
  const milestones = roadmap?.milestones || project.milestones || [];
  const tasks = roadmap?.tasks || [];

  return (
    <section className="goals-detail">
      <button type="button" className="goals-back" onClick={onBack}>← All goals</button>
      <p className="eyebrow">Goal</p>
      <h2>{goal.title}</h2>
      <p>{goal.outcome}</p>
      {error && <div role="alert" className="error">{error}</div>}

      <dl className="goals-meta">
        <div><dt>Target date</dt><dd>{goal.targetDate}</dd></div>
        <div><dt>Schedule health</dt><dd><HealthBadge health={project.deadlineHealth} /></dd></div>
      </dl>

      <progress value={project.progress?.percent ?? 0} max={100} />
      <span className="goals-progress-label">{project.progress?.done ?? 0}/{project.progress?.total ?? 0} tasks done</span>

      <h3>Success criteria</h3>
      <ul className="goals-criteria">
        {(goal.successCriteria || []).map((criterion) => <li key={criterion.id}>{criterion.text}</li>)}
      </ul>

      <h3>Roadmap</h3>
      {milestones.map((milestone) => (
        <section className="goals-milestone" key={milestone.id} aria-label={milestone.title}>
          <header><h4>{milestone.title}</h4><span className="goals-due">due {milestone.dueDate}</span></header>
          <ul>
            {tasks.filter((task) => task.milestoneId === milestone.id).map((task) => (
              <li key={task.id} className="goals-task">
                <span className="goals-task-number">{task.taskNumber}</span>
                <span className="goals-task-title">{task.title}</span>
                <span className={`status-badge status-${task.status}`}>{task.status}</span>
                <input
                  type="date"
                  aria-label={`Schedule ${task.title}`}
                  value={task.scheduledFor || ""}
                  onChange={(event) => schedule(task, event.target.value)}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}

      <div className="goals-actions">
        {project.eligibleForAchievement && (
          <button type="button" onClick={() => patchGoal({ action: "achieve" }, "Goal marked achieved")}>Confirm achieved</button>
        )}
        <button type="button" onClick={() => patchGoal({ action: "update", status: "paused" }, "Goal paused")}>Pause</button>
        <button type="button" onClick={() => patchGoal({ action: "update", status: "abandoned" }, "Goal abandoned")}>Abandon</button>
        <button type="button" onClick={() => requestAgent("Recover")}>Recover</button>
        <button type="button" onClick={() => requestAgent("Re-plan")}>Re-plan</button>
      </div>

      {proposals.length > 0 && (
        <section className="goals-proposals" aria-label="Proposed changes">
          <h3>Proposed changes</h3>
          {proposals.map((proposal) => (
            <div className="goals-proposal-row" key={proposal.id}>
              <span>Proposal from {proposal.createdBy}</span>
              <button type="button" onClick={(event) => setDialog({ proposal, trigger: event.currentTarget })}>Review proposal</button>
            </div>
          ))}
        </section>
      )}

      {dialog && (
        <ProposalDialog
          proposal={dialog.proposal}
          trigger={dialog.trigger}
          onClose={() => setDialog(null)}
          onResolved={(action) => { setDialog(null); announce(`Proposal ${action}d`); onChanged(); }}
        />
      )}
    </section>
  );
}

function Portfolio({ data, error, onOpen }) {
  if (error) return <div role="alert" className="error">{error}</div>;
  if (!data) return <p className="hint">Loading portfolio…</p>;
  if (data.projects.length === 0) {
    return (
      <div className="empty">
        <h2>No active goals</h2>
        <p>Have a connected agent propose a roadmap, then approve it to start tracking a goal.</p>
      </div>
    );
  }
  return (
    <>
      <section className="goals-next" aria-label="Highest-value next action">
        <p className="eyebrow">Highest-value next action</p>
        {data.nextAction
          ? <h2>{data.nextAction.title}</h2>
          : <p className="hint">Nothing blocking — you're clear.</p>}
      </section>

      <div className="goals-grid">
        {data.projects.map((project) => (
          <article className="goals-card" data-testid="project-goal-card" key={project.id}>
            <button type="button" className="goals-card-open" aria-label={`Open ${project.title}`} onClick={() => onOpen(project)}>
              <span className="goals-rank">{project.activeRank}</span>
              <h3>{project.title}</h3>
            </button>
            <progress value={project.progress.percent} max={100} />
            <span className="goals-progress-label">{project.progress.done}/{project.progress.total} tasks</span>
            <HealthBadge health={project.deadlineHealth} />
            <p className="goals-next-task">Next: {project.nextTask ? project.nextTask.title : "—"}</p>
          </article>
        ))}
      </div>

      <section className="goals-attention" aria-label="Needs a decision">
        <h2>Needs a decision</h2>
        {data.attention.length === 0
          ? <p className="hint">No blockers or stalls.</p>
          : data.attention.map((item, index) => (
            <article className={`decision-row ${item.kind}`} key={`${item.kind}-${item.taskId || item.id || index}`}>{item.message}</article>
          ))}
      </section>

      <section className="goals-verified" aria-label="Verified this week">
        <h2>Verified this week</h2>
        {data.verifiedOutcomes.length === 0
          ? <p className="hint">No goals completed yet this week.</p>
          : data.verifiedOutcomes.map((outcome) => <article key={outcome.id}>{outcome.title}</article>)}
      </section>
    </>
  );
}

function Week({ data, error, weekStart, setWeekStart, capacity, setCapacity, onAutoPlan, planning }) {
  return (
    <section className="week">
      <div className="week-controls">
        <label>Week of <input type="date" aria-label="Week of" value={weekStart} onChange={(event) => setWeekStart(event.target.value)} /></label>
        <label>Capacity <input type="number" min="1" aria-label="Weekly capacity" value={capacity} onChange={(event) => setCapacity(Number(event.target.value))} /></label>
        <button type="button" onClick={onAutoPlan} disabled={planning}>Auto-plan week</button>
      </div>
      {error && <div role="alert" className="error">{error}</div>}
      {!data ? <p className="hint">Loading week…</p> : (
        <>
          <div className="week-grid">
            {WEEKDAYS.map((day, index) => {
              const date = addDays(data.weekStart, index);
              const dayTasks = data.scheduled.filter((task) => task.scheduledFor === date);
              return (
                <section className="week-day" key={day} aria-label={day}>
                  <header><strong>{day}</strong><span>{date.slice(5)}</span></header>
                  {dayTasks.map((task) => <article className="week-task" key={task.id}>{task.title}</article>)}
                </section>
              );
            })}
          </div>
          <section className="week-unscheduled" aria-label="Unscheduled">
            <h3>Unscheduled</h3>
            {data.unscheduled.length === 0
              ? <p className="hint">Everything is scheduled.</p>
              : data.unscheduled.map((task) => <article key={task.id}>{task.title}</article>)}
          </section>
        </>
      )}
    </section>
  );
}

export default function Goals() {
  const [tab, setTab] = useState("portfolio");
  const [selected, setSelected] = useState(null);
  const [portfolio, setPortfolio] = useState({ data: null, error: "" });
  const [week, setWeek] = useState({ data: null, error: "" });
  const [weekStart, setWeekStart] = useState(() => mondayOf(today()));
  const [capacity, setCapacity] = useState(10);
  const [planning, setPlanning] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  function loadPortfolio() {
    api(`/goals?today=${today()}`).then(
      (data) => setPortfolio({ data, error: "" }),
      (error) => setPortfolio((old) => ({ ...old, error: error.message })),
    );
  }
  function loadWeek() {
    api(`/weeks?start=${weekStart}&capacity=${capacity}`).then(
      (data) => setWeek({ data, error: "" }),
      (error) => setWeek((old) => ({ ...old, error: error.message })),
    );
  }
  useEffect(() => { loadPortfolio(); }, []);
  useEffect(() => { loadWeek(); }, [weekStart, capacity]);

  async function autoPlan() {
    setPlanning(true);
    try {
      await api("/weeks/auto-plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "human", weekStart, totalCapacity: capacity }),
      });
      loadWeek();
      setAnnouncement("Week re-planned");
    } catch (error) {
      setWeek((old) => ({ ...old, error: error.message }));
      setAnnouncement(error.message); // announce failures too
    } finally {
      setPlanning(false);
    }
  }

  function onTabKey(event) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const index = TABS.findIndex((entry) => entry.id === tab);
    const next = TABS[(index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    setSelected(null);
    setTab(next.id);
    event.currentTarget.parentElement.querySelector(`#goals-tab-${next.id}`)?.focus();
  }

  return (
    <main className="page goals">
      <p className="eyebrow">Roadmap</p>
      <div className="page-header">
        <h1>Goals</h1>
        <div role="tablist" aria-label="Goals views" className="goals-tabs">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              id={`goals-tab-${entry.id}`}
              role="tab"
              aria-selected={tab === entry.id}
              tabIndex={tab === entry.id ? 0 : -1}
              className={tab === entry.id ? "active" : ""}
              onClick={() => { setSelected(null); setTab(entry.id); }}
              onKeyDown={onTabKey}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "portfolio" && (selected
        ? <ProjectDetail
            project={selected}
            onBack={() => setSelected(null)}
            onChanged={() => { loadPortfolio(); setSelected(null); }}
            announce={setAnnouncement}
          />
        : <Portfolio data={portfolio.data} error={portfolio.error} onOpen={setSelected} />)}

      {tab === "week" && (
        <Week
          data={week.data}
          error={week.error}
          weekStart={weekStart}
          setWeekStart={setWeekStart}
          capacity={capacity}
          setCapacity={setCapacity}
          onAutoPlan={autoPlan}
          planning={planning}
        />
      )}

      <div className="sr-only" aria-live="polite">{announcement}</div>
    </main>
  );
}
