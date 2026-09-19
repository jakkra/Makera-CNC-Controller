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

export function createFileCatalog({ getFiles, paths }) {
  const { relPath, cleanRelPath, joinRelPath, remotePathFromRel } = paths;

  function directoryRows(dir) {
    dir = cleanRelPath(dir);
    const prefix = dir ? dir + "/" : "";
    const byPath = new Map();
    const rows = [];
    for (const entry of getFiles().values()) {
      const rel = relPath(entry.path);
      if (dir && rel === dir) continue;
      if (!rel.startsWith(prefix)) continue;
      const rest = rel.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf("/");
      if (slash >= 0) {
        const folderRel = joinRelPath(dir, rest.slice(0, slash));
        if (!byPath.has(folderRel)) byPath.set(folderRel, synthFolder(folderRel));
        continue;
      }
      const row = { ...entry, virtual: false, children: entry.is_dir ? countChildren(rel) : null };
      byPath.set(rel, row);
      rows.push(row);
    }
    for (const [folderRel, folder] of byPath) {
      if (folder.is_dir) {
        folder.children = countChildren(folderRel);
        folder.mtime = folder.mtime || newestDescendantMTime(folderRel);
      }
      if (!rows.some((r) => relPath(r.path) === folderRel)) rows.push(folder);
    }
    return sortFileRows(rows, relPath);
  }

  function searchFileRows(q) {
    const rows = [];
    for (const folder of allFolderRows()) {
      const rel = relPath(folder.path).toLowerCase();
      if (rel.includes(q)) rows.push(folder);
    }
    for (const entry of getFiles().values()) {
      const rel = relPath(entry.path).toLowerCase();
      if (rel.includes(q) || (entry.sync || "").toLowerCase().includes(q) || (entry.error || "").toLowerCase().includes(q)) {
        rows.push({ ...entry, virtual: false, children: entry.is_dir ? countChildren(relPath(entry.path)) : null });
      }
    }
    const seen = new Set();
    return sortFileRows(rows.filter((r) => {
      const key = relPath(r.path);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }), relPath);
  }

  function synthFolder(rel) {
    const actual = getFiles().get(remotePathFromRel(rel));
    if (actual && actual.is_dir) return { ...actual, virtual: false, children: 0 };
    return { path: remotePathFromRel(rel), is_dir: true, size: 0, mtime: "", sync: "", virtual: true, children: 0 };
  }

  function countChildren(dir) {
    dir = cleanRelPath(dir);
    const prefix = dir ? dir + "/" : "";
    const direct = new Set();
    for (const entry of getFiles().values()) {
      const rel = relPath(entry.path);
      if (!rel.startsWith(prefix) || rel === dir) continue;
      const rest = rel.slice(prefix.length);
      if (!rest) continue;
      direct.add(rest.split("/")[0]);
    }
    return direct.size;
  }

  function newestDescendantMTime(dir) {
    dir = cleanRelPath(dir);
    const prefix = dir ? dir + "/" : "";
    let newest = "";
    for (const entry of getFiles().values()) {
      const rel = relPath(entry.path);
      if (!rel.startsWith(prefix) || rel === dir || !entry.mtime) continue;
      if (!newest || new Date(entry.mtime) > new Date(newest)) newest = entry.mtime;
    }
    return newest;
  }

  function allFolderRows() {
    const folders = new Map();
    for (const entry of getFiles().values()) {
      const rel = relPath(entry.path);
      const parts = rel.split("/").filter(Boolean);
      const limit = entry.is_dir ? parts.length : parts.length - 1;
      for (let i = 1; i <= limit; i++) {
        const folderRel = parts.slice(0, i).join("/");
        if (!folders.has(folderRel)) folders.set(folderRel, synthFolder(folderRel));
      }
    }
    for (const folder of folders.values()) {
      const rel = relPath(folder.path);
      folder.children = countChildren(rel);
      folder.mtime = folder.mtime || newestDescendantMTime(rel);
    }
    return sortFileRows([...folders.values()], relPath);
  }

  return { directoryRows, searchFileRows, sortFileRows: (rows) => sortFileRows(rows, relPath), synthFolder, countChildren, newestDescendantMTime, allFolderRows };
}

export function sortFileRows(rows, relPath) {
  return rows.sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return relPath(a.path).localeCompare(relPath(b.path));
  });
}

export function mountFilesNavigation({ documentRef, getCurrentDir, setCurrentDir, getFilter, setFilter, renderFiles, paths, catalog }) {
  const { cleanRelPath, parentRelPath, relPath, basename } = paths;

  function openDir(dir) {
    setCurrentDir(cleanRelPath(dir));
    setFilter("");
    documentRef.getElementById("filter").value = "";
    renderFiles();
  }

  function renderFolderChrome() {
    const currentDir = getCurrentDir();
    documentRef.getElementById("current-folder").textContent = "/" + (currentDir || "");
    documentRef.getElementById("folder-up").disabled = !currentDir;
    const crumbs = documentRef.getElementById("breadcrumbs");
    crumbs.innerHTML = "";
    const root = documentRef.createElement("button");
    root.type = "button";
    root.textContent = "gcodes";
    root.onclick = () => openDir("");
    crumbs.appendChild(root);
    const parts = currentDir.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const sep = documentRef.createElement("span");
      sep.className = "crumb-sep";
      sep.textContent = "/";
      const btn = documentRef.createElement("button");
      btn.type = "button";
      btn.textContent = parts[i];
      btn.onclick = () => openDir(parts.slice(0, i + 1).join("/"));
      crumbs.append(sep, btn);
    }
  }

  function renderFolderTree() {
    const tree = documentRef.getElementById("folder-tree");
    tree.innerHTML = "";
    tree.appendChild(folderTreeButton("", "gcodes", 0));
    for (const folder of catalog.allFolderRows()) {
      const rel = relPath(folder.path);
      tree.appendChild(folderTreeButton(rel, basename(rel), rel.split("/").length));
    }
  }

  function folderTreeButton(rel, label, depth) {
    const btn = documentRef.createElement("button");
    btn.type = "button";
    btn.className = "folder-tree-item" + (cleanRelPath(rel) === getCurrentDir() ? " active" : "");
    btn.style.paddingLeft = 8 + Math.max(0, depth) * 14 + "px";
    btn.textContent = label;
    btn.onclick = () => openDir(rel);
    return btn;
  }

  function mount() {
    documentRef.getElementById("folder-up").onclick = () => openDir(parentRelPath(getCurrentDir()));
  }

  return { mount, openDir, renderFolderChrome, renderFolderTree, folderTreeButton };
}
