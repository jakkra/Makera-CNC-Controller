export function fileRowLocallyOwned(row, fileActions, activeElement) {
  const action = fileActions.get(row.dataset.filePath) || "";
  return row.contains(activeElement) || !!row.querySelector(":active") || (!!action && row.dataset.fileAction === action);
}

export function beginFileAction(fileActions, path, buttonLabel, notice, setNotice, render) {
  fileActions.set(path, buttonLabel);
  setNotice(notice, "info", "files-action", { timeoutMs: 0, force: true });
  render();
}

export function endFileAction(fileActions, path, render) {
  fileActions.delete(path);
  render();
}
