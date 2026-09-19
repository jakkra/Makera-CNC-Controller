import { setTextIfChanged } from "./dom.js";
import { fmtDuration, fmtTime } from "./format.js";

export function mountMaintenance({ request, setStatusMessage, bindButtonAction, getReadOnly, documentRef = document }) {
  const featureState = {
    runs: [],
    notificationSnapshot: { enabled: false, deliveries: [] },
    loading: false,
    testPending: false,
  };

  function runOutcome(run) {
    if (run?.active) return "Running";
    if (Array.isArray(run?.alarms) && run.alarms.length) return "Alarm";
    switch (String(run?.end_state || "")) {
    case "Idle": return "Completed";
    case "Unknown": return "Unknown";
    default: return String(run?.end_state || "Ended");
    }
  }

  function openRunHistoryDetail(run) {
    const dialog = documentRef.getElementById("run-history-dialog");
    const title = documentRef.getElementById("run-history-detail-title");
    const summary = documentRef.getElementById("run-history-detail-summary");
    const eventsRoot = documentRef.getElementById("run-history-detail-events");
    if (!dialog || !title || !summary || !eventsRoot) return;
    title.textContent = run.file || "Observed controller job";
    summary.textContent = `${runOutcome(run)} · ${fmtDuration(Number(run.duration_ms))} · ${fmtTime(run.started_at)}`;
    const fragment = documentRef.createDocumentFragment();
    for (const event of runHistoryEvents(run)) {
      const row = documentRef.createElement("div");
      row.className = "run-history-event";
      const time = documentRef.createElement("time");
      time.textContent = fmtTime(event.time);
      const text = documentRef.createElement("span");
      text.textContent = event.text;
      row.append(time, text);
      fragment.appendChild(row);
    }
    if (!fragment.children.length) {
      const empty = documentRef.createElement("div");
      empty.className = "maintenance-empty";
      empty.textContent = "No observed events for this job.";
      fragment.appendChild(empty);
    }
    eventsRoot.replaceChildren(fragment);
    dialog.showModal();
  }

  function render() {
    const runs = documentRef.getElementById("maintenance-runs");
    const notifications = documentRef.getElementById("maintenance-notifications");
    if (runs) {
      const fragment = documentRef.createDocumentFragment();
      for (const run of featureState.runs) {
        const row = documentRef.createElement("button");
        row.type = "button";
        row.className = "maintenance-row";
        const title = documentRef.createElement("strong");
        title.textContent = run.file || "Observed controller job";
        const detail = documentRef.createElement("span");
        detail.textContent = `${runOutcome(run)} · ${fmtDuration(Number(run.duration_ms))} · ${fmtTime(run.started_at)}`;
        row.append(title, detail);
        row.title = `${title.textContent} · ${detail.textContent}`;
        row.onclick = () => openRunHistoryDetail(run);
        fragment.appendChild(row);
      }
      if (!fragment.children.length) {
        const empty = documentRef.createElement("div");
        empty.className = "maintenance-empty";
        empty.textContent = "No observed jobs yet.";
        fragment.appendChild(empty);
      }
      runs.replaceChildren(fragment);
    }
    if (notifications) {
      const fragment = documentRef.createDocumentFragment();
      const deliveries = Array.isArray(featureState.notificationSnapshot?.deliveries) ? featureState.notificationSnapshot.deliveries : [];
      for (const delivery of deliveries) {
        const row = documentRef.createElement("div");
        row.className = "maintenance-row";
        const title = documentRef.createElement("strong");
        title.textContent = delivery.title || "Notification";
        const detail = documentRef.createElement("span");
        detail.textContent = `${delivery.state || "unknown"} · ${delivery.body || delivery.error || ""} · ${fmtTime(delivery.created_at)}`;
        row.append(title, detail);
        row.title = `${title.textContent} · ${detail.textContent}`;
        fragment.appendChild(row);
      }
      if (!fragment.children.length) {
        const empty = documentRef.createElement("div");
        empty.className = "maintenance-empty";
        empty.textContent = featureState.notificationSnapshot?.enabled ? "No notification deliveries yet." : "Mobile notifications are not configured.";
        fragment.appendChild(empty);
      }
      notifications.replaceChildren(fragment);
    }
    const test = documentRef.getElementById("maintenance-notification-test");
    if (test) {
      test.disabled = !featureState.notificationSnapshot?.enabled || featureState.testPending || getReadOnly();
      test.setAttribute("aria-busy", String(featureState.testPending));
      setTextIfChanged(test, featureState.testPending ? "Sending test…" : "Test notification");
    }
  }

  async function load() {
    if (featureState.loading) return;
    featureState.loading = true;
    try {
      const [runsResponse, notificationResponse] = await Promise.all([request("/api/runs"), request("/api/notifications")]);
      featureState.runs = await runsResponse.json();
      featureState.notificationSnapshot = await notificationResponse.json();
      render();
    } catch (error) {
      setStatusMessage("maintenance", "Maintenance history could not be loaded: " + error.message, "error", { force: true });
    } finally {
      featureState.loading = false;
    }
  }

  async function testNotification() {
    if (!featureState.notificationSnapshot?.enabled || featureState.testPending || getReadOnly()) return;
    featureState.testPending = true;
    render();
    setStatusMessage("maintenance-notification", "Sending notification test…", "", { force: true });
    try {
      await request("/api/notifications/test", { method: "POST" });
      setStatusMessage("maintenance-notification", "Notification test sent.", "ok", { force: true });
      await load();
    } catch (error) {
      setStatusMessage("maintenance-notification", "Notification test failed: " + error.message, "error", { force: true });
    } finally {
      featureState.testPending = false;
      render();
    }
  }

  function mount() {
    bindButtonAction(documentRef.getElementById("maintenance-notification-test"), testNotification);
    documentRef.getElementById("run-history-detail-close").onclick = () => documentRef.getElementById("run-history-dialog")?.close();
  }

  return { mount, load, render, runHistoryEvents };
}

export function runHistoryEvents(run) {
  const events = [];
  for (const item of Array.isArray(run?.state_transitions) ? run.state_transitions : []) events.push({ time: item.time, text: `Machine state · ${item.state}` });
  for (const item of Array.isArray(run?.alarms) ? run.alarms : []) events.push({ time: item.time, text: `Alarm${item.halt_reason?.code ? ` · ${item.halt_reason.code}` : ""}` });
  for (const item of Array.isArray(run?.feed_overrides) ? run.feed_overrides : []) events.push({ time: item.time, text: `Feed override · ${Math.round(Number(item.override) || 0)}%` });
  for (const item of Array.isArray(run?.spindle_overrides) ? run.spindle_overrides : []) events.push({ time: item.time, text: `Spindle override · ${Math.round(Number(item.override) || 0)}%` });
  for (const item of Array.isArray(run?.commands) ? run.commands : []) events.push({ time: item.time, text: `${item.source || "controller"} · ${item.text || "command"}` });
  return events.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
}
