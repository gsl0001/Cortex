const GENERIC_TERMS = new Set([
  "src", "test", "tests", "main", "master", "feature", "fix", "chore", "docs", "lib", "app",
]);

const PRIORITY_WEIGHT = { urgent: 4, high: 3, normal: 2, low: 1 };

function tokenize(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2 && !GENERIC_TERMS.has(term));
}

export function extractContextTerms(context = {}) {
  const terms = new Set(tokenize(context.branch));
  for (const file of context.recentFiles || []) {
    for (const term of tokenize(file)) terms.add(term);
  }
  return [...terms];
}

function relevance(text, terms) {
  if (!terms.length) return 0;
  const tokens = new Set(tokenize(text));
  return terms.reduce((score, term) => score + (tokens.has(term) ? 1 : 0), 0);
}

function stableRank(items, score) {
  return items
    .map((item, index) => ({ item, index, score: score(item) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ item }) => item);
}

const RECENCY_HALF_LIFE_DAYS = Number(process.env.CORTEX_BRIEF_RECENCY_HALF_LIFE_DAYS || 30);

// Small fractional tiebreakers (never as large as a single relevance-term match) so an old,
// unverified record doesn't crowd out a verified or recent one purely by insertion order —
// but an actual keyword/file match still wins over both.
function recencyDecay(createdAt, now = Date.now()) {
  if (!createdAt) return 0;
  const ageDays = Math.max(0, (now - new Date(createdAt).getTime()) / 86400000);
  return Math.exp(-Math.log(2) * ageDays / RECENCY_HALF_LIFE_DAYS);
}

function confidence(entry) {
  const verified = Boolean(entry.verification) || entry.qualityStatus === "verified";
  // useCount = times an agent cited this record's [m:xxxxxx] id (recall_cited metrics).
  // Capped below a single relevance-term hit so a much-cited stale record still loses to
  // an actual keyword/file match — citations break ties, they don't override relevance.
  const cited = Math.min(Number(entry.useCount) || 0, 5) * 0.09;
  return (verified ? 0.5 : 0) + recencyDecay(entry.createdAt) * 0.3 + cited;
}

export function rankTasks(tasks, context = {}) {
  const terms = extractContextTerms(context);
  const active = tasks.filter((task) => task.status !== "done");
  const pinned = active.filter(
    (task) => task.status === "in_progress" || task.priority === "urgent",
  );
  const pinnedIds = new Set(pinned.map((task) => task.id));
  const ranked = stableRank(
    active.filter((task) => !pinnedIds.has(task.id)),
    (task) =>
      relevance([task.title, ...(task.relatedFiles || [])].join(" "), terms) * 10 +
      (PRIORITY_WEIGHT[task.priority] || 1),
  );
  return [...pinned, ...ranked.slice(0, 6)];
}

export function rankResearch(entries, context = {}) {
  const terms = extractContextTerms(context);
  return stableRank(entries, (entry) =>
    relevance([entry.question, entry.finding, ...(entry.reuseTags || [])].join(" "), terms) + confidence(entry),
  ).slice(0, 5);
}

export function rankFixes(entries, context = {}) {
  const terms = extractContextTerms(context);
  return stableRank(entries, (entry) =>
    relevance([entry.summary, ...(entry.filesChanged || [])].join(" "), terms) + confidence(entry),
  ).slice(0, 5);
}

// Same file/branch-term relevance as rankFixes, applied to attempts that got superseded —
// surfaces "you tried this here before and it didn't stick" for the files in play right now.
export function rankPreviouslyAttempted(entries, context = {}) {
  const terms = extractContextTerms(context);
  if (!terms.length) return entries.slice(0, 3);
  return stableRank(entries, (entry) =>
    relevance([entry.summary, ...(entry.filesChanged || [])].join(" "), terms),
  ).slice(0, 3);
}
