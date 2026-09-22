// Surface quick actions from the kiosk shell. These are existing navigation and
// DOM actions; this module never issues a machine command directly.
export function createSurfaceShell({
  documentRef = globalThis.document,
  showTab = () => {},
} = {}) {
  const document = documentRef;

  function runSurfaceShellAction(action) {
    switch (action) {
    case "home":
      document.getElementById("ctl-home-main")?.click();
      break;
    case "probe-z":
      document.getElementById("origin-probe-z")?.click();
      break;
    case "work-zero": {
      showTab("control");
      const section = document.getElementById("work-zero-section");
      if (section) {
        section.open = true;
        section.scrollIntoView?.({ block: "start", behavior: "smooth" });
      }
      break;
    }
    case "files":
      showTab("files");
      break;
    case "camera":
      showTab("dashboard");
      document.querySelector(".dashboard-camera-stage")?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      break;
    case "maintenance":
      showTab("maintenance");
      break;
    case "actions": {
      const actions = document.getElementById("command-actions");
      const toggle = document.getElementById("mobile-actions-toggle");
      const open = !actions?.classList.contains("mobile-menu-open");
      actions?.classList.toggle("mobile-menu-open", open);
      toggle?.setAttribute("aria-expanded", String(open));
      break;
    }
    }
  }

  return { runSurfaceShellAction };
}
