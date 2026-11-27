// All controller tabs observe the same queue. Dismissal belongs to this tab.
export function mountUpNext({ document, request, setStatusMessage, canStart, readOnly, relPath }) {
  const list = document.getElementById("up-next-items");
  const popup = document.getElementById("upload-offer");
  const title = document.getElementById("upload-offer-title");
  const start = document.getElementById("upload-offer-start");
  const dismiss = document.getElementById("upload-offer-dismiss");
  const rows = new Map();
  let current = { items: [] };
  let offered = null;
  const dismissed = new Set();
  let timer;
  let busy = false;
  let transferText = "";
  let offerDeadline = 0;
  let shownOffer = null;
  const countdown = document.getElementById("upload-offer-countdown");
  const facts = document.getElementById("upload-offer-facts");
  const notes = document.getElementById("upload-offer-notes");
  let summaryFor = null;

  async function act(item, action, fromOffer = false) {
    if (!item || busy || readOnly()) return;
    if (action === "start" && !fromOffer && !globalThis.confirm("Start " + relPath(item.path) + "?")) return;
    busy = true;
    render();
    const label = relPath(item.path);
    const message = (text, kind, options = {}) => setStatusMessage("up-next-action", text, kind, { force: true, ...options });
    message((action === "start" ? "Starting " : "Removing from Up next: ") + label, "info", { timeoutMs: 0 });
    try {
      const response = await request("/api/up-next/" + action, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: item.path, id: item.id, md5: item.md5, from_offer: fromOffer }),
      });
      const result = await response.json();
      if (action === "remove") {
        apply(result);
        if (result.items.some((entry) => entry.id === item.id)) throw new Error("File still listed in Up next");
        message("Removed from Up next: " + label, "ok");
      } else {
        if (offered?.id === item.id) offered = null;
        current.items = current.items.filter((entry) => entry.id !== item.id);
        message(result.message, result.verified ? "ok" : "info");
      }
    } catch (error) {
      message(label + ": " + error.message, "error");
    } finally {
      busy = false;
      render();
    }
  }

  function makeRow(item) {
    const row = document.createElement("li");
    const name = document.createElement("span");
    const run = document.createElement("button");
    const remove = document.createElement("button");
    run.textContent = "Start job";
    remove.textContent = "Remove";
    run.type = remove.type = "button";
    run.onclick = () => act(item, "start");
    remove.onclick = () => act(item, "remove");
    run.setAttribute("aria-label", "Start " + relPath(item.path));
    remove.setAttribute("aria-label", "Remove " + relPath(item.path) + " from Up next");
    row.append(name, run, remove);
    return { row, name, run, remove };
  }

  function render() {
    if (!list || !popup) return;
    const ids = new Set(current.items.map((item) => item.id));
    for (const id of dismissed) if (!ids.has(id)) dismissed.delete(id);
    for (const [id, value] of rows) {
      if (!ids.has(id)) { value.row.remove(); rows.delete(id); }
    }
    current.items.forEach((item, index) => {
      const value = rows.get(item.id) || makeRow(item);
      rows.set(item.id, value);
      const path = relPath(item.path);
      if (value.name.textContent !== path) value.name.textContent = path;
      value.run.disabled = busy || readOnly() || !canStart() || !item.ready;
      value.remove.disabled = busy || readOnly();
      if (list.children[index] !== value.row) list.insertBefore(value.row, list.children[index] || null);
    });
    document.getElementById("up-next-count").textContent = String(current.items.length);
    popup.hidden = !offered || dismissed.has(offered.id) || !canStart() || readOnly();
    if (!popup.hidden) {
      title.textContent = relPath(offered.path);
      // Run the countdown bar over the time left on this offer.
      if (shownOffer !== offered.id && countdown?.style) {
        shownOffer = offered.id;
        countdown.style.animation = "none";
        void countdown.offsetWidth;
        countdown.style.animation = `upload-offer-countdown ${Math.max(0, offerDeadline - Date.now())}ms linear forwards`;
      }
      loadSummary(offered);
    } else {
      shownOffer = null;
    }
    start.disabled = busy;
    start.setAttribute("aria-busy", String(busy));
  }

  // Estimated time, tools and the program's own header comments, when the
  // file can be read; the prompt works the same without them.
  async function loadSummary(item) {
    const key = item.id + ":" + item.md5;
    if (summaryFor === key || !facts || !notes) return;
    summaryFor = key;
    facts.hidden = notes.hidden = true;
    let summary;
    try {
      const query = "?path=" + encodeURIComponent(item.path) + "&md5=" + encodeURIComponent(item.md5);
      summary = await (await request("/api/up-next/summary" + query)).json();
    } catch {
      return;
    }
    if (summaryFor !== key) return;
    const rows = [];
    if (summary.estimated_ms > 0) rows.push(["Estimated time", formatDuration(summary.estimated_ms)]);
    const tools = (summary.tools || []).filter((tool) => tool.number > 0);
    if (tools.length) rows.push([tools.length === 1 ? "Tool" : "Tools", tools.map((tool) => "T" + tool.number + (tool.name ? " " + tool.name : "")).join(", ")]);
    facts.replaceChildren(...rows.flatMap(([label, value]) => {
      const term = document.createElement("dt");
      const detail = document.createElement("dd");
      term.textContent = label;
      detail.textContent = value;
      return [term, detail];
    }));
    facts.hidden = !rows.length;
    notes.replaceChildren(...(summary.notes || []).map((text) => {
      const line = document.createElement("li");
      line.textContent = text;
      return line;
    }));
    notes.hidden = !(summary.notes || []).length;
  }

  function apply(snapshot) {
    if (!Array.isArray(snapshot?.items)) return;
    current = snapshot;
    clearTimeout(timer);
    offered = current.items.find((item) => item.id === current.offer_id) || null;
    if (offered && current.offer_ms > 0) {
      offerDeadline = Date.now() + current.offer_ms;
      timer = setTimeout(() => { offered = null; render(); }, current.offer_ms);
    } else offered = null;
    showTransfer(current.transfer);
    render();
  }

  function showTransfer(t) {
    const text = t ? `Uploading ${relPath(t.path)} to CNC · ${t.percent}%` : "";
    if (text !== transferText) {
      transferText = text;
      setStatusMessage("cnc-transfer", text, "info", { timeoutMs: 0 });
    }
  }

  if (start) {
    // A transfer can replace the prompt between pointer-down and activation.
    let pressedID;
    start.onpointerdown = () => { pressedID = offered?.id; };
    start.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") pressedID = offered?.id;
    };
    start.onblur = start.onpointercancel = () => { pressedID = undefined; };
    start.onclick = () => {
      const matches = pressedID === undefined || pressedID === offered?.id;
      pressedID = undefined;
      if (matches && !popup.hidden) return act(offered, "start", true);
    };
  }
  if (dismiss) dismiss.onclick = () => { if (offered) dismissed.add(offered.id); render(); };
  return { apply, render, showTransfer };
}

export function formatDuration(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `about ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `about ${hours} h${rest ? ` ${rest} min` : ""}`;
}
