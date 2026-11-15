import { recordOfKey, vectorKey } from "./chunk.js";

export class NullEmbeddingProvider {
  available() {
    return false;
  }

  similarity() {
    return 0;
  }
}

function features(text) {
  const tokens = String(text || "").toLowerCase().match(/[a-z0-9_-]{2,}/g) || [];
  return [...new Set([...tokens, ...tokens.slice(1).map((token, index) => `${tokens[index]} ${token}`)])];
}

function hash(value, seed) {
  let result = (2166136261 ^ seed) >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    result = Math.imul(result ^ value.charCodeAt(index), 16777619) >>> 0;
  }
  return result;
}

export function float32ToBlob(vector) {
  return Buffer.from(new Float32Array(vector).buffer);
}

export function blobToFloat32(blob) {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

function cosine(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i]; }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom ? dot / denom : 0;
}

// Semantic scoring via a local Ollama embedding model (2026-07-19 A/B on the real DB:
// hits@5 8/9 median rank 1, vs 5/9 median 4 for MinHash). Doc vectors are precomputed by
// embedMissing() (server sweep); prepare(query) embeds the query once before a search.
// Anywhere that skips prepare(), or any row without a stored vector, scores via the
// MinHash fallback — Ollama being down can never break or block a search.
export class OllamaEmbeddingProvider {
  constructor({
    storage,
    fallback = new LocalMinHashEmbeddingProvider(),
    baseUrl = process.env.CORTEX_OLLAMA_URL || "http://127.0.0.1:11434",
    model = process.env.CORTEX_EMBED_MODEL || "nomic-embed-text",
    fetchImpl = fetch,
  } = {}) {
    this.storage = storage;
    this.fallback = fallback;
    this.baseUrl = baseUrl;
    this.model = model;
    this.fetchImpl = fetchImpl;
    this.queryKey = null;
    this.queryVec = null;
    this.docVecs = new Map();
  }

  // The semantic term always scores something (cosine or fallback), so search never
  // reweights it away like it does for NullEmbeddingProvider.
  available() {
    return true;
  }

  async embed(inputs, { prefix, timeoutMs }) {
    const response = await this.fetchImpl(`${this.baseUrl}/api/embed`, {
      method: "POST",
      // No num_gpu override: let Ollama place the model. On this machine's RTX 5060 Ti
      // that is ~9ms/doc vs ~117ms on CPU (2026-07-26); CPU-only hosts still work.
      // keep_alive -1: cold load is ~6s but prepare() aborts at 2s, so with the default
      // 5m keep_alive the first recall after any idle gap silently degraded to MinHash.
      // The model is 376MB — keeping it resident costs nothing.
      body: JSON.stringify({ model: this.model, keep_alive: -1, input: inputs.map((text) => prefix + text) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`ollama embed ${response.status}`);
    return (await response.json()).embeddings;
  }

  // Call (and await) before a search to enable cosine scoring for that query. Failure is
  // silent by design: the recall hook path must never hang or throw on a down Ollama.
  async prepare(query) {
    this.queryKey = null;
    this.queryVec = null;
    try {
      const [vector] = await this.embed([String(query || "")], { prefix: "search_query: ", timeoutMs: 2000 });
      // ponytail: reload the whole doc-vector cache when the row count changes — vectors are
      // immutable per record_id, and 2k rows load in single-digit ms. Revisit if the corpus 10x's.
      if (this.storage.countEmbeddings() !== this.docVecs.size) {
        // keyed by vector key ("<id>" for chunk 0, "<id>#<n>" for later chunks; chunk.js)
        this.docVecs = new Map(this.storage.allEmbeddings().map(({ recordId, vector: blob }) => [recordId, blobToFloat32(blob)]));
        this.recordVecs = new Map();
        for (const [key, vec] of this.docVecs) {
          const id = recordOfKey(key);
          if (!this.recordVecs.has(id)) this.recordVecs.set(id, []);
          this.recordVecs.get(id).push(vec);
        }
      }
      this.queryKey = String(query || "");
      this.queryVec = vector;
    } catch { /* fall back to MinHash for this query */ }
  }

  similarity(query, text, recordId) {
    if (this.queryVec && this.queryKey === String(query || "")) {
      const docs = this.recordVecs?.get(recordId);
      // ponytail: clamped raw cosine, best chunk wins; rows without a vector score on the
      // MinHash scale for one sweep cycle (≤60s) until embedMissing catches them.
      if (docs?.length) return Math.max(0, ...docs.map((vec) => cosine(this.queryVec, vec)));
    }
    return this.fallback.similarity(query, text);
  }

  // Server sweep: prune vectors for deleted records, embed chunks that lack one. Bounded
  // per tick so the first backfill (~2k rows at 185ms/doc) spreads across a few ticks.
  async embedMissing({ limit = 256, batch = 32 } = {}) {
    this.storage.pruneOrphanEmbeddings();
    const missing = this.storage.missingEmbeddingChunks(limit);
    let embedded = 0;
    for (let index = 0; index < missing.length; index += batch) {
      const chunk = missing.slice(index, index + batch);
      const vectors = await this.embed(
        chunk.map((row) => `${row.title || ""} ${row.body || ""}`.slice(0, 1500)),
        { prefix: "search_document: ", timeoutMs: 120_000 },
      );
      chunk.forEach((row, i) => this.storage.putEmbedding(vectorKey(row.recordId, row.chunkIndex), this.model, float32ToBlob(vectors[i])));
      embedded += chunk.length;
    }
    return embedded;
  }
}

export class LocalMinHashEmbeddingProvider {
  constructor(size = 64) {
    this.size = size;
    this.cache = new Map();
  }

  available() {
    return true;
  }

  signature(text) {
    const key = String(text || "");
    if (this.cache.has(key)) return this.cache.get(key);
    const values = features(key);
    const signature = values.length
      ? Array.from({ length: this.size }, (_, seed) =>
        values.reduce((minimum, value) => Math.min(minimum, hash(value, seed)), 0xffffffff))
      : [];
    this.cache.set(key, signature);
    return signature;
  }

  similarity(left, right) {
    const a = this.signature(left);
    const b = this.signature(right);
    if (!a.length || !b.length) return 0;
    const minHash = a.reduce((matches, value, index) => matches + (value === b[index] ? 1 : 0), 0) / a.length;
    const leftFeatures = features(left);
    const rightFeatures = new Set(features(right));
    const containment = leftFeatures.filter((value) => rightFeatures.has(value)).length
      / Math.min(leftFeatures.length, rightFeatures.size);
    return Math.max(minHash, containment);
  }
}
