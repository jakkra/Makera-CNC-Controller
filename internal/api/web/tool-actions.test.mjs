import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bindButtonAction, setElementBusy, setSoftDisabled } from "./modules/dom.js";
import { createToolActions } from "./modules/tool-actions.js";
import { validToolID, toolDisplayName } from "./modules/tooling.js";

test("tool actions reject an invalid selected tool before request", async () => {
  const messages = []; let pending = ""; let requests = 0;
  const tool = createToolActions({ documentRef: { getElementById: () => null }, request: async () => { requests++; }, validToolID: (id) => id === 1, toolDisplayName: (id) => `Tool ${id}`, getPending: () => pending, setPending: (v) => { pending = v; }, setStatusMessage: (...args) => messages.push(args), setSoftDisabled: () => {}, setElementBusy: () => {} });
  await tool.setCurrentTool(2);
  assert.equal(requests, 0); assert.equal(pending, ""); assert.equal(messages.at(-1)[2], "error");
});

test("the Work Zero shortcut finishes a 3D Probe exchange only when the machine reports it active", async () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.match(html, /id="work-zero-section"[\s\S]*?id="origin-probe-tool" disabled>Fit 3D Probe<\/button>/);

  const events = new Map();
  const attrs = new Map();
  const button = {
    disabled: true,
    dataset: {},
    classList: { toggle() {} },
    setAttribute: (key, value) => attrs.set(key, value),
    removeAttribute: (key) => attrs.delete(key),
    addEventListener: (event, fn) => events.set(event, fn),
  };
  const nodes = new Map([
    ["origin-probe-tool", button], ["tool-set-select", {}], ["tool-change-select", {}],
  ]);
  const requests = [];
  const messages = [];
  let pending = "";
  let releaseResponse;
  let machine = { connected: true, state: "Idle", tool: { active: 2 } };
  const feature = createToolActions({
    documentRef: { getElementById: (id) => nodes.get(id) || null },
    validToolID, toolDisplayName, setSoftDisabled, setElementBusy,
    getPending: () => pending, setPending: (value) => { pending = value; },
    getMachine: () => machine,
    request: (path, options) => {
      requests.push([path, options.method, options.body]);
      return new Promise(resolve => {
        releaseResponse = () => resolve({ json: async () => ({ message: "Command sent." }) });
      });
    },
    disarmTapMoveForCommand: async () => {},
    appendGcodeLine: () => {},
    pollMachine: () => {},
    setTimeoutRef: () => 1,
    clearTimeoutRef: () => {},
    setStatusMessage: (key, message, kind) => messages.push({ key, message, kind }),
  });
  feature.bindInteractions({
    bindButtonAction: (el, action) => bindButtonAction(el, action, { performanceRef: { now: () => 1000 } }),
  });
  const click = () => events.get("click")({});
  const update = (state, tool, stale = false) => {
    machine = { connected: true, stale, state, tool };
    feature.renderToolActions();
  };
  const drain = () => new Promise(resolve => setImmediate(resolve));

  feature.renderToolActions();
  assert.equal(button.disabled, false);
  click();
  assert.equal(button.disabled, true);
  assert.equal(attrs.get("aria-busy"), "true");
  feature.renderToolActions();
  click();
  await drain();
  assert.deepEqual(requests, [["/api/tool/change", "POST", '{"tool_id":9999}']]);
  releaseResponse();
  await drain();
  assert.equal(button.disabled, true, "an accepted command still needs a machine observation");
  assert.notEqual(messages.at(-1).kind, "ok");
  update("Tool", { active: 2, target: 9999 }, true);
  assert.equal(button.disabled, true);
  update("Tool", { active: 2, target: 9999 });
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Continue");
  assert.equal(attrs.get("aria-label"), "Continue 3D Probe exchange");
  assert.match(messages.at(-1).message, /Fit and connect/);
  click();
  assert.deepEqual(requests.at(-1), ["/api/tool/continue?tool_id=9999", "POST", undefined]);
  assert.equal(button.disabled, true);
  releaseResponse();
  await drain();
  update("Run", { active: 9999 });
  assert.notEqual(messages.at(-1).kind, "ok");
  assert.equal(button.disabled, true);
  update("Idle", { active: 9999 });
  assert.deepEqual(messages.at(-1), { key: "tool", message: "Machine reports the 3D Probe active.", kind: "ok" });
  assert.equal(attrs.has("aria-busy"), false);
  assert.equal(button.disabled, true);
});
