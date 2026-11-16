// Operational diagnostics, not an accuracy benchmark. Legacy counts remain useful,
// but missing trace fields must never be interpreted as zero packed results.
export function summarizeSearches(rows) {
  const summary = { searches: rows.length, traced: 0, legacy: 0, emptyResults: 0,
    emptyPacksWithResults: 0, budgetLimited: 0, truncatedQueries: 0,
    embeddingModes: {}, latencySamples: 0, searchP50Ms: null, searchP95Ms: null };
  const durations = [];
  for (const row of rows) {
    const p = row.payload || {};
    if (p.results === 0) summary.emptyResults++;
    if (p.traceVersion !== 1 || !Array.isArray(p.packedIds) || !Array.isArray(p.returnedIds)) {
      summary.legacy++;
      continue;
    }
    summary.traced++;
    if (p.results > 0 && p.packedIds.length === 0) summary.emptyPacksWithResults++;
    if (p.budgetExcluded > 0) summary.budgetLimited++;
    if (p.queryTruncated) summary.truncatedQueries++;
    const mode = ["ollama", "minhash", "unknown"].includes(p.embeddingMode) ? p.embeddingMode : "other";
    summary.embeddingModes[mode] = (summary.embeddingModes[mode] || 0) + 1;
    if (typeof p.searchDurationMs === "number" && Number.isFinite(p.searchDurationMs) && p.searchDurationMs >= 0) durations.push(p.searchDurationMs);
  }
  durations.sort((a, b) => a - b);
  summary.latencySamples = durations.length;
  if (durations.length) {
    summary.searchP50Ms = durations[Math.max(0, Math.ceil(durations.length * .5) - 1)];
    summary.searchP95Ms = durations[Math.max(0, Math.ceil(durations.length * .95) - 1)];
  }
  return summary;
}
