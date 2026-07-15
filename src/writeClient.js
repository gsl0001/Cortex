const DEFAULT_TIMEOUT_MS = 2000;

// ponytail: thin fetch wrapper around the write API's POST endpoints.
// One method today (capture) — add more only when another adapter needs one.
export function createWriteClient({
  host = process.env.CORTEX_HOST || "127.0.0.1",
  port = Number(process.env.CORTEX_PORT || 4317),
  token = process.env.CORTEX_TOKEN || "",
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  async function post(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`http://${host}:${port}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        // the server responded — it rejected the write (validation, policy, auth), which is a
        // different failure mode than "the server is unreachable". Marked so callers can tell
        // the two apart instead of treating a real rejection as grounds to fall back to a
        // second, uncoordinated write attempt.
        const payload = await response.json().catch(() => ({}));
        const error = new Error(payload?.error?.message || `write request failed: ${response.status}`);
        error.isHttpRejection = true;
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    capture: (body) => post("/api/v1/capture", body),
  };
}
