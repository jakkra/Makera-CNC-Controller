export function createSurfaceControls({ state, documentRef = document, callbacks = {} }) {
  const {
    bindButtonAction,
    toggleSurfaceMovementArm,
    selectSurfaceJogMethod,
    stopSurfaceHoldJog,
    saveSurfaceViewPreferences,
    renderSurfaceJog,
    selectSurfaceStep,
    selectSurfaceMotion,
    applySurfaceAutomaticView,
    bindSurfaceMPGWheel,
    selectSurfaceMPGAxis,
    beginSurfaceHoldJog,
    sendSurfaceStep,
    normalizeMachineSettings,
    clampNumber,
  } = callbacks;

  function bindSurfaceStepButton(button, axis, sign) {
    bindButtonAction(button, () => sendSurfaceStep(axis, sign));
  }

  function bindSurfaceHoldButton(button, axis, sign, useSelectedAxis = false) {
    if (!button) return;
    let pointerId = null;
    const targetAxis = () => useSelectedAxis ? state.surface.mpg_axis : axis;
    const start = () => {
      if (state.surface.motion === "step" && !useSelectedAxis) return;
      beginSurfaceHoldJog(targetAxis(), sign);
    };
    const stop = () => stopSurfaceHoldJog();
    button.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      // A hold-to-move control owns the touch for its full duration. Prevent the
      // browser from turning a deliberate hold into text selection or a context
      // menu while preserving the button's keyboard path below.
      e.preventDefault();
      pointerId = e.pointerId;
      button.setPointerCapture?.(pointerId);
      if (state.surface.motion === "hold" || useSelectedAxis) start();
    });
    button.addEventListener("pointerup", (e) => {
      if (pointerId !== e.pointerId) return;
      if (state.surface.motion === "hold" || useSelectedAxis) stop();
      else sendSurfaceStep(targetAxis(), sign);
      pointerId = null;
    });
    button.addEventListener("pointercancel", stop);
    button.addEventListener("lostpointercapture", stop);
    button.addEventListener("contextmenu", (e) => e.preventDefault());
    button.addEventListener("keydown", (e) => {
      if (e.repeat || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      if (state.surface.motion === "hold" || useSelectedAxis) start();
      else sendSurfaceStep(targetAxis(), sign);
    });
    button.addEventListener("keyup", (e) => {
      if (e.key === "Enter" || e.key === " ") stop();
    });
    button.addEventListener("click", (e) => e.preventDefault());
  }

  function bindSurfaceXYMap() {
    const modal = documentRef.getElementById("surface-xy-map-modal");
    const plot = documentRef.getElementById("surface-xy-map-plot");
    const target = documentRef.getElementById("surface-xy-map-target");
    const close = () => modal?.close();
    documentRef.getElementById("surface-map-open")?.addEventListener("click", () => modal?.showModal());
    documentRef.getElementById("surface-map-close")?.addEventListener("click", close);
    documentRef.getElementById("surface-map-close-bottom")?.addEventListener("click", close);
    modal?.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
    plot?.addEventListener("pointerdown", (e) => {
      const rect = plot.getBoundingClientRect();
      const work = normalizeMachineSettings(state.ui.machine).work_area;
      const x = work.x_min + clampNumber((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1) * (work.x_max - work.x_min);
      const y = work.y_max - clampNumber((e.clientY - rect.top) / Math.max(1, rect.height), 0, 1) * (work.y_max - work.y_min);
      target.textContent = `X ${x.toFixed(1)}  Y ${y.toFixed(1)} mm`;
    });
  }

  function bindFooterInteractions({
    bindButtonAction: bind = bindButtonAction,
    sendControl,
    resumeActiveJob,
    onVacuum,
  } = {}) {
    bind(documentRef.getElementById("surface-footer-hold"), () => sendControl("hold"));
    bind(documentRef.getElementById("surface-footer-resume"), () => resumeActiveJob());
    bind(documentRef.getElementById("surface-footer-vacuum"), onVacuum);
  }

  function init() {
    bindButtonAction(documentRef.getElementById("surface-jog-arm"), toggleSurfaceMovementArm);
    documentRef.getElementById("surface-jog-directional").onclick = () => selectSurfaceJogMethod("directional");
    documentRef.getElementById("surface-jog-mpg").onclick = () => selectSurfaceJogMethod("mpg");
    documentRef.getElementById("surface-jog-motion").onchange = (e) => {
      stopSurfaceHoldJog();
      state.surface.motion = e.target.value === "hold" ? "hold" : "step";
      saveSurfaceViewPreferences();
      renderSurfaceJog();
    };
    documentRef.getElementById("surface-jog-step").onchange = (e) => {
      selectSurfaceStep(e.target.value);
    };
    for (const button of documentRef.querySelectorAll("[data-surface-step]")) {
      button.onclick = () => selectSurfaceStep(button.dataset.surfaceStep);
    }
    for (const button of documentRef.querySelectorAll("[data-surface-motion]")) {
      button.onclick = () => selectSurfaceMotion(button.dataset.surfaceMotion);
    }
    documentRef.getElementById("surface-auto-switch").onchange = (e) => {
      state.surface.auto_switch = !!e.target.checked;
      saveSurfaceViewPreferences();
      applySurfaceAutomaticView();
    };
    documentRef.getElementById("surface-start-view").onchange = (e) => {
      state.surface.start_view = ["jog", "active-job", "dashboard"].includes(e.target.value) ? e.target.value : "jog";
      saveSurfaceViewPreferences();
    };
    documentRef.getElementById("surface-mpg-feedback").onchange = (e) => {
      state.surface.mpg_feedback = e.target.value === "detent" ? "detent" : "confirmed";
      saveSurfaceViewPreferences();
    };
    for (const button of documentRef.querySelectorAll("[data-surface-axis]")) {
      bindSurfaceHoldButton(button, button.dataset.surfaceAxis, Number(button.dataset.surfaceSign), false);
    }
    for (const button of documentRef.querySelectorAll("[data-surface-z-sign]")) {
      bindSurfaceHoldButton(button, "z", Number(button.dataset.surfaceZSign), false);
    }
    for (const button of documentRef.querySelectorAll("[data-surface-a-sign]")) {
      bindSurfaceStepButton(button, "a", Number(button.dataset.surfaceASign));
    }
    for (const button of documentRef.querySelectorAll("[data-surface-a-turn]")) {
      bindButtonAction(button, () => sendSurfaceStep("a", 1, "button", Number(button.dataset.surfaceATurn)));
    }
    for (const button of documentRef.querySelectorAll("[data-surface-hold-sign]")) {
      bindSurfaceHoldButton(button, "", Number(button.dataset.surfaceHoldSign), true);
    }
    for (const button of documentRef.querySelectorAll(".surface-mpg-axis")) {
      button.onclick = () => selectSurfaceMPGAxis(button.dataset.surfaceMpgAxis);
    }
    bindSurfaceMPGWheel();
    bindSurfaceXYMap();
    documentRef.getElementById("surface-jog-settings-open").onclick = () => documentRef.getElementById("surface-settings-modal")?.showModal();
    documentRef.getElementById("surface-settings-close").onclick = () => documentRef.getElementById("surface-settings-modal")?.close();
  }

  return { init, bindFooterInteractions, bindSurfaceStepButton, bindSurfaceHoldButton, bindSurfaceXYMap };
}
