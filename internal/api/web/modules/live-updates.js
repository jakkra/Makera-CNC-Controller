// Own the existing scoped streams and status poll; callbacks retain snapshot ordering.
export function createLiveUpdates({
  request,
  applySnapshot,
  applyMachineStatus,
  appendGcodeLine,
  applyChange,
  clearConnectivityIssue,
  setConnectivityIssue,
  refreshJobs,
  EventSource = globalThis.EventSource,
}) {
  const state = { controlES: null, filesES: null };

  function resetEventStream(key) {
    const stream = state[key];
    if (!stream) return;
    stream.onopen = null;
    stream.onerror = null;
    stream.close();
    state[key] = null;
  }

  function connectControlSSE() {
    if (state.controlES) return;
    const es = new EventSource("/api/events?scope=control");
    state.controlES = es;
    es.onopen = () => clearConnectivityIssue("control-sse");
    es.addEventListener("snapshot", (e) => {
      clearConnectivityIssue("control-sse");
      applySnapshot(JSON.parse(e.data));
    });
    es.addEventListener("machine", (e) => applyMachineStatus(JSON.parse(e.data)));
    es.addEventListener("gcode", (e) => appendGcodeLine(JSON.parse(e.data)));
    es.onerror = () => setConnectivityIssue("control-sse", "Control event stream disconnected; retrying.");
  }

  function connectFilesSSE() {
    if (state.filesES) return;
    const es = new EventSource("/api/events?scope=files");
    state.filesES = es;
    es.onopen = () => clearConnectivityIssue("files-sse");
    es.addEventListener("snapshot", (e) => {
      clearConnectivityIssue("files-sse");
      applySnapshot(JSON.parse(e.data));
    });
    es.addEventListener("change", (e) => applyChange(JSON.parse(e.data)));
    es.onerror = () => setConnectivityIssue("files-sse", "Files event stream disconnected; retrying.");
  }

  async function pollMachine() {
    try {
      const r = await request("/api/machine/status");
      const next = await r.json();
      applyMachineStatus(next);
      clearConnectivityIssue("machine-status");
    } catch (e) {
      setConnectivityIssue("machine-status", "Machine status unavailable: " + e.message);
    }
    try {
      await refreshJobs();
    } catch {
      // File SSE reports its own disconnect state; avoid duplicating it here.
    }
  }

  return { resetEventStream, connectControlSSE, connectFilesSSE, pollMachine };
}
