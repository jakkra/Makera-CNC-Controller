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
  getLines = () => [],
  setLines,
  getSeqs,
  getFilter = () => "all",
  getSearch = () => "",
  getAutoscroll = () => true,
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
    appendGcodeLineElement,
    clearGcodeLog,
    formatLogLine,
    lineMatchesFilter: matches,
    renderGcodeLog,
    visibleGcodeLines: () => visibleGcodeLines(getLines(), { filter: getFilter(), search: getSearch() }),
  };
}
