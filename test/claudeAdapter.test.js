import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createCortex,
  createClaudeHookContext,
  flushClaudeStop,
  installClaudeAdapter,
} from "../src/index.js";

// no server reachable in tests -> deterministic fallback to direct DB write
const offlineClient = { capture: async () => { throw new Error("server unreachable"); } };
// the server WAS reached and rejected the write (e.g. policy/validation) — mirrors what
// writeClient.js's post() throws for a real non-2xx response (see test/writeClient.test.js).
const rejectingClient = { capture: async () => {
  const error = new Error("message is required");
  error.isHttpRejection = true;
  error.status = 400;
  throw error;
} };

async function withProject(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cortex-claude-"));
  const dbPath = join(dir, "cortex.sqlite");
  const hub = createCortex({ dbPath });
  // recall/flush are scoped to registered projects — unregistered dirs get a stub and no capture
  hub.upsertProjectProfile({ projectPath: dir, name: "Test Project", mode: "general", summary: "" });

  try {
    await fn({ dir, dbPath, hub });
  } finally {
    hub.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("installs Claude Code local hooks for session start, prompt recall, and stop flush", async () => {
  await withProject(async ({ dir }) => {
    const settingsPath = await installClaudeAdapter({
      projectPath: dir,
      cortexBin: "node C:\\work\\cortex\\src\\cli.js",
      dbPath: join(dir, ".cortex", "cortex.sqlite"),
    });
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));

    assert.equal(settingsPath, join(dir, ".claude", "settings.local.json"));
    assert.equal(settings.hooks.SessionStart[0].hooks[0].type, "command");
    assert.match(settings.hooks.SessionStart[0].hooks[0].command, /claude recall/);
    assert.match(settings.hooks.SessionStart[0].hooks[0].command, /--db/);
    assert.doesNotMatch(settings.hooks.SessionStart[0].hooks[0].command, /CORTEX_DB=/);
    assert.match(settings.hooks.UserPromptSubmit[0].hooks[0].command, /claude recall/);
    assert.match(settings.hooks.Stop[0].hooks[0].command, /claude flush/);
    assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].timeout, 10);
  });
});

test("builds Claude additional context from the compact project brief", async () => {
  await withProject(async ({ dir, hub }) => {
    hub.upsertProjectProfile({
      projectPath: dir,
      name: "Alpha Project",
      mode: "paper-trading ops",
      summary: "Audit logs before editing live trading behavior.",
      standardCommands: ["python scripts/eod_audit.py YYYY-MM-DD"],
      risks: ["Running orchestrator state can lag file edits."],
    });
    hub.addTask({ type: "chore",
      projectPath: dir,
      title: "Check live orchestrator status",
      priority: "high",
      verificationCommand: "curl /api/orchestrator/status",
    });

    const output = await createClaudeHookContext(hub, {
      hook_event_name: "UserPromptSubmit",
      cwd: dir,
      branch: "check-orchestrator-logs",
      prompt: "check logs see what happened",
    });

    assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(output.hookSpecificOutput.additionalContext, /Cortex context/);
    assert.match(output.hookSpecificOutput.additionalContext, /paper-trading ops/);
    assert.match(output.hookSpecificOutput.additionalContext, /Check live orchestrator status/);
  });
});

test("routes Claude stop messages through durable capture policy", async () => {
  await withProject(async ({ dir, hub }) => {
    const discarded = await flushClaudeStop(hub, {
      hook_event_name: "Stop",
      cwd: dir,
      last_assistant_message: "Can you approve the permission dialog?",
    }, { client: offlineClient });
    const accepted = await flushClaudeStop(hub, {
      hook_event_name: "Stop",
      cwd: dir,
      last_assistant_message: "Fixed backup restore wording. Verification: npm run release:check passed",
    }, { client: offlineClient });
    const duplicate = await flushClaudeStop(hub, {
      hook_event_name: "Stop",
      cwd: dir,
      last_assistant_message: "Fixed backup restore wording. Verification: npm run release:check passed",
    }, { client: offlineClient });
    const brief = hub.buildBrief({ projectPath: dir, context: { goalText: "backup restore wording" } });

    assert.equal(discarded.reason, "discarded_low_signal");
    assert.equal(accepted.reason, "accepted_fix");
    assert.equal(duplicate.reason, "discarded_duplicate");
    assert.match(brief.text, /Fixed backup restore wording/);
  });
});

test("a real HTTP rejection does not fall back to a direct DB write (no double-processing)", async () => {
  await withProject(async ({ dir, hub }) => {
    const result = await flushClaudeStop(hub, {
      hook_event_name: "Stop",
      cwd: dir,
      last_assistant_message: "Fixed the retry bug. Verification: npm test passed",
    }, { client: rejectingClient });

    assert.equal(result.action, "rejected");
    assert.equal(result.reason, "server_rejected");
    assert.match(result.message, /message is required/);
    // must NOT have been silently re-submitted through the direct-DB fallback path
    assert.equal(hub.storage.listFixes(dir).length, 0);
  });
});

test("flush reads the last assistant turn from transcript_path when message is absent", async () => {
  await withProject(async ({ dir, hub }) => {
    const transcript = join(dir, "transcript.jsonl");
    await writeFile(transcript, [
      JSON.stringify({ type: "user", message: { content: "fix the thing" } }),
      JSON.stringify({ type: "assistant", message: { content: [
        { type: "text", text: "Fixed the cache eviction bug. Verification: npm test passed" },
      ] } }),
    ].join("\n"));

    const accepted = await flushClaudeStop(hub, {
      hook_event_name: "Stop",
      cwd: dir,
      transcript_path: transcript,
    }, { client: offlineClient });

    assert.equal(accepted.reason, "accepted_fix");
    assert.match(hub.buildBrief({ projectPath: dir, context: { goalText: "cache eviction bug" } }).text, /cache eviction bug/);
  });
});

test("flush reads the last assistant turn from transcript_path for Antigravity transcript format", async () => {
  await withProject(async ({ dir, hub }) => {
    const transcript = join(dir, "transcript_antigravity.jsonl");
    await writeFile(transcript, [
      JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "fix the thing" }),
      JSON.stringify({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", content: "Fixed the cache eviction bug. Verification: npm test passed" }),
    ].join("\n"));

    const accepted = await flushClaudeStop(hub, {
      hook_event_name: "Stop",
      cwd: dir,
      transcript_path: transcript,
    }, { client: offlineClient });

    assert.equal(accepted.reason, "accepted_fix");
    assert.match(hub.buildBrief({ projectPath: dir, context: { goalText: "cache eviction bug" } }).text, /cache eviction bug/);
  });
});

test("flush routes the capture through the write client when the server is reachable", async () => {
  await withProject(async ({ dir, hub }) => {
    const calls = [];
    const client = { capture: async (body) => { calls.push(body); return { action: "accepted", reason: "accepted_fix", recordType: "fix", recordId: "via-http" }; } };

    const result = await flushClaudeStop(hub, {
      hook_event_name: "Stop",
      cwd: dir,
      last_assistant_message: "Fixed backup restore wording. Verification: npm run release:check passed",
    }, { client });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].projectPath, dir);
    assert.equal(calls[0].agent, "claude-code");
    assert.equal(result.recordId, "via-http");
    // the client handled the write -> no direct-DB fix record for this candidate
    assert.equal(hub.storage.listFixes(dir).length, 0);
  });
});

test("flush falls back to a direct DB write when the write client throws", async () => {
  await withProject(async ({ dir, hub }) => {
    const result = await flushClaudeStop(hub, {
      hook_event_name: "Stop",
      cwd: dir,
      last_assistant_message: "Fixed backup restore wording. Verification: npm run release:check passed",
    }, { client: offlineClient });

    assert.equal(result.reason, "accepted_fix");
    assert.equal(hub.storage.listFixes(dir).length, 1);
  });
});

test("SessionStart recall sweeps expired records; per-prompt recall does not", async () => {
  await withProject(async ({ dir, hub }) => {
    const past = new Date(Date.now() - 86400000).toISOString();
    hub.storage.insertSessionEvent({
      id: "evt-old", projectPath: dir, agent: "a", source: "s",
      summary: "stale", expiresAt: past,
    });

    await createClaudeHookContext(hub, { hook_event_name: "UserPromptSubmit", cwd: dir });
    assert.equal(hub.storage.listSessionEvents(dir).length, 1, "prompt recall must not sweep");

    await createClaudeHookContext(hub, { hook_event_name: "SessionStart", cwd: dir });
    assert.equal(hub.storage.listSessionEvents(dir).length, 0, "session start should sweep");
  });
});

test("SessionStart opens an agent session and Stop closes it", async () => {
  await withProject(async ({ dir, hub }) => {
    await createClaudeHookContext(hub, {
      hook_event_name: "SessionStart", cwd: dir, session_id: "sess-1", branch: "feat/x",
    });
    let active = hub.storage.listActiveSessions(dir);
    assert.equal(active.length, 1);
    assert.equal(active[0].id, "sess-1");
    assert.match(hub.buildBrief({ projectPath: dir, context: { branch: "feat/x" } }).text, /Active Agent Sessions[\s\S]*claude-code/);

    // Re-fired SessionStart must not create a duplicate or throw.
    await createClaudeHookContext(hub, { hook_event_name: "SessionStart", cwd: dir, session_id: "sess-1" });
    assert.equal(hub.storage.listActiveSessions(dir).length, 1);

    await flushClaudeStop(hub, { hook_event_name: "Stop", cwd: dir, session_id: "sess-1", last_assistant_message: "done" }, { client: offlineClient });
    assert.equal(hub.storage.listActiveSessions(dir).length, 0);
  });
});

test("sweep reaps active sessions past the TTL (crashed agents)", async () => {
  await withProject(async ({ dir, hub }) => {
    hub.storage.insertSession({
      id: "zombie", projectPath: dir, agent: "claude-code", source: "claude-session-hook",
      goal: "active session", dirtyFiles: [], status: "active",
    });
    hub.storage.db.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 13 * 3600000).toISOString(), "zombie");
    assert.equal(hub.storage.sweepStaleSessions(new Date(), 12), 1);
    assert.equal(hub.storage.listActiveSessions(dir).length, 0);
  });
});

test("recall_injected lists only records the brief rendered, so a budget-cut record is not marked served", async () => {
  await withProject(async ({ dir, hub }) => {
    for (let i = 0; i < 12; i += 1) {
      hub.addFixEntry({ projectPath: dir, agent: "claude-code", summary: `Close fill reconciliation pass ${i} repaired the watcher retry path for venue ${i}`, filesChanged: [`src/venue${i}.js`], verification: "npm test passed" });
    }
    // Sweep the budget from "no room for any fix" to "room for all": at every step the metric
    // must list exactly the fixes whose marker is in the brief, and the count must grow through
    // partial serves rather than jump from none to all.
    const servedCounts = [];
    for (let budget = 200; budget <= 700; budget += 25) {
      const sessionId = `sess-${budget}`;
      hub.storage.setSetting("brief.maxTokens", budget);
      // the first prompt of an open session becomes its goal, which is what un-gates memory
      await createClaudeHookContext(hub, { hook_event_name: "SessionStart", cwd: dir, session_id: sessionId });
      const result = await createClaudeHookContext(hub, { hook_event_name: "UserPromptSubmit", cwd: dir, session_id: sessionId, prompt: "repair the close fill watcher retry path" });
      const text = result.hookSpecificOutput.additionalContext;
      const event = hub.storage.listMetrics(dir, { kind: "recall_injected", limit: 100 })
        .find((m) => m.payload.sessionId === sessionId && m.payload.eventName === "UserPromptSubmit");
      const ids = event.payload.injectedFixIds;
      const rendered = hub.storage.listFixes(dir, { limit: 50 }).filter((f) => text.includes(`[m:${f.id.replace(/-/g, "").slice(0, 6)}]`)).map((f) => f.id);
      assert.deepEqual([...ids].sort(), rendered.sort(), `budget ${budget}: recorded ids must be the rendered ones`);
      assert.equal(event.payload.servedAgeDays.length, ids.length);
      assert.deepEqual(event.payload.injectedFixes.map((f) => f.id), ids);
      // and the report counts what was seen
      assert.equal(hub.recallEconomics({}).sessions.find((s) => s.sessionId === sessionId).servedRecords, ids.length);
      servedCounts.push(ids.length);
    }
    const most = Math.max(...servedCounts);
    assert.equal(servedCounts[0], 0, "the tightest budget renders no fix, and records none");
    assert.ok(most > 1 && servedCounts.some((n) => n > 0 && n < most), `expected a partial serve in ${servedCounts.join(",")}`);
  });
});

test("recall records a recall_injected metric with token usage and agent", async () => {
  await withProject(async ({ dir, hub }) => {
    await createClaudeHookContext(hub, { cwd: dir });
    const events = hub.storage.listMetrics(dir, { kind: "recall_injected" });
    assert.equal(events.length, 1);
    assert.equal(typeof events[0].payload.usedTokens, "number");
    assert.equal(typeof events[0].payload.maxTokens, "number");
    assert.equal(events[0].payload.agent, "claude-code");
  });
});

test("recall_injected attributes agent_type for non-Claude adapters (e.g. codex)", async () => {
  await withProject(async ({ dir, hub }) => {
    await createClaudeHookContext(hub, { cwd: dir, agent_type: "codex" });
    const events = hub.storage.listMetrics(dir, { kind: "recall_injected" });
    assert.equal(events[0].payload.agent, "codex");
  });
});

test("recall_useful fires when a fix lands on a file the last recall injected", async () => {
  await withProject(async ({ dir, hub }) => {
    hub.storage.insertFix({ id: "seed", projectPath: dir, agent: "a", summary: "seed fix for retry logic", filesChanged: ["retry.js"], verification: "npm test passed" });

    // this recall injects the seed fix (retry.js) into the brief
    await createClaudeHookContext(hub, { cwd: dir, branch: "retry-hardening" });
    const injected = hub.storage.listMetrics(dir, { kind: "recall_injected" })[0];
    assert.ok(injected.payload.injectedFilesChanged.includes("retry.js"));

    // agent then lands a fix on that same file
    const outcome = hub.captureCandidate({ projectPath: dir, agent: "claude-code", message: "Fixed retry race. Files changed: retry.js. Verification: npm test passed" });
    assert.equal(outcome.reason, "accepted_fix");

    const useful = hub.storage.listMetrics(dir, { kind: "recall_useful" });
    assert.equal(useful.length, 1);
    assert.deepEqual(useful[0].payload.matchedFiles, ["retry.js"]);
    assert.equal(useful[0].payload.fixId, outcome.recordId);
    assert.equal(useful[0].payload.agent, "claude-code");
  });
});

test("recall_useful does not fire when the new fix touches unrelated files", async () => {
  await withProject(async ({ dir, hub }) => {
    hub.storage.insertFix({ id: "seed", projectPath: dir, agent: "a", summary: "seed fix for retry logic", filesChanged: ["retry.js"], verification: "npm test passed" });
    await createClaudeHookContext(hub, { cwd: dir });

    hub.captureCandidate({ projectPath: dir, agent: "claude-code", message: "Fixed unrelated parser bug. Files changed: parser.js. Verification: npm test passed" });

    assert.equal(hub.storage.listMetrics(dir, { kind: "recall_useful" }).length, 0);
  });
});

test("recall_useful stays quiet when the matched file spans several injected records (hot file)", async () => {
  await withProject(async ({ dir, hub }) => {
    // three unrelated recalled fixes all touched the same hot file — a new fix landing
    // there says nothing about which recall (if any) was actually used
    hub.storage.insertFix({ id: "seed-a", projectPath: dir, agent: "a", summary: "hardened request routing paths", filesChanged: ["server.js"], verification: "npm test passed" });
    hub.storage.insertFix({ id: "seed-b", projectPath: dir, agent: "a", summary: "tightened settings allowlist checks", filesChanged: ["server.js"], verification: "npm test passed" });
    hub.storage.insertFix({ id: "seed-c", projectPath: dir, agent: "a", summary: "cleaned response encoding defaults", filesChanged: ["server.js"], verification: "npm test passed" });
    await createClaudeHookContext(hub, { cwd: dir, branch: "server-hotfile" });
    const injected = hub.storage.listMetrics(dir, { kind: "recall_injected" })[0];
    assert.ok(injected.payload.injectedFilesChanged.includes("server.js"));

    hub.captureCandidate({ projectPath: dir, agent: "claude-code", message: "Fixed the port binding bug. Files changed: server.js. Verification: npm test passed" });
    assert.equal(hub.storage.listMetrics(dir, { kind: "recall_useful" }).length, 0);
  });
});

test("recall_useful legacy payloads (no per-record data) fall back to the narrow-file rule", async () => {
  await withProject(async ({ dir, hub }) => {
    // pre-upgrade recall_injected payload: flat union only
    hub.storage.recordMetric("recall_injected", dir, { agent: "claude-code", injectedFilesChanged: ["a.js", "b.js", "c.js"] });

    // broad overlap (3 matched files) is not a signal
    hub.captureCandidate({ projectPath: dir, agent: "claude-code", message: "Fixed startup order. Files changed: a.js, b.js, c.js. Verification: npm test passed" });
    assert.equal(hub.storage.listMetrics(dir, { kind: "recall_useful" }).length, 0);

    // a narrow overlap still counts
    hub.captureCandidate({ projectPath: dir, agent: "claude-code", message: "Fixed teardown leak. Files changed: a.js. Verification: npm test passed" });
    assert.equal(hub.storage.listMetrics(dir, { kind: "recall_useful" }).length, 1);
  });
});

test("first real prompt replaces the placeholder session goal, later prompts don't", async () => {
  await withProject(async ({ dir, hub }) => {
    await createClaudeHookContext(hub, {
      hook_event_name: "SessionStart", cwd: dir, session_id: "sg-1",
    });
    assert.equal(hub.storage.getSession("sg-1").goal, "active session");

    await createClaudeHookContext(hub, {
      hook_event_name: "UserPromptSubmit", cwd: dir, session_id: "sg-1",
      prompt: "Fix the paywall gating bug in Sifter",
    });
    assert.equal(hub.storage.getSession("sg-1").goal, "Fix the paywall gating bug in Sifter");

    await createClaudeHookContext(hub, {
      hook_event_name: "UserPromptSubmit", cwd: dir, session_id: "sg-1",
      prompt: "now run the tests",
    });
    assert.equal(hub.storage.getSession("sg-1").goal, "Fix the paywall gating bug in Sifter", "first prompt wins");
  });
});

test("a still-placeholder session goal does not gate the brief on a branch-less prompt hook", async () => {
  await withProject(async ({ dir, hub }) => {
    // a verified fix whose text shares no token with the placeholder "work on master"
    hub.captureCandidate({ projectPath: dir, agent: "claude-code",
      message: "Fixed the paywall subscription gate. Files changed: src/paywall.js. Verification: npm test passed." });
    // SessionStart on a branch left the placeholder goal "work on master" (never enriched)
    hub.storage.insertSession({ id: "sess-gate", projectPath: dir, agent: "claude-code",
      source: "claude-session-hook", goal: "work on master", branch: "master", dirtyFiles: [], status: "active" });
    // a later prompt hook WITHOUT a branch must still recognize the placeholder via the stored
    // session branch — its lone term "work" must NOT leak into goalText. Since audit V a truly
    // signal-less session gets the deliberate minimal brief (memory withheld + pull hint), not
    // a gated-empty full brief and not placeholder-term-filtered records.
    const out = await createClaudeHookContext(hub, {
      hook_event_name: "UserPromptSubmit", cwd: dir, session_id: "sess-gate",
    });
    assert.match(out.hookSpecificOutput.additionalContext, /memory withheld/);
    assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /paywall subscription/);
  });
});

test("a long first prompt is truncated to ~140 chars for the goal", async () => {
  await withProject(async ({ dir, hub }) => {
    await createClaudeHookContext(hub, {
      hook_event_name: "SessionStart", cwd: dir, session_id: "sg-3",
    });

    const longPrompt = "Investigate and fix the recurring flaky test failure in the checkout integration suite that only reproduces under CI load with concurrent workers enabled";
    await createClaudeHookContext(hub, {
      hook_event_name: "UserPromptSubmit", cwd: dir, session_id: "sg-3", prompt: longPrompt,
    });

    const goal = hub.storage.getSession("sg-3").goal;
    assert.ok(goal.length <= 140, `expected goal length <= 140, got ${goal.length}`);
    assert.notEqual(goal, "active session");
  });
});

test("a legitimate 'work on ...' first prompt is not mistaken for a placeholder later", async () => {
  await withProject(async ({ dir, hub }) => {
    await createClaudeHookContext(hub, {
      hook_event_name: "SessionStart", cwd: dir, session_id: "sg-4",
    });

    await createClaudeHookContext(hub, {
      hook_event_name: "UserPromptSubmit", cwd: dir, session_id: "sg-4",
      prompt: "work on the paywall refactor",
    });
    assert.equal(hub.storage.getSession("sg-4").goal, "work on the paywall refactor");

    await createClaudeHookContext(hub, {
      hook_event_name: "UserPromptSubmit", cwd: dir, session_id: "sg-4",
      prompt: "now run the tests",
    });
    assert.equal(hub.storage.getSession("sg-4").goal, "work on the paywall refactor", "first prompt wins");
  });
});

test("slash-command prompts do not become the goal; a later real prompt does", async () => {
  await withProject(async ({ dir, hub }) => {
    await createClaudeHookContext(hub, {
      hook_event_name: "SessionStart", cwd: dir, session_id: "sg-5",
    });

    await createClaudeHookContext(hub, {
      hook_event_name: "UserPromptSubmit", cwd: dir, session_id: "sg-5", prompt: "/compact",
    });
    assert.equal(hub.storage.getSession("sg-5").goal, "active session", "slash command leaves the placeholder");

    await createClaudeHookContext(hub, {
      hook_event_name: "UserPromptSubmit", cwd: dir, session_id: "sg-5",
      prompt: "Fix the flaky checkout test",
    });
    assert.equal(hub.storage.getSession("sg-5").goal, "Fix the flaky checkout test");
  });
});

test("flush stores a truncated outcome on the finished session", async () => {
  await withProject(async ({ dir, hub }) => {
    await createClaudeHookContext(hub, {
      hook_event_name: "SessionStart", cwd: dir, session_id: "sg-2",
    });

    await flushClaudeStop(hub, {
      hook_event_name: "Stop", cwd: dir, session_id: "sg-2",
      last_assistant_message: "Done. Paywall gate shipped; 42 tests green.",
    }, { client: offlineClient });

    const session = hub.storage.getSession("sg-2");
    assert.equal(session.status, "finished");
    assert.match(session.outcome, /Paywall gate shipped/);
  });
});

test("a Stop-hook Handoff note surfaces at the top of the next same-branch brief", async () => {
  await withProject(async ({ dir, hub }) => {
    await flushClaudeStop(hub, {
      hook_event_name: "Stop", cwd: dir, branch: "feat/mcp",
      last_assistant_message: "Handoff: wired 4 of 5 MCP tools; next step is memory_lesson's auto-promotion path.",
    }, { client: offlineClient });

    // a same-branch SessionStart picks it up, at the top of the brief text
    const sameBranch = await createClaudeHookContext(hub, { hook_event_name: "SessionStart", cwd: dir, branch: "feat/mcp" });
    const text = sameBranch.hookSpecificOutput.additionalContext;
    assert.match(text, /Handoff \(picking up from last session\): wired 4 of 5 MCP tools/);
    // compare against the always-rendered footer — empty sections (like Inbox here) are elided
    assert.ok(text.indexOf("Handoff") < text.indexOf("Next Recommended Command"), "handoff appears before the rest of the brief");

    // a different branch does not see it
    const otherBranch = await createClaudeHookContext(hub, { hook_event_name: "SessionStart", cwd: dir, branch: "main" });
    assert.doesNotMatch(otherBranch.hookSpecificOutput.additionalContext, /Handoff \(picking up/);
  });
});

test("the first real prompt sets the session goal BEFORE its own brief is ranked", async () => {
  await withProject(async ({ dir, hub }) => {
    await createClaudeHookContext(hub, {
      hook_event_name: "SessionStart", cwd: dir, session_id: "goal-order-1", branch: "master",
    });
    // Before this fix buildBrief ran first, so prompt #1 was ranked against the placeholder goal
    // and the goal only took effect from prompt #2 — the full-budget injection was the one with
    // nothing to be relevant to (value audit IV / independent audit finding 1).
    await createClaudeHookContext(hub, {
      hook_event_name: "UserPromptSubmit", cwd: dir, session_id: "goal-order-1", branch: "master",
      prompt: "fix the paywall restore flow",
    });

    const session = hub.storage.getSession("goal-order-1");
    assert.equal(session.goal, "fix the paywall restore flow", "goal is enriched on prompt #1, not prompt #2");

    const injected = hub.storage.listMetrics(dir, { kind: "recall_injected", limit: 5 })
      .filter((m) => m.payload?.sessionId === "goal-order-1");
    assert.equal(injected.length, 2, "SessionStart and prompt #1 both injected");
    assert.notEqual(injected[0].payload.briefHash, injected[1].payload.briefHash,
      "prompt #1's brief differs from the cold one, so delta suppression cannot swallow it");
  });
});

test("a slash command does not become the session goal", async () => {
  await withProject(async ({ dir, hub }) => {
    await createClaudeHookContext(hub, {
      hook_event_name: "SessionStart", cwd: dir, session_id: "goal-order-2", branch: "master",
    });
    await createClaudeHookContext(hub, {
      hook_event_name: "UserPromptSubmit", cwd: dir, session_id: "goal-order-2", branch: "master",
      prompt: "/compact",
    });
    const session = hub.storage.getSession("goal-order-2");
    assert.notEqual(session.goal, "/compact");
  });
});

test("a real goal is not overwritten by a later prompt", async () => {
  await withProject(async ({ dir, hub }) => {
    await createClaudeHookContext(hub, {
      hook_event_name: "SessionStart", cwd: dir, session_id: "goal-order-3", branch: "master",
    });
    for (const prompt of ["fix the paywall restore flow", "now check the capture gate"]) {
      await createClaudeHookContext(hub, {
        hook_event_name: "UserPromptSubmit", cwd: dir, session_id: "goal-order-3", branch: "master", prompt,
      });
    }
    assert.equal(hub.storage.getSession("goal-order-3").goal, "fix the paywall restore flow");
  });
});
