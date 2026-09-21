export function createProbeConfirmation({ documentRef } = {}) {
  let pendingResolve = null;

  function confirmProbeAction({ title, message, warning = "", confirmLabel = "Probe" }) {
    const dialog = documentRef.getElementById("probe-confirm-modal");
    if (!dialog || dialog.open || pendingResolve) return Promise.resolve(false);
    documentRef.getElementById("probe-confirm-title").textContent = title;
    documentRef.getElementById("probe-confirm-message").textContent = message;
    const warningEl = documentRef.getElementById("probe-confirm-warning");
    warningEl.textContent = warning;
    warningEl.hidden = !warning;
    documentRef.getElementById("probe-confirm-accept").textContent = confirmLabel;
    return new Promise((resolve) => {
      pendingResolve = resolve;
      dialog.showModal();
      documentRef.getElementById("probe-confirm-accept").focus();
    });
  }

  function settleProbeConfirmation(accepted) {
    const resolve = pendingResolve;
    pendingResolve = null;
    documentRef.getElementById("probe-confirm-modal")?.close();
    if (resolve) resolve(!!accepted);
  }

  return { confirmProbeAction, settleProbeConfirmation };
}
