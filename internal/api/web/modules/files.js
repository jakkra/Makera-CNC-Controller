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

export function mountFilesRows({
  documentRef,
  windowRef,
  getFilter,
  getCurrentDir,
  getFilesLoaded,
  getFileActions,
  getActiveSelectPendingPath,
  getFileRenderTimer,
  setFileRenderTimer,
  directoryRows,
  searchFileRows,
  renderFileSummary,
  renderFolderChrome,
  renderFolderTree,
  escapeHtml,
  fmtSize,
  fmtTime,
  relPath,
  basename,
  apiFileURL,
  syncLabel,
  preferredRetryJob,
  failedJobsForPath,
  canDiscardFile,
  canSelectGcodeFile,
  retryButtonText,
  retryJob,
  discardFile,
  doRename,
  doDelete,
  selectActiveGcode,
  openDir,
}) {
  function renderFiles() {
    if (getFileRenderTimer()) {
      clearTimeout(getFileRenderTimer());
      setFileRenderTimer(null);
    }
    renderFileSummary();
    renderFolderChrome();
    renderFolderTree();
    const tbody = documentRef.getElementById("files");
    const q = getFilter().trim().toLowerCase();
    const rows = q ? searchFileRows(q) : directoryRows(getCurrentDir());

    const empty = documentRef.getElementById("files-empty");
    empty.textContent = getFilesLoaded()
      ? (q ? "No files or folders match the search." : "This folder is empty.")
      : "Files load when this tab opens.";
    empty.hidden = rows.length > 0;

    // Update stable row nodes keyed by path instead of rebuilding the table:
    // rows whose rendered state is unchanged keep their DOM (and any in-flight
    // click/pointer state); only rows whose signature changed are rebuilt.
    const existing = new Map();
    for (const tr of tbody.children) existing.set(tr.dataset.fileKey, tr);
    rows.forEach((f, i) => {
      const key = (f.virtual ? "virtual:" : "entry:") + relPath(f.path);
      const signature = fileRowSignature(f, q);
      let tr = existing.get(key);
      if (tr) {
        existing.delete(key);
        if (tr.dataset.fileSignature !== signature) {
          if (isFileRowLocallyOwned(tr)) {
            scheduleFileRender();
          } else {
            buildFileRow(tr, f, q);
            tr.dataset.fileSignature = signature;
          }
        }
      } else {
        tr = documentRef.createElement("tr");
        tr.dataset.fileKey = key;
        buildFileRow(tr, f, q);
        tr.dataset.fileSignature = signature;
      }
      const ref = tbody.children[i] || null;
      if (ref !== tr) tbody.insertBefore(tr, ref);
    });
    for (const tr of existing.values()) {
      if (isFileRowLocallyOwned(tr)) {
        scheduleFileRender();
      } else {
        tr.remove();
      }
    }
  }

  function isFileRowLocallyOwned(row) {
    return fileRowLocallyOwned(row, getFileActions(), documentRef.activeElement);
  }

  function scheduleFileRender() {
    if (getFileRenderTimer()) return;
    setFileRenderTimer(setTimeout(() => {
      setFileRenderTimer(null);
      renderFiles();
    }, 250));
  }

  function fileRowSignature(f, q) {
    const retry = preferredRetryJob(failedJobsForPath(f.path));
    return JSON.stringify([
      q ? 1 : 0,
      f.is_dir ? 1 : 0,
      f.virtual ? 1 : 0,
      f.children,
      f.error || "",
      f.sync || "",
      f.size,
      f.mtime || "",
      retry ? retry.id + "/" + retryButtonText(retry) : "",
      canDiscardFile(f) ? 1 : 0,
      canSelectGcodeFile(f) ? 1 : 0,
      getActiveSelectPendingPath() === f.path ? 1 : 0,
      getFileActions().get(f.path) || "",
    ]);
  }

  function buildFileRow(tr, f, q) {
    tr.dataset.filePath = f.path;
    tr.dataset.fileAction = getFileActions().get(f.path) || "";
    tr.classList.toggle("is-folder", !!f.is_dir);
    tr.classList.toggle("is-file", !f.is_dir);
    tr.classList.toggle("is-virtual", !!f.virtual);
    const label = syncLabel[f.sync] || f.sync || "-";
    const type = f.is_dir ? (f.virtual ? "folder" : "dir") : "file";
    tr.innerHTML = `
    <td class="path-cell">
      <button type="button" class="file-name ${f.is_dir ? "folder-name" : ""}">${escapeHtml(q ? relPath(f.path) : basename(f.path))}</button>
      ${f.children != null ? `<div class="muted">${f.children} item${f.children === 1 ? "" : "s"}</div>` : ""}
      ${f.error ? `<div class="err">${escapeHtml(f.error)}</div>` : ""}
    </td>
    <td class="file-type-cell" data-label="Type">${type}</td>
    <td class="file-size-cell num" data-label="${f.is_dir ? "Items" : "Size"}">${escapeHtml(f.is_dir && f.children != null ? String(f.children) : fmtSize(f.size, f.is_dir))}</td>
    <td class="file-modified-cell" data-label="Modified">${escapeHtml(fmtTime(f.mtime))}</td>
    <td class="status-cell">${f.virtual ? `<span class="sync"><span class="dot"></span>Folder</span>` : `<span class="sync s-${escapeHtml(f.sync)}"><span class="dot"></span>${escapeHtml(label)}</span>`}</td>
    <td class="actions"></td>`;

    const actions = tr.querySelector(".actions");
    const name = tr.querySelector(".file-name");
    if (f.is_dir) {
      name.onclick = () => openDir(relPath(f.path));
      const open = documentRef.createElement("button");
      open.type = "button";
      open.textContent = "Open";
      open.onclick = () => openDir(relPath(f.path));
      actions.append(open);
    } else {
      name.onclick = () => windowRef.open(apiFileURL(f.path), "_blank", "noopener");
      const open = documentRef.createElement("a");
      open.textContent = "Open";
      open.href = apiFileURL(f.path);
      open.target = "_blank";
      open.rel = "noopener";
      actions.append(open);
    }
    if (!f.virtual) appendFileActions(actions, f);
  }

  function appendFileActions(actions, f) {
    const pending = getFileActions().get(f.path);
    if (pending) {
      const btn = documentRef.createElement("button");
      btn.type = "button";
      btn.textContent = pending;
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
      actions.append(btn);
      return;
    }
    const failed = failedJobsForPath(f.path);
    const retry = preferredRetryJob(failed);
    if (retry) {
      const btn = documentRef.createElement("button");
      btn.type = "button";
      btn.textContent = retryButtonText(retry);
      btn.onclick = () => retryJob(retry);
      actions.append(btn);
    }
    if (canDiscardFile(f)) appendFileOverflowAction(actions, "Discard", () => discardFile(f.path));
    if (f.sync === "error") return;
    if (canSelectGcodeFile(f)) {
      const select = documentRef.createElement("button");
      select.type = "button";
      const pendingSelect = getActiveSelectPendingPath() === f.path;
      select.textContent = pendingSelect ? "Selecting..." : "Select";
      select.disabled = pendingSelect;
      select.onclick = () => selectActiveGcode(f.path);
      actions.append(select);
    }
    const rename = documentRef.createElement("button");
    rename.type = "button";
    rename.textContent = "Rename";
    rename.onclick = () => doRename(f.path);
    const del = documentRef.createElement("button");
    del.type = "button";
    del.textContent = "Delete";
    del.onclick = () => doDelete(f.path);
    appendFileOverflowAction(actions, rename);
    appendFileOverflowAction(actions, del, null, true);
  }

  function fileOverflowMenu(actions) {
    let menu = actions.querySelector(".file-row-menu");
    if (menu) return menu;
    menu = documentRef.createElement("details");
    menu.className = "file-row-menu";
    const summary = documentRef.createElement("summary");
    summary.setAttribute("aria-label", "More file actions");
    summary.title = "More actions";
    summary.textContent = "•••";
    const panel = documentRef.createElement("div");
    panel.className = "file-row-menu-panel";
    menu.append(summary, panel);
    actions.append(menu);
    return menu;
  }

  function appendFileOverflowAction(actions, labelOrButton, onclick, danger = false) {
    const menu = fileOverflowMenu(actions);
    const button = labelOrButton instanceof windowRef.HTMLElement ? labelOrButton : documentRef.createElement("button");
    button.type = "button";
    if (typeof labelOrButton === "string") button.textContent = labelOrButton;
    if (onclick) button.onclick = onclick;
    if (danger) button.classList.add("danger");
    button.addEventListener("click", () => menu.removeAttribute("open"));
    menu.querySelector(".file-row-menu-panel").append(button);
    actions.append(menu);
  }

  return { renderFiles, fileRowLocallyOwned: isFileRowLocallyOwned, scheduleFileRender, fileRowSignature, buildFileRow, appendFileActions, fileOverflowMenu, appendFileOverflowAction };
}

export function mountFilesCommands({
  documentRef,
  request,
  FormDataRef,
  promptRef,
  confirmRef,
  getCurrentDir,
  setCurrentDir,
  setFilter,
  joinRelPath,
  cleanRelPath,
  dirname,
  basename,
  relPath,
  apiFileURL,
  retryButtonText,
  setNotice,
  clearNotice,
  beginFileAction,
  endFileAction,
  renderFiles,
}) {
  async function uploadFiles(fileList) {
    clearNotice("files-action");
    for (const file of fileList) {
      const target = joinRelPath(getCurrentDir(), file.name);
      const fd = new FormDataRef();
      fd.append("file", file, file.name);
      fd.append("path", target);
      try {
        await request("/api/files", { method: "POST", body: fd });
        setNotice("Queued upload: " + target, "ok", "files-action");
      } catch (e) {
        setNotice("Upload failed for " + file.name + ": " + e.message, "error", "files-action");
      }
    }
  }

  async function doMkdir() {
    const name = promptRef("New folder name:");
    if (!name) return;
    const dir = joinRelPath(getCurrentDir(), name);
    try {
      await request("/api/dirs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: dir }),
      });
      setNotice("Folder queued: " + dir, "ok", "files-action");
      setCurrentDir(cleanRelPath(dir));
      renderFiles();
    } catch (e) {
      setNotice("Folder create failed: " + e.message, "error", "files-action");
    }
  }

  async function doDelete(path) {
    if (!confirmRef("Delete " + relPath(path) + "?")) return;
    beginFileAction(path, "Deleting...", "Deleting: " + relPath(path));
    try {
      await request(apiFileURL(path), { method: "DELETE" });
      setNotice("Delete accepted: " + relPath(path), "ok", "files-action");
    } catch (e) {
      setNotice("Delete failed: " + e.message, "error", "files-action");
    } finally {
      endFileAction(path);
    }
  }

  async function retryJob(job) {
    if (!job) return;
    beginFileAction(job.path, "Retrying...", retryButtonText(job) + ": " + relPath(job.path));
    try {
      await request("/api/files/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: job.id }),
      });
      setNotice(retryButtonText(job) + " queued: " + relPath(job.path), "ok", "files-action");
    } catch (e) {
      setNotice("Retry failed: " + e.message, "error", "files-action");
    } finally {
      endFileAction(job.path);
    }
  }

  async function discardFile(path) {
    if (!confirmRef("Discard local state for " + relPath(path) + "? This does not delete anything from the machine.")) return;
    beginFileAction(path, "Discarding...", "Discarding local state: " + relPath(path));
    try {
      await request("/api/files/discard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      setNotice("Discarded local state: " + relPath(path), "ok", "files-action");
    } catch (e) {
      setNotice("Discard failed: " + e.message, "error", "files-action");
    } finally {
      endFileAction(path);
    }
  }

  async function doRename(path) {
    const currentName = basename(path);
    const nextName = promptRef("Rename to:", currentName);
    if (!nextName || nextName === currentName) return;
    const dir = dirname(path);
    const to = dir ? dir + "/" + nextName : nextName;
    beginFileAction(path, "Renaming...", "Renaming: " + relPath(path));
    try {
      await request("/api/files/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: path, to }),
      });
      setNotice("Rename queued: " + relPath(path) + " -> " + to, "ok", "files-action");
    } catch (e) {
      setNotice("Rename failed: " + e.message, "error", "files-action");
    } finally {
      endFileAction(path);
    }
  }

  let bound = false;
  function bind() {
    if (bound) return;
    bound = true;
    const input = documentRef.getElementById("file");
    const drop = documentRef.getElementById("drop");
    drop.onclick = () => input.click();
    input.onchange = () => { uploadFiles(input.files); input.value = ""; };
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = (e) => {
      e.preventDefault();
      drop.classList.remove("over");
      uploadFiles(e.dataTransfer.files);
    };
    documentRef.getElementById("filter").oninput = (e) => {
      setFilter(e.target.value);
      renderFiles();
    };
    documentRef.getElementById("folder-new").onclick = doMkdir;
  }

  return { bind, uploadFiles, doMkdir, doDelete, retryJob, discardFile, doRename };
}

export function mountFilesTransitions({
  getFiles,
  setFiles,
  setFilesLoaded,
  getJobs,
  setJobs,
  getMachine,
  queuePendingCount,
  renderMachine,
  renderFiles,
  renderJobs,
  isActiveGcodePath,
  loadActiveGcode,
}) {
  function applySnapshot(snap) {
    if (Array.isArray(snap.files)) {
      setFiles(new Map(snap.files.map((f) => [f.path, f])));
      setFilesLoaded(true);
    }
    if (Array.isArray(snap.jobs)) {
      setJobs(new Map(snap.jobs.map((j) => [j.id, j])));
      getMachine().pending_jobs = queuePendingCount();
    }
  }

  function applyEntry(entry) {
    if (entry.sync === "") getFiles().delete(entry.path);
    else getFiles().set(entry.path, entry);
    if (isActiveGcodePath(entry.path)) loadActiveGcode();
    renderMachine();
    renderFiles();
  }

  function applyJob(job) {
    getJobs().set(job.id, job);
    getMachine().pending_jobs = queuePendingCount();
    renderMachine();
    renderJobs();
  }

  return { applySnapshot, applyEntry, applyJob };
}

export function mountFilesJobRefresh({
  request,
  getFilesLoaded,
  getJobs,
  setJobs,
  getMachine,
  queuePendingCount,
  renderMachine,
  renderFiles,
  renderJobs,
}) {
  function hasLiveJobs() {
    return [...getJobs().values()].some((j) => j.state === "queued" || j.state === "running");
  }

  async function refreshJobs() {
    if (!getFilesLoaded() || !hasLiveJobs()) return;
    const r = await request("/api/jobs");
    const jobs = await r.json();
    if (!Array.isArray(jobs)) return;
    setJobs(new Map(jobs.map((j) => [j.id, j])));
    getMachine().pending_jobs = queuePendingCount();
    renderMachine();
    renderFiles();
    renderJobs();
  }

  return { hasLiveJobs, refreshJobs };
}
