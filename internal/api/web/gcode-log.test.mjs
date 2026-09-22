import test from "node:test";
import assert from "node:assert/strict";
import { createGcodeLogFeature, formatLogLine, lineMatchesFilter, visibleGcodeLines } from "./modules/gcode-log.js";

const lines = [
  { seq: 1, dir: "send", source: "controller", text: "G1 X1" },
  { seq: 2, dir: "recv", source: "api", text: "ok" },
  { seq: 3, dir: "recv", source: "jog", text: "error: not idle" },
];

test("gcode log filters preserve source, direction, search, and error semantics", () => {
  assert.equal(lineMatchesFilter(lines[0], { filter: "send" }), true);
  assert.equal(lineMatchesFilter(lines[1], { filter: "send" }), false);
  assert.deepEqual(visibleGcodeLines(lines, { filter: "api" }), [lines[1]]);
  assert.deepEqual(visibleGcodeLines(lines, { filter: "all", search: "NOT IDLE" }), [lines[2]]);
  assert.deepEqual(visibleGcodeLines(lines, { filter: "error" }), [lines[2]]);
});

test("gcode log formatter keeps the shipped operator line format", () => {
  assert.equal(formatLogLine({ time: "2026-01-02T03:04:05.000Z", dir: "send", source: "api", text: "G0 X1" }), "2026-01-02T03:04:05.000Z api > G0 X1");
  assert.equal(formatLogLine({ dir: "recv", text: "ok" }), "< ok");
});

function fakeDocument() {
  const log = {
    _innerHTML: "",
    childNodes: [],
    scrollTop: 0,
    scrollHeight: 100,
    clientHeight: 20,
    appendChild(node) { this.childNodes.push(node); this.scrollHeight = 100 + this.childNodes.length * 10; },
    removeChild() { this.childNodes.shift(); },
  };
  Object.defineProperty(log, "innerHTML", {
    get() { return this._innerHTML; },
    set(value) { this._innerHTML = value; this.childNodes = []; },
  });
  return {
    log,
    documentRef: {
      getElementById(id) { return id === "gcode-log" ? log : null; },
      createElement() { return { className: "", innerHTML: "" }; },
    },
  };
}

test("gcode log renderer uses the existing container and preserves scroll policy", () => {
  const dom = fakeDocument();
  let current = [...lines];
  const seqs = new Set(current.map((line) => line.seq));
  const feature = createGcodeLogFeature({
    documentRef: dom.documentRef,
    getLines: () => current,
    setLines: (value) => { current = value; },
    getSeqs: () => seqs,
    getFilter: () => "all",
    getAutoscroll: () => false,
    maxLines: 3,
    escapeHtml: (value) => String(value).replaceAll("<", "&lt;"),
  });

  dom.log.childNodes = [{ old: true }];
  dom.log.scrollTop = 42;
  feature.renderGcodeLog();
  assert.equal(dom.log.scrollTop, 42);
  assert.equal(dom.log.childNodes.length, 3);
  assert.match(dom.log.childNodes[0].innerHTML, /controller/);
  feature.clearGcodeLog();
  assert.deepEqual(current, []);
  assert.equal(seqs.size, 0);
  assert.equal(dom.log.innerHTML, "");
});

test("gcode append deduplicates, trims bounded history, cleans seqs, and respects paused rendering", () => {
  const dom = fakeDocument();
  const current = [];
  const seqs = new Set();
  let paused = false;
  const feature = createGcodeLogFeature({
    documentRef: dom.documentRef,
    getLines: () => current,
    getSeqs: () => seqs,
    getPaused: () => paused,
    maxLines: 2,
  });

  feature.appendGcodeLine(lines[0]);
  feature.appendGcodeLine(lines[0]);
  assert.deepEqual(current, [lines[0]]);
  assert.equal(dom.log.childNodes.length, 1);

  paused = true;
  feature.appendGcodeLine(lines[1]);
  feature.appendGcodeLine(lines[2]);
  assert.deepEqual(current, [lines[1], lines[2]]);
  assert.deepEqual([...seqs], [2, 3]);
  assert.equal(dom.log.childNodes.length, 1, "paused logging stores lines without rendering them");

  paused = false;
  feature.appendGcodeLine(lines[0]);
  assert.deepEqual(current, [lines[2], lines[0]], "a trimmed sequence can be accepted again");
  assert.deepEqual([...seqs], [3, 1]);
});

test("gcode append stores filtered lines but only renders matching lines", () => {
  const dom = fakeDocument();
  const current = [];
  const seqs = new Set();
  const feature = createGcodeLogFeature({
    documentRef: dom.documentRef,
    getLines: () => current,
    getSeqs: () => seqs,
    getFilter: () => "api",
  });
  feature.appendGcodeLine(lines[0]);
  assert.deepEqual(current, [lines[0]]);
  assert.equal(seqs.has(lines[0].seq), true);
  assert.equal(dom.log.childNodes.length, 0);
});

function makeLogActions({ clipboard = { writeText: async () => {} }, lines: initialLines = [...lines], filter = "all", search = "" } = {}) {
  const notices = [];
  const exported = { blob: null, anchor: null, timer: null, revoked: [] };
  const documentRef = {
    body: { appendChild(node) { exported.anchor = node; } },
    createElement(tag) {
      assert.equal(tag, "a");
      return {
        href: "",
        download: "",
        click() { exported.clicked = true; },
        remove() { exported.removed = true; },
      };
    },
  };
  const feature = createGcodeLogFeature({
    documentRef,
    navigatorRef: { clipboard },
    URLRef: {
      createObjectURL(blob) { exported.blob = blob; return "blob:log"; },
      revokeObjectURL(url) { exported.revoked.push(url); },
    },
    BlobCtor: class { constructor(parts, options) { this.parts = parts; this.options = options; } },
    setTimeoutRef(callback, delay) { exported.timer = callback; exported.delay = delay; },
    setNotice: (...args) => notices.push(args),
    getLines: () => initialLines,
    getFilter: () => filter,
    getSearch: () => search,
  });
  return { feature, notices, exported };
}

test("copy visible log uses active filters and reports clipboard success or failure", async () => {
  const copied = [];
  const success = makeLogActions({
    clipboard: { writeText: async (text) => copied.push(text) },
    filter: "api",
  });
  await success.feature.copyVisibleLog();
  assert.deepEqual(copied, ["api < ok"]);
  assert.deepEqual(success.notices, [["Copied visible log lines.", "ok", "log-copy"]]);

  const failure = makeLogActions({ clipboard: { writeText: async () => { throw new Error("denied"); } } });
  await failure.feature.copyVisibleLog();
  assert.deepEqual(failure.notices, [["Copy failed.", "error", "log-copy"]]);

  const unavailable = makeLogActions({ clipboard: null });
  await unavailable.feature.copyVisibleLog();
  assert.deepEqual(unavailable.notices, [["Copy failed.", "error", "log-copy"]]);
});

test("export visible log preserves NDJSON bytes, filename, MIME type, and delayed URL revoke", () => {
  const action = makeLogActions({ filter: "api" });
  action.feature.exportVisibleLog();
  assert.deepEqual(action.exported.blob.parts, ['{"seq":2,"dir":"recv","source":"api","text":"ok"}\n']);
  assert.deepEqual(action.exported.blob.options, { type: "application/x-ndjson" });
  assert.equal(action.exported.anchor.download, "cnc-proxy-log.ndjson");
  assert.equal(action.exported.anchor.href, "blob:log");
  assert.equal(action.exported.clicked, true);
  assert.equal(action.exported.removed, true);
  assert.equal(action.exported.delay, 1000);
  assert.deepEqual(action.exported.revoked, []);
  action.exported.timer();
  assert.deepEqual(action.exported.revoked, ["blob:log"]);
});
