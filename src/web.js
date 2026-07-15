#!/usr/bin/env node
// Node version guard MUST run before anything imports node:sqlite (storage.js), or the
// import chain throws ERR_UNKNOWN_BUILTIN_MODULE first and buries this clear message.
// Static imports hoist above top-level code, so the real entry is loaded dynamically below.
if (Number(process.versions.node.split(".")[0]) < 25) {
  console.error(`Cortex needs Node >= 25 (node:sqlite); found ${process.version}`);
  process.exit(1);
}

const { createCortex } = await import("./index.js");
const { ensureSearchIndex } = await import("./indexer.js");
const { ensureRecordLinks } = await import("./linker.js");
const { createCortexServer } = await import("./server.js");

const hub = createCortex({ dbPath: process.env.CORTEX_DB });
ensureRecordLinks(hub.storage);
ensureSearchIndex(hub.storage);
const swept = hub.sweep();
if (swept.sessionEventsDeleted || swept.metricsDeleted) {
  console.log(`Swept ${swept.sessionEventsDeleted} expired session events, ${swept.metricsDeleted} old metrics`);
}
// Opt-in for non-loopback binding (containers, LAN). server.js still refuses this
// unless CORTEX_TOKEN is set, so writes can never be exposed unauthenticated.
const allowRemote = ["1", "true"].includes(process.env.CORTEX_ALLOW_REMOTE || "");
const application = createCortexServer({
  hub,
  host: process.env.CORTEX_HOST || "127.0.0.1",
  port: Number(process.env.CORTEX_PORT || 4317),
  allowRemote,
});
const address = await application.start();
console.log(`Cortex: http://${address.host}:${address.port}`);
if (!process.env.CORTEX_TOKEN) {
  console.warn("CORTEX_TOKEN is not set — every API write will be rejected with 401 until it is (see SETUP.md).");
}

async function shutdown() {
  await application.stop();
  hub.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
