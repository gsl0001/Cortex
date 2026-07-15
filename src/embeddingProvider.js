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
