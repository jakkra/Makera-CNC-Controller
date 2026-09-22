export function lineMatchesFilter(ln, { filter = "all", search = "" } = {}) {
  const q = String(search || "").trim().toLowerCase();
  if (q) {
    const haystack = `${ln?.source || ""} ${ln?.dir || ""} ${ln?.text || ""}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  switch (filter) {
  case "send":
  case "recv":
    return ln?.dir === filter;
  case "api":
  case "controller":
  case "jog":
    return ln?.source === filter;
  case "error":
    return /^(error|alarm)/i.test(ln?.text || "");
  default:
    return true;
  }
}

export function visibleGcodeLines(lines, options) {
  return (Array.isArray(lines) ? lines : []).filter((ln) => lineMatchesFilter(ln, options));
}

export function formatLogLine(ln) {
  const when = ln?.time ? new Date(ln.time).toISOString() : "";
  const arrow = ln?.dir === "send" ? ">" : "<";
  return `${when} ${ln?.source || ""} ${arrow} ${ln?.text || ""}`.trim();
}

export function createGcodeLogFeature({
  documentRef = globalThis.document,
  navigatorRef = globalThis.navigator,
  URLRef = globalThis.URL,
  BlobCtor = globalThis.Blob,
  setTimeoutRef = globalThis.setTimeout,
  setNotice = () => {},
  getLines = () => [],
  setLines,
  getSeqs,
  getFilter = () => "all",
  getSearch = () => "",
  getAutoscroll = () => true,
  getPaused = () => false,
  setFilter = () => {},
  setSearch = () => {},
  setAutoscroll = () => {},
  setPaused = () => {},
  queueSaveUISettings = () => {},
  maxLines = 500,
  escapeHtml = (value) => String(value ?? ""),
} = {}) {
  function logElement() {
    return documentRef?.getElementById?.("gcode-log") || null;
  }

  function matches(ln) {
    return lineMatchesFilter(ln, { filter: getFilter(), search: getSearch() });
  }

  function appendGcodeLineElement(ln, keepScroll = true) {
    const log = logElement();
    if (!log) return;
    const autoscroll = getAutoscroll() !== false;
    const atBottom = autoscroll && (!keepScroll || log.scrollHeight - log.scrollTop - log.clientHeight < 8);
    const div = documentRef.createElement("div");
    const isErr = ln?.dir === "recv" && /^(error|alarm)/i.test(ln?.text || "");
    div.className = (ln?.dir || "") + (isErr ? " err-line" : "");
    const arrow = ln?.dir === "send" ? ">" : "<";
    div.innerHTML = `<span class="src">${escapeHtml(ln?.source)} ${arrow}</span> ${escapeHtml(ln?.text)}`;
    log.appendChild(div);
    while (log.childNodes.length > maxLines) log.removeChild(log.firstChild);
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  function appendGcodeLine(ln) {
    const seqs = getSeqs?.();
    if (!ln || seqs?.has?.(ln.seq)) return;
    seqs?.add?.(ln.seq);
    const lines = getLines();
    lines.push(ln);
    if (lines.length > maxLines) {
      const drop = lines.splice(0, lines.length - maxLines);
      for (const old of drop) seqs?.delete?.(old.seq);
    }
    if (getPaused()) return;
    if (!matches(ln)) return;
    appendGcodeLineElement(ln);
  }

  async function copyVisibleLog() {
    const text = visibleGcodeLines(getLines(), { filter: getFilter(), search: getSearch() }).map(formatLogLine).join("\n");
    try {
      if (!navigatorRef?.clipboard) throw new Error("clipboard unavailable");
      await navigatorRef.clipboard.writeText(text);
      setNotice("Copied visible log lines.", "ok", "log-copy");
    } catch {
      setNotice("Copy failed.", "error", "log-copy");
    }
  }

  function exportVisibleLog() {
    const text = visibleGcodeLines(getLines(), { filter: getFilter(), search: getSearch() }).map((ln) => JSON.stringify(ln)).join("\n") + "\n";
    const blob = new BlobCtor([text], { type: "application/x-ndjson" });
    const a = documentRef.createElement("a");
    a.href = URLRef.createObjectURL(blob);
    a.download = "cnc-proxy-log.ndjson";
    documentRef.body.appendChild(a);
    a.click();
    a.remove();
    setTimeoutRef(() => URLRef.revokeObjectURL(a.href), 1000);
  }

  function bindInteractions({
    copyVisibleLog: copyVisibleLogHandler = copyVisibleLog,
    exportVisibleLog: exportVisibleLogHandler = exportVisibleLog,
    clearGcodeLog: clearGcodeLogHandler = clearGcodeLog,
  } = {}) {
    documentRef.getElementById("log-filter").onchange = (e) => {
      setFilter(e.target.value);
      queueSaveUISettings();
      renderGcodeLog();
    };
    documentRef.getElementById("log-search").oninput = (e) => {
      setSearch(e.target.value);
      renderGcodeLog();
    };
    documentRef.getElementById("log-autoscroll").onchange = (e) => {
      setAutoscroll(e.target.checked);
      queueSaveUISettings();
    };
    documentRef.getElementById("log-pause").onchange = (e) => {
      setPaused(e.target.checked);
      if (!e.target.checked) renderGcodeLog();
    };
    documentRef.getElementById("log-copy").onclick = copyVisibleLogHandler;
    documentRef.getElementById("log-export").onclick = exportVisibleLogHandler;
    documentRef.getElementById("log-clear").onclick = clearGcodeLogHandler;
  }

  function renderGcodeLog() {
    const log = logElement();
    if (!log) return;
    const autoscroll = getAutoscroll() !== false;
    const scrollTop = log.scrollTop;
    log.innerHTML = "";
    for (const ln of getLines()) {
      if (matches(ln)) appendGcodeLineElement(ln, false);
    }
    log.scrollTop = autoscroll ? log.scrollHeight : scrollTop;
  }

  function clearGcodeLog() {
    getSeqs?.()?.clear?.();
    if (setLines) setLines([]);
    const log = logElement();
    if (log) log.innerHTML = "";
  }

  return {
    appendGcodeLine,
    appendGcodeLineElement,
    bindInteractions,
    copyVisibleLog,
    exportVisibleLog,
    clearGcodeLog,
    formatLogLine,
    lineMatchesFilter: matches,
    renderGcodeLog,
    visibleGcodeLines: () => visibleGcodeLines(getLines(), { filter: getFilter(), search: getSearch() }),
  };
}
