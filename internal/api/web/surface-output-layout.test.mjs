import test from "node:test";
import assert from "node:assert/strict";
import { createSurfaceControls } from "./modules/surface-controls.js";

test("mobile outputs move into Control and return to the desktop footer without replacing controls", () => {
  let onChange;
  const media = { matches: true, addEventListener: (event, callback) => { assert.equal(event, "change"); onChange = callback; } };
  const after = {};
  const outputs = { nextSibling: after, pending: true };
  let parent;
  const slot = { appendChild: (node) => { assert.equal(node, outputs); parent = slot; } };
  const footer = {
    querySelector: () => outputs,
    insertBefore: (node, sibling) => { assert.equal(node, outputs); assert.equal(sibling, after); parent = footer; },
  };
  const nodes = { "mobile-output-slot": slot, "surface-quick-actions": footer };
  const bound = [];
  const controls = createSurfaceControls({
    state: {},
    documentRef: {
      getElementById: (id) => nodes[id] || null,
      defaultView: { matchMedia: () => media },
    },
  });
  controls.bindFooterInteractions({ bindButtonAction: (node) => bound.push(node) });
  assert.equal(parent, slot);
  media.matches = false;
  onChange();
  assert.equal(parent, footer);
  media.matches = true;
  onChange();
  assert.equal(parent, slot);
  assert.equal(outputs.pending, true);
  assert.equal(bound.length, 3, "resizing does not bind additional action handlers");
});
