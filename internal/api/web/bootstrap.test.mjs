import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("production entrypoint links and composes once without starting resources before DOM readiness", () => {
  const entrypoint = new URL("./app.js", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    const events = [];
    globalThis.document = {
      addEventListener: (name, handler) => events.push({ name, handler }),
    };
    globalThis.window = {
      matchMedia: () => ({ matches: false }),
      location: { href: "http://localhost/active-job", pathname: "/active-job", search: "" },
    };
    globalThis.localStorage = { getItem: () => null };
    globalThis.fetch = () => assert.fail("fetch before DOM readiness");
    globalThis.WebSocket = class { constructor() { assert.fail("WebSocket before DOM readiness"); } };
    globalThis.EventSource = class { constructor() { assert.fail("SSE before DOM readiness"); } };
    globalThis.setTimeout = () => assert.fail("timer before DOM readiness");
    globalThis.setInterval = () => assert.fail("polling before DOM readiness");
    await import(${JSON.stringify(entrypoint)});
    assert.equal(events.length, 1);
    assert.equal(events[0].name, "DOMContentLoaded");
    assert.equal(typeof events[0].handler, "function");
  `], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
