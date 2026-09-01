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
    // instrument-or-delete counters (2026-07 audit): zero after the clock runs out = delete
    searchUsedCount: events.filter((event) => event.kind === "search_used").length,
    // goals_viewed is recorded machine-wide (the goals portfolio spans projects — commands.js),
    // so it must be read from the "machine" bucket. Counting it off the per-project `events`
    // above yields a structural 0 that would misreport the goals layer as unused (audit III).
    goalsViewedCount: storage.listMetrics("machine", { kind: "goals_viewed", since }).length,
    tasksGroomedCount: events.filter((event) => event.kind === "task_groomed").length,
    // audit-III counters for the previously-unmeasured PRs (#29/#32/#35): make the shipped
    // guards legible so the Aug-17 judgment isn't blind to whether they ever fired.
    dispatchHoldCount: events.filter((event) => event.kind === "dispatch_hold").length,
    completionClampedCount: events.filter((event) => event.kind === "completion_clamped").length,
    goalRetiredCount: events.filter((event) => event.kind === "goal_retired").length,
    // the cap-size test's readout (value audit II Phase 2): cost of the brief per citation
    recallCitedCount: events.filter((event) => event.kind === "recall_cited").length,
    ...(() => {
      const cited = events.filter((event) => event.kind === "recall_cited");
      // Attribution-corrected denominator (injection audit Aug 28): distinct (session, id)
      // pairs, excluding citations that resolve to no record. Pre-fix events carry neither
      // sessionId nor resolved, so they pass through and the number stays comparable across
      // the transition. brief-sourced-only cost is the honest per-rail readout; the blended
      // legacy figure stays for continuity with earlier audits.
      const distinct = new Set();
      let briefSourced = 0;
      for (const event of cited) {
        if (event.payload.resolved === false) continue;
        distinct.add(`${event.payload.sessionId || event.id}${event.payload.idPrefix}`);
        if (!event.payload.source || event.payload.source === "brief") briefSourced += 1;
      }
      return {
        // memory_get pulls: the stub-index brief's direct usage signal, alongside citations
        recallPulledCount: events.filter((event) => event.kind === "recall_pulled").length,
        recallCitedDistinct: distinct.size,
        tokensPerCitedRecall: cited.length ? Math.round(totalTokens / cited.length) : null,
        tokensPerDistinctCitation: distinct.size ? Math.round(totalTokens / distinct.size) : null,
        recallCitedBriefSourced: briefSourced,
      };
    })(),
  };
}
