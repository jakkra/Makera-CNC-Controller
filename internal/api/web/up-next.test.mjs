import test from "node:test";
import assert from "node:assert/strict";
import { mountUpNext } from "./modules/up-next.js";

function controller(request) {
  function node() {
    return {
      children: [], setAttribute() {},
      append(...items) { this.children.push(...items); },
      remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); },
      insertBefore(item, next) {
        item.remove();
        this.children.splice(next ? this.children.indexOf(next) : this.children.length, 0, item);
        item.parent = this;
      },
    };
  }
  const ids = new Map();
  const document = { createElement: node, getElementById(id) {
    if (!ids.has(id)) ids.set(id, node());
    return ids.get(id);
  } };
  const notices = [];
  const ui = mountUpNext({ document, request, readOnly: () => false, canStart: () => true,
    relPath: (s) => s, setStatusMessage: (...args) => notices.push(args) });
  return { ui, ids, notices };
}

test("shared upload offer dismisses locally and starts the displayed revision once", async () => {
  const calls = [];
  let finish;
  const request = async (url, opts) => {
    calls.push([url, JSON.parse(opts.body)]);
    await new Promise(resolve => { finish = resolve; });
    return { json: async () => ({ message: "Machine running", verified: true }) };
  };
  const first = controller(request), second = controller(request);
  const program = { id: 42, path: "/sd/gcodes/face.nc", md5: "abc", sync: "synced", ready: true };
  const snapshot = { offer_id: 42, offer_ms: 100, items: [program] };
  for (const tab of [first, second]) tab.ui.apply(structuredClone(snapshot));
  first.ids.get("upload-offer-dismiss").onclick();
  first.ui.apply(snapshot);
  assert.equal(first.ids.get("upload-offer").hidden, true);
  assert.equal(second.ids.get("upload-offer").hidden, false);
  const button = second.ids.get("upload-offer-start");
  const pending = button.onclick();
  second.ui.apply(snapshot);
  assert.equal(button.disabled, true);
  await button.onclick();
  assert.deepEqual(calls, [["/api/up-next/start", { id: 42, path: program.path, md5: "abc", from_offer: true }]]);
  finish();
  await pending;
  assert.equal(second.ids.get("upload-offer").hidden, true);
  assert.equal(second.notices.at(-1)[2], "ok");
});

test("expiry preserves the ordered list and packet progress uses the bottom status bar", async () => {
  const tab = controller(() => assert.fail("expiry sent a machine action"));
  tab.ui.apply({ offer_id: 5, offer_ms: 5, items: [{ id: 5, path: "a.nc", ready: true }] });
  const row = tab.ids.get("up-next-items").children[0];
  tab.ui.showTransfer({ path: "b.nc", percent: 43 });
  assert.equal(tab.notices.at(-1)[1], "Uploading b.nc to CNC · 43%");
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(tab.ids.get("upload-offer").hidden, true);
  assert.equal(tab.ids.get("up-next-items").children[0], row);
});
