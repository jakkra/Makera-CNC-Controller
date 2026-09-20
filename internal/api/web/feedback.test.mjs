import test from "node:test";
import assert from "node:assert/strict";
import { createFeedback, feedbackTiming } from "./modules/feedback.js";

function makeDocument() {
  const makeElement = (tag) => {
    const node = {
      tagName: tag,
      children: [],
      dataset: {},
      className: "",
      textContent: "",
      classList: { contains: (name) => node.className.split(" ").includes(name), remove: (name) => { node.className = node.className.split(" ").filter((part) => part !== name).join(" "); } },
      append(...items) { this.children.push(...items); },
      appendChild(item) { this.children = this.children.filter((child) => child !== item); this.children.push(item); },
      querySelector(selector) { return this.children.find((child) => child.className?.split(" ").includes(selector.slice(1))); },
      setAttribute() {},
      remove() { this.removed = true; },
      getBoundingClientRect: () => ({ top: 0 }),
      animate() {},
    };
    return node;
  };
  const list = makeElement("div");
  return { getElementById(id) { return id === "notice" ? list : id === "status-bar" ? { hidden: true } : null; }, createElement: makeElement, list };
}

test("feedback aggregates connectivity and suppresses repeated status", () => {
  let now = 100;
  const timers = [];
  const documentRef = makeDocument();
  const feedback = createFeedback({ documentRef, performanceRef: { now: () => now }, setTimeoutRef: (fn) => { timers.push(fn); return fn; }, clearTimeoutRef: () => {} });
  feedback.setNotice("Connected", "ok", "connection");
  feedback.setConnectivityIssue("sse", "Stream disconnected");
  assert.equal(documentRef.list.children.length, 2);
  now += feedbackTiming.NOTICE_REPEAT_SUPPRESS_MS - 1;
  feedback.setStatusMessage("status", "Waiting");
  const firstStatusRow = documentRef.list.children.find((row) => row.dataset.noticeKey === "status");
  feedback.setStatusMessage("status", "Waiting");
  assert.equal(documentRef.list.children.filter((row) => row === firstStatusRow).length, 1);
  feedback.clearConnectivityIssue("sse");
  assert.ok(timers.length > 0);
});

test("terminal feedback is consumed exactly once", () => {
  const documentRef = makeDocument();
  const feedback = createFeedback({ documentRef, performanceRef: { now: () => 0 }, setTimeoutRef: () => 1, clearTimeoutRef: () => {} });
  const holder = { text: "Done", kind: "ok" };
  feedback.consumeStatusFeedback("job", holder, "text", "kind");
  assert.deepEqual(holder, { text: "", kind: "" });
  assert.equal(documentRef.list.children[0].querySelector(".status-text").textContent, "Done");
  feedback.consumeStatusFeedback("job", holder, "text", "kind");
  assert.equal(documentRef.list.children.length, 1);
});
