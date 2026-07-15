import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { gitChangedFiles, truncate } from "./claudeAdapter.js";
import { createWriteClient } from "./writeClient.js";

// Codex stores session transcripts as ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<session_id>.jsonl
const SESSIONS_DIR = join(homedir(), ".codex", "sessions");

// Find the rollout transcript whose filename contains the session id (newest if several).
export function findCodexTranscript(sessionId, sessionsDir = SESSIONS_DIR) {
  if (!sessionId) return null;
  const matches = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".jsonl") && entry.name.includes(sessionId)) matches.push(full);
    }
  };
  walk(sessionsDir);
  if (!matches.length) return null;
  return matches.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

// Pull the last assistant message text out of a Codex rollout transcript.
// ponytail: walk from the end, take the first of the known final-message shapes.
export function lastCodexAgentMessage(transcriptPath) {
  if (!transcriptPath) return "";
  let lines;
  try { lines = readFileSync(transcriptPath, "utf8").trim().split("\n"); } catch { return ""; }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    const payload = entry?.payload;
    if (!payload) continue;
    if (payload.type === "task_complete" && payload.last_agent_message) return payload.last_agent_message;
    if (payload.type === "agent_message" && payload.message) return payload.message;
    if (entry.type === "response_item" && payload.role === "assistant" && Array.isArray(payload.content)) {
      const text = payload.content
        .filter((c) => c.type === "output_text" || c.type === "text")
        .map((c) => c.text)
        .join("\n");
      if (text) return text;
    }
  }
  return "";
}

// Codex Stop payload carries { session_id, cwd } (no message inline) — resolve the
// transcript and extract the final message, then route through the shared capture gate.
// Mirrors flushClaudeStop: session outcome kept, HTTP capture first, direct DB only
// when the server is unreachable (a real rejection must not re-submit).
export async function flushCodexStop(hub, hookInput = {}, { client = createWriteClient() } = {}) {
  // Mirror of flushClaudeStop's scope gate: unregistered directories capture nothing.
  if (!hub.storage.getProjectProfile(hookInput.cwd || process.cwd())) {
    return { action: "skipped", reason: "unregistered_project" };
  }
  const sessionId = hookInput.session_id || hookInput.id;
  const transcriptPath = hookInput.transcript_path || findCodexTranscript(sessionId);
  const message = hookInput.last_agent_message || lastCodexAgentMessage(transcriptPath);
  if (sessionId) {
    try { hub.storage.finishSession(sessionId, { outcome: truncate(message, 240) || null }); } catch { /* no open session - fine */ }
  }
  const candidate = {
    projectPath: hookInput.cwd || process.cwd(),
    agent: hookInput.agent_type || "codex",
    source: "codex-stop-hook",
    eventType: hookInput.hook_event_name || "Stop",
    message,
    branch: hookInput.branch,
    recentFiles: hookInput.recentFiles?.length
      ? hookInput.recentFiles
      : gitChangedFiles(hookInput.cwd || process.cwd()),
    commitSha: hookInput.commit_sha,
    // the server enqueues transcript distillation from this — the hook itself never distills
    transcriptPath: transcriptPath || null,
  };
  try {
    return await client.capture(candidate);
  } catch (error) {
    if (error.isHttpRejection) {
      return { action: "rejected", reason: "server_rejected", message: error.message };
    }
    return hub.captureCandidate(candidate);
  }
}
