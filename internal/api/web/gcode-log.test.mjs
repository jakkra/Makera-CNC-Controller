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
