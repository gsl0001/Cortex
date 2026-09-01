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

// The one query string the semantic arm embeds — derived identically by prepareBrief
// (which awaits the embedding) and buildBrief's semantic closure (which scores with it):
// OllamaEmbeddingProvider caches by exact query string, so the two must never drift.
export function briefQuery(context = {}) {
  return [context.goalText, context.branch, ...(context.recentFiles || [])].filter(Boolean).join(" ");
}

export function extractContextTerms(context = {}) {
  const terms = new Set(tokenize(context.branch));
  for (const file of context.recentFiles || []) {
    for (const term of tokenize(file)) terms.add(term);
  }
  // The session goal (first real prompt) is what this session is actually about — the strongest
  // relevance signal, and stable per session so it doesn't churn the brief hash (audit III).
  for (const term of tokenize(context.goalText)) terms.add(term);
  return [...terms];
}

// Relevance gate (audit III): when the session gives a goal/branch/file signal, admit only the
// records that match it instead of packing the brief to the token cap with never-cited filler
// — ~81% of injected brief tokens were never cited, and irrelevant context measurably degrades
// the reading agent (GSM-DC, context-rot). A cold session with no signal keeps the old
// recency/confidence top-k. Flip CORTEX_BRIEF_RELEVANCE_GATE=0 to disable without a redeploy.
const RELEVANCE_GATE = process.env.CORTEX_BRIEF_RELEVANCE_GATE !== "0";
// Admission floor + hard fatigue (value audit V): a lone term hit on an unverified, uncited
// record is still padding — it needs a second hit, a verification, or a past citation to earn
// a slot. And a record served many times without ever being cited (top record: 309 injections
// in 14 days) is measured non-signal: past the cap it is excluded outright unless the session
// gives it ≥2 term hits. One citation clears both bars permanently.
const FATIGUE_EXCLUDE = Number(process.env.CORTEX_BRIEF_FATIGUE_EXCLUDE || 10);
// Semantic arm (injection research Aug 28): keyword admission drops paraphrase matches
// outright — NoLiMa's failure mode. A record whose embedding cosine against the session
// query clears this floor is admitted as if it had 2 term hits. Cosine on nomic-embed-text
// for on-topic pairs typically lands 0.6+; MinHash fallback rarely reaches it, which is the
// right conservatism for the weaker signal.
const SEMANTIC_ADMIT = Number(process.env.CORTEX_BRIEF_SEMANTIC_ADMIT || 0.6);
const SEMANTIC_WEIGHT = Number(process.env.CORTEX_BRIEF_SEMANTIC_WEIGHT || 1.5);
const admit = (entries, terms, textOf, semantic) => {
  if (!RELEVANCE_GATE || !terms.length) return entries;
  return entries.filter((e) => {
    const hits = relevance(textOf(e), terms);
    const semStrong = semantic ? semantic(e, textOf(e)) >= SEMANTIC_ADMIT : false;
    if (!hits && !semStrong) return false;
    const verified = Boolean(e.verification) || e.qualityStatus === "verified";
    const cited = (Number(e.useCount) || 0) > 0;
    if (hits === 1 && !verified && !cited && !semStrong) return false;
    const cap = verified ? FATIGUE_EXCLUDE * 2.5 : FATIGUE_EXCLUDE;
    if (!cited && (Number(e.injectedCount) || 0) >= cap && hits < 2 && !semStrong) return false;
    return true;
  });
};

function relevance(text, terms) {
  if (!terms.length) return 0;
  const tokens = new Set(tokenize(text));
  return terms.reduce((score, term) => score + (tokens.has(term) ? 1 : 0), 0);
}

// IDF over the candidate set (injection research Aug 28): unweighted overlap scored "fix" and
// "src" like "quarantine", and in a self-referential store nearly every record shares the
// project's own vocabulary. A term carried by every candidate ranks nothing; a term unique to
// one candidate ranks strongly (weight slightly above 1). Admission (admit) stays on raw hit
// counts so its 1-hit/2-hit floors keep their meaning.
function termWeights(entries, textOf, terms) {
  const n = entries.length || 1;
  const df = new Map();
  for (const entry of entries) {
    const tokens = new Set(tokenize(textOf(entry)));
    for (const term of terms) if (tokens.has(term)) df.set(term, (df.get(term) || 0) + 1);
  }
  const weights = new Map();
  for (const term of terms) weights.set(term, Math.log((n + 1) / ((df.get(term) || 0) + 0.5)) / Math.log(n + 1));
  return weights;
}

function weightedRelevance(text, terms, weights) {
  if (!terms.length) return 0;
  const tokens = new Set(tokenize(text));
  return terms.reduce((score, term) => score + (tokens.has(term) ? weights.get(term) ?? 1 : 0), 0);
}

function stableRank(items, score) {
  return items
    .map((item, index) => ({ item, index, score: score(item) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ item }) => item);
}

const RECENCY_HALF_LIFE_DAYS = Number(process.env.CORTEX_BRIEF_RECENCY_HALF_LIFE_DAYS || 30);

// Record kinds age differently: a fix stays valid until the code changes (file-overlap
// supersession handles that; the clock is only a tiebreaker) and a decision until the goal
// changes — so decisions decay 3× slower than the global default. Research keeps the default.
const HALF_LIFE_BY_KIND = {
  fix: Number(process.env.CORTEX_FIX_HALF_LIFE_DAYS || RECENCY_HALF_LIFE_DAYS),
  research: Number(process.env.CORTEX_RESEARCH_HALF_LIFE_DAYS || RECENCY_HALF_LIFE_DAYS),
  decision: Number(process.env.CORTEX_DECISION_HALF_LIFE_DAYS || RECENCY_HALF_LIFE_DAYS * 3),
};

// Small fractional tiebreakers (never as large as a single relevance-term match) so an old,
// unverified record doesn't crowd out a verified or recent one purely by insertion order —
// but an actual keyword/file match still wins over both.
function recencyDecay(createdAt, halfLifeDays, now = Date.now()) {
  if (!createdAt) return 0;
  const ageDays = Math.max(0, (now - new Date(createdAt).getTime()) / 86400000);
  return Math.exp(-Math.log(2) * ageDays / halfLifeDays);
}

function confidence(entry, halfLifeDays = RECENCY_HALF_LIFE_DAYS) {
  const verified = Boolean(entry.verification) || entry.qualityStatus === "verified";
  // useCount = times an agent cited this record's [m:xxxxxx] id (recall_cited metrics).
  // Capped below a single relevance-term hit so a much-cited stale record still loses to
  // an actual keyword/file match — citations break ties, they don't override relevance.
  const cited = Math.min(Number(entry.useCount) || 0, 5) * 0.09;
  // Injection fatigue (value audit IV): a record served over and over and never once cited is
  // measured non-signal for this project, and should yield its slot instead of winning on
  // recency forever. Live data: 10 records filled 22.5% of all brief slots in 8 days, one of
  // them 124 times, while 38.6% of the store had never been served at all. Applies only while
  // useCount is 0 — one citation clears it — and caps at 0.48, just under the verified bonus,
  // so a verified record is never pushed out by fatigue alone.
  const fatigue = Number(entry.useCount) > 0
    ? 0
    : Math.min(Number(entry.injectedCount) || 0, 8) * 0.06;
  return (verified ? 0.5 : 0) + recencyDecay(entry.createdAt, halfLifeDays) * 0.3 + cited - fatigue;
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

export function rankResearch(entries, context = {}, semantic = null) {
  const terms = extractContextTerms(context);
  const textOf = (e) => [e.question, e.finding, ...(e.reuseTags || [])].join(" ");
  const weights = termWeights(entries, textOf, terms);
  return stableRank(admit(entries, terms, textOf, semantic), (entry) =>
    weightedRelevance(textOf(entry), terms, weights) + confidence(entry, HALF_LIFE_BY_KIND.research)
    + (semantic ? SEMANTIC_WEIGHT * semantic(entry, textOf(entry)) : 0),
  ).slice(0, 5);
}

export function rankFixes(entries, context = {}, semantic = null) {
  const terms = extractContextTerms(context);
  const textOf = (e) => [e.summary, ...(e.filesChanged || [])].join(" ");
  const weights = termWeights(entries, textOf, terms);
  return stableRank(admit(entries, terms, textOf, semantic), (entry) =>
    weightedRelevance(textOf(entry), terms, weights) + confidence(entry, HALF_LIFE_BY_KIND.fix)
    + (semantic ? SEMANTIC_WEIGHT * semantic(entry, textOf(entry)) : 0),
  ).slice(0, 5);
}

// Decisions were the one record kind the brief served straight off the recency list — no
// relevance gate, no confidence, no fatigue (value audit IV). That is why they were the most
// polluted section after research: an unranked slice(0,5) cannot decline anything.
export function rankDecisions(entries, context = {}, semantic = null) {
  const terms = extractContextTerms(context);
  const textOf = (e) => [e.decision, e.rationale, e.alternatives].filter(Boolean).join(" ");
  const weights = termWeights(entries, textOf, terms);
  return stableRank(admit(entries, terms, textOf, semantic), (entry) =>
    weightedRelevance(textOf(entry), terms, weights) + confidence(entry, HALF_LIFE_BY_KIND.decision)
    + (semantic ? SEMANTIC_WEIGHT * semantic(entry, textOf(entry)) : 0),
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
