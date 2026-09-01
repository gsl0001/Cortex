import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCortex } from "../src/index.js";
import { drainIndexJobs } from "../src/indexer.js";
import { searchMemory } from "../src/search.js";
import { OllamaEmbeddingProvider, LocalMinHashEmbeddingProvider, float32ToBlob, blobToFloat32 } from "../src/embeddingProvider.js";

async function withHub(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cortex-embed-"));
  const hub = createCortex({ dbPath: join(dir, "embed.sqlite") });
  try { await fn(hub, dir); } finally { hub.close(); await rm(dir, { recursive: true, force: true }); }
}

// Deterministic fake Ollama: any input mentioning "alpha" → [1,0], otherwise [0,1].
const vecFor = (text) => (text.includes("alpha") ? [1, 0] : [0, 1]);
const stubFetch = async (url, options) => ({
  ok: true,
  json: async () => ({ embeddings: JSON.parse(options.body).input.map(vecFor) }),
});
const failingFetch = async () => { throw new Error("connection refused"); };

test("embedding vectors round-trip through storage as float32 blobs", async () => {
  await withHub(async (hub) => {
    hub.storage.putEmbedding("rec-1", "test-model", float32ToBlob([0.5, -0.25, 1]));
    assert.equal(hub.storage.countEmbeddings(), 1);
    const [row] = hub.storage.allEmbeddings();
    assert.equal(row.recordId, "rec-1");
    assert.deepEqual([...blobToFloat32(row.vector)], [0.5, -0.25, 1]);
  });
});

test("embedMissing backfills chunks, is idempotent, and prunes orphans", async () => {
  await withHub(async (hub, dir) => {
    hub.captureCandidate({ projectPath: dir, agent: "codex", message: "Fixed alpha cache stampede. Verification: npm test passed." });
    hub.captureCandidate({ projectPath: dir, agent: "codex", message: "Fixed beta queue drain. Verification: npm test passed." });
    drainIndexJobs(hub.storage);
    const provider = new OllamaEmbeddingProvider({ storage: hub.storage, fetchImpl: stubFetch });
    assert.equal(await provider.embedMissing(), 2);
    assert.equal(await provider.embedMissing(), 0); // nothing left to embed
    assert.equal(hub.storage.countEmbeddings(), 2);
    hub.storage.putEmbedding("ghost-record", "test-model", float32ToBlob([1, 1]));
    await provider.embedMissing();
    assert.equal(hub.storage.allEmbeddings().some((row) => row.recordId === "ghost-record"), false);
  });
});

test("prepared provider scores by cosine per record id and falls back per row and per query", async () => {
  await withHub(async (hub, dir) => {
    const alpha = hub.captureCandidate({ projectPath: dir, agent: "codex", message: "Fixed alpha cache stampede. Verification: npm test passed." });
    const beta = hub.captureCandidate({ projectPath: dir, agent: "codex", message: "Fixed beta cache drain. Verification: npm test passed." });
    drainIndexJobs(hub.storage);
    const provider = new OllamaEmbeddingProvider({ storage: hub.storage, fetchImpl: stubFetch });
    await provider.embedMissing();
    await provider.prepare("alpha stampede");
    assert.equal(provider.similarity("alpha stampede", "ignored", alpha.recordId), 1); // cosine([1,0],[1,0])
    assert.equal(provider.similarity("alpha stampede", "ignored", beta.recordId), 0); // cosine([1,0],[0,1])
    // a record without a stored vector scores on the MinHash fallback
    const minhash = new LocalMinHashEmbeddingProvider();
    assert.equal(provider.similarity("alpha stampede", "alpha stampede text", "no-vector-id"), minhash.similarity("alpha stampede", "alpha stampede text"));
    // a different query than the prepared one falls back wholesale (stale vector must not leak)
    assert.equal(provider.similarity("unrelated", "alpha stampede text", alpha.recordId), minhash.similarity("unrelated", "alpha stampede text"));
  });
});

test("prepare failure is silent and search still works via MinHash fallback", async () => {
  await withHub(async (hub, dir) => {
    hub.captureCandidate({ projectPath: dir, agent: "codex", message: "Fixed alpha cache stampede. Verification: npm test passed." });
    drainIndexJobs(hub.storage);
    const provider = new OllamaEmbeddingProvider({ storage: hub.storage, fetchImpl: failingFetch });
    await provider.prepare("alpha cache"); // must not throw
    const { results, diagnostics } = searchMemory(hub.storage, { projectPath: dir, query: "alpha cache", embeddingProvider: provider });
    assert.equal(diagnostics.semanticAvailable, true);
    assert.equal(results.length, 1);
    const minhash = new LocalMinHashEmbeddingProvider();
    assert.equal(results[0].scoreComponents.semantic, minhash.similarity("alpha cache", `${results[0].title} ${results[0].excerpt}`));
  });
});

test("searchMemory feeds record ids to the provider so cosine reaches score components", async () => {
  await withHub(async (hub, dir) => {
    const alpha = hub.captureCandidate({ projectPath: dir, agent: "codex", message: "Fixed alpha cache stampede. Verification: npm test passed." });
    const beta = hub.captureCandidate({ projectPath: dir, agent: "codex", message: "Fixed beta cache drain. Verification: npm test passed." });
    drainIndexJobs(hub.storage);
    const provider = new OllamaEmbeddingProvider({ storage: hub.storage, fetchImpl: stubFetch });
    await provider.embedMissing();
    await provider.prepare("cache alpha semantics");
    const { results } = searchMemory(hub.storage, { projectPath: dir, query: "cache alpha semantics", embeddingProvider: provider });
    const semanticOf = (id) => results.find((r) => r.id === id).scoreComponents.semantic;
    assert.equal(semanticOf(alpha.recordId), 1);
    assert.equal(semanticOf(beta.recordId), 0);
  });
});
