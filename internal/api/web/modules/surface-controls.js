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
    const hint = documentRef.getElementById("surface-map-hint");
    // Zoom and pan: view.zoom >= 1 around a centre in machine coordinates.
    const view = { zoom: 1, cx: null, cy: null };
    const pointers = new Map();
    let gesture = null;
    const TAP_SLOP_PX = 16;
    const MAX_ZOOM = 8;
    const mapModel = () => {
      const machine = normalizeMachineSettings(state.ui.machine);
      const work = machine.work_area;
      const placement = bedPlatePlacement(machine.learned);
      return { work, placement, extent: bedMapExtent(work, placement) };
    };
    // The part of the map currently shown, clamped inside the full extent.
    function visibleExtent() {
      const { extent } = mapModel();
      const w = extent.x_max - extent.x_min;
      const h = extent.y_max - extent.y_min;
      const vw = w / view.zoom;
      const vh = h / view.zoom;
      const cx = clampNumber(view.cx ?? extent.x_min + w / 2, extent.x_min + vw / 2, extent.x_max - vw / 2);
      const cy = clampNumber(view.cy ?? extent.y_min + h / 2, extent.y_min + vh / 2, extent.y_max - vh / 2);
      view.cx = cx;
      view.cy = cy;
      return { x_min: cx - vw / 2, x_max: cx + vw / 2, y_min: cy - vh / 2, y_max: cy + vh / 2 };
    }
    function pointFromClient(clientX, clientY) {
      const rect = plot.getBoundingClientRect();
      const v = visibleExtent();
      const fx = clampNumber((clientX - rect.left - (plot.clientLeft || 0)) / Math.max(1, plot.clientWidth || rect.width), 0, 1);
      const fy = clampNumber((clientY - rect.top - (plot.clientTop || 0)) / Math.max(1, plot.clientHeight || rect.height), 0, 1);
      return { x: v.x_min + fx * (v.x_max - v.x_min), y: v.y_max - fy * (v.y_max - v.y_min) };
    }
    function zoomAt(factor, anchor = null) {
      const before = visibleExtent();
      const next = clampNumber(view.zoom * factor, 1, MAX_ZOOM);
      if (next === view.zoom) return;
      if (anchor) {
        // Keep the anchor point under the finger or cursor.
        const ax = (anchor.x - before.x_min) / (before.x_max - before.x_min);
        const ay = (anchor.y - before.y_min) / (before.y_max - before.y_min);
        const { extent } = mapModel();
        const vw = (extent.x_max - extent.x_min) / next;
        const vh = (extent.y_max - extent.y_min) / next;
        view.cx = anchor.x - (ax - 0.5) * vw;
        view.cy = anchor.y - (ay - 0.5) * vh;
      }
      view.zoom = next;
      render();
    }
    function chooseAt(point) {
      if (inputs.every(Boolean)) {
        inputs[0].value = point.x.toFixed(3);
        inputs[1].value = point.y.toFixed(3);
        select(Number(inputs[0].value), Number(inputs[1].value));
      } else select(point.x, point.y);
    }

    renderXYMapControls = () => {
      if (!modal?.open || !move || !arm) return;
      const { armed, armAvailable, armPending, ready, busy } = callbacks.xyMapMovement();
      if (hint) {
        hint.textContent = !selected ? "Tap the map to choose where to move."
          : !armed ? "Arm Movement, then tap Move here."
            : !ready ? "Waiting for the machine to be ready to move."
              : "Tap Move here to move to this point at Safe Z.";
      }
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
        plot.style.width = `min(100%, calc(70dvh * ${ratio.toFixed(4)}))`;
      }
      plot.innerHTML = bedPlateSVG({ work, placement, target: selected });
      const v = visibleExtent();
      plot.querySelector?.("svg")?.setAttribute("viewBox", `${v.x_min} ${-v.y_max} ${v.x_max - v.x_min} ${v.y_max - v.y_min}`);
      const level = documentRef.getElementById("surface-map-zoom-level");
      if (level) level.textContent = view.zoom.toFixed(view.zoom < 2 ? 1 : 0) + "×";
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
      view.zoom = 1;
      view.cx = view.cy = null;
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
    // One finger: tap to choose, drag to pan when zoomed. Two fingers: pinch
    // to zoom. Mouse wheel zooms at the cursor.
    plot?.addEventListener("pointerdown", (e) => {
      if ((e.button ?? 0) !== 0) return;
      try {
        plot.setPointerCapture?.(e.pointerId);
      } catch {
        // Capture is best-effort; pointerup on the plot still ends the gesture.
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        gesture = { kind: "tap", startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY };
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        gesture = { kind: "pinch", distance: Math.hypot(a.x - b.x, a.y - b.y) };
      }
      e.preventDefault?.();
    });
    plot?.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId) || !gesture) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (gesture.kind === "pinch" && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (gesture.distance > 0 && distance > 0) {
          zoomAt(distance / gesture.distance, pointFromClient((a.x + b.x) / 2, (a.y + b.y) / 2));
          gesture.distance = distance;
        }
        return;
      }
      const moved = Math.hypot(e.clientX - gesture.startX, e.clientY - gesture.startY);
      if (gesture.kind === "tap" && moved > TAP_SLOP_PX && view.zoom > 1) gesture.kind = "pan";
      if (gesture.kind === "pan") {
        const rect = plot.getBoundingClientRect();
        const v = visibleExtent();
        view.cx -= (e.clientX - gesture.lastX) / Math.max(1, rect.width) * (v.x_max - v.x_min);
        view.cy += (e.clientY - gesture.lastY) / Math.max(1, rect.height) * (v.y_max - v.y_min);
        render();
      }
      gesture.lastX = e.clientX;
      gesture.lastY = e.clientY;
    });
    const endPointer = (e, cancelled) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      const done = gesture;
      if (pointers.size === 0) gesture = null;
      else if (done?.kind === "pinch") gesture = { kind: "pinched" };
      if (cancelled || !done || done.kind !== "tap" || callbacks.xyMapMovement?.().busy) return;
      if (Math.hypot(e.clientX - done.startX, e.clientY - done.startY) > TAP_SLOP_PX) return;
      chooseAt(pointFromClient(e.clientX, e.clientY));
    };
    plot?.addEventListener("pointerup", (e) => endPointer(e, false));
    plot?.addEventListener("pointercancel", (e) => endPointer(e, true));
    plot?.addEventListener("wheel", (e) => {
      e.preventDefault();
      zoomAt(e.deltaY < 0 ? 1.25 : 0.8, pointFromClient(e.clientX, e.clientY));
    }, { passive: false });
    for (const [id, factor] of [["surface-map-zoom-in", 1.5], ["surface-map-zoom-out", 1 / 1.5]]) {
      documentRef.getElementById(id)?.addEventListener("click", () => zoomAt(factor, selected));
    }
    documentRef.getElementById("surface-map-zoom-reset")?.addEventListener("click", () => {
      view.zoom = 1;
      view.cx = view.cy = null;
      render();
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
      // Choosing a point and arming Movement already make this deliberate;
      // a tap that is released on the button starts the move.
      if (!inside || move.disabled || held.target !== selected) return;
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
