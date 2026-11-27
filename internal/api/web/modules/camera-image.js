// Exposure controls for the external camera, shown in the camera dialog next
// to focus. Each change is applied at once so its effect is visible in the
// stream; the proxy stores it and restores it when the camera reconnects.

export function cameraImageBody(form) {
  return {
    auto_exposure: form.mode === "auto",
    exposure_time: Math.round(Number(form.exposure)),
    gain: Math.round(Number(form.gain)),
    brightness: Math.round(Number(form.brightness)),
    power_line: Number(form.powerLine),
    dynamic_framerate: !!form.dynamicFramerate,
  };
}

export function createCameraImageControls({ document, request, setStatusMessage, setTimeoutRef = setTimeout, clearTimeoutRef = clearTimeout }) {
  const node = (id) => document.getElementById("camera-image-" + id);
  const form = { mode: "auto", exposure: 250, gain: 0, brightness: 128, powerLine: 1, dynamicFramerate: false };
  let available = false;
  let pending = false;
  let timer = null;

  function render() {
    const root = node("section");
    if (!root) return;
    for (const button of root.querySelectorAll("[data-camera-exposure]")) {
      button.setAttribute("aria-pressed", String(button.dataset.cameraExposure === form.mode));
      button.disabled = !available;
    }
    for (const button of root.querySelectorAll("[data-camera-power-line]")) {
      button.setAttribute("aria-pressed", String(Number(button.dataset.cameraPowerLine) === Number(form.powerLine)));
      button.disabled = !available;
    }
    for (const [name, key] of [["exposure", "exposure"], ["gain", "gain"], ["brightness", "brightness"]]) {
      const input = node(name);
      if (document.activeElement !== input) input.value = String(form[key]);
      input.disabled = !available || (name === "exposure" && form.mode === "auto");
      node(name + "-label").textContent = name === "exposure"
        ? (form.mode === "auto" ? "automatic" : `${(form[key] / 10).toFixed(1)} ms`)
        : String(form[key]);
    }
    const dynamic = node("dynamic");
    dynamic.checked = !!form.dynamicFramerate;
    dynamic.disabled = !available;
  }

  async function load() {
    available = false;
    render();
    try {
      const data = await (await request("/api/camera/external/image")).json();
      Object.assign(form, {
        mode: data.auto_exposure ? "auto" : "manual",
        exposure: data.exposure_time,
        gain: data.gain,
        brightness: data.brightness,
        powerLine: data.power_line,
        dynamicFramerate: data.dynamic_framerate,
      });
      node("exposure").min = String(data.exposure_min ?? 3);
      node("exposure").max = String(data.exposure_max ?? 2047);
      available = data.available === true;
    } catch (error) {
      setStatusMessage("camera-image", `Camera exposure unavailable: ${error?.message || "the controls could not be read"}.`, "error", { force: true });
    }
    render();
  }

  async function apply() {
    if (!available) return;
    if (pending) {
      schedule();
      return;
    }
    pending = true;
    try {
      await request("/api/camera/external/image", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cameraImageBody(form)),
      });
      setStatusMessage("camera-image", "");
    } catch (error) {
      setStatusMessage("camera-image", `Camera exposure failed: ${error?.message || "the controls could not be updated"}.`, "error", { force: true });
    } finally {
      pending = false;
    }
  }

  function schedule() {
    if (timer) clearTimeoutRef(timer);
    timer = setTimeoutRef(() => {
      timer = null;
      apply();
    }, 250);
  }

  function bind() {
    const root = node("section");
    if (!root) return;
    root.addEventListener("click", (event) => {
      const mode = event.target.closest?.("[data-camera-exposure]");
      const power = event.target.closest?.("[data-camera-power-line]");
      if (mode && !mode.disabled) form.mode = mode.dataset.cameraExposure;
      else if (power && !power.disabled) form.powerLine = Number(power.dataset.cameraPowerLine);
      else return;
      render();
      schedule();
    });
    for (const name of ["exposure", "gain", "brightness"]) {
      node(name).addEventListener("input", (event) => {
        form[name] = Number(event.target.value);
        render();
        schedule();
      });
    }
    node("dynamic").addEventListener("change", (event) => {
      form.dynamicFramerate = event.target.checked;
      schedule();
    });
    // Read the camera whenever its dialog opens.
    const modal = document.getElementById("dashboard-camera-focus-modal");
    const Observer = document.defaultView?.MutationObserver;
    if (modal && Observer) {
      new Observer(() => { if (modal.open) load(); }).observe(modal, { attributes: true, attributeFilter: ["open"] });
    }
  }

  return { bind, load, render };
}
