// Snapshot live hub performance metrics into benchmarks/<date>-perf-baseline.json.
// Baseline for judging the value-audit fixes (recall usefulness, tokens/citation,
// decision supersede counts). Re-run later and diff against the committed baseline.
// Usage: node scripts/perf-snapshot.mjs [outputPath]
import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "node:fs";

const API = process.env.CORTEX_URL || "http://127.0.0.1:4317";
const DB = process.env.CORTEX_DB || `${process.env.USERPROFILE || process.env.HOME}/.cortex/cortex.sqlite`;

const health = await fetch(`${API}/api/v1/health`).then((r) => r.json()).catch(() => null);
if (!health?.ok) { console.error(`Hub not reachable at ${API} — start it first (npm start).`); process.exit(1); }

const projects = await (await fetch(`${API}/api/v1/projects`)).json();
const projectStats = {};
let runsWeekly = null;
for (const p of projects) {
  const s = await (await fetch(`${API}/api/v1/stats?project=${encodeURIComponent(p.projectPath)}`)).json();
  runsWeekly = s.runsWeekly; // machine-wide rollup, identical for every project — keep once
  delete s.runsWeekly;
  projectStats[p.projectPath] = s;
}

// Read-only DB open: live vs superseded decisions per project (baseline for the PR #42
// capture-time supersede gate — future duplicates should land as superseded, not pile up live).
const db = new DatabaseSync(DB, { readOnly: true });
const decisionCounts = db.prepare(`
  SELECT project_path AS projectPath,
    SUM(CASE WHEN id IN (SELECT supersedes_id FROM decision_entries WHERE supersedes_id IS NOT NULL) THEN 0 ELSE 1 END) AS live,
    SUM(CASE WHEN id IN (SELECT supersedes_id FROM decision_entries WHERE supersedes_id IS NOT NULL) THEN 1 ELSE 0 END) AS superseded
  FROM decision_entries GROUP BY project_path ORDER BY project_path
`).all();
db.close();

const capturedAt = new Date().toISOString();
const out = {
  _meta: {
    capturedAt,
    regenerate: "node scripts/perf-snapshot.mjs",
    note: "All-time cumulative counters per project (no `since` window). To compare later: re-run and subtract these baselines.",
  },
  runsWeekly,
  decisionCounts,
  projectStats,
};

const outPath = process.argv[2] || `benchmarks/${capturedAt.slice(0, 10)}-perf-baseline.json`;
mkdirSync("benchmarks", { recursive: true });
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`${outPath}: ${projects.length} projects, ${decisionCounts.length} decision rows`);
