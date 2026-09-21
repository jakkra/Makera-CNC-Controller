import test from "node:test";
import assert from "node:assert/strict";
import { createDashboardProfiles } from "./modules/dashboard-profiles.js";

function feature() {
  const state = {
    ui: { dashboard: { default_profile_id: "overview", profiles: [{ id: "overview", name: "Overview", panels: ["machine", "job"], layout: "grid", density: "comfortable", background: "solid", gcode_lines: 9 }] } },
    dashboardProfileID: "overview",
    dashboardRequestedProfileID: "",
    dashboardEmbed: false,
    dashboardSettingsLoaded: true,
    dashboardDraftProfileID: "",
  };
  return createDashboardProfiles({
    dashboardState: state,
    documentRef: { body: { classList: { toggle() {} } } },
    windowRef: { location: { href: "http://localhost/dashboard", pathname: "/dashboard", search: "" }, matchMedia: () => ({ matches: false }) },
    navigatorRef: {}, confirmRef: () => true,
    normalizeDashboardSettings: value => value,
    viewTabFromURL: () => "dashboard",
    setDashboardControlsOpen() {}, renderDashboard() {}, newID: () => "new",
    saveUISettings: async () => true, setNotice() {},
    dashboardGcodeView: {}, scheduleDashboardGcodeRender() {},
  });
}

test("dashboard profile component parses canonical URL state", () => {
  const profiles = feature();
  assert.deepEqual(profiles.dashboardURLState({ search: "?profile=operator&embed=true" }), { profile: "operator", embed: true });
  assert.deepEqual(profiles.dashboardURLState({ search: "?embed=no" }), { profile: "", embed: false });
});

test("wide Surface visibility keeps machine and job panels available", () => {
  const profiles = feature();
  const profile = { panels: ["gcode"] };
  assert.equal(profiles.dashboardPanelVisible("machine", profile, true), true);
  assert.equal(profiles.dashboardPanelVisible("job", profile, true), true);
  assert.equal(profiles.dashboardPanelVisible("telemetry", profile, true), false);
});
