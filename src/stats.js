function percentile(sortedAscending, p) {
  if (!sortedAscending.length) return 0;
  const index = Math.min(sortedAscending.length - 1, Math.floor((p / 100) * sortedAscending.length));
  return sortedAscending[index];
}

export function computeStats(storage, { projectPath, since } = {}) {
  const events = storage.listMetrics(projectPath, { since });
  const recall = events.filter((event) => event.kind === "recall_injected");
  const capture = events.filter((event) => event.kind === "capture_outcome");
  // recall usefulness: of the briefs that actually surfaced fix content, how many were
  // followed by a fix landing on one of those files (captureService.recordRecallUsefulness)?
  const recallWithFixes = recall.filter((event) => (event.payload.injectedFilesChanged || []).length > 0);
  const recallUseful = events.filter((event) => event.kind === "recall_useful");

  const tokens = recall.map((event) => Number(event.payload.usedTokens || 0)).sort((left, right) => left - right);
  const totalTokens = tokens.reduce((sum, value) => sum + value, 0);

  const captureByReason = {};
  for (const event of capture) {
    const reason = event.payload.reason || "unknown";
    captureByReason[reason] = (captureByReason[reason] || 0) + 1;
  }

  return {
    projectPath,
    recallCount: recall.length,
    avgTokens: tokens.length ? Math.round(totalTokens / tokens.length) : 0,
    tokensP50: percentile(tokens, 50),
    tokensP95: percentile(tokens, 95),
    captureTotal: capture.length,
    captureByReason,
    records: storage.countRecords(projectPath),
    supersededFixes: storage.countSupersededFixes(projectPath),
    recallInjectedWithFixes: recallWithFixes.length,
    recallUsefulCount: recallUseful.length,
    recallUsefulRatePct: recallWithFixes.length
      ? Math.round((recallUseful.length / recallWithFixes.length) * 100)
      : 0,
  };
}
