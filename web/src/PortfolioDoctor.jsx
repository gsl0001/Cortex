import { useEffect, useMemo, useState } from "react";
import { api } from "./api.js";

const STATES = ["unclassified", "active", "waiting", "maintenance", "archived"];
const HUMAN = "human";

function shortDate(value) {
  return value ? new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "Never";
}

function proofLabel(row) {
  const taskProof = row.tasks.open ? `${row.tasks.evidenceContracts}/${row.tasks.open} task proofs` : "No open tasks";
  const runProof = row.runs.total ? `${row.runs.verified}/${row.runs.total} runs verified` : "No runs";
  return `${taskProof} · ${runProof}`;
}

export default function PortfolioDoctor() {
  const [report, setReport] = useState(null);
  const [filter, setFilter] = useState("attention");
  const [busyPath, setBusyPath] = useState("");
  const [error, setError] = useState("");

  const refresh = () => api("/portfolio/doctor").then(setReport).catch((caught) => setError(caught.message));
  useEffect(() => { refresh(); }, []);

  const rows = useMemo(() => {
    if (!report) return [];
    if (filter === "all") return report.rows;
    if (filter === "attention") return report.rows.filter(({ issues }) => issues.some(({ severity }) => severity !== "info"));
    return report.rows.filter(({ lifecycle }) => lifecycle === filter);
  }, [report, filter]);

  async function setLifecycle(projectPath, state) {
    setBusyPath(projectPath);
    setError("");
    try {
      await api("/projects/lifecycle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: HUMAN, projectPath, state }),
      });
      await refresh();
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusyPath("");
    }
  }

  if (!report) return <main className="page"><p className="hint">{error || "Loading portfolio…"}</p></main>;
  const { summary } = report;

  return (
    <main className="page portfolio-page">
      <p className="eyebrow">Outcome loop</p>
      <div className="page-header portfolio-header">
        <div>
          <h1>Portfolio Doctor</h1>
          <p className="hint">One state, one next action, and inspectable proof for every project.</p>
        </div>
        <select aria-label="Filter portfolio" value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="attention">Needs attention</option>
          <option value="all">All projects</option>
          {STATES.map((state) => <option key={state} value={state}>{state}</option>)}
        </select>
      </div>

      {error && <div role="alert" className="error">{error}</div>}
      {summary.active > 3 && (
        <div role="status" className="portfolio-wip">
          {summary.active} projects are active. Finish or park {summary.active - 3} to restore the three-project WIP limit.
        </div>
      )}

      <section className="portfolio-metrics" aria-label="Portfolio health">
        <article><strong>{summary.attention}</strong><span>need attention</span></article>
        <article><strong>{summary.active}</strong><span>active</span></article>
        <article><strong>{summary.unclassified}</strong><span>unclassified</span></article>
        <article><strong>{summary.missingContracts}</strong><span>tasks missing proof</span></article>
        <article><strong>{summary.overdueRechecks}</strong><span>overdue rechecks</span></article>
        <article><strong>{summary.verifiedRuns}/{summary.runs}</strong><span>runs verified</span></article>
      </section>

      <div className="portfolio-table-wrap">
        <table className="portfolio-table">
          <thead>
            <tr><th>Project</th><th>State</th><th>Last verified result</th><th>Next action</th><th>Proof</th><th>Attention</th></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.projectPath}>
                <td>
                  <strong>{row.name}</strong>
                  <span className="portfolio-path">{row.projectPath}</span>
                  <span className="portfolio-activity">Activity {shortDate(row.lastActivityAt)}</span>
                </td>
                <td>
                  <select
                    aria-label={`Lifecycle for ${row.name}`}
                    value={row.lifecycle}
                    disabled={busyPath === row.projectPath}
                    onChange={(event) => setLifecycle(row.projectPath, event.target.value)}
                  >
                    {STATES.map((state) => <option key={state} value={state}>{state}</option>)}
                  </select>
                  {row.lifecycle === "unclassified" && row.suggestedLifecycle !== "unclassified" && (
                    <button
                      type="button"
                      className="portfolio-suggestion"
                      disabled={Boolean(busyPath)}
                      onClick={() => setLifecycle(row.projectPath, row.suggestedLifecycle)}
                    >
                      Use {row.suggestedLifecycle}
                    </button>
                  )}
                </td>
                <td>
                  {row.lastVerifiedOutcome
                    ? <><span>{row.lastVerifiedOutcome.title}</span><small>{shortDate(row.lastVerifiedOutcome.at)}</small></>
                    : <span className="muted">No verified result</span>}
                </td>
                <td>
                  <span className={`portfolio-next portfolio-next-${row.nextAction.kind}`}>{row.nextAction.title}</span>
                </td>
                <td><span className="portfolio-proof">{proofLabel(row)}</span></td>
                <td>
                  <div className="portfolio-flags">
                    {row.issues.map((issue) => (
                      <span key={issue.code} className={`portfolio-flag portfolio-flag-${issue.severity}`} title={issue.message}>
                        {issue.code.replaceAll("-", " ")}
                      </span>
                    ))}
                    {!row.issues.length && <span className="portfolio-clear">Clear</span>}
                  </div>
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={6} className="log-empty">No projects match this filter.</td></tr>}
          </tbody>
        </table>
      </div>

      {report.identityIssues.length > 0 && (
        <details className="portfolio-identities">
          <summary>{report.identityIssues.length} session path issue{report.identityIssues.length === 1 ? "" : "s"}</summary>
          <ul>
            {report.identityIssues.slice(0, 20).map((item) => (
              <li key={item.projectPath}>
                <code>{item.projectPath}</code>
                <span>{item.sessions} session{item.sessions === 1 ? "" : "s"}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </main>
  );
}
