#!/usr/bin/env node
// Stdio MCP server exposing Cortex to coding agents.
// HTTP client only: authentication, capture policy, search, and task transitions
// all stay in the HTTP server — this file just translates tool calls.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.CORTEX_URL || "http://127.0.0.1:4317").replace(/\/$/, "");
const TOKEN = process.env.CORTEX_TOKEN || "";
const AGENT = process.env.CORTEX_AGENT || "mcp-agent";

async function request(method, path, { query, body } = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      },
      body: body ? JSON.stringify({ agent: AGENT, ...body }) : undefined,
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error(`Memory Hub server is unavailable at ${BASE_URL} — start it with npm start.`);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `Memory Hub request failed (${response.status})`);
  return payload;
}

function asText(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({ name: "cortex", version: "0.1.0" });

server.registerTool("memory_search", {
  description: "Search the Cortex for past fixes, research, decisions, and lessons relevant to a query. Use before starting work to avoid repeating solved problems.",
  inputSchema: {
    projectPath: z.string().describe("Absolute path of the project to search"),
    query: z.string().describe("What to look for, e.g. an error message or topic"),
    maxTokens: z.number().optional().describe("Token budget for results (default 1500)"),
  },
}, async ({ projectPath, query, maxTokens }) =>
  asText(await request("GET", "/api/v1/search", { query: { project: projectPath, query, maxTokens } })));

server.registerTool("memory_remember", {
  description: "Save a fix, research finding, or decision to permanent memory. Include verification evidence (e.g. 'Verification: npm test passed') so the record is trusted.",
  inputSchema: {
    projectPath: z.string().describe("Absolute path of the project"),
    message: z.string().describe("What to remember, in one or two sentences"),
  },
}, async ({ projectPath, message }) =>
  asText(await request("POST", "/api/v1/capture", { body: { projectPath, message } })));

server.registerTool("memory_recall_task", {
  description: "List this project's tracked tasks, or fetch one by id.",
  inputSchema: {
    projectPath: z.string().describe("Absolute path of the project"),
    taskId: z.string().optional().describe("Return only the task with this id"),
  },
}, async ({ projectPath, taskId }) => {
  const tasks = await request("GET", "/api/v1/tasks", { query: { project: projectPath } });
  return asText(taskId ? tasks.filter((task) => task.id === taskId) : tasks);
});

server.registerTool("memory_update_task", {
  description: "Transition a tracked task: claim it, block it with a reason, submit for review, or complete it with evidence.",
  inputSchema: {
    taskId: z.string().describe("Task id"),
    action: z.enum(["claim", "block", "review", "complete"]).describe("Transition to apply"),
    reason: z.string().optional().describe("Required when blocking"),
    evidence: z.string().optional().describe("Required when completing; verification evidence"),
    commitSha: z.string().optional().describe("Commit that implements the work"),
  },
}, async ({ taskId, action, reason, evidence, commitSha }) =>
  asText(await request("PATCH", `/api/v1/tasks/${encodeURIComponent(taskId)}`, {
    body: { action, reason, evidence, commitSha },
  })));

server.registerTool("memory_lesson", {
  description: "Record a durable lesson about how to work in this project (e.g. 'start the backend before trusting the Vite proxy'). Lessons surface in every future session brief.",
  inputSchema: {
    projectPath: z.string().describe("Absolute path of the project"),
    lesson: z.string().describe("The lesson, stated as an imperative one-liner"),
  },
}, async ({ projectPath, lesson }) =>
  asText(await request("POST", "/api/v1/lessons", { body: { projectPath, lesson } })));

await server.connect(new StdioServerTransport());
