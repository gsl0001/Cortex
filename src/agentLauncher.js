// Builds fixed runner commands and goals for autonomous Codex / Claude Code runs.
// Pure functions plus process supervision in createAgentLauncher (below).
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { createRunWorktree, removeRunWorktree, hasRemote } from "./worktree.js";
import { integrateRun, localMerge } from "./integrate.js";
import { reviewRun } from "./reviewer.js";
import { killChild } from "./procKill.js";

// Default is a no-op: pushes only happen when the caller wires a real notifier
// (server.js does), so unit tests and library use never touch Telegram.
const NO_NOTIFIER = { enabled: false, push: async () => false };

// Hard rule: some repos must never have an autonomous agent launched against them
// (e.g. a production or money-moving repo). Enrollment is guarded at the API; this guards
// the launch chokepoint itself (dispatcher AND direct POST /tasks/:id/launch both come
// through here). Set CORTEX_NEVER_AUTOPILOT to a comma-separated list of absolute paths.
export const autopilotKey = (path) => String(path || "").toLowerCase().replaceAll("\\", "/");
export const NEVER_AUTOPILOT = new Set(
  (process.env.CORTEX_NEVER_AUTOPILOT || "")
    .split(",")
    .map((p) => autopilotKey(p.trim()))
    .filter(Boolean),
);

// Run the model that fits the task's type: heavy-reasoning work gets Opus, mechanical
// work gets Sonnet. Keyed by the validated `type` vocabulary (commands.js TASK_TYPES).
// codex ships without tiers — its CLI default model stands until settings define them.
export const DEFAULT_MODEL_ROUTING = {
  "claude-code": {
    feature: "opus", bug: "opus", research: "opus",
    chore: "sonnet", docs: "sonnet", test: "sonnet", infra: "sonnet",
  },
  codex: {},
};

// Settings-driven routing: the per-project `modelRouting.<lowercased /-form path>` map
// beats the global `modelRouting` setting beats the built-in default. Values must look
// like model ids — anything else is dropped so a bad setting can never smuggle extra
// flags into the CLI invocation. Unknown agent/type → undefined → CLI default model.
const MODEL_LITERAL = /^[\w.-]+$/;
export function resolveModel(storage, { agent, type, projectPath } = {}) {
  const pick = (map) => map?.[agent]?.[type];
  const perProject = projectPath ? storage.getSetting(`modelRouting.${autopilotKey(projectPath)}`, null) : null;
  const model = pick(perProject) ?? pick(storage.getSetting("modelRouting", null)) ?? pick(DEFAULT_MODEL_ROUTING);
  return MODEL_LITERAL.test(String(model || "")) ? model : undefined;
}

export function buildAgentCommand(agent, sessionId, model) {
  if (agent === "codex") {
    const args = ["exec", "--json", "--sandbox", "workspace-write"];
    if (model) args.push("--model", model);
    args.push("-");
    return { command: process.platform === "win32" ? "codex.cmd" : "codex", args };
  }
  if (agent === "claude-code") {
    // claude CLI >= 2.1.129 rejects --print + stream-json without --verbose
    const args = ["-p", "--verbose", "--output-format", "stream-json", "--permission-mode", "auto", "--session-id", sessionId];
    if (model) args.push("--model", model);
    return { command: process.platform === "win32" ? "claude.cmd" : "claude", args };
  }
  throw new Error("agent must be codex or claude-code");
}

// Deterministic gate between a successful run and review: cheap, explainable checks first
// (no model call) so a run that exits 0 but reported nothing real doesn't get rubber-stamped.
// Weak evidence doesn't fail the run — it flags it (see launch) so a reviewer sees the gap.
export function gradeEvidence({ summary, verificationCommand, logPath }) {
  const text = String(summary || "").trim();
  const problems = [];
  if (text.length < 40) problems.push("summary missing or too thin");
  // when a verification command was configured, the agent's summary should show it actually ran.
  if (verificationCommand && !/\b(tests?|verif\w*|passe?d|npm|pytest|check|lint|build|ran|green|✓)\b/i.test(text)) {
    problems.push(`verification (${verificationCommand}) not mentioned`);
  }
  if (!logPath) problems.push("run log path missing");
  return { ok: problems.length === 0, problems };
}

// Deterministic pre-launch gate: given a task and the project's memory, decide whether
// spawning an agent is safe — before any process starts. Pure (no DB, no spawn): the caller
// gathers the memory and acts on the verdict. Three levels so a warn can still run while a
// block is refused. Files are matched by basename (relatedFiles and a fix's filesChanged
// often differ in path shape), lowercased, so cross-platform paths still line up.
const fileKey = (f) => String(f || "").toLowerCase().replaceAll("\\", "/").split("/").pop();

export function memoryGuard({ task = {}, superseded = [], risks = [], lessons = [] } = {}) {
  const files = new Set((task.relatedFiles || []).map(fileKey).filter(Boolean));
  const touches = (list) => (list || []).some((f) => files.has(fileKey(f)));
  const reasons = [];

  // Prior fixes on these files that were later superseded — work that was tried and didn't
  // stick. One is a caution; two or more means the same area has repeatedly failed, so
  // autopilot shouldn't keep hammering it blindly.
  const priorAttempts = files.size ? superseded.filter((f) => touches(f.filesChanged)) : [];
  if (priorAttempts.length >= 2) {
    reasons.push({ level: "block", code: "repeatedly-superseded",
      detail: `${priorAttempts.length} prior fixes on ${[...files].join(", ")} were superseded; this work has repeatedly failed to stick` });
  } else if (priorAttempts.length === 1) {
    reasons.push({ level: "warn", code: "prior-superseded",
      detail: `a prior fix on these files was superseded: ${priorAttempts[0].summary}` });
  }

  // Open lessons or project risks that name one of these files — recorded "watch out here".
  for (const l of lessons) {
    if ((l.status === "open" || l.status === "active") && [...files].some((f) => String(l.statement || "").toLowerCase().includes(f))) {
      reasons.push({ level: "warn", code: "open-lesson", detail: l.statement });
    }
  }
  for (const r of risks) {
    if ([...files].some((f) => String(r).toLowerCase().includes(f))) {
      reasons.push({ level: "warn", code: "risk", detail: String(r) });
    }
  }

  // A task with neither acceptance criteria nor a verification command gives the agent no
  // way to know when it's done or to prove it — flag it rather than launch blind.
  if (!task.acceptanceCriteria && !task.verificationCommand) {
    reasons.push({ level: "warn", code: "unverifiable", detail: "task has no acceptance criteria and no verification command" });
  }

  const verdict = reasons.some((r) => r.level === "block") ? "block"
    : reasons.some((r) => r.level === "warn") ? "warn" : "allow";
  return { verdict, reasons };
}

// Classify a failed run so the dispatcher can react appropriately (pause on auth, retry
// transient with backoff, leave the rest blocked). The dispatcher reads this back off the
// block reason via a [fail:CLASS] tag, so the vocabulary must stay in sync.
export function classifyFailure({ timedOut = false, stopped = false, detail = "" } = {}) {
  if (stopped) return "stopped";
  if (timedOut) return "transient"; // a wall-clock timeout is usually a slow/wedged run — retryable
  const d = String(detail).toLowerCase();
  if (/(^|\D)(401|403)(\D|$)|invalid.?(api.?key|credential)|unauthor|authenticat|oauth|\/login|credentials|token expired/.test(d)) return "auth";
  if (/(^|\D)(429|502|503|504)(\D|$)|rate.?limit|econnreset|etimedout|enotfound|socket hang up|network|fetch failed|timeout|overloaded|temporarily/.test(d)) return "transient";
  return "permanent";
}

export function buildTaskGoal(task) {
  return [
    `Goal: ${task.title}`,
    task.acceptanceCriteria && `Acceptance criteria: ${task.acceptanceCriteria}`,
    task.relatedFiles?.length && `Related files: ${task.relatedFiles.join(", ")}`,
    task.verificationCommand && `Verification: ${task.verificationCommand}`,
    "Work autonomously until the goal is complete. Preserve unrelated changes. Run the verification command when provided. End with a concise summary and evidence.",
  ].filter(Boolean).join("\n\n");
}

// Normalize an agent's model id to a short label (opus/sonnet/haiku) for grouping/display.
// claude reports e.g. "claude-opus-4-8[1m]" (the [1m] marks the 1-hour cache tier).
export function normalizeModelId(raw) {
  const s = String(raw || "").toLowerCase();
  if (s.includes("opus")) return "opus";
  if (s.includes("sonnet")) return "sonnet";
  if (s.includes("haiku")) return "haiku";
  return raw ? String(raw).replace(/\[.*?]$/, "") : null;
}

// Extract cost/token/model from claude's stream-json terminal `result` event. Cost comes
// straight from the CLI (total_cost_usd) — authoritative, no price table. input_tokens folds
// in cache-creation/read so it reflects total input processed; cost already accounts for cache
// discounts. Returns null for non-result events and for codex (no usage reported yet).
export function parseUsage(event) {
  if (!event || event.type !== "result") return null;
  const u = event.usage || {};
  const inputTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const outputTokens = u.output_tokens || 0;
  // claude reports modelUsage as an object keyed by model id, e.g. {"claude-opus-4-8[1m]": {...}}.
  // Tolerate an array or a plain event.model too.
  const mu = event.modelUsage;
  const modelKey = Array.isArray(mu) ? mu[0] : (mu && typeof mu === "object" ? Object.keys(mu)[0] : event.model);
  const model = normalizeModelId(modelKey);
  return {
    costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : null,
    inputTokens, outputTokens, tokens: inputTokens + outputTokens, model,
  };
}

// Backfill helper: pull usage from a finished run's on-disk .jsonl log (last `result` line).
export function usageFromLog(logPath) {
  let text;
  try { text = readFileSync(logPath, "utf8"); } catch { return null; }
  const lines = text.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { const event = JSON.parse(lines[i]); if (event.type === "result") return parseUsage(event); } catch { /* skip non-JSON */ }
  }
  return null;
}

export function parseAgentEvent(agent, line) {
  try {
    const event = JSON.parse(line);
    const sessionId = agent === "codex" && event.type === "thread.started"
      ? event.thread_id
      : event.session_id;
    const text = event.item?.text
      || event.item?.message
      || event.message?.content?.find?.((part) => part.type === "text")?.text
      || (event.type === "result" ? event.result : undefined); // claude's terminal summary → task evidence
    const lastEvent = text
      || (event.type === "thread.started" ? "Session started" : event.type?.replaceAll("_", " "));
    const usage = parseUsage(event); // non-null only on the terminal result event
    if (!(sessionId || lastEvent || usage)) return null;
    const result = { sessionId: sessionId || undefined, lastEvent };
    if (usage) result.usage = usage; // omit when absent so the common shape stays { sessionId, lastEvent }
    return result;
  } catch {
    return null;
  }
}

function eachLine(stream, visit) {
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop();
    for (const line of lines) if (line) visit(line);
  });
  stream.on("end", () => { if (buffered) visit(buffered); });
}

// Auto-merge tier: only these low-risk task types can skip human review, and only when every
// gate holds (machine-verified green, reviewer clean, diff confined to the task's files).
const AUTOMERGE_TYPES = new Set(["chore", "docs", "test"]);
const VERIFY_TIMEOUT_MS = Number(process.env.CORTEX_VERIFY_TIMEOUT_MIN || 10) * 60_000;

// Is every changed file one the task declared? ponytail: basename matching (same key as
// memoryGuard) — loose, but the reviewer + verification gates back it up; tighten to full
// relative paths if auto-merge ever admits a wrong file.
export function diffConfinedTo(changedFiles, relatedFiles) {
  if (!relatedFiles?.length || !changedFiles?.length) return false;
  const allowed = new Set(relatedFiles.map(fileKey).filter(Boolean));
  return changedFiles.every((f) => allowed.has(fileKey(f)));
}

// Machine re-run of the task's verification command inside the run's worktree — trust moves
// from "the agent says tests passed" to "the server watched them pass" (verification_exit).
function defaultVerify({ command, cwd, spawnProc = spawn, timeoutMs = VERIFY_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProc(command, { cwd, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return resolve({ exit: -1, output: "verification spawn failed" });
    }
    let out = "";
    const timer = setTimeout(() => { killChild(child); }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.once("error", () => { clearTimeout(timer); resolve({ exit: -1, output: out.slice(-500) }); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ exit: code ?? -1, output: out.slice(-500) }); });
  });
}

// logRoot anchors to the DB's directory, not process.cwd(): a server started from a
// worktree would otherwise write run logs into the worktree, and they vanish with it —
// losing the only evidence for why a blocked task failed.
export function createAgentLauncher({ hub, spawnImpl = spawn, logRoot, worktreesDir, git = execFileSync, timeoutMs = Number(process.env.CORTEX_AGENT_TIMEOUT_MIN || 60) * 60_000, notifier = NO_NOTIFIER, reviewImpl = reviewRun, verifyImpl = defaultVerify, mergeImpl = localMerge }) {
  logRoot ??= hub?.storage?.dbPath
    ? join(dirname(hub.storage.dbPath), "agent-runs")
    : join(process.cwd(), ".cortex", "agent-runs");
  // Each run gets a throwaway worktree next to the DB so parallel agents never fight over
  // one checkout. Injectable git (default execFileSync) keeps unit tests off real git.
  worktreesDir ??= hub?.storage?.dbPath
    ? join(dirname(hub.storage.dbPath), "run-worktrees")
    : join(process.cwd(), ".cortex", "run-worktrees");
  const active = new Map();

  // The branch a fresh worktree should fork from: an explicit baseRef (e.g. a producer run's
  // branch, Task 4) else the project's current HEAD branch. Never throws — falls back to HEAD.
  const defaultBranch = (repo) => {
    try {
      return String(git("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }) || "").trim() || "HEAD";
    } catch {
      return "HEAD";
    }
  };

  async function launch({ taskId, agent, baseRef }) {
    const task = hub.storage.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (NEVER_AUTOPILOT.has(autopilotKey(task.projectPath))) {
      throw new Error(`Agents must not run against ${task.projectPath} — human-only project`);
    }
    // Memory Guard: refuse to spawn when project memory says this work has repeatedly failed.
    // Block leaves the task blocked with a visible reason (dashboard/brief), so autopilot won't
    // re-pick it and a manual launch throws instead of silently burning a run. warn/allow proceed.
    const guard = memoryGuard({
      task,
      superseded: hub.storage.listSupersededFixes(task.projectPath, { limit: 20 }),
      risks: hub.storage.getProjectProfile(task.projectPath)?.risks || [],
      lessons: hub.storage.listLessons(task.projectPath, { limit: 20 }),
    });
    if (guard.verdict === "block") {
      // Sentinel format the surfacing layer reads back (server.js GUARD_RE) — keep in sync.
      const reason = `Memory Guard [block]: ${guard.reasons.filter((r) => r.level === "block").map((r) => r.detail).join("; ")}`;
      hub.blockTask({ id: taskId, agent, reason });
      throw new Error(reason);
    }
    // A soft warn still runs, but the reasons must reach the human: carried into the review
    // evidence under the same sentinel (GUARD_RE is start-anchored, so it goes first).
    const guardWarn = guard.verdict === "warn"
      ? guard.reasons.filter((r) => r.level === "warn").map((r) => r.detail).join("; ")
      : null;
    const sessionId = agent === "claude-code" ? randomUUID() : null;
    const intendedModel = resolveModel(hub.storage, { agent, type: task.type, projectPath: task.projectPath }) ?? null;
    hub.claimTask({ id: taskId, agent });
    const run = hub.startRun({ taskId, agent, verificationCommand: task.verificationCommand, model: intendedModel });
    const logPath = join(logRoot, `${run.id}.jsonl`);
    hub.updateRunProgress({ id: run.id, sessionId, logPath, lastEvent: "Starting agent" });
    // Fork the run's worktree from the caller's baseRef, else the project's current branch.
    const base = baseRef || defaultBranch(task.projectPath);
    // Removed on every finish path (and if spawn fails after creation); the branch it committed
    // to survives for Task 4 integration. Guarded so we never double-remove.
    let wtPath;
    let branch;
    let worktreeRemoved = false;
    let preserveWorktree = false; // set when the worktree holds the only copy of unlanded work
    const cleanupWorktree = () => {
      if (worktreeRemoved || !wtPath) return;
      worktreeRemoved = true;
      removeRunWorktree({ repo: task.projectPath, path: wtPath, run: git });
    };
    // "Is there real work sitting uncommitted in the worktree?" — used to decide whether a
    // failed commit means lost-work-if-removed. If git itself can't answer, err on preserving.
    const uncommittedWork = () => {
      try { return String(git("git", ["-C", wtPath, "status", "--porcelain"], { encoding: "utf8" }) || "").trim().length > 0; }
      catch { return true; }
    };
    let child;
    try {
      await mkdir(logRoot, { recursive: true });
      const created = createRunWorktree({ repo: task.projectPath, worktreesDir, taskId, baseRef: base, run: git });
      wtPath = created.path;
      branch = created.branch;
      hub.updateRunProgress({ id: run.id, worktreePath: wtPath, branch: created.branch });
      const command = buildAgentCommand(agent, sessionId, intendedModel);
      child = spawnImpl(command.command, command.args, {
        cwd: wtPath, // run inside the isolated worktree, not the shared checkout
        shell: process.platform === "win32",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      cleanupWorktree(); // no-op if the worktree never got created
      hub.finishRun({ id: run.id, outcome: "fail", notes: error.message });
      // Tag like the finish path does — an untagged reason reads as "permanent" to the
      // dispatcher's failureClass(), which would never retry a transient spawn/worktree error.
      hub.blockTask({ id: taskId, agent, reason: `[fail:${classifyFailure({ detail: error.message })}] Agent launch failed: ${error.message}` });
      throw error;
    }

    const log = createWriteStream(logPath, { flags: "a" });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    // Wall-clock ceiling: one hung CLI would otherwise hold the single dispatcher slot
    // all night. Killing the child makes it emit "close" with a non-zero code, which the
    // finish path below turns into a blocked task; timedOut just gives it a clearer reason.
    let timedOut = false;
    let stopped = false; // set by stopRun()/stop() so a user-killed run reads "Stopped by user", not "exited 143"
    const timer = setTimeout(() => { timedOut = true; killChild(child); }, timeoutMs);
    timer.unref?.(); // never keep the process alive just to hold this timer

    let finalText = "";
    let stderr = "";
    let usage = null; // cost/tokens/model from the terminal result event, captured for finishRun
    eachLine(child.stdout, (line) => {
      const event = parseAgentEvent(agent, line);
      if (!event) return;
      if (event.lastEvent) finalText = event.lastEvent;
      if (event.usage) usage = event.usage;
      hub.updateRunProgress({ id: run.id, ...event });
    });
    eachLine(child.stderr, (line) => { stderr = line; });
    child.stdin.end(buildTaskGoal(task));

    let settled = false;
    const completed = new Promise((resolve) => {
      const finish = async (code, launchError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        active.delete(run.id);
        log.end();
        // Cost/tokens are the same whether the run passed or failed — record on both paths.
        // Reported model (what actually ran) wins over the model we asked for.
        const cost = { model: usage?.model || intendedModel, inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, tokens: usage?.tokens ?? null, costUsd: usage?.costUsd ?? null };
        if (code === 0 && !launchError) {
          // Commit the agent's work to autopilot/<taskId> so it can be integrated. Commit
          // only when something is staged. A commit failure with real work in the tree must
          // NOT fall through to "success" — cleanupWorktree() below would force-remove the
          // only copy of the agent's changes.
          let commitError = null;
          try {
            git("git", ["-C", wtPath, "add", "-A"], { encoding: "utf8" });
            const staged = String(git("git", ["-C", wtPath, "diff", "--cached", "--name-only"], { encoding: "utf8" }) || "").trim();
            if (staged) git("git", ["-C", wtPath, "commit", "-m", `autopilot: ${task.title}`], { encoding: "utf8" });
          } catch (error) { commitError = error; }
          if (commitError && uncommittedWork()) {
            preserveWorktree = true;
            const reason = `Agent finished but committing its work failed: ${commitError.message}; work preserved in worktree ${wtPath}`;
            hub.finishRun({ id: run.id, outcome: "fail", notes: reason, ...cost });
            // permanent: an auto-retry can't fix a broken git config, and would reset the
            // preserved branch — a human needs to rescue the worktree first.
            hub.blockTask({ id: taskId, agent, reason: `[fail:permanent] ${reason}; log: ${logPath}` });
            notifier.push(`run-fail:${task.projectPath}`, `❌ Run failed: "${task.title}" (${task.projectPath}) — ${reason}`).catch(() => {});
          } else {
            // While the worktree still exists: machine-verify, first-pass review, and collect
            // the changed-file list. All best-effort — any failure degrades to human review.
            let verificationExit = null;
            let verifyOutput = "";
            if (task.verificationCommand) {
              try {
                const verified = await verifyImpl({ command: task.verificationCommand, cwd: wtPath });
                verificationExit = verified.exit;
                verifyOutput = verified.output || "";
              } catch { verificationExit = -1; }
            }
            let review = null;
            if (hub.storage.getSetting("reviewer.enabled", true)) {
              try {
                review = await reviewImpl({
                  worktreePath: wtPath, baseRef: base, task,
                  model: hub.storage.getSetting("reviewer.model", "haiku"),
                });
              } catch { review = null; }
            }
            let changedFiles = [];
            try {
              changedFiles = String(git("git", ["-C", wtPath, "diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" }) || "")
                .split(/\r?\n/).map((f) => f.trim()).filter(Boolean);
            } catch { /* no file list -> auto-merge simply won't qualify */ }
            // Push + open a PR when the project has a remote; otherwise the branch persists for
            // a manual/local merge (POST /runs/:id/merge). Best-effort: a failure here must never
            // crash finish or lose the run's work. Awaited async (integrateRun's own runner) so
            // the 30s-timeout network calls don't freeze the event loop for every other run.
            let prUrl = null;
            try {
              const result = await integrateRun({ repo: task.projectPath, branch, baseRef: base, title: task.title, hasRemote: hasRemote(task.projectPath, git) });
              prUrl = result.prUrl;
            } catch { /* integration is best-effort; branch persists for manual/local merge */ }
            hub.finishRun({ id: run.id, outcome: "success", notes: finalText || null, prUrl, verificationExit, ...cost });
            // Grade before review so weak/missing evidence is flagged, not silently accepted.
            const grade = gradeEvidence({ summary: finalText, verificationCommand: task.verificationCommand, logPath });
            const evidence = finalText || `Agent completed; log: ${logPath}`;
            let graded = grade.ok ? evidence : `⚠ Weak evidence: ${grade.problems.join("; ")}. ${evidence} (log: ${logPath})`;
            if (verificationExit !== null) {
              graded = verificationExit === 0
                ? `Verified: ${task.verificationCommand} exited 0. ${graded}`
                : `⚠ Verification failed (exit ${verificationExit}): ${verifyOutput.slice(-200)}. ${graded}`;
            }
            if (review) graded = `Reviewer [${review.verdict}]: ${review.notes.slice(0, 200)}. ${graded}`;
            const finalEvidence = guardWarn ? `Memory Guard [warn]: ${guardWarn}. ${graded}` : graded;

            // Auto-merge tier: low-risk type + machine-verified green + reviewer clean + diff
            // confined to the task's declared files + no guard warning. Everything else parks
            // in human review as before. The merge itself needs the worktree gone (its branch
            // is checked out there), so tear it down first.
            const autoMergeable = hub.storage.getSetting("automerge.enabled", true)
              && AUTOMERGE_TYPES.has(task.type)
              && verificationExit === 0
              && review?.verdict === "clean"
              && !guardWarn
              && diffConfinedTo(changedFiles, task.relatedFiles);
            let merged = false;
            if (autoMergeable) {
              cleanupWorktree();
              try {
                merged = Boolean((await mergeImpl({ repo: task.projectPath, branch, baseRef: base })).merged);
              } catch { merged = false; }
            }
            if (merged) {
              hub.completeTask({ id: taskId, agent, evidence: `Auto-merged into ${base}. ${finalEvidence}` });
              notifier.push("auto-merged", `✅ Auto-merged: "${task.title}" (${task.projectPath}) — verified green, reviewer clean`).catch(() => {});
            } else {
              hub.reviewTask({ id: taskId, agent, evidence: finalEvidence });
              // fire-and-forget: a Telegram outage must never delay finish
              notifier.push("needs-you", `👀 Needs you: "${task.title}" is parked in review (${task.projectPath})`).catch(() => {});
            }
          }
        } else {
          // finalText carries the agent's own last words (e.g. "API Error: 401 …") —
          // without it every failure reads "exited with code 1" and is undiagnosable.
          const detail = launchError?.message || stderr || finalText;
          const reason = timedOut
            ? `Agent timed out after ${Math.round(timeoutMs / 60_000)} min`
            : stopped ? "Stopped by user"
            : detail ? `Agent exited with code ${code}: ${detail}` : `Agent exited with code ${code}`;
          // Stamp the failure class so the dispatcher can pause on auth / retry transient / block the rest.
          const cls = classifyFailure({ timedOut, stopped, detail });
          hub.finishRun({ id: run.id, outcome: "fail", notes: reason, ...cost });
          hub.blockTask({ id: taskId, agent, reason: `[fail:${cls}] ${reason}; log: ${logPath}` });
          notifier.push(`run-fail:${task.projectPath}`, `❌ Run failed: "${task.title}" (${task.projectPath}) — ${reason}`).catch(() => {});
        }
        // Every outcome (success, fail, timeout, stopped) tears down the worktree dir; the
        // branch it committed to remains for integration. Exception: a failed commit leaves
        // the worktree as the only copy of the work, so it stays for manual rescue.
        if (!preserveWorktree) cleanupWorktree();
        resolve(hub.storage.getRun(run.id));
      };
      child.once("error", (error) => finish(1, error));
      // defer so any stdout already buffered is parsed before we finalize
      child.once("close", (code) => setImmediate(() => finish(code)));
    });
    // stop() marks the run as user-stopped before killing so finish() reports it as such.
    active.set(run.id, { child, completed, stop: () => { stopped = true; killChild(child); } });
    return { task: hub.storage.getTask(taskId), run: hub.storage.getRun(run.id), completed };
  }

  // Kill one running agent by run id; resolves once it's fully settled (task → blocked
  // "Stopped by user"). Returns false if the run isn't currently active.
  async function stopRun(runId) {
    const entry = active.get(runId);
    if (!entry) return false;
    entry.stop();
    await entry.completed;
    return true;
  }

  async function stop() {
    const runs = [...active.values()];
    for (const entry of runs) entry.stop();
    await Promise.allSettled(runs.map(({ completed }) => completed));
  }

  return { launch, stop, stopRun };
}
