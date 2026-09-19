export async function request(url, opts = {}) {
  const resp = await fetch(url, { credentials: "same-origin", cache: "no-store", ...opts });
  if (!resp.ok) {
    let detail = "";
    try {
      const body = await resp.json();
      detail = body.error || JSON.stringify(body);
    } catch {
      detail = await resp.text();
    }
    throw new Error(detail || resp.statusText || "HTTP " + resp.status);
  }
  return resp;
}
