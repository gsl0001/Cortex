import "@testing-library/jest-dom/vitest";

// Node 25's built-in `localStorage` global shadows jsdom's with a stub that
// throws unless `--localstorage-file` is set (see `node --help`). Replace it
// with a plain in-memory Storage so tests can use localStorage normally.
class MemoryStorage {
  #data = new Map();
  getItem(key) { return this.#data.has(key) ? this.#data.get(key) : null; }
  setItem(key, value) { this.#data.set(key, String(value)); }
  removeItem(key) { this.#data.delete(key); }
  clear() { this.#data.clear(); }
}
Object.defineProperty(window, "localStorage", { value: new MemoryStorage(), configurable: true });
