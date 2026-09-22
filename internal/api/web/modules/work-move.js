export function createWorkMoveInteractions({ documentRef = globalThis.document } = {}) {
  const document = documentRef;

  function bindInteractions({ workMoveInput, renderWorkMoveControls, sendWorkCoordinateMove, resetWorkMoveInput, bindButtonAction } = {}) {
    for (const axis of ["x", "y", "z"]) {
      const input = workMoveInput(axis);
      input.oninput = () => {
        input.dataset.dirty = "1";
        renderWorkMoveControls();
      };
      input.onkeydown = (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          sendWorkCoordinateMove();
        }
      };
    }
    for (const button of document.querySelectorAll("[data-work-move-reset]")) {
      bindButtonAction(button, (event) => {
        event.preventDefault();
        resetWorkMoveInput(button.dataset.workMoveReset);
      });
    }
    bindButtonAction(document.getElementById("work-move-send"), sendWorkCoordinateMove);
  }

  return { bindInteractions };
}
