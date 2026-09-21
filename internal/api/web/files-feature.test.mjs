import test from "node:test";
import assert from "node:assert/strict";
import { createFilesFeature } from "./modules/files.js";

function feature() {
  const documentRef = { getElementById: () => null, querySelector: () => null };
  const machine = {};
  const path = value => String(value || "").replace(/^\/sd\/gcodes\/?/, "");
  return { machine, files: createFilesFeature({
    documentRef,
    windowRef: { setTimeout, clearTimeout },
    request: async () => ({ json: async () => [] }),
    FormDataRef: FormData,
    promptRef: () => null,
    confirmRef: () => true,
    paths: {
      relPath: path,
      cleanRelPath: path,
      joinRelPath: (dir, name) => [path(dir), path(name)].filter(Boolean).join("/"),
      remotePathFromRel: rel => "/sd/gcodes/" + path(rel),
      parentRelPath: rel => path(rel).split("/").slice(0, -1).join("/"),
      dirname: rel => path(rel).split("/").slice(0, -1).join("/"),
      basename: rel => path(rel).split("/").pop() || "",
      apiFileURL: rel => "/api/files/" + encodeURIComponent(path(rel)),
    },
    escapeHtml: String,
    fmtSize: String,
    fmtTime: String,
    syncLabel: {},
    setNotice() {}, clearNotice() {},
    getMachine: () => machine,
    renderMachine() {},
    getActiveGcodePath: () => "",
    loadActiveGcode() {},
    getActiveSelectPendingPath: () => "",
    selectActiveGcode() {},
  }) };
}

test("files feature privately owns snapshots, jobs, and pending count", () => {
  const { files, machine } = feature();
  files.applySnapshot({
    files: [{ path: "/sd/gcodes/part.nc", sync: "synced" }],
    jobs: [{ id: "one", state: "queued" }, { id: "two", state: "done" }],
  });
  assert.equal(files.isLoaded(), true);
  assert.equal(files.getFile("/sd/gcodes/part.nc").sync, "synced");
  assert.equal(files.queuePendingCount(), 1);
  assert.equal(machine.pending_jobs, 1);
});
