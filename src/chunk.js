// Split a long record body into overlapping windows so a fact buried in a 9k-character
// research finding is both findable (FTS/bm25 and a per-chunk vector) and servable (the
// matched chunk is the excerpt, so it fits the pack budget). Short bodies stay one chunk.
export const CHUNK_CHARS = 1200;
export const CHUNK_OVERLAP = 150;

export function chunkText(body, { size = CHUNK_CHARS, overlap = CHUNK_OVERLAP } = {}) {
  const text = String(body || "");
  if (text.length <= size) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      // prefer a sentence boundary in the back half of the window
      const cut = text.lastIndexOf(". ", end);
      if (cut > start + size / 2) end = cut + 1;
    }
    chunks.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter(Boolean);
}

// Vector rows are keyed by record id for chunk 0 and "<id>#<n>" for later chunks, so the
// existing single-vector rows stay valid without a table migration.
export const vectorKey = (recordId, chunkIndex) => chunkIndex ? `${recordId}#${chunkIndex}` : recordId;
export const recordOfKey = (key) => { const i = key.indexOf("#"); return i < 0 ? key : key.slice(0, i); };
export const chunkOfKey = (key) => { const i = key.indexOf("#"); return i < 0 ? 0 : Number(key.slice(i + 1)); };
