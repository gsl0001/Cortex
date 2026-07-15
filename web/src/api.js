export async function api(path, options = {}) {
  const token = localStorage.getItem("cortex_token");
  const headers = { ...(options.headers || {}), ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const response = await fetch(`/api/v1${path}`, { ...options, headers });
  if (response.status === 401) {
    // ponytail: prompt() over a login screen — one token, one user, one line.
    const supplied = window.prompt("Cortex token:");
    if (supplied) {
      localStorage.setItem("cortex_token", supplied);
      return api(path, options);
    }
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || `Request failed (${response.status})`);
  return body;
}
