import test from "node:test";
import assert from "node:assert/strict";
import { createToolActions } from "./modules/tool-actions.js";

test("tool actions reject an invalid selected tool before request", async () => {
  const messages = []; let pending = ""; let requests = 0;
  const tool = createToolActions({ documentRef: { getElementById: () => null }, request: async () => { requests++; }, validToolID: (id) => id === 1, toolDisplayName: (id) => `Tool ${id}`, getPending: () => pending, setPending: (v) => { pending = v; }, setStatusMessage: (...args) => messages.push(args), setSoftDisabled: () => {}, setElementBusy: () => {} });
  await tool.setCurrentTool(2);
  assert.equal(requests, 0); assert.equal(pending, ""); assert.equal(messages.at(-1)[2], "error");
});
