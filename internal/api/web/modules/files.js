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

export function mountFilesPresentation({ documentRef, getFiles, getJobs, getFilesLoaded, relPath, escapeHtml, retryButtonText, retryJob, discardFile, canDiscardFile, syncLabel }) {
  function renderFileSummary() {
    const box = documentRef.getElementById("file-summary");
    const counts = new Map();
    for (const f of getFiles().values()) counts.set(f.sync || "unknown", (counts.get(f.sync || "unknown") || 0) + 1);
    const total = getFiles().size;
    const parts = [["files", total], ...[...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))];
    box.innerHTML = "";
    for (const [label, count] of parts) {
      const el = documentRef.createElement("span");
      el.className = "summary-pill";
      el.textContent = `${syncLabel[label] || label}: ${count}`;
      box.appendChild(el);
    }
  }

  function renderJobs() {
    const div = documentRef.getElementById("jobs");
    const jobs = [...getJobs().values()].filter((j) => j.state !== "done").sort((a, b) => a.id - b.id);
    documentRef.getElementById("active-jobs").textContent = String(jobs.length);
    if (!jobs.length) {
      const text = getFilesLoaded() ? "No active or failed jobs." : "Activity loads with the Files tab.";
      div.innerHTML = `<div class="empty">${text}</div>`;
      return;
    }
    div.innerHTML = `<div class="jobs-head"><span>Job</span><span>Status</span><span>Detail</span></div>`;
    for (const j of jobs) {
      const row = documentRef.createElement("div");
      row.className = "job";
      row.innerHTML = `
      <span class="job-main"><span class="job-kind">${escapeHtml(j.kind)}</span><span class="name">${escapeHtml(relPath(j.path))}</span></span>
      <span class="job-status">${escapeHtml(jobStatusText(j))}</span>
      <span class="job-detail">${jobDetailHTML(j)}</span>`;
      appendJobActions(row.querySelector(".job-detail"), j);
      div.appendChild(row);
    }
  }

  function jobStatusText(j) {
    return `${j.state || ""}${j.attempts ? `, attempt ${j.attempts}` : ""}`;
  }

  function jobDetailHTML(j) {
    if (j.state === "failed" && j.last_error) return `<span class="job-message">Failed</span><span class="job-error">${escapeHtml(j.last_error)}</span>`;
    const message = j.blocked_message || j.last_error || "";
    return message ? `<span class="job-message">${escapeHtml(message)}</span>` : "";
  }

  function appendJobActions(box, job) {
    const actions = documentRef.createElement("span");
    actions.className = "job-recovery";
    if (job.state === "failed") {
      const retry = documentRef.createElement("button");
      retry.type = "button";
      retry.textContent = retryButtonText(job);
      retry.onclick = () => retryJob(job);
      actions.append(retry);
      const discard = documentRef.createElement("button");
      discard.type = "button";
      discard.textContent = "Discard";
      discard.onclick = () => discardFile(job.path);
      actions.append(discard);
    }
    const entry = getFiles().get(job.path);
    if (job.state !== "failed" && job.state !== "running" && entry && canDiscardFile(entry)) {
      const discard = documentRef.createElement("button");
      discard.type = "button";
      discard.textContent = "Discard";
      discard.onclick = () => discardFile(job.path);
      actions.append(discard);
    }
    if (actions.children.length) box.appendChild(actions);
  }

  return { renderFileSummary, renderJobs, jobStatusText, jobDetailHTML, appendJobActions };
}
