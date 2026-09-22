import test from "node:test";
import assert from "node:assert/strict";
import { createGamepadControls } from "./modules/gamepad-controls.js";

test("gamepad settings binder preserves axis, button, dirty-draft, and macro callbacks", () => {
  const ids = [
    "gamepad-axis-x", "gamepad-invert-x", "gamepad-speed-x",
    "gamepad-axis-y", "gamepad-invert-y", "gamepad-speed-y",
    "gamepad-axis-z", "gamepad-invert-z", "gamepad-speed-z",
    "gamepad-deadman-button", "gamepad-slow-button-0", "gamepad-slow-button-1",
    "gamepad-outline-button", "gamepad-add-macro",
  ];
  const nodes = new Map(ids.map((id) => [id, { id, blur() {} }]));
  const events = [];
  const controls = createGamepadControls({
    state: { jog: { buttons: [] }, ui: { gamepad: { axes: {}, macro_buttons: [], outline_button: 0 } }, outline: {} },
    navigatorRef: {},
    documentRef: { getElementById: (id) => nodes.get(id) },
    callbacks: {
      updateGamepadAxis: (axis) => events.push(["axis", axis]),
      updateGamepadButtons: () => events.push(["buttons"]),
      markControlDirty: (node) => events.push(["dirty", node.id]),
      clearControlDrafts: (node) => events.push(["clear", node.id]),
      addGamepadMacroBinding: () => events.push(["add-macro"]),
    },
  });
  controls.bindInteractions();

  for (const axis of ["x", "y", "z"]) {
    nodes.get("gamepad-axis-" + axis).onchange();
    nodes.get("gamepad-invert-" + axis).onchange();
    nodes.get("gamepad-speed-" + axis).oninput();
  }
  nodes.get("gamepad-deadman-button").onchange();
  nodes.get("gamepad-slow-button-0").onchange();
  nodes.get("gamepad-slow-button-1").onchange();
  nodes.get("gamepad-outline-button").oninput();
  nodes.get("gamepad-outline-button").onchange();
  nodes.get("gamepad-add-macro").onclick();

  assert.deepEqual(events, [
    ["axis", "x"], ["axis", "x"], ["axis", "x"],
    ["axis", "y"], ["axis", "y"], ["axis", "y"],
    ["axis", "z"], ["axis", "z"], ["axis", "z"],
    ["buttons"], ["buttons"], ["buttons"],
    ["dirty", "gamepad-outline-button"], ["clear", "gamepad-outline-button"], ["buttons"],
    ["add-macro"],
  ]);
});
