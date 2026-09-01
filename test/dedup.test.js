import test from "node:test";
import assert from "node:assert/strict";
import { isNearDuplicate } from "../src/capturePolicy.js";

const recent = [
  { id: "1", signature: "fixed close fill reconciliation in reconcile module", verification: null, qualityStatus: "unverified" },
  { id: "2", signature: "added retry to broker websocket", verification: "npm test", qualityStatus: "verified" },
];

test("flags a reworded near-duplicate and reports the existing id", () => {
  const hit = isNearDuplicate(
    { signature: "fixed the close-fill reconciliation inside reconcile module", verification: "npm test" },
    recent, { threshold: 0.6 },
  );
  assert.equal(hit.duplicate, true);
  assert.equal(hit.existingId, "1");
  assert.equal(hit.existingVerified, false);
});

test("returns null for a distinct candidate", () => {
  assert.equal(
    isNearDuplicate({ signature: "rewrote the dashboard layout grid" }, recent, { threshold: 0.6 }),
    null,
  );
});

test("catches the same question re-asked, even when the finding is freshly worded", () => {
  // Verbatim from the live DB: this question was stored four times in 25 minutes. Combined
  // question+finding similarity measured 0.20-0.39 against the first row -- nowhere near the
  // 0.82 gate -- because each retelling wrote a different finding body.
  const first = {
    id: "z1",
    key: "Can copyrighted orchestral film-score recordings be bundled in an app?",
    signature: "Can copyrighted orchestral film-score recordings be bundled in an app? No. Sync and master rights are required and the rights holder does not license them for consumer apps.",
    qualityStatus: "unverified",
  };
  for (const question of [
    "Can copyrighted orchestral film-score recordings be bundled in an App Store app?",
    "Can copyrighted orchestral film-score recordings be bundled in an App Store iOS app?",
    "Can copyrighted orchestral film-score recordings be bundled in an iOS app?",
  ]) {
    const hit = isNearDuplicate(
      { signature: `${question} Bundling them would need both a sync licence and a master-use licence, neither of which is offered.`, key: question },
      [first],
    );
    assert.equal(hit?.duplicate, true, question);
    assert.equal(hit.existingId, "z1");
    assert.equal(hit.matchedOn, "key"); // the body did NOT match; the question did
  }
});

test("does not merge template questions that differ only by subject", () => {
  // Also from the live DB: a trading project asks the same shape about each strategy. These are four
  // distinct answers and must stay four records. Containment separates them from a rewording --
  // each side holds a token the other lacks, so it lands at 0.83, under the 0.95 bar.
  const gapfade = {
    id: "s1",
    key: "Does gapfade_pre strategy pass vetting gates?",
    signature: "Does gapfade_pre strategy pass vetting gates? Yes on the entry-offset sweep.",
    qualityStatus: "unverified",
  };
  const meanrev = "Does meanrev strategy pass vetting gates?";
  assert.equal(isNearDuplicate({ signature: `${meanrev} No, it fails the phase-robustness check.`, key: meanrev }, [gapfade]), null);
});

test("keeps recurring reports apart when only a short number differs", () => {
  // Scheduled tasks emit one report per run, and the date is the only thing that changes.
  // The body tokenizer drops runs under three characters, so "07-09" and "07-10" both vanish
  // and every day's report reads as the same question -- headline tokens keep digits for this.
  // 07-07 first on purpose: split into parts a Set eats the repeated "07", leaving a strict
  // subset of every other date, so one self-repeating date swallowed all thirteen.
  const day7 = { id: "p7", key: "Market pulse 2026-07-07: what's moving and what's on deck?", signature: "Market pulse 2026-07-07: what's moving and what's on deck? Rates led, semis lagged." };
  for (const later of ["Market pulse 2026-07-09: what's moving and what's on deck?", "Market pulse 2026-07-10: what's moving and what's on deck?"]) {
    assert.equal(isNearDuplicate({ signature: `${later} Energy led, banks lagged.`, key: later }, [day7]), null, later);
  }
  // Same shape, sequence number instead of a date.
  const d7 = { id: "c7", key: "canary-broker Day-7 SIMULATE live test: GO or NO-GO?", signature: "canary-broker Day-7 SIMULATE live test: GO or NO-GO? GO, 9/9 checks passed." };
  const d8 = "canary-broker Day-8 SIMULATE live test: GO or NO-GO?";
  assert.equal(isNearDuplicate({ signature: `${d8} NO-GO, premarket check 4 failed.`, key: d8 }, [d7]), null);
  // But a pure rewording with no distinguishing number is still caught.
  const bare = "Market pulse: what's moving and what's on deck today?";
  assert.equal(isNearDuplicate({ signature: `${bare} Rates led.`, key: bare }, [{ id: "p0", key: "Market pulse: what's moving and what's on deck?", signature: "Market pulse: what's moving and what's on deck? Rates led." }])?.duplicate, true);
});

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCortex } from "../src/index.js";
import { findDecisionDuplicate } from "../src/captureService.js";

// Live-DB measurement (2026-08-03): 133 of 630 live decisions were restatements of another —
// almost all same-session, reworded past the 0.7 full-text gate (the "restatement" pair below
// measures 0.40). The choice sentence is the stable anchor: dupe pairs measure 0.7-1.0 headline
// containment (94% at >=0.8) while random same-project pairs sit at 0.0-0.3 (2 of 747 above 0.7).
const NOISE_SCENE = {
  id: "d1",
  decision: "Reused existing `noise` visual scene instead of adding a new `focus` scene.",
  rationale: "The noise scene particle drift already reads as ambient focus; a new enum would duplicate rendering paths.",
};

test("a reworded same-subject decision is a revision of the prior, not a new record", () => {
  const hit = findDecisionDuplicate(
    {
      decision: "Reused existing `noise` scene for the Focus category instead of adding a new `focus` scene enum.",
      rationale: "Keeps the scene switch exhaustive without another render branch to maintain.",
    },
    [NOISE_SCENE],
  );
  assert.equal(hit.revision, true);
  assert.equal(hit.duplicate, undefined);
  assert.equal(hit.existingId, "d1");
});

test("a reversal on the same subject is a revision — the newer decision supersedes the stance it flips", () => {
  // "A over B" -> "B over A" shares every headline token, so token measures cannot see the flip.
  // That is fine: for both a restatement and a reversal the correct outcome is the same — the
  // newest decision is current and the prior moves to history via the supersede chain.
  const hit = findDecisionDuplicate(
    {
      decision: "API-key cloud signing over manual App Store signing + GUI-session archive.",
      rationale: "Xcode 26.1 fixed headless provisioning; cloud auth now completes without a GUI session.",
    },
    [{
      id: "sign1",
      decision: "Manual App Store signing + GUI-session archive over API-key cloud signing.",
      rationale: "Xcode 26 headless cloud auth is broken; manually-installed signing works.",
    }],
  );
  assert.equal(hit.revision, true);
  assert.equal(hit.existingId, "sign1");
});

test("decisions on different subjects stay independent", () => {
  assert.equal(
    findDecisionDuplicate(
      {
        decision: "Formspree as waitlist backend with mailto fallback.",
        rationale: "Silent quota exhaustion on the free tier is worse than a visible mailto fallback.",
      },
      [NOISE_SCENE],
    ),
    null,
  );
});

test("a full-text restatement is still a duplicate, which outranks revision", () => {
  const hit = findDecisionDuplicate(
    {
      decision: "Reuse existing noise scene for the Focus category instead of adding a new focus scene enum.",
      rationale: "Avoids a duplicate rendering path for a single visual variant.",
    },
    [{
      id: "d2",
      decision: "Reuse existing noise scene for Focus category instead of adding new focus scene enum.",
      rationale: "Avoids a duplicate rendering path for one visual variant.",
    }],
  );
  assert.equal(hit.duplicate, true);
  assert.equal(hit.existingId, "d2");
});

async function withHub(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cortex-dedup-"));
  const hub = createCortex({ dbPath: join(dir, "d.sqlite") });
  try { await fn(hub, dir); } finally { hub.close(); await rm(dir, { recursive: true, force: true }); }
}

test("a reworded fix on the same file is discarded as a near-duplicate and can merge up verification", async () => {
  await withHub(async (hub, dir) => {
    const first = hub.captureCandidate({
      projectPath: dir, agent: "claude-code",
      message: "Implemented deterministic context ranking for the brief builder. Files changed: src/contextRanking.js. Commit: abc1234.",
    });
    assert.equal(first.reason, "accepted_fix");
    const second = hub.captureCandidate({
      projectPath: dir, agent: "claude-code",
      message: "Implemented deterministic context ranking for the brief builder now. Files changed: src/contextRanking.js. Verification: npm test passed.",
    });
    assert.equal(second.reason, "discarded_near_duplicate");
    assert.equal(second.recordId, first.recordId);
    assert.equal(hub.storage.listFixes(dir).length, 1);
    assert.equal(hub.storage.getFix(first.recordId).qualityStatus, "verified");
  });
});

test("a captured revision supersedes the prior decision and replaces it in the live list", async () => {
  await withHub(async (hub, dir) => {
    const first = hub.captureCandidate({
      projectPath: dir, agent: "claude-code",
      message: "Decision: Reused existing `noise` visual scene instead of adding a new `focus` scene. Rationale: The noise scene particle drift already reads as ambient focus; a new enum would duplicate rendering paths.",
    });
    assert.equal(first.reason, "accepted_decision");
    const second = hub.captureCandidate({
      projectPath: dir, agent: "claude-code",
      message: "Decision: Reused existing `noise` scene for the Focus category instead of adding a new `focus` scene enum. Rationale: Keeps the scene switch exhaustive without another render branch to maintain.",
    });
    assert.equal(second.reason, "accepted_decision_revision");
    assert.equal(hub.storage.getDecision(second.recordId).supersedesId, first.recordId);
    const live = hub.storage.listDecisions(dir, { limit: 10, excludeSuperseded: true });
    assert.deepEqual(live.map((d) => d.id), [second.recordId]);
  });
});

test("distinct decisions in the same project both stay live", async () => {
  await withHub(async (hub, dir) => {
    const scene = hub.captureCandidate({
      projectPath: dir, agent: "claude-code",
      message: "Decision: Reused existing `noise` visual scene instead of adding a new `focus` scene. Rationale: The noise scene particle drift already reads as ambient focus.",
    });
    const waitlist = hub.captureCandidate({
      projectPath: dir, agent: "claude-code",
      message: "Decision: Formspree as waitlist backend with mailto fallback. Rationale: Silent quota exhaustion on the free tier is worse than a visible mailto fallback.",
    });
    assert.equal(scene.reason, "accepted_decision");
    assert.equal(waitlist.reason, "accepted_decision");
    assert.equal(hub.storage.listDecisions(dir, { limit: 10, excludeSuperseded: true }).length, 2);
  });
});

test("Supersedes: [m:xxxxxx] marker links a reversal that similarity detection would miss", async () => {
  await withHub(async (hub, dir) => {
    const first = hub.captureCandidate({
      projectPath: dir, agent: "claude-code",
      message: "Decision: Formspree as waitlist backend with mailto fallback. Rationale: Silent quota exhaustion on the free tier is worse than a visible mailto fallback.",
    });
    assert.equal(first.reason, "accepted_decision");
    const prefix = first.recordId.replace(/-/g, "").slice(0, 6);
    // reads nothing like the original — the text-similarity revision path cannot fire here
    const reversal = hub.captureCandidate({
      projectPath: dir, agent: "claude-code",
      message: `Decision: Self-host the waitlist on our own /api/waitlist endpoint. Supersedes: [m:${prefix}]. Rationale: We now run a server anyway, and owning the data beats a third-party quota.`,
    });
    assert.equal(reversal.reason, "accepted_decision_revision");
    assert.equal(hub.storage.getDecision(reversal.recordId).supersedesId, first.recordId);
    const live = hub.storage.listDecisions(dir, { limit: 10, excludeSuperseded: true });
    assert.deepEqual(live.map((d) => d.id), [reversal.recordId]);
  });
});

test("a Supersedes marker with an unknown or short prefix is ignored, capture still succeeds", async () => {
  await withHub(async (hub, dir) => {
    const result = hub.captureCandidate({
      projectPath: dir, agent: "claude-code",
      message: "Decision: Ship the beta behind a flag. Supersedes: [m:zzzz]. Rationale: Flag lets us roll back without a deploy.",
    });
    assert.equal(result.reason, "accepted_decision");
    assert.equal(hub.storage.getDecision(result.recordId).supersedesId, null);
  });
});

test("dedupeDecisions chains legacy restatement clusters so one member stays live", async () => {
  // Rows inserted directly, bypassing the capture gate — this is what the store looks like for
  // decisions captured before the revision gate existed.
  await withHub(async (hub, dir) => {
    const insert = (id, decision, rationale) => hub.storage.insertDecision({
      id, projectPath: dir, agent: "claude-code", decision, rationale,
    });
    insert("00000000-0000-4000-8000-000000000001",
      "Reused existing `noise` visual scene instead of adding a new `focus` scene.",
      "The noise scene particle drift already reads as ambient focus.");
    insert("00000000-0000-4000-8000-000000000002",
      "Reused existing `noise` scene for the Focus category instead of adding a new `focus` scene enum.",
      "Keeps the scene switch exhaustive without another render branch to maintain.");
    insert("00000000-0000-4000-8000-000000000003",
      "Reuse existing `noise` scene for Focus instead of a new `focus` scene enum.",
      "Avoids a duplicate rendering path for a single visual variant.");
    insert("00000000-0000-4000-8000-000000000004",
      "Formspree as waitlist backend with mailto fallback.",
      "Silent quota exhaustion on the free tier is worse than a visible mailto fallback.");

    const dryRun = hub.dedupeDecisions({ projectPath: dir });
    assert.equal(dryRun.applied, false);
    assert.equal(dryRun.clusters, 1);
    assert.equal(dryRun.redundant, 2);
    // dry run wrote nothing
    assert.equal(hub.storage.listDecisions(dir, { limit: 10, excludeSuperseded: true }).length, 4);

    const applied = hub.dedupeDecisions({ projectPath: dir, apply: true });
    assert.equal(applied.applied, true);
    assert.equal(applied.linked, 2);
    const live = hub.storage.listDecisions(dir, { limit: 10, excludeSuperseded: true });
    assert.equal(live.length, 2);
    assert.ok(live.some((d) => d.decision.startsWith("Formspree")), "distinct decision must stay live");
    // re-running finds nothing left to do
    const again = hub.dedupeDecisions({ projectPath: dir, apply: true });
    assert.equal(again.redundant, 0);
  });
});

test("two distinct fixes with near-identical wording stay distinct when they touch different files", async () => {
  // entity-anchored dedup: raw token overlap can't separate "login form" from "signup form"
  // (a one-word swap between genuinely different bugs), but the changed-file anchor can —
  // no shared file means no duplicate, at any text similarity.
  await withHub(async (hub, dir) => {
    const login = hub.captureCandidate({ projectPath: dir, agent: "a", message: "Fixed validation on the login form submit handler. Files changed: src/login.js. Verification: npm test passed." });
    const signup = hub.captureCandidate({ projectPath: dir, agent: "a", message: "Fixed validation on the signup form submit handler. Files changed: src/signup.js. Verification: npm test passed." });
    assert.equal(login.reason, "accepted_fix");
    assert.equal(signup.reason, "accepted_fix");
    assert.notEqual(login.recordId, signup.recordId);
  });
});
