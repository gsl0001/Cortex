#!/usr/bin/env node
/**
 * PostToolUse hook: flush Cortex only when a memory file was written.
 * Reads Claude Code's JSON payload from stdin, checks tool_input.file_path,
 * and calls `claude flush` if the path contains "memory".
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createCortex, flushClaudeStop } from "./index.js";

let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", async () => {
  try {
    const payload = JSON.parse(raw || "{}");
    const filePath = payload?.tool_input?.file_path ?? "";
    if (!filePath.toLowerCase().includes("memory")) process.exit(0);

    const hub = createCortex({
      dbPath: process.env.CORTEX_DB || join(homedir(), ".cortex", "cortex.sqlite"),
    });
    await flushClaudeStop(hub, {
      ...payload,
      cwd: process.env.CORTEX_PROJECT || payload.cwd || process.cwd(),
    });
    hub.close();
  } catch {
    // never block Claude
  }
  process.exit(0);
});
