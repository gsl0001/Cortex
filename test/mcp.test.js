import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createCortex } from "../src/index.js";
import { createCortexServer } from "../src/server.js";

// Boots a real Cortex HTTP server, then spawns src/mcp.js over stdio pointed at it.
async function withMcp(run, { env = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "cortex-mcp-"));
  const hub = createCortex({ dbPath: join(dir, "mcp.sqlite") });
  const staticDir = join(dir, "dist");
  await mkdir(staticDir);
  await writeFile(join(staticDir, "index.html"), "<main>UI</main>");
  process.env.CORTEX_TOKEN = "test-secret";
  const server = createCortexServer({ hub, staticDir });
  const address = await server.start();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("src/mcp.js")],
    env: {
      ...process.env,
      CORTEX_URL: `http://${address.host}:${address.port}`,
      CORTEX_TOKEN: "test-secret",
      CORTEX_AGENT: "mcp-test-agent",
      ...env,
    },
  });
  const client = new Client({ name: "mcp-test", version: "0.0.1" });
  try {
    await client.connect(transport);
    await run({ client, dir, hub });
  } finally {
    await client.close().catch(() => {});
    await server.stop();
    hub.close();
    delete process.env.CORTEX_TOKEN;
    await rm(dir, { recursive: true, force: true });
  }
}

function textOf(result) {
  return result.content.map((c) => c.text).join("\n");
}

test("MCP server lists the six memory tools", async () => {
  await withMcp(async ({ client }) => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["memory_get", "memory_lesson", "memory_recall_task", "memory_remember", "memory_search", "memory_update_task"],
    );
  });
});

test("memory_remember captures through the HTTP policy and memory_search finds it", async () => {
  await withMcp(async ({ client, dir }) => {
    const remembered = await client.callTool({
      name: "memory_remember",
      arguments: { projectPath: dir, message: "Fixed flaky socket teardown. Verification: npm test passed" },
    });
    assert.match(textOf(remembered), /"action":\s*"accepted"/);

    const found = await client.callTool({
      name: "memory_search",
      arguments: { projectPath: dir, query: "socket teardown" },
    });
    assert.match(textOf(found), /socket teardown/);
  });
});

test("memory_recall_task lists tasks and filters by taskId client-side", async () => {
  await withMcp(async ({ client, dir, hub }) => {
    const a = hub.addTask({ type: "chore", projectPath: dir, title: "Task A", status: "ready" });
    hub.addTask({ type: "chore", projectPath: dir, title: "Task B", status: "ready" });

    const all = await client.callTool({ name: "memory_recall_task", arguments: { projectPath: dir } });
    assert.match(textOf(all), /Task A/);
    assert.match(textOf(all), /Task B/);

    const one = await client.callTool({ name: "memory_recall_task", arguments: { projectPath: dir, taskId: a.id } });
    assert.match(textOf(one), /Task A/);
    assert.doesNotMatch(textOf(one), /Task B/);
  });
});

test("memory_update_task claims and parks in review, but an agent may not complete to done", async () => {
  await withMcp(async ({ client, dir, hub }) => {
    const task = hub.addTask({ type: "chore", projectPath: dir, title: "Do it", status: "ready" });
    const claimed = await client.callTool({
      name: "memory_update_task",
      arguments: { taskId: task.id, action: "claim" },
    });
    assert.match(textOf(claimed), /"status":\s*"in_progress"/);

    // the MCP client is an agent (agent="mcp-agent"); completing to done is rejected — agents park in review
    const rejected = await client.callTool({
      name: "memory_update_task",
      arguments: { taskId: task.id, action: "complete", evidence: "verified by mcp test" },
    });
    assert.equal(rejected.isError, true);
    assert.match(textOf(rejected), /may not set a task to 'done'/);
    assert.equal(hub.storage.getTask(task.id).status, "in_progress");

    const reviewed = await client.callTool({
      name: "memory_update_task",
      arguments: { taskId: task.id, action: "review", evidence: "verified by mcp test" },
    });
    assert.match(textOf(reviewed), /"status":\s*"review"/);
  });
});

test("memory_lesson stores a lesson (served by JIT, no longer injected into the brief)", async () => {
  await withMcp(async ({ client, dir, hub }) => {
    const saved = await client.callTool({
      name: "memory_lesson",
      arguments: { projectPath: dir, lesson: "Start the backend on 4317 before trusting the Vite proxy." },
    });
    assert.match(textOf(saved), /"action":\s*"accepted"/);
    // audit III: lessons dropped from the brief (0/70 ever cited); still stored + JIT-served
    assert.equal(hub.storage.listLessons(dir).length, 1);
    assert.doesNotMatch(hub.buildBrief({ projectPath: dir }).text, /4317 before trusting/);
  });
});

test("API errors propagate as tool errors with the API message", async () => {
  await withMcp(async ({ client }) => {
    const result = await client.callTool({
      name: "memory_update_task",
      arguments: { taskId: "missing-task", action: "complete", evidence: "x" },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /not found/i);
  });
});

test("network failure reports the hub as unavailable", async () => {
  await withMcp(async ({ client, dir }) => {
    // point nowhere: tool call must fail fast with an availability message
    const result = await client.callTool({
      name: "memory_search",
      arguments: { projectPath: dir, query: "anything" },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /unavailable/i);
  }, { env: { CORTEX_URL: "http://127.0.0.1:9" } });
});
