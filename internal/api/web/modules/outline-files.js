// Outline file import/export orchestration. The browser state and the outline
// parser/serializer stay in app.js; this module owns only the file lifecycle
// and receives every side effect through explicit callbacks.

export function createOutlineFilesFeature({
  documentRef = globalThis.document,
  urlRef = globalThis.URL,
  blobCtor = globalThis.Blob,
  getOutline = () => null,
  setOutline = () => {},
  outlineJSONDocument = () => { throw new Error("outline JSON serializer is unavailable"); },
  buildOutlineDXF = () => { throw new Error("outline DXF builder is unavailable"); },
  outlineStateFromJSON = () => { throw new Error("outline JSON parser is unavailable"); },
  cancelOutlineCaptureIntents = () => {},
  markGcodeContextOverlayDirty = () => {},
  updateFieldProbePreview = () => {},
  renderOutlineCapture = () => {},
  renderWorkArea = () => {},
  setOutlineFeedback = () => {},
  setStatusMessage = () => {},
  confirmRef = () => true,
  now = () => new Date(),
} = {}) {
  function downloadBlob(filename, content, type) {
    const blob = blobCtor && content instanceof blobCtor ? content : new blobCtor([content], { type });
    const anchor = documentRef.createElement("a");
    anchor.href = urlRef.createObjectURL(blob);
    anchor.download = filename;
    documentRef.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => urlRef.revokeObjectURL(anchor.href), 1000);
  }

  function saveOutlineJSON() {
    try {
      const stamp = now().toISOString().replace(/[:.]/g, "-");
      downloadBlob("cnc-outline-" + stamp + ".json", JSON.stringify(outlineJSONDocument(), null, 2) + "\n", "application/json");
      setOutlineFeedback("Outline JSON export started.", "ok");
    } catch (e) {
      setOutlineFeedback("Save outline failed: " + e.message, "error");
    }
  }

  function exportOutline() {
    try {
      if (getOutline().points.length < 2) throw new Error("outline needs at least two points");
      const dxf = buildOutlineDXF();
      const stamp = now().toISOString().replace(/[:.]/g, "-");
      downloadBlob("cnc-outline-" + stamp + ".dxf", dxf, "application/dxf");
      setOutlineFeedback("DXF export started.", "ok");
    } catch (e) {
      setOutlineFeedback("Export failed: " + e.message, "error");
    }
  }

  function installLoadedOutlineState(next) {
    const current = getOutline();
    cancelOutlineCaptureIntents(current);
    setOutline(next);
    markGcodeContextOverlayDirty();
    if (next.closed) updateFieldProbePreview();
  }

  async function loadOutlineFile(file) {
    if (!file) return;
    const current = getOutline();
    if (current.points.length && !confirmRef("Load this outline and replace the current captured outline?")) return;
    current.filePending = true;
    setStatusMessage("outline", "Loading outline...", "", { force: true });
    renderOutlineCapture();
    try {
      const next = outlineStateFromJSON(JSON.parse(await file.text()));
      installLoadedOutlineState(next);
      renderOutlineCapture();
      renderWorkArea();
      setStatusMessage("outline", "Loaded outline with " + next.points.length + " points.", "ok", { force: true });
    } catch (e) {
      current.filePending = false;
      renderOutlineCapture();
      setStatusMessage("outline", "Load outline failed: " + e.message, "error", { force: true });
    }
  }

  return {
    downloadBlob,
    saveOutlineJSON,
    exportOutline,
    loadOutlineFile,
    installLoadedOutlineState,
  };
}
