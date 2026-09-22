import test from "node:test";
import assert from "node:assert/strict";
import { createBackupFeature } from "./modules/backup.js";

function makeBackup(overrides = {}) {
  const calls = [];
  const notices = [];
  const statuses = [];
  const timers = [];
  const links = [];
  const documentRef = {
    body: { appendChild(node) { links.push(node); } },
    createElement(tag) {
      assert.equal(tag, "a");
      return {
        href: "",
        download: "",
        click() { this.clicked = true; },
        remove() { this.removed = true; },
      };
    },
  };
  const feature = createBackupFeature({
    request: async (...args) => {
      calls.push(args);
      if (overrides.request) return overrides.request(...args);
      return { blob: async () => "backup-blob" };
    },
    documentRef,
    URLRef: {
      createObjectURL(blob) { assert.equal(blob, "backup-blob"); return "blob:backup"; },
      revokeObjectURL(url) { calls.push(["revoke", url]); },
    },
    BlobCtor: class {},
    setTimeoutRef(callback, delay) { timers.push({ callback, delay }); },
    locationRef: { reload: () => calls.push(["reload"]) },
    confirmRef: overrides.confirmRef || (() => true),
    setStatusMessage: (...args) => statuses.push(args),
    setNotice: (...args) => notices.push(args),
  });
  return { feature, calls, notices, statuses, timers, links };
}

test("backup export downloads the established JSON file and reports success", async () => {
  const backup = makeBackup();
  await backup.feature.exportBackup();
  assert.deepEqual(backup.calls, [["/api/backup"]]);
  assert.equal(backup.links.length, 1);
  assert.equal(backup.links[0].href, "blob:backup");
  assert.equal(backup.links[0].download, "cnc-proxy-backup.json");
  assert.equal(backup.links[0].clicked, true);
  assert.equal(backup.links[0].removed, true);
  assert.deepEqual(backup.statuses, [["backup", "Backup exported.", "ok", { force: true }]]);
  assert.deepEqual(backup.timers.map(({ delay }) => delay), [1000]);
  backup.timers[0].callback();
  assert.deepEqual(backup.calls, [["/api/backup"], ["revoke", "blob:backup"]]);
});

test("backup export reports request failures through the notice channel", async () => {
  const backup = makeBackup({ request: async () => { throw new Error("offline"); } });
  await backup.feature.exportBackup();
  assert.deepEqual(backup.notices, [["Backup export failed: offline", "error", "backup"]]);
  assert.deepEqual(backup.statuses, []);
});

test("backup import preserves cancel and empty-file behavior", async () => {
  const empty = makeBackup();
  await empty.feature.importBackupFile(null);
  assert.deepEqual(empty.calls, []);

  const cancelled = makeBackup({ confirmRef: (message) => {
    assert.equal(message, "Import this CNC Proxy backup? This replaces local catalog, queue, UI settings, retained logs, and run history.");
    return false;
  } });
  await cancelled.feature.importBackupFile({ text: async () => "ignored" });
  assert.deepEqual(cancelled.calls, []);
});

test("backup import posts JSON, reports success, and reloads after the established delay", async () => {
  const backup = makeBackup();
  await backup.feature.importBackupFile({ text: async () => "{\"version\":1}" });
  assert.deepEqual(backup.calls, [["/api/backup/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{\"version\":1}",
  }]]);
  assert.deepEqual(backup.statuses, [["backup", "Backup imported; reloading...", "ok", { force: true }]]);
  assert.deepEqual(backup.timers.map(({ delay }) => delay), [600]);
  backup.timers[0].callback();
  assert.deepEqual(backup.calls.at(-1), ["reload"]);
});

test("backup import reports file or request failures through the notice channel", async () => {
  const fileFailure = makeBackup({ request: async () => { throw new Error("bad backup"); } });
  await fileFailure.feature.importBackupFile({ text: async () => "{}" });
  assert.deepEqual(fileFailure.notices, [["Backup import failed: bad backup", "error", "backup"]]);

  const readFailure = makeBackup();
  await readFailure.feature.importBackupFile({ text: async () => { throw new Error("read failed"); } });
  assert.deepEqual(readFailure.notices, [["Backup import failed: read failed", "error", "backup"]]);
});

test("backup interactions preserve click routing, file handoff, and input reset", () => {
  const nodes = new Map();
  let fileClicks = 0;
  nodes.set("backup-export", {});
  nodes.set("backup-import", {});
  nodes.set("backup-file", {
    click() { fileClicks++; },
  });
  const feature = createBackupFeature({
    documentRef: { getElementById: (id) => nodes.get(id) },
    request: async () => ({ blob: async () => "blob" }),
    URLRef: { createObjectURL: () => "blob:url", revokeObjectURL: () => {} },
    BlobCtor: class {},
    setTimeoutRef: () => {},
    locationRef: { reload: () => {} },
    confirmRef: () => true,
    setStatusMessage: () => {},
    setNotice: () => {},
  });
  const calls = [];
  const exportBackup = () => calls.push(["export"]);
  const importBackupFile = (file) => calls.push(["import", file]);
  feature.bindInteractions({ exportBackup, importBackupFile });

  nodes.get("backup-export").onclick();
  nodes.get("backup-import").onclick();
  const file = { name: "backup.json" };
  const event = { target: { files: [file], value: "backup.json" } };
  nodes.get("backup-file").onchange(event);

  assert.deepEqual(calls, [["export"], ["import", file]]);
  assert.equal(fileClicks, 1);
  assert.equal(event.target.value, "");
});
