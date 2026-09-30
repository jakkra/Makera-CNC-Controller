import test from "node:test";
import assert from "node:assert/strict";
import {
  confirmControl,
  controlErrorText,
  controlPendingText,
  controlSuccessText,
  createMachineCommands,
} from "./modules/machine-commands.js";

function fakeDocument(buttons = [], byID = {}) {
  return {
    querySelectorAll(selector) {
      assert.equal(selector, "[data-control-action]");
      return buttons;
    },
    getElementById(id) {
      return byID[id] || null;
    },
  };
}

function response(body = null, contentType = "") {
  return {
    headers: { get: (name) => name === "Content-Type" ? contentType : null },
    async json() { return body; },
  };
}

test("machine command text and confirmation helpers preserve operator copy", () => {
  assert.equal(controlPendingText("recover"), "Recovering alarm...");
  assert.equal(controlPendingText("unknown"), "Sending control: unknown");
  assert.equal(controlSuccessText("unlock"), "Unlock sent. If the alarm clears, home before moving.");
  assert.equal(controlSuccessText("hold", { message: "Observed hold." }), "Observed hold.");
  assert.equal(controlErrorText("halt", "offline"), "halt failed: offline");

  const prompts = [];
  const confirmRef = (message) => { prompts.push(message); return false; };
  assert.equal(confirmControl("home", confirmRef), true);
  assert.deepEqual(prompts, []);
  assert.equal(confirmControl("hold", confirmRef), true);
  assert.equal(confirmControl("reset", confirmRef), false);
  assert.match(prompts[0], /^Reset the machine controller\?/);
});

test("sendGcode preserves disarm, endpoint, payload, and failure feedback", async () => {
  const events = [];
  const commands = createMachineCommands({
    request: async (url, opts) => {
      events.push(["request", url, opts]);
      return response();
    },
    disarmTapMoveForCommand: async () => events.push(["disarm"]),
    appendGcodeLine: (line) => events.push(["log", line]),
    nowRef: () => 123,
  });

  assert.equal(await commands.sendGcode("G0 X1"), true);
  assert.deepEqual(events, [
    ["disarm"],
    ["request", "/api/gcode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line: "G0 X1" }),
    }],
  ]);

  const failures = [];
  const failed = createMachineCommands({
    request: async () => { throw new Error("machine busy"); },
    appendGcodeLine: (line) => failures.push(["log", line]),
    setStatusMessage: (...args) => failures.push(["status", ...args]),
    nowRef: () => 456,
  });
  assert.equal(await failed.sendGcode("M114", { feedback: true }), false);
  assert.deepEqual(failures, [
    ["log", { seq: "local-456", dir: "recv", source: "api", text: "error: machine busy" }],
    ["status", "gcode-command", "Manual command failed: machine busy", "error", { force: true }],
  ]);
});

test("sendControl preserves pending button state, request payload, polling, and success notice", async () => {
  const controlButton = { dataset: { controlAction: "hold" }, disabled: false };
  const events = [];
  const timers = [];
  const commands = createMachineCommands({
    documentRef: fakeDocument([controlButton]),
    request: async (url, opts) => {
      events.push(["request", url, opts]);
      return response({ message: "Hold observed." }, "application/json");
    },
    setControlPendingAction: (value) => events.push(["pending", value]),
    setNotice: (...args) => events.push(["notice", ...args]),
    renderMachine: () => events.push(["render"]),
    pollMachine: () => events.push(["poll"]),
    setTimeoutRef: (fn, delay) => timers.push([fn, delay]),
  });

  await commands.sendControl("hold");
  assert.equal(controlButton.disabled, false);
  assert.deepEqual(events, [
    ["pending", "hold"],
    ["render"],
    ["notice", "Sending hold...", "info", "control-hold"],
    ["request", "/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "hold" }),
    }],
    ["notice", "Hold observed.", "ok", "control-hold"],
    ["poll"],
    ["pending", ""],
    ["render"],
  ]);
  assert.equal(timers.length, 1);
  assert.equal(timers[0][1], 1200);
});

test("sendControl keeps recovery failure state and logs the concrete error", async () => {
  const events = [];
  const commands = createMachineCommands({
    documentRef: fakeDocument(),
    request: async () => { throw new Error("alarm remains"); },
    setLastControlResult: (value) => events.push(["result", value]),
    appendGcodeLine: (line) => events.push(["log", line]),
    setNotice: (...args) => events.push(["notice", ...args]),
    setControlPendingAction: (value) => events.push(["pending", value]),
    nowRef: () => 789,
  });

  await commands.sendControl("recover");
  assert.deepEqual(events, [
    ["pending", "recover"],
    ["result", null],
    ["notice", "Recovering alarm...", "info", "control-recover"],
    ["result", { action: "recover", recovered: false, failed: true, message: "alarm remains" }],
    ["log", { seq: "local-789", dir: "recv", source: "api", text: "error: alarm remains" }],
    ["notice", "recover failed: alarm remains", "error", "control-recover"],
    ["pending", ""],
  ]);
});

test("Home releases its pending state after failure and a repeated click sends a new request", async () => {
  const home = { dataset: { controlAction: "home" }, disabled: false };
  let pending = "";
  let attempts = 0;
  const notices = [];
  const commands = createMachineCommands({
    documentRef: fakeDocument([home]),
    setControlPendingAction: (value) => { pending = value; },
    setNotice: (...args) => notices.push(args),
    request: async (url, opts) => {
      assert.equal(home.disabled, true);
      assert.equal(pending, "home");
      assert.equal(url, "/api/control");
      assert.deepEqual(JSON.parse(opts.body), { action: "home" });
      if (++attempts === 1) throw new Error("home could not disarm movement: context deadline exceeded");
      return response({ message: "Home command sent." }, "application/json");
    },
    setTimeoutRef: () => {},
  });
  await commands.sendControl("home");
  assert.equal(home.disabled, false);
  assert.equal(pending, "");
  assert.match(notices.at(-1)[0], /home failed: home could not disarm movement/);
  await commands.sendControl("home");
  assert.equal(attempts, 2);
  assert.equal(home.disabled, false);
  assert.equal(pending, "");
});
