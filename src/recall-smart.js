#!/usr/bin/env node
/**
 * Context-aware SessionStart hook.
 * Reads git branch + recent files + memory file tags, then calls createClaudeHookContext
 * so the hub brief only surfaces relevant tasks/research/fixes/memories.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createCortex, createClaudeHookContext } from "./index.js";
import { loadRelevantMemories } from "./memoryFiles.js";

// Claude pipes the hook payload (session_id, agent_type, ...) on stdin.
// Guard on isTTY so a manual `node recall-smart.js` doesn't block waiting for input.
function readHookPayload() {
  if (process.stdin.isTTY) return {};
  try {
    const input = readFileSync(0, "utf8").trim();
    return input ? JSON.parse(input) : {};
  } catch {
    return {};
  }
}

const DB_PATH =
  process.env.CORTEX_DB ||
  join(homedir(), ".cortex", "cortex.sqlite");
const PROJECT_PATH = resolve(
  process.env.CORTEX_PROJECT || process.argv[2] || process.cwd(),
);

// ── git context ──────────────────────────────────────────────────────────────

function gitExec(cmd) {
  try {
    return execSync(cmd, { cwd: PROJECT_PATH, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })
      .trim();
  } catch {
    return "";
  }
}

const branch = gitExec("git rev-parse --abbrev-ref HEAD");
const recentFiles = (gitExec("git diff --name-only HEAD~5 HEAD") || gitExec("git diff --name-only HEAD~1 HEAD"))
  .split("\n")
  .filter(Boolean);

// ── memory file tag matching ──────────────────────────────────────────────────

function contextKeywords(branchStr, files) {
  const words = new Set();
  branchStr
    .toLowerCase()
    .split(/[/\-_]+/)
    .filter((w) => w.length > 2)
    .forEach((w) => words.add(w));
  for (const f of files) {
    f.toLowerCase()
      .replace(/\.\w+$/, "")
      .split(/[/\\_.\-]+/)
      .filter((w) => w.length > 2)
      .forEach((w) => words.add(w));
  }
  return [...words];
}

// ── build and emit context ────────────────────────────────────────────────────

const keywords = contextKeywords(branch, recentFiles);
const hub = createCortex({ dbPath: DB_PATH });
const profile = hub.storage.getProjectProfile(PROJECT_PATH);
const configuredDirs = process.env.CORTEX_MEMORY_DIRS
  ? process.env.CORTEX_MEMORY_DIRS.split(delimiter).filter(Boolean)
  : process.env.CORTEX_MEMORY_DIR
    ? [process.env.CORTEX_MEMORY_DIR]
    : profile?.externalMemoryDirs || [];
const relevantMemories = loadRelevantMemories(configuredDirs, keywords);
const hookPayload = readHookPayload();
const envAgent = (process.env.CORTEX_AGENT && process.env.CORTEX_AGENT !== "1" && process.env.CORTEX_AGENT !== "true" && process.env.CORTEX_AGENT) ||
                 (process.env.ANTIGRAVITY_AGENT && process.env.ANTIGRAVITY_AGENT !== "1" && process.env.ANTIGRAVITY_AGENT !== "true" && process.env.ANTIGRAVITY_AGENT);

const result = await createClaudeHookContext(hub, {
  hook_event_name: "SessionStart", // so the brief + retention sweep run as a session start
  cwd: PROJECT_PATH,
  session_id: hookPayload.session_id, // opens an agent session keyed on this id
  agent_type: hookPayload.agent_type || envAgent || "claude-code",
  branch,
  recentFiles,
  relevantMemories,
});
hub.close();

console.log(JSON.stringify(result));
