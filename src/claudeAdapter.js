import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createWriteClient } from "./writeClient.js";

export function resolveAgent(agentType) {
  if (agentType && agentType !== "1" && agentType !== "true") return agentType;
  const envAgent = process.env.CORTEX_AGENT || process.env.ANTIGRAVITY_AGENT;
  if (envAgent && envAgent !== "1" && envAgent !== "true") return envAgent;
  return "claude-code";
}

// ponytail: Stop hook rarely passes recentFiles, so 100% of captured fixes had
// empty files_changed and the graph never linked fixes to code. Derive working-tree
// changes from git. Last-commit-only sessions need commitSha diffing — add when needed.
export function gitChangedFiles(projectPath) {
  try {
    const out = execFileSync("git", ["-C", projectPath, "diff", "--name-only", "HEAD"], {
      encoding: "utf8",
      timeout: 3000,
    });
    return out.split("\n").map((file) => file.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// ponytail: Stop hook payload gives transcript_path (JSONL), not the message text.
// Read the last assistant turn from it so live capture isn't always empty.
export function lastAssistantText(transcriptPath) {
  if (!transcriptPath) return "";
  let lines;
  try {
    lines = readFileSync(transcriptPath, "utf8").trim().split("\n");
  } catch {
    return "";
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (entry?.source === "MODEL" && typeof entry?.content === "string") {
      return entry.content;
    }
    if (entry?.type !== "assistant") continue;
    const content = entry.message?.content;
    if (typeof content === "string") return content;
    return (content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  }
  return "";
}

// Shared by the SessionStart insert and the UserPromptSubmit placeholder check so
// the two formats can't drift — only these exact strings are ever replaced by a prompt.
const placeholderGoal = (branch) => (branch ? `work on ${branch}` : "active session");

// "/ship the recall fix" states the work as clearly as any prose prompt — only the command
// token itself is unidentifiable. Skipping ALL slash prompts left slash-driven sessions (a
// heavy pattern here) with no goal, and with no git context either the cold gate then
// withheld all project memory for the session's entire life.
const goalFromPrompt = (prompt) => {
  const text = String(prompt || "").trim();
  return (text.startsWith("/") ? text.replace(/^\/\S+\s*/, "") : text).trim();
};

// A pasted stack trace or log dump as prompt #1 poisons ranking for the whole session: its
// noise tokens drive the subtractive relevance gate, which is worse than having no goal at
// all (no goal at least falls back to recency top-k).
const looksLikeMachineOutput = (text) => {
  if (/Traceback \(most recent|npm ERR!|^\s*at [\w$.<>[\]]+ \(|\w+(Error|Exception):/m.test(text)) return true;
  const alpha = (String(text).match(/[a-z\s]/gi) || []).length;
  return alpha / Math.max(1, String(text).length) < 0.55;
};

export function truncate(text, limit = 240) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit - 3)}...`;
}

function commandWithEnv({ cortexBin, dbPath, action }) {
  const dbFlag = dbPath ? ` --db "${dbPath}"` : "";
  return `${cortexBin}${dbFlag} claude ${action}`;
}

function mergeHook(settings, eventName, hook) {
  const next = structuredClone(settings);
  next.hooks ||= {};
  next.hooks[eventName] ||= [];
  next.hooks[eventName].push({ hooks: [hook] });
  return next;
}

async function readSettings(settingsPath) {
  try {
    return JSON.parse(await readFile(settingsPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

export async function installClaudeAdapter({
  projectPath = process.cwd(),
  settingsPath,
  cortexBin,
  dbPath,
} = {}) {
  const resolvedProject = resolve(projectPath);
  const targetPath = settingsPath || join(resolvedProject, ".claude", "settings.local.json");
  const bin = cortexBin || `node "${resolve("src/cli.js")}"`;
  // Default to the global hub DB (matches storage.defaultDbPath), not a per-project
  // file — the hub is one shared database, so installed hooks must write where the
  // server reads. Pass dbPath explicitly only for an intentionally isolated DB.
  const resolvedDbPath = dbPath || join(homedir(), ".cortex", "cortex.sqlite");
  const base = await readSettings(targetPath);

  const withSessionStart = mergeHook(base, "SessionStart", {
    type: "command",
    command: commandWithEnv({ cortexBin: bin, dbPath: resolvedDbPath, action: "recall" }),
    timeout: 10,
    statusMessage: "Loading Cortex brief...",
  });
  const withPrompt = mergeHook(withSessionStart, "UserPromptSubmit", {
    type: "command",
    command: commandWithEnv({ cortexBin: bin, dbPath: resolvedDbPath, action: "recall" }),
    timeout: 10,
    statusMessage: "Loading Cortex brief...",
  });
  const withStop = mergeHook(withPrompt, "Stop", {
    type: "command",
    command: commandWithEnv({ cortexBin: bin, dbPath: resolvedDbPath, action: "flush" }),
    timeout: 10,
    statusMessage: "Saving Cortex handoff...",
  });

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(withStop, null, 2)}\n`);
  return targetPath;
}

// Delta briefs: how many prompts may skip re-injection before a full brief is re-sent
// (guards against /compact or truncation silently dropping the original from context).
const FULL_BRIEF_EVERY_N_PROMPTS = Number(process.env.CORTEX_FULL_BRIEF_EVERY || 10);

const briefHashOf = (text) => {
  let hash = 0;
  const s = String(text || "");
  for (let i = 0; i < s.length; i += 1) hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(16);
};

export async function createClaudeHookContext(hub, hookInput = {}) {
  const projectPath = hookInput.cwd || process.cwd();
  const eventName = hookInput.hook_event_name || "UserPromptSubmit";
  // Registered-scope gate (2026-07 audit): 29% of all injections went to sessions in
  // unregistered directories (the home folder, scratch dirs) — a full project brief there is
  // pure context pollution at ~740 tokens a shot. One discoverable line instead.
  if (!hub.storage.getProjectProfile(projectPath)) {
    return {
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: eventName === "SessionStart"
          ? "Cortex: this directory is not a registered project — no brief injected. Run memory-hub-setup to register it."
          : "",
      },
    };
  }
  // First real prompt becomes the session goal — "active session" placeholders made 95% of
  // captured sessions unidentifiable (2026-07-03 data review). Slash commands (/compact, /clear,
  // ...) are no more identifiable than the placeholder, so skip them and let a later real prompt
  // enrich the goal.
  //
  // This MUST run before the brief is built. It used to sit after buildBrief, so prompt #1 — the
  // prompt that states the work — was ranked against an empty goal, and the goal only took effect
  // from prompt #2. Measured on live data: 2 of the 10 served records change once the goal is
  // known, and prompt #1 is the session's full-budget injection, so it was simultaneously the
  // most expensive brief and the least informed one.
  if (eventName === "UserPromptSubmit" && hookInput.session_id && hookInput.prompt) {
    try {
      const goalCandidate = goalFromPrompt(hookInput.prompt);
      if (goalCandidate && !looksLikeMachineOutput(goalCandidate)) {
        const session = hub.storage.getSession(hookInput.session_id);
        // Exact match only: a legitimate first prompt like "work on the paywall refactor" must not
        // re-match as a placeholder and get overwritten by the next prompt.
        // Recognize the placeholder using the STORED session branch, not this hook's branch: a
        // branch-less UserPromptSubmit would otherwise fail to match "work on <branch>" and leak it
        // into goalText, whose lone term wrongly gates the brief empty. Reading the hook's `context`
        // here instead would be a temporal-dead-zone ReferenceError — declared below — and the
        // catch would swallow it, leaving the goal silently un-enriched forever.
        const isPlaceholder = session
          && (session.goal === "active session" || session.goal === placeholderGoal(session?.branch));
        if (isPlaceholder) hub.storage.updateSessionGoal(hookInput.session_id, truncate(goalCandidate, 140));
      }
    } catch { /* goal enrichment must never block recall */ }
  }
  // Goal-conditioned brief (audit III): rank/admit records by relevance to what THIS session is
  // about. Use the STORED session goal (enriched immediately above), never the live prompt — a
  // per-prompt goal would change the brief hash every turn and defeat the delta-suppression that
  // skips re-injecting an unchanged brief. Placeholder goals contribute nothing.
  let goalText = "";
  let storedSession = null;
  if (hookInput.session_id) {
    try {
      storedSession = hub.storage.getSession(hookInput.session_id);
      const goal = storedSession?.goal;
      // Recognize the placeholder using the STORED session branch, not this hook's branch: a
      // branch-less UserPromptSubmit (documented below) would otherwise fail to match
      // "work on <branch>" and leak it into goalText, whose lone term wrongly gates the brief empty.
      if (goal && goal !== "active session" && goal !== placeholderGoal(storedSession?.branch)) goalText = goal;
    } catch { /* goal is optional ranking context */ }
  }
  // UserPromptSubmit hooks carry no git context (~90% of all injections), so the relevance
  // gate was ranking on goal text alone. The session row opened at SessionStart already holds
  // the branch and dirty files — reuse them. Deliberately NOT re-derived from git per prompt:
  // stable inputs keep the brief hash stable, which delta suppression depends on.
  const context = {
    branch: hookInput.branch || storedSession?.branch || undefined,
    recentFiles: hookInput.recentFiles?.length ? hookInput.recentFiles : (storedSession?.dirtyFiles || []),
    relevantMemories: hookInput.relevantMemories || [],
    goalText,
  };
  // Budget split (value audit IV): at SessionStart there is no goal yet — the stored goal stays a
  // placeholder until the first real prompt enriches it below — so the relevance gate has nothing
  // to rank against, and when branch/files tokenize to nothing it disables itself and packs the
  // full cap with recency filler. Live data: 1,184 of 1,200 tokens used on average while dropping
  // 16.6 records a shot, at 7,340 tokens per citation. Spend a thin brief on the least-informed
  // injection of the session and keep the full budget for the first prompt, when there is
  // something to be relevant to.
  // One awaited query embed enables cosine scoring for the brief's semantic arm; failure
  // (Ollama down, no prepareBrief on the hub) silently leaves the MinHash fallback.
  try { await hub.prepareBrief?.(context); } catch { /* semantic scoring is optional */ }
  const brief = hub.buildBrief({
    projectPath,
    context,
    ...(eventName === "SessionStart" && !goalText
      ? { maxTokens: Number(process.env.CORTEX_SESSION_START_TOKENS || 400) }
      : {}),
  });
  // ponytail: perpetual retention with no daemon — sweep once per session start.
  // Reuses the hook that already fires; per-prompt recall skips it (too frequent).
  if (eventName === "SessionStart") {
    try { hub.sweep(); } catch { /* maintenance must never block recall */ }
    // Make "Active Agent Sessions" real: open one keyed on the Claude session id.
    // Idempotent by catch — a re-fired SessionStart hits the PRIMARY KEY and is ignored.
    if (hookInput.session_id) {
      const agent = resolveAgent(hookInput.agent_type);
      const source = agent === "codex" ? "codex-session-hook" : "claude-session-hook";
      // ponytail: Codex Desktop can emit a second worker id for the same startup;
      // keep real sessions started more than a minute apart distinct.
      const duplicateStart = agent === "codex" && hub.storage.listActiveSessions(projectPath).some(
        (session) => session.agent === agent
          && session.source === source
          && Date.parse(session.createdAt) > Date.now() - 60_000,
      );
      try {
        if (!duplicateStart) hub.storage.insertSession({
          id: hookInput.session_id,
          projectPath,
          agent,
          source,
          goal: placeholderGoal(context.branch),
          branch: context.branch,
          dirtyFiles: context.recentFiles,
          status: "active",
        });
      } catch { /* session already open (hook re-fire) — fine */ }
    }
  }
  // Delta briefs (2026-07 audit): ~58% of injected tokens were verbatim repeats of a brief
  // already sitting in the session's context. Same session + unchanged brief → inject nothing,
  // but re-send the full brief every N prompts so /compact or truncation can't silently
  // strand the session without one.
  // Hash the CONTENT, not the rendered text: the "(+N omitted)" footer counts drops from
  // sections that never render, so hashing it made unrelated store activity (a session opening
  // anywhere in the project) churn the hash and force full re-injection — live suppression
  // rate was 4.6% against a design assumption of ~58%.
  const briefHash = briefHashOf(brief.contentText ?? brief.text);
  if (eventName === "UserPromptSubmit" && hookInput.session_id) {
    try {
      // session-scoped lookup: a shared 20-row window missed this session's rows whenever
      // several sessions (main + subagents + scheduled tasks) were live concurrently
      const lastInjected = hub.storage.listMetrics(projectPath,
        { kind: "recall_injected", sessionId: hookInput.session_id, limit: 1 })[0];
      if (lastInjected?.payload?.briefHash === briefHash) {
        const skipsSinceFull = hub.storage.listMetrics(projectPath,
          { kind: "recall_skipped", sessionId: hookInput.session_id, limit: FULL_BRIEF_EVERY_N_PROMPTS + 1 })
          .filter((m) => m.createdAt > lastInjected.createdAt).length;
        if (skipsSinceFull < FULL_BRIEF_EVERY_N_PROMPTS) {
          hub.storage.recordMetric("recall_skipped", projectPath, { sessionId: hookInput.session_id, briefHash });
          return { hookSpecificOutput: { hookEventName: eventName, additionalContext: "" } };
        }
      }
    } catch { /* delta optimization must never block recall */ }
  }
  try {
    // injectedFilesChanged backs the recall_useful metric (captureService.js): when a fix
    // lands soon after touching one of these files, the recall that surfaced it "worked".
    const injectedFilesChanged = [...new Set((brief.fixes || []).flatMap((f) => f.filesChanged || []))];
    hub.storage.recordMetric("recall_injected", projectPath, {
      agent: resolveAgent(hookInput.agent_type),
      sessionId: hookInput.session_id || null,
      // SessionStart vs UserPromptSubmit costs were previously inseparable in the metrics
      eventName,
      briefHash,
      usedTokens: brief.usedTokens ?? 0,
      maxTokens: brief.maxTokens ?? 0,
      dropped: brief.dropped ?? 0,
      injectedFixIds: (brief.fixes || []).map((f) => f.id),
      // Research and decision slots were never recorded (value audit IV), so no scope or
      // repetition claim about them was checkable — the audit's own "0% foreign payload" number
      // covered fix slots only, roughly half the records a brief actually serves. Record all
      // three, and how many records topic scoping declined to serve.
      injectedResearchIds: (brief.research || []).map((r) => r.id),
      injectedDecisionIds: (brief.decisions || []).map((d) => d.id),
      offTopicFiltered: brief.offTopicFiltered ?? 0,
      injectedFilesChanged,
      // per-record file lists so recall_useful can attribute a later fix to ONE recalled
      // record instead of firing on any overlap with this flat union (hot files are in
      // every brief, which made the union match meaningless)
      injectedFixes: (brief.fixes || []).map((f) => ({ id: f.id, projectPath: f.projectPath ?? null, filesChanged: f.filesChanged || [] })),
    });
  } catch {
    // telemetry must never block recall
  }
  const prompt = hookInput.prompt ? `\nPrompt: ${truncate(hookInput.prompt, 200)}` : "";
  const additionalContext = [
    "<cortex-context>",
    "Cortex context for this project:",
    brief.text,
    prompt,
    "</cortex-context>",
  ].filter(Boolean).join("\n");

  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext,
    },
  };
}

export async function flushClaudeStop(hub, hookInput = {}, { client = createWriteClient() } = {}) {
  // Mirror of the recall-side scope gate: unregistered directories capture nothing
  // (27 "fixes" once accumulated under a Pictures folder).
  const flushProject = hookInput.cwd || process.cwd();
  if (!hub.storage.getProjectProfile(flushProject)) {
    return { action: "skipped", reason: "unregistered_project" };
  }
  const message = hookInput.last_assistant_message || lastAssistantText(hookInput.transcript_path);
  // Close the session opened at SessionStart (same session_id key), keeping
  // the final assistant text as the session outcome.
  if (hookInput.session_id) {
    try { hub.storage.finishSession(hookInput.session_id, { outcome: truncate(message, 240) || null }); } catch { /* no open session — fine */ }
  }
  const candidate = {
    projectPath: hookInput.cwd || process.cwd(),
    agent: resolveAgent(hookInput.agent_type),
    // citation dedup across turns: Stop fires per assistant turn, and without a session key
    // the same [m:id] echoed on five turns counted as five citations (28% of live citation
    // events were same-pair repeats within 30 minutes)
    sessionId: hookInput.session_id || null,
    source: "claude-stop-hook",
    eventType: hookInput.hook_event_name || "Stop",
    message,
    branch: hookInput.branch,
    recentFiles: hookInput.recentFiles?.length
      ? hookInput.recentFiles
      : gitChangedFiles(hookInput.cwd || process.cwd()),
    commitSha: hookInput.commit_sha,
    // the server enqueues transcript distillation from this — the hook itself never distills
    transcriptPath: hookInput.transcript_path || null,
  };
  // Route through the running server's write API so capture goes through one process;
  // only write to the DB directly here if the server is unreachable (not running yet) —
  // a real HTTP rejection (validation/policy/auth) must NOT fall back, or the candidate
  // gets silently re-submitted through a second, uncoordinated capture path.
  try {
    return await client.capture(candidate);
  } catch (error) {
    if (error.isHttpRejection) {
      return { action: "rejected", reason: "server_rejected", message: error.message };
    }
    return hub.captureCandidate(candidate);
  }
}
