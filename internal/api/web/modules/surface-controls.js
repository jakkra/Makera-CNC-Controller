import { bedMapExtent, bedPlatePlacement, bedPlateSVG, describeBedTarget } from "./bed-plate.js";

export function createSurfaceControls({ state, documentRef = document, performanceRef = globalThis.performance, callbacks = {} }) {
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
    goToSurfaceDestination,
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

  let renderXYMapControls = () => {};

  function bindSurfaceXYMap() {
    const modal = documentRef.getElementById("surface-xy-map-modal");
    const plot = documentRef.getElementById("surface-xy-map-plot");
    const target = documentRef.getElementById("surface-xy-map-target");
    const move = documentRef.getElementById("surface-map-move");
    const arm = documentRef.getElementById("surface-map-arm");
    const inputs = ["x", "y"].map((axis) => documentRef.getElementById("surface-map-" + axis));
    let selected = null;
    let press = null;
    const mapModel = () => {
      const machine = normalizeMachineSettings(state.ui.machine);
      const work = machine.work_area;
      const placement = bedPlatePlacement(machine.learned);
      return { work, placement, extent: bedMapExtent(work, placement) };
    };
    renderXYMapControls = () => {
      if (!modal?.open || !move || !arm) return;
      const { armed, armAvailable, armPending, ready, busy } = callbacks.xyMapMovement();
      arm.textContent = callbacks.movementArmLabel();
      arm.disabled = armPending || busy || !armAvailable;
      arm.setAttribute("aria-pressed", String(armed));
      move.disabled = !selected || !ready;
      move.setAttribute("aria-busy", String(busy));
      for (const input of inputs) input.disabled = busy;
      if (move.disabled && press) cancelPress();
    };
    const render = () => {
      if (!plot) return;
      const { work, placement, extent } = mapModel();
      const ratio = (extent.x_max - extent.x_min) / Math.max(1e-6, extent.y_max - extent.y_min);
      if (plot.style) {
        plot.style.aspectRatio = String(ratio);
        plot.style.width = `min(100%, calc(48dvh * ${ratio.toFixed(4)}))`;
      }
      plot.innerHTML = bedPlateSVG({ work, placement, target: selected });
      renderXYMapControls();
    };
    function select(x, y) {
      const { work, placement } = mapModel();
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < work.x_min || x > work.x_max || y < work.y_min || y > work.y_max) {
        selected = null;
        target.textContent = "No target selected";
        callbacks.reportXYMapError?.("Select a point within XY travel.");
      } else {
        const text = describeBedTarget(placement, x, y);
        selected = { x, y, feature: text.feature || null };
        target.textContent = text.detail ? text.primary + "\n" + text.detail : text.primary;
      }
      render();
    }
    const open = () => {
      selected = null;
      target.textContent = "No target selected";
      for (const input of inputs) if (input) input.value = "";
      modal?.showModal();
      render();
    };
    const close = () => { cancelPress(); modal?.close(); };
    for (const id of ["surface-map-open", "workarea-map-open"]) {
      documentRef.getElementById(id)?.addEventListener("click", open);
    }
    documentRef.getElementById("surface-map-close")?.addEventListener("click", close);
    documentRef.getElementById("surface-map-close-bottom")?.addEventListener("click", close);
    modal?.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
    bindButtonAction?.(arm, toggleSurfaceMovementArm);
    plot?.addEventListener("pointerdown", (e) => {
      if ((e.button ?? 0) !== 0 || callbacks.xyMapMovement?.().busy) return;
      const rect = plot.getBoundingClientRect();
      const { extent } = mapModel();
      const x = extent.x_min + clampNumber((e.clientX - rect.left - (plot.clientLeft || 0)) / Math.max(1, plot.clientWidth || rect.width), 0, 1) * (extent.x_max - extent.x_min);
      const y = extent.y_max - clampNumber((e.clientY - rect.top - (plot.clientTop || 0)) / Math.max(1, plot.clientHeight || rect.height), 0, 1) * (extent.y_max - extent.y_min);
      if (inputs.every(Boolean)) {
        inputs[0].value = x.toFixed(3);
        inputs[1].value = y.toFixed(3);
        select(Number(inputs[0].value), Number(inputs[1].value));
      } else select(x, y);
    });
    for (const input of inputs) input?.addEventListener("input", () => {
      if (inputs.some((field) => !field.value.trim() || field.validity?.badInput)) {
        selected = null;
        target.textContent = "No target selected";
        render();
        return;
      }
      select(...inputs.map((field) => Number(field.value)));
    });

    function cancelPress() {
      press = null;
      move?.classList?.remove("is-confirming");
    }
    function beginPress(id) {
      if (move.disabled || !selected || press) return;
      press = { id, target: selected, started: performanceRef.now() };
      move.classList.add("is-confirming");
    }
    function finishPress(id, inside) {
      if (!press || press.id !== id) return;
      const held = press;
      cancelPress();
      if (!inside || move.disabled || held.target !== selected) return;
      if (performanceRef.now() - held.started < 600) {
        callbacks.reportXYMapError("Hold the button until it fills; the move starts when you release.");
        return;
      }
      sendTarget();
    }
    function sendTarget() {
      if (!selected || !callbacks.xyMapMovement().ready) return;
      const { x, y } = selected;
      const { work } = mapModel();
      if (x < work.x_min || x > work.x_max || y < work.y_min || y > work.y_max) {
        callbacks.reportXYMapError("Selected point is outside current XY travel.");
        return;
      }
      callbacks.sendXYMapTarget({ x, y });
    }
    move?.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      move.setPointerCapture?.(event.pointerId);
      beginPress(event.pointerId);
    });
    move?.addEventListener("pointerup", (event) => {
      const rect = move.getBoundingClientRect();
      finishPress(event.pointerId, event.clientX >= rect.left && event.clientX <= rect.right &&
        event.clientY >= rect.top && event.clientY <= rect.bottom);
    });
    for (const event of ["pointercancel", "lostpointercapture", "blur"]) move?.addEventListener(event, cancelPress);
    const activationKey = (key) => key === "Enter" || key === " ";
    move?.addEventListener("keydown", (event) => {
      if (!activationKey(event.key)) return;
      event.preventDefault();
      if (!event.repeat) beginPress(event.key);
    });
    move?.addEventListener("keyup", (event) => {
      if (!activationKey(event.key)) return;
      event.preventDefault();
      finishPress(event.key, true);
    });
    move?.addEventListener("click", (event) => {
      if (event.detail === 0 && !move.disabled && selected &&
          globalThis.confirm("Move to " + target.textContent.split("\n")[0] + " with Safe Z?")) sendTarget();
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
    const mobileLayout = documentRef.defaultView?.matchMedia("(max-width: 760px), (pointer: coarse) and (max-width: 1179px)");
    const slot = documentRef.getElementById("mobile-output-slot");
    const footer = documentRef.getElementById("surface-quick-actions");
    const outputs = footer?.querySelector(".surface-output-actions");
    if (mobileLayout && slot && outputs) {
      // Move the existing nodes so listeners and pending state survive resizing.
      const nextSibling = outputs.nextSibling;
      const placeOutputs = () => {
        if (mobileLayout.matches) slot.appendChild(outputs);
        else footer.insertBefore(outputs, nextSibling);
      };
      placeOutputs();
      mobileLayout.addEventListener("change", placeOutputs);
    }
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
      bindButtonAction(button, () => selectSurfaceStep(button.dataset.surfaceStep));
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
    const includeZ = documentRef.getElementById("surface-recall-include-z");
    const retract = documentRef.getElementById("surface-recall-retract-y");
    const distance = documentRef.getElementById("surface-recall-retract-mm");
    if (includeZ && retract && distance) {
      includeZ.checked = state.surface.saved_position_include_z === true;
      retract.checked = state.surface.saved_position_retract_y === true;
      distance.value = String(state.surface.saved_position_retract_mm || 200);
      const save = () => {
        state.surface.saved_position_include_z = includeZ.checked;
        state.surface.saved_position_retract_y = retract.checked;
        saveSurfaceViewPreferences();
        callbacks.renderRecallSettings();
      };
      includeZ.onchange = retract.onchange = save;
      distance.onchange = () => {
        if (!distance.reportValidity()) {
          distance.value = String(state.surface.saved_position_retract_mm);
          return;
        }
        state.surface.saved_position_retract_mm = distance.valueAsNumber;
        save();
      };
    }
    const zFeed = documentRef.getElementById("surface-z-step-feed");
    if (zFeed) {
      zFeed.onchange = () => {
        state.surface.z_step_feed_mm_min = Number(zFeed.value);
        saveSurfaceViewPreferences();
      };
    }
    for (const button of documentRef.querySelectorAll("[data-surface-goto]")) {
      bindButtonAction(button, () => goToSurfaceDestination?.(button.dataset.surfaceGoto));
    }
    documentRef.getElementById("surface-jog-settings-open").onclick = () => documentRef.getElementById("surface-settings-modal")?.showModal();
    documentRef.getElementById("surface-settings-close").onclick = () => documentRef.getElementById("surface-settings-modal")?.close();
  }

  return { init, bindFooterInteractions, bindSurfaceStepButton, bindSurfaceHoldButton, bindSurfaceXYMap, renderXYMapControls: () => renderXYMapControls() };
}
