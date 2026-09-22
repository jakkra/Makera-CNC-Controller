export function createBackupFeature({
  request,
  documentRef,
  URLRef,
  BlobCtor,
  setTimeoutRef,
  locationRef,
  confirmRef,
  setStatusMessage,
  setNotice,
} = {}) {
  async function exportBackup() {
    try {
      const r = await request("/api/backup");
      const blob = await r.blob();
      const a = documentRef.createElement("a");
      a.href = URLRef.createObjectURL(blob);
      a.download = "cnc-proxy-backup.json";
      documentRef.body.appendChild(a);
      a.click();
      a.remove();
      setTimeoutRef(() => URLRef.revokeObjectURL(a.href), 1000);
      setStatusMessage("backup", "Backup exported.", "ok", { force: true });
    } catch (e) {
      setNotice("Backup export failed: " + e.message, "error", "backup");
    }
  }

  async function importBackupFile(file) {
    if (!file) return;
    if (!confirmRef("Import this CNC Proxy backup? This replaces local catalog, queue, UI settings, retained logs, and run history.")) return;
    try {
      const text = await file.text();
      await request("/api/backup/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: text,
      });
      setStatusMessage("backup", "Backup imported; reloading...", "ok", { force: true });
      setTimeoutRef(() => locationRef.reload(), 600);
    } catch (e) {
      setNotice("Backup import failed: " + e.message, "error", "backup");
    }
  }

  function bindInteractions({ exportBackup: exportBackupHandler = exportBackup, importBackupFile: importBackupFileHandler = importBackupFile } = {}) {
    documentRef.getElementById("backup-export").onclick = exportBackupHandler;
    documentRef.getElementById("backup-import").onclick = () => documentRef.getElementById("backup-file").click();
    documentRef.getElementById("backup-file").onchange = (e) => {
      importBackupFileHandler(e.target.files[0]);
      e.target.value = "";
    };
  }

  return { bindInteractions, exportBackup, importBackupFile };
}
