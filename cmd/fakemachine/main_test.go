package main

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"io"
	"math"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/uwin/cnc-proxy/internal/carveratest"
	"github.com/uwin/cnc-proxy/internal/client"
	"github.com/uwin/cnc-proxy/internal/machine"
	"github.com/uwin/cnc-proxy/internal/protocol"
)

func TestSidecarServesSnapshotAndAssets(t *testing.T) {
	m, err := carveratest.New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	m.PutFile("/sd/gcodes/a.nc", []byte("G1 X1\n"))

	srv := httptest.NewServer(sidecarHandler(m))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/state")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("/api/state status = %d", resp.StatusCode)
	}
	var snap carveratest.Snapshot
	if err := json.NewDecoder(resp.Body).Decode(&snap); err != nil {
		t.Fatal(err)
	}
	if snap.Status.Raw == "" || len(snap.Files) != 1 || snap.Files[0].Path != "/sd/gcodes/a.nc" {
		t.Fatalf("snapshot = %+v", snap)
	}
	if snap.MachineProfile.Model != "CA1" || snap.MachineProfile.WorkSizeXMM != 300 || snap.Config["coordinate.worksize_y"] != "200.0" {
		t.Fatalf("machine profile/config = %+v config=%v", snap.MachineProfile, snap.Config)
	}
	if snap.Status.Tool == nil || snap.Status.Tool.Active != 0 || snap.Status.Tool.Offset != 0 {
		t.Fatalf("tool status = %+v", snap.Status.Tool)
	}

	asset, err := http.Get(srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer asset.Body.Close()
	body, _ := io.ReadAll(asset.Body)
	if asset.StatusCode != http.StatusOK || !strings.Contains(string(body), "Fakemachine Sidecar") {
		t.Fatalf("index status=%d body=%q", asset.StatusCode, string(body[:min(len(body), 80)]))
	}
	index := string(body)
	for _, want := range []string{"tool contact plane", `id="laser-toggle"`, `id="laser-status"`, `id="simulation-panel"`, `id="stock-place"`, `id="stock-rotation"`, `aria-label="Stock rotation degrees"`, `data-view-mode="orbit"`, `data-view-mode="move"`, `data-view-mode="rotate"`, `id="simulation-reset"`, `id="simulation-download"`, `aria-pressed="false"`, "tool laser"} {
		if !strings.Contains(index, want) {
			t.Fatalf("sidecar index missing legend marker %q", want)
		}
	}
	for _, gone := range []string{"work zero", "WCS Z0", ".swatch.tip", "--tip", "probe laser"} {
		if strings.Contains(index, gone) {
			t.Fatalf("sidecar index still contains obsolete legend marker %q", gone)
		}
	}

	app, err := http.Get(srv.URL + "/app.js")
	if err != nil {
		t.Fatal(err)
	}
	defer app.Body.Close()
	jsBody, _ := io.ReadAll(app.Body)
	js := string(jsBody)
	for _, want := range []string{
		"box(profile.workX, 12, profile.workY",
		"box(profile.workX, 4, profile.workY",
		"profile.workYMax, 1, 0.34, mat.tableGridMinor",
		"profile.workYMax, 10, 0.38, mat.tableGridMajor",
		"function steppedGridValues",
		`from "/geometry.mjs"`,
		"workOriginMachinePoint(point, wpos)",
		"parts.workPlane.visible = hasToolTip(snap.inserted_tool)",
		"toolContactTableY(point, snap.inserted_tool, wpos, currentProfile)",
		"let toolLaserEnabled = false",
		"function updateToolLaser(snap, point)",
		"laserSurfaceMachineZ(point)",
		"meshSurfaceZAtXY",
		"stockSurfaceZAtXY",
		"new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 1",
		"laserBeam.renderOrder = 20",
		"parts.laserBeam.scale.set(1, geometry.scaleY, 1)",
		"laserToggleButtonEl.addEventListener(\"click\"",
		"laserToggleButtonEl.dataset.source = geometry.source",
		"updateLaserStatus",
		"insertedToolLabel(tool)",
		"tool.matches_firmware_tool === false",
		"function panCamera(dx, dy)",
		"event.button === 1 || event.button === 2 || event.shiftKey || event.altKey",
		"mode: pan ? \"pan\" : \"orbit\"",
		"pointer.mode === \"pan\"",
		"canvas.addEventListener(\"contextmenu\"",
		"function updateStockModel",
		"fetch(\"/api/simulation/stock\"",
		"function renderStock",
		"const baseY = number(stock.base_z) - currentProfile.zMin",
		"const addQuad = (a, b, c, d)",
		"updateSimulationSettings",
		"placeStockModel",
		"fetch(\"/api/model/placement\"",
		"function createStockMoveGizmo",
		"function createStockRotateGizmo",
		"function beginGizmoDrag",
		"function moveGizmoDrag",
		"function rotateGizmoDrag",
		"function stockGizmoTargets",
		"function stockVisualBounds",
		"function visibleStockObject",
		"new THREE.Box3().setFromObject(drawn)",
		"raycaster.intersectObjects(targets, true)",
		"rotation_deg",
		"stockRotationEl",
		"repairSpindleModelNormals",
		"geometryNeedsNormalFlip",
		"spindleNormalsFlipped",
		"new THREE.CylinderGeometry(tipRadius, tipRadius, tipLength",
		"placementDirty",
		"placementFieldFocused",
		"resetSimulationStock",
		"fetch(\"/api/simulation/reset\"",
		"snap.simulation?.show_vectors === false",
		"holdSimulationStatus",
	} {
		if !strings.Contains(js, want) {
			t.Fatalf("sidecar app.js missing configured table/grid marker %q", want)
		}
	}
	for _, gone := range []string{"profile.workX + 30", "profile.workY + 28", "profile.workYMax, 25,", "new THREE.Vector3(0, -16, 0), new THREE.Vector3(0, 16, 0)", "const toolOffsetZ", "visualWorkOffset", "toolTip:", "toolTipCursor", "createToolTipCursor", "toolTipOffset", "cutCursor", "cutRing", "cutDot", "laserDot", "SphereGeometry", "TorusGeometry", "const laserBeam = new THREE.Line", "beginStockDrag", "moveStockDrag", "stockDragState", "intersectObjects([modelGroup, stockGroup"} {
		if strings.Contains(js, gone) {
			t.Fatalf("sidecar app.js still contains oversized/old grid marker %q", gone)
		}
	}

	geom, err := http.Get(srv.URL + "/geometry.mjs")
	if err != nil {
		t.Fatal(err)
	}
	defer geom.Body.Close()
	geomBody, _ := io.ReadAll(geom.Body)
	if geom.StatusCode != http.StatusOK || !strings.Contains(string(geomBody), "function toolLaserGeometry") {
		t.Fatalf("geometry module status=%d body=%q", geom.StatusCode, string(geomBody[:min(len(geomBody), 80)]))
	}
}

func TestSidecarGeometryModule(t *testing.T) {
	cmd := exec.Command("node", "--test", "web/geometry.test.mjs")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("sidecar geometry tests failed: %v\n%s", err, out)
	}
}

func TestSpindleAssetNormalsRequireSelectiveRepair(t *testing.T) {
	script := `
const fs = require("fs");
const b = fs.readFileSync("../../assets/spindle.glb");
let off = 12, json = null, bin = null;
while (off + 8 <= b.length) {
  const len = b.readUInt32LE(off);
  const type = b.readUInt32LE(off + 4);
  off += 8;
  const chunk = b.slice(off, off + len);
  off += len;
  if (type === 0x4e4f534a) json = JSON.parse(chunk.toString("utf8").trim());
  if (type === 0x004e4942) bin = chunk;
}
function components(type) { return { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type]; }
function reader(type) {
  if (type === 5126) return ["readFloatLE", 4];
  if (type === 5123) return ["readUInt16LE", 2];
  if (type === 5125) return ["readUInt32LE", 4];
  throw new Error("unsupported component type " + type);
}
function accessor(i) {
  const a = json.accessors[i];
  const view = json.bufferViews[a.bufferView];
  const [read, size] = reader(a.componentType);
  const n = components(a.type);
  const stride = view.byteStride || n * size;
  const start = (view.byteOffset || 0) + (a.byteOffset || 0);
  const rows = [];
  for (let r = 0; r < a.count; r++) {
    const row = [];
    for (let c = 0; c < n; c++) row.push(bin[read](start + r * stride + c * size));
    rows.push(row);
  }
  return rows;
}
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function score(primitive) {
  const pos = accessor(primitive.attributes.POSITION);
  const nor = accessor(primitive.attributes.NORMAL);
  const idx = accessor(primitive.indices).map((v) => v[0]);
  const center = [0, 0, 0];
  for (const p of pos) for (let i = 0; i < 3; i++) center[i] += p[i] / pos.length;
  let out = 0;
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = pos[idx[i]], b = pos[idx[i + 1]], c = pos[idx[i + 2]];
    const face = cross(sub(b, a), sub(c, a));
    const area = Math.hypot(face[0], face[1], face[2]) * 0.5;
    const triCenter = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const normal = norm([
      nor[idx[i]][0] + nor[idx[i + 1]][0] + nor[idx[i + 2]][0],
      nor[idx[i]][1] + nor[idx[i + 1]][1] + nor[idx[i + 2]][1],
      nor[idx[i]][2] + nor[idx[i + 1]][2] + nor[idx[i + 2]][2],
    ]);
    out += dot(normal, sub(triCenter, center)) * area;
  }
  return out;
}
const primitives = json.meshes[0].primitives;
if (primitives.length !== 2) throw new Error("expected block and spindle primitives");
const block = score(primitives[0]);
const spindle = score(primitives[1]);
if (!(block > 0 && spindle < 0)) throw new Error("normal scores block=" + block + " spindle=" + spindle);
`
	cmd := exec.Command("node", "-e", script)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("spindle asset normal inspection failed: %v\n%s", err, out)
	}
}

func TestSidecarInsertsTool(t *testing.T) {
	m, err := carveratest.New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	srv := httptest.NewServer(sidecarHandler(m))
	defer srv.Close()

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/tool/insert", strings.NewReader(`{"kind":"tool_6_35"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("insert status=%d body=%q", resp.StatusCode, string(b))
	}
	var tool carveratest.SnapshotInsertedTool
	if err := json.NewDecoder(resp.Body).Decode(&tool); err != nil {
		t.Fatal(err)
	}
	if tool.Kind != "tool_6_35" || tool.ToolID != 3 || tool.FirmwareToolID != 3 || !tool.MatchesFirmwareTool || tool.DiameterMM != 6.35 {
		t.Fatalf("inserted tool = %+v", tool)
	}
	if !tool.SpindleLocked || tool.Calibrated {
		t.Fatalf("inserted tool lock/calibration = %+v", tool)
	}

	req, err = http.NewRequest(http.MethodPost, srv.URL+"/api/tool/stickout", strings.NewReader(`{"stickout_mm":40}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	lockedResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	lockedResp.Body.Close()
	if lockedResp.StatusCode != http.StatusConflict {
		t.Fatalf("locked stickout status = %d, want 409", lockedResp.StatusCode)
	}

	req, err = http.NewRequest(http.MethodPost, srv.URL+"/api/tool/lock", strings.NewReader(`{"locked":false}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	unlockResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer unlockResp.Body.Close()
	if unlockResp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(unlockResp.Body)
		t.Fatalf("unlock status=%d body=%q", unlockResp.StatusCode, string(b))
	}

	req, err = http.NewRequest(http.MethodPost, srv.URL+"/api/tool/stickout", strings.NewReader(`{"stickout_mm":40}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	depthResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer depthResp.Body.Close()
	if depthResp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(depthResp.Body)
		t.Fatalf("stickout status=%d body=%q", depthResp.StatusCode, string(b))
	}
	if err := json.NewDecoder(depthResp.Body).Decode(&tool); err != nil {
		t.Fatal(err)
	}
	if tool.StickoutMM != 40 || tool.SpindleLocked || tool.Calibrated {
		t.Fatalf("adjusted tool = %+v", tool)
	}

	stateResp, err := http.Get(srv.URL + "/api/state")
	if err != nil {
		t.Fatal(err)
	}
	defer stateResp.Body.Close()
	var snap carveratest.Snapshot
	if err := json.NewDecoder(stateResp.Body).Decode(&snap); err != nil {
		t.Fatal(err)
	}
	if snap.InsertedTool == nil || snap.InsertedTool.Kind != "tool_6_35" || snap.InsertedTool.StickoutMM != 40 {
		t.Fatalf("snapshot inserted tool = %+v", snap.InsertedTool)
	}
	if snap.Status.Tool == nil || snap.Status.Tool.Active != 3 {
		t.Fatalf("snapshot tool status = %+v", snap.Status.Tool)
	}
}

func TestSidecarStreamsStateEvents(t *testing.T) {
	m, err := carveratest.New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	srv := httptest.NewServer(sidecarHandler(m))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/events", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if got := resp.Header.Get("Content-Type"); !strings.HasPrefix(got, "text/event-stream") {
		t.Fatalf("content-type = %q", got)
	}
	buf := make([]byte, 4096)
	n, err := resp.Body.Read(buf)
	if err != nil && err != io.EOF {
		t.Fatal(err)
	}
	if !strings.Contains(string(buf[:n]), "event: state") || !strings.Contains(string(buf[:n]), `"status"`) {
		t.Fatalf("event chunk = %q", string(buf[:n]))
	}
}

func TestSidecarUploadsProbeModelAndServesMesh(t *testing.T) {
	m, err := carveratest.New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	srv := httptest.NewServer(sidecarHandler(m))
	defer srv.Close()

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	part, err := mw.CreateFormFile("model", "plate.stl")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte(sidecarPlaneSTL())); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/model", &body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("upload status=%d body=%q", resp.StatusCode, string(b))
	}
	var model carveratest.SnapshotProbeModel
	if err := json.NewDecoder(resp.Body).Decode(&model); err != nil {
		t.Fatal(err)
	}
	if model.Name != "plate.stl" || model.Triangles != 2 {
		t.Fatalf("model = %+v", model)
	}
	if model.Placement.XMinMM != -300 || model.Placement.YMinMM != -200 {
		t.Fatalf("default model placement = %+v", model.Placement)
	}
	if model.Bounds.Min.Z < -121.000001 || model.Bounds.Min.Z > -120.999999 || model.Bounds.Max.Z < -121.000001 || model.Bounds.Max.Z > -120.999999 {
		t.Fatalf("default model z bounds = %+v, want source bottom on bed", model.Bounds)
	}

	meshResp, err := http.Get(srv.URL + "/api/model/mesh")
	if err != nil {
		t.Fatal(err)
	}
	defer meshResp.Body.Close()
	if meshResp.StatusCode != http.StatusOK {
		t.Fatalf("mesh status = %d", meshResp.StatusCode)
	}
	var mesh carveratest.ProbeModelMesh
	if err := json.NewDecoder(meshResp.Body).Decode(&mesh); err != nil {
		t.Fatal(err)
	}
	if mesh.ID != model.ID || mesh.Triangles != 2 || len(mesh.Positions) != 18 {
		t.Fatalf("mesh = %+v", mesh)
	}

	reqBody := strings.NewReader(`{"x_min_mm":25,"y_min_mm":35,"top_z_mm":-8,"rotation_deg":15}`)
	req, err = http.NewRequest(http.MethodPost, srv.URL+"/api/model/placement", reqBody)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	placeResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer placeResp.Body.Close()
	if placeResp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(placeResp.Body)
		t.Fatalf("placement status=%d body=%q", placeResp.StatusCode, string(b))
	}
	var placed carveratest.SnapshotProbeModel
	if err := json.NewDecoder(placeResp.Body).Decode(&placed); err != nil {
		t.Fatal(err)
	}
	if math.Abs(placed.Placement.XMinMM-25) > 0.001 || math.Abs(placed.Placement.YMinMM-35) > 0.001 || math.Abs(placed.Placement.TopZMM+8) > 0.001 || math.Abs(placed.Placement.RotationDeg-15) > 0.001 {
		t.Fatalf("placed model = %+v", placed.Placement)
	}
	if placed.SourceBounds.Min.X != 0 || math.Abs(placed.Bounds.Min.X-25) > 0.001 || math.Abs(placed.Bounds.Max.Z+8) > 0.001 {
		t.Fatalf("placed bounds = source %+v placed %+v", placed.SourceBounds, placed.Bounds)
	}

	stockResp, err := http.Get(srv.URL + "/api/simulation/stock")
	if err != nil {
		t.Fatal(err)
	}
	defer stockResp.Body.Close()
	if stockResp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(stockResp.Body)
		t.Fatalf("stock status=%d body=%q", stockResp.StatusCode, string(b))
	}
	var stock carveratest.StockState
	if err := json.NewDecoder(stockResp.Body).Decode(&stock); err != nil {
		t.Fatal(err)
	}
	if math.Abs(stock.XMin-25) > 0.001 || math.Abs(stock.YMin-35) > 0.001 || stock.TopZ < -8.000001 || stock.TopZ > -7.999999 {
		t.Fatalf("stock placement = %+v", stock)
	}
}

func TestSidecarSimulatesControllerJobAndDownloadsEndStock(t *testing.T) {
	m, err := carveratest.New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	srv := httptest.NewServer(sidecarHandler(m))
	defer srv.Close()

	uploadSidecarModel(t, srv.URL, "stock.stl", sidecarBlockSTL(0, 20, 0, 12, -41, -36))
	postSidecarJSON(t, srv.URL+"/api/model/placement", `{"x_min_mm":0,"y_min_mm":0,"top_z_mm":-36}`)
	postSidecarJSON(t, srv.URL+"/api/simulation/settings", `{"enabled":true,"speed_scale":120,"tool_shape":"flat"}`)
	if _, err := m.InsertTool("tool_6"); err != nil {
		t.Fatal(err)
	}

	conn, err := client.Dial(m.Addr(), time.Second, client.WithUploadStartDelay(0))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	gcode := []byte(strings.Join([]string{
		"G21 G90",
		"G0 X2 Y6 Z2",
		"G1 Z-3 F600",
		"G1 X18 F600",
		"G0 Z2",
	}, "\n") + "\n")
	sum := md5.Sum(gcode)
	if err := conn.Upload("/sd/gcodes/sidecar-slot.nc", bytes.NewReader(gcode), int64(len(gcode)), hex.EncodeToString(sum[:]), time.Second, nil); err != nil {
		t.Fatalf("upload gcode: %v", err)
	}

	c, err := net.Dial("tcp", m.Addr())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Write(protocol.Encode(protocol.CmdCtrlMulti, []byte(protocol.PlayLine("/sd/gcodes/sidecar-slot.nc")))); err != nil {
		t.Fatal(err)
	}
	stock := waitSidecarStockCut(t, srv.URL, time.Second)
	if stock.RemovedVolumeMM3 <= 0 || sidecarStockHeight(stock, 10, 6) > -36.8 {
		t.Fatalf("stock after run removed=%.3f center=%.3f", stock.RemovedVolumeMM3, sidecarStockHeight(stock, 10, 6))
	}
	waitSidecarState(t, srv.URL, machine.Idle, time.Second)

	postSidecarJSON(t, srv.URL+"/api/simulation/reset", `{}`)
	resetResp, err := http.Get(srv.URL + "/api/simulation/stock")
	if err != nil {
		t.Fatal(err)
	}
	defer resetResp.Body.Close()
	var resetStock carveratest.StockState
	if err := json.NewDecoder(resetResp.Body).Decode(&resetStock); err != nil {
		t.Fatal(err)
	}
	if resetStock.RemovedVolumeMM3 != 0 || sidecarStockHeight(resetStock, 10, 6) < -36.001 {
		t.Fatalf("reset stock removed=%.3f center=%.3f", resetStock.RemovedVolumeMM3, sidecarStockHeight(resetStock, 10, 6))
	}

	stlResp, err := http.Get(srv.URL + "/api/simulation/stock.stl")
	if err != nil {
		t.Fatal(err)
	}
	defer stlResp.Body.Close()
	stl, _ := io.ReadAll(stlResp.Body)
	if stlResp.StatusCode != http.StatusOK || !strings.Contains(string(stl[:min(len(stl), 80)]), "solid fakemachine-stock") {
		t.Fatalf("stl status=%d header=%q", stlResp.StatusCode, string(stl[:min(len(stl), 80)]))
	}
}

func uploadSidecarModel(t *testing.T, baseURL, name, model string) {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	part, err := mw.CreateFormFile("model", name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte(model)); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, baseURL+"/api/model", &body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("model upload status=%d body=%q", resp.StatusCode, string(b))
	}
}

func postSidecarJSON(t *testing.T, url, body string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("post %s status=%d body=%q", url, resp.StatusCode, string(b))
	}
}

func waitSidecarStockCut(t *testing.T, baseURL string, timeout time.Duration) carveratest.StockState {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var stock carveratest.StockState
	for time.Now().Before(deadline) {
		resp, err := http.Get(baseURL + "/api/simulation/stock")
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			t.Fatalf("stock status=%d body=%q", resp.StatusCode, string(body))
		}
		if err := json.NewDecoder(resp.Body).Decode(&stock); err != nil {
			resp.Body.Close()
			t.Fatal(err)
		}
		resp.Body.Close()
		if stock.RemovedVolumeMM3 > 0 {
			return stock
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("stock was not cut; removed volume = %.3f", stock.RemovedVolumeMM3)
	return stock
}

func waitSidecarState(t *testing.T, baseURL string, want machine.State, timeout time.Duration) carveratest.Snapshot {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var snap carveratest.Snapshot
	for time.Now().Before(deadline) {
		resp, err := http.Get(baseURL + "/api/state")
		if err != nil {
			t.Fatal(err)
		}
		if err := json.NewDecoder(resp.Body).Decode(&snap); err != nil {
			resp.Body.Close()
			t.Fatal(err)
		}
		resp.Body.Close()
		if snap.Status.State == want {
			return snap
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("state = %s, want %s", snap.Status.State, want)
	return snap
}

func sidecarStockHeight(stock carveratest.StockState, x, y float64) float64 {
	xi := int(mathRound((x - stock.XMin) / stock.StepX))
	yi := int(mathRound((y - stock.YMin) / stock.StepY))
	if xi < 0 {
		xi = 0
	}
	if yi < 0 {
		yi = 0
	}
	if xi >= stock.CellsX {
		xi = stock.CellsX - 1
	}
	if yi >= stock.CellsY {
		yi = stock.CellsY - 1
	}
	return stock.Heights[yi*stock.CellsX+xi]
}

func mathRound(v float64) float64 {
	if v < 0 {
		return float64(int(v - 0.5))
	}
	return float64(int(v + 0.5))
}

func sidecarBlockSTL(xMin, xMax, yMin, yMax, zMin, zMax float64) string {
	type p struct{ x, y, z float64 }
	v := []p{
		{xMin, yMin, zMin}, {xMax, yMin, zMin}, {xMax, yMax, zMin}, {xMin, yMax, zMin},
		{xMin, yMin, zMax}, {xMax, yMin, zMax}, {xMax, yMax, zMax}, {xMin, yMax, zMax},
	}
	faces := [][3]int{{4, 5, 6}, {4, 6, 7}, {0, 2, 1}, {0, 3, 2}, {0, 1, 5}, {0, 5, 4}, {1, 2, 6}, {1, 6, 5}, {2, 3, 7}, {2, 7, 6}, {3, 0, 4}, {3, 4, 7}}
	lines := []string{"solid block"}
	for _, f := range faces {
		lines = append(lines,
			"facet normal 0 0 0",
			"outer loop",
			"vertex "+floatString(v[f[0]].x)+" "+floatString(v[f[0]].y)+" "+floatString(v[f[0]].z),
			"vertex "+floatString(v[f[1]].x)+" "+floatString(v[f[1]].y)+" "+floatString(v[f[1]].z),
			"vertex "+floatString(v[f[2]].x)+" "+floatString(v[f[2]].y)+" "+floatString(v[f[2]].z),
			"endloop",
			"endfacet",
		)
	}
	lines = append(lines, "endsolid block")
	return strings.Join(lines, "\n")
}

func floatString(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}

func sidecarPlaneSTL() string {
	return strings.Join([]string{
		"solid plate",
		"facet normal 0 0 1",
		"outer loop",
		"vertex 0 0 -5",
		"vertex 10 0 -5",
		"vertex 10 10 -5",
		"endloop",
		"endfacet",
		"facet normal 0 0 1",
		"outer loop",
		"vertex 0 0 -5",
		"vertex 10 10 -5",
		"vertex 0 10 -5",
		"endloop",
		"endfacet",
		"endsolid plate",
	}, "\n")
}
