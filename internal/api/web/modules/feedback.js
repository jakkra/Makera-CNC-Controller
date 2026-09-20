const NOTICE_INFO_TIMEOUT_MS = 4500;
const NOTICE_OK_TIMEOUT_MS = 3500;
const NOTICE_ERROR_TIMEOUT_MS = 8000;
const NOTICE_REPEAT_SUPPRESS_MS = 30000;
const NOTICE_EXIT_MS = 180;
const NOTICE_REFLOW_MS = 200;

export function createFeedback({
  documentRef = document,
  performanceRef = performance,
  setTimeoutRef = setTimeout,
  clearTimeoutRef = clearTimeout,
} = {}) {
  const state = {
    noticeKey: "",
    noticeSeq: 0,
    notices: new Map(),
    statusMessages: new Map(),
    connectivityIssues: new Map(),
  };

  function setNotice(text, kind = "info", key = "", opts = {}) {
    if (!text) {
      clearNotice(key);
      return;
    }
    const noticeKey = key || "global";
    const noticeText = String(text);
    const noticeKind = kind || "info";
    const timeoutMs = Object.prototype.hasOwnProperty.call(opts, "timeoutMs")
      ? Number(opts.timeoutMs)
      : noticeTimeoutMs(noticeKind);
    const prev = state.notices.get(noticeKey);
    if (!opts.force && !prev?.removing && prev?.text === noticeText && prev?.kind === noticeKind && prev?.timeoutMs === timeoutMs) return;
    if (prev?.timer) clearTimeoutRef(prev.timer);
    if (prev?.removeTimer) clearTimeoutRef(prev.removeTimer);
    const notice = {
      key: noticeKey,
      text: noticeText,
      kind: noticeKind,
      seq: ++state.noticeSeq,
      timer: null,
      removeTimer: null,
      timeoutMs,
      entering: true,
      removing: false,
    };
    state.notices.set(noticeKey, notice);
    state.noticeKey = noticeKey;
    renderNoticeBar();

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      notice.timer = setTimeoutRef(() => {
        const cur = state.notices.get(noticeKey);
        if (cur?.seq === notice.seq) dismissNotice(noticeKey, notice.seq);
      }, timeoutMs);
    }
  }

  function noticeTimeoutMs(kind) {
    if (kind === "error") return NOTICE_ERROR_TIMEOUT_MS;
    if (kind === "ok") return NOTICE_OK_TIMEOUT_MS;
    return NOTICE_INFO_TIMEOUT_MS;
  }

  function statusMessageSignature(text, kind = "") {
    return (kind || "info") + "\n" + String(text || "");
  }

  function setStatusMessage(key, text, kind = "", opts = {}) {
    if (!text) {
      state.statusMessages.delete(key);
      clearNotice(key);
      return;
    }
    const sig = statusMessageSignature(text, kind);
    const prev = state.statusMessages.get(key);
    const now = performanceRef.now();
    if (!opts.force && prev?.sig === sig && !state.notices.has(key) && now - prev.shownAt < NOTICE_REPEAT_SUPPRESS_MS) return;
    state.statusMessages.set(key, { sig, shownAt: now });
    setNotice(text, kind || "info", key, opts);
  }

  function consumeStatusFeedback(key, holder, textProp, kindProp) {
    const text = holder[textProp];
    if (!text) return;
    const kind = holder[kindProp];
    holder[textProp] = "";
    holder[kindProp] = "";
    setStatusMessage(key, text, kind, { force: true });
  }

  function clearVisibleNotices() {
    for (const key of [...state.notices.keys()]) dismissNotice(key);
  }

  function clearNotice(key = "") {
    if (key) {
      dismissNotice(key);
      return;
    }
    clearVisibleNotices();
  }

  function setConnectivityIssue(source, text) {
    state.connectivityIssues.set(source, String(text || "Connection unavailable."));
    const summary = [...state.connectivityIssues.values()][0] || "Connection unavailable.";
    setNotice(summary, "error", "connectivity", { timeoutMs: 0 });
  }

  function clearConnectivityIssue(source) {
    state.connectivityIssues.delete(source);
    if (state.connectivityIssues.size === 0) {
      clearNotice("connectivity");
      return;
    }
    setNotice([...state.connectivityIssues.values()][0], "error", "connectivity", { timeoutMs: 0 });
  }

  function noticeItemRects() {
    const list = documentRef.getElementById("notice");
    const rects = new Map();
    if (!list) return rects;
    for (const row of list.children) {
      if (!row.dataset.noticeKey || row.classList.contains("leaving")) continue;
      rects.set(row.dataset.noticeKey, row.getBoundingClientRect().top);
    }
    return rects;
  }

  function animateNoticeReflow(previousRects) {
    if (!previousRects?.size) return;
    const list = documentRef.getElementById("notice");
    if (!list) return;
    for (const row of list.children) {
      const previousTop = previousRects.get(row.dataset.noticeKey);
      if (!Number.isFinite(previousTop) || typeof row.animate !== "function") continue;
      const delta = previousTop - row.getBoundingClientRect().top;
      if (Math.abs(delta) < 0.5) continue;
      row.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }],
        { duration: NOTICE_REFLOW_MS, easing: "ease-out" },
      );
    }
  }

  function dismissNotice(key, seq = 0) {
    const notice = state.notices.get(key);
    if (!notice || (seq && notice.seq !== seq) || notice.removing) return false;
    if (notice.timer) clearTimeoutRef(notice.timer);
    notice.timer = null;
    notice.removing = true;
    notice.entering = false;
    renderNoticeBar();
    notice.removeTimer = setTimeoutRef(() => {
      const current = state.notices.get(key);
      if (current?.seq !== notice.seq || !current.removing) return;
      const previousRects = noticeItemRects();
      state.notices.delete(key);
      if (state.noticeKey === key) state.noticeKey = "";
      renderNoticeBar();
      animateNoticeReflow(previousRects);
    }, NOTICE_EXIT_MS);
    return true;
  }

  function renderNoticeBar() {
    const bar = documentRef.getElementById("status-bar");
    const list = documentRef.getElementById("notice");
    if (!bar || !list) return;
    const notices = [...state.notices.values()].sort((a, b) => b.seq - a.seq);
    const visible = notices.length > 0;
    bar.hidden = !visible;
    const existing = new Map([...list.children].map((row) => [row.dataset.noticeKey, row]));
    const activeKeys = new Set();
    for (const notice of notices) {
      activeKeys.add(notice.key);
      let row = existing.get(notice.key);
      if (!row) {
        row = documentRef.createElement("div");
        row.dataset.noticeKey = notice.key;
        const dot = documentRef.createElement("span");
        dot.className = "status-dot";
        const text = documentRef.createElement("span");
        text.className = "status-text";
        const dismiss = documentRef.createElement("button");
        dismiss.type = "button";
        dismiss.className = "status-dismiss";
        dismiss.textContent = "Dismiss";
        dismiss.onclick = () => clearNotice(row.dataset.noticeKey);
        row.append(dot, text, dismiss);
      }
      row.className = "status-item " + notice.kind + (notice.entering ? " entering" : "") + (notice.removing ? " leaving" : "");
      const text = row.querySelector(".status-text");
      if (text) text.textContent = notice.text;
      const dismiss = row.querySelector(".status-dismiss");
      if (dismiss) dismiss.setAttribute("aria-label", "Dismiss notification: " + notice.text);
      list.appendChild(row);
      if (notice.entering) {
        row.onanimationend = (event) => {
          if (event.animationName && event.animationName !== "status-item-in") return;
          const current = state.notices.get(notice.key);
          if (current?.seq !== notice.seq || !current.entering) return;
          current.entering = false;
          row.classList.remove("entering");
          row.onanimationend = null;
        };
      }
    }
    for (const [key, row] of existing) {
      if (!activeKeys.has(key)) row.remove();
    }
  }

  return {
    clearConnectivityIssue,
    clearNotice,
    consumeStatusFeedback,
    dismissNotice,
    renderNoticeBar,
    setConnectivityIssue,
    setNotice,
    setStatusMessage,
  };
}

export const feedbackTiming = Object.freeze({
  NOTICE_INFO_TIMEOUT_MS,
  NOTICE_OK_TIMEOUT_MS,
  NOTICE_ERROR_TIMEOUT_MS,
  NOTICE_REPEAT_SUPPRESS_MS,
  NOTICE_EXIT_MS,
  NOTICE_REFLOW_MS,
});
