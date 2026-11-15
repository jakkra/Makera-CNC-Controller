package carveratest

import (
	"bytes"
	"crypto/md5"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"math"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/uwin/cnc-proxy/internal/client"
	"github.com/uwin/cnc-proxy/internal/machine"
	"github.com/uwin/cnc-proxy/internal/protocol"
)

func TestFakeMachineDiagnoseUsesDiagRes(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()

	c, err := net.Dial("tcp", m.Addr())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	if _, err := c.Write(protocol.Encode(protocol.CmdCtrlMulti, []byte("diagnose\n"))); err != nil {
		t.Fatal(err)
	}

	c.SetReadDeadline(time.Now().Add(time.Second))
	var scan protocol.Scanner
	buf := make([]byte, 1024)
	n, err := c.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	frames := scan.Push(buf[:n])
	if len(frames) == 0 {
		t.Fatal("no response frame")
	}
	if frames[0].Cmd != protocol.CmdDiagRes {
		t.Fatalf("diagnose response cmd = %s, want DIAG_RES", protocol.CmdName(frames[0].Cmd))
	}
}

func TestFakeMachineInstantJogInterpolatesStatusPosition(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	c := dialFakeMachine(t, m)
	defer c.Close()

	writeCtrlMulti(t, c, "$J X30 F0.1\n")

	st := queryFakeStatus(t, c)
	if st.MPos["x"] >= 30 {
		t.Fatalf("instant jog status jumped to target immediately: %+v", st.MPos)
	}
}

func TestFakeMachineInstantJogFinishesAtTarget(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	c := dialFakeMachine(t, m)
	defer c.Close()

	writeCtrlMulti(t, c, "$J X1.25 Y-2 Z0.5 F1\n")
	time.Sleep(100 * time.Millisecond)

	st := queryFakeStatus(t, c)
	assertAxis(t, st.MPos, "x", 1.25)
	assertAxis(t, st.MPos, "y", -2)
	assertAxis(t, st.MPos, "z", 0.5)
	assertAxis(t, st.WPos, "x", 1.25)
	assertAxis(t, st.WPos, "y", -2)
	assertAxis(t, st.WPos, "z", 0.5)
}

func TestFakeMachineG53MoveUpdatesMachineAndWorkPosition(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	m.SetStatus("<Idle|MPos:1,2,3|WPos:0,1,2|F:0,0,100>")
	c := dialFakeMachine(t, m)
	defer c.Close()

	writeCtrlMulti(t, c, "G53 G0 X5 Z4\n")
	time.Sleep(180 * time.Millisecond)

	st := queryFakeStatus(t, c)
	assertAxis(t, st.MPos, "x", 5)
	assertAxis(t, st.MPos, "y", 2)
	assertAxis(t, st.MPos, "z", 4)
	assertAxis(t, st.WPos, "x", 4)
	assertAxis(t, st.WPos, "y", 1)
	assertAxis(t, st.WPos, "z", 3)
	if st.Feed == nil {
		t.Fatal("status mutation dropped F field")
	}
}

func TestFakeMachineG0IgnoresFeedRate(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	c := dialFakeMachine(t, m)
	defer c.Close()

	writeCtrlMulti(t, c, "G0 X1 F1\n")
	time.Sleep(100 * time.Millisecond)

	st := queryFakeStatus(t, c)
	assertAxis(t, st.MPos, "x", 1)
	assertAxis(t, st.WPos, "x", 1)
}

func TestFakeMachineG1UsesModalFeedRate(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	c := dialFakeMachine(t, m)
	defer c.Close()

	writeCtrlMulti(t, c, "G1 F60\n")
	writeCtrlMulti(t, c, "X10\n")
	time.Sleep(120 * time.Millisecond)

	st := queryFakeStatus(t, c)
	got := st.MPos["x"]
	if got <= 0 || got >= 5 {
		t.Fatalf("modal feed move X = %v, want slow in-progress move below 5mm (all axes %+v)", got, st.MPos)
	}
}

func TestFakeMachineOriginCommandUpdatesWorkPosition(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	m.SetStatus("<Idle|MPos:5,2,-1|WPos:4,1,-2>")
	c := dialFakeMachine(t, m)
	defer c.Close()

	writeCtrlMulti(t, c, "G10L20P0Z0\n")

	st := queryFakeStatus(t, c)
	assertAxis(t, st.MPos, "x", 5)
	assertAxis(t, st.MPos, "y", 2)
	assertAxis(t, st.MPos, "z", -1)
	assertAxis(t, st.WPos, "x", 4)
	assertAxis(t, st.WPos, "y", 1)
	assertAxis(t, st.WPos, "z", 0)
}

func TestFakeMachineRenameMovesUploadedFile(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	conn := dialFakeClient(t, m)

	content := []byte("renamed gcode")
	uploadFakeContent(t, conn, "/sd/gcodes/original.nc", content)
	if err := conn.Rename("/sd/gcodes/original.nc", "/sd/gcodes/renamed.nc", time.Second); err != nil {
		t.Fatalf("Rename: %v", err)
	}

	if _, ok := m.File("/sd/gcodes/original.nc"); ok {
		t.Fatal("old path still exists after rename")
	}
	got, ok := m.File("/sd/gcodes/renamed.nc")
	if !ok || !bytes.Equal(got, content) {
		t.Fatalf("renamed file = %q ok=%v, want %q", got, ok, content)
	}
}

func TestFakeMachineDownloadPacketDelayPacesDownload(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()

	content := bytes.Repeat([]byte("G1 X1\n"), 1000) // 6000 bytes
	m.PutFile("/sd/gcodes/slow.nc", content)
	m.SetDownloadPacketSize(2048) // 3 packets
	const perPacket = 60 * time.Millisecond
	m.SetDownloadPacketDelay(perPacket)

	conn := dialFakeClient(t, m)
	var got bytes.Buffer
	start := time.Now()
	_, _, err = conn.Download("/sd/gcodes/slow.nc", &got, 5*time.Second, nil)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("Download: %v", err)
	}
	if !bytes.Equal(got.Bytes(), content) {
		t.Fatalf("downloaded %d bytes, want %d", got.Len(), len(content))
	}
	// Three data packets, each delayed: the transfer must take at least the
	// summed per-packet delay.
	if min := 3 * perPacket; elapsed < min {
		t.Fatalf("download elapsed = %s, want >= %s (delay hook not applied)", elapsed, min)
	}
}

func TestFakeMachineRejectsFileOpsWhileRunning(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	c := dialFakeMachine(t, m)
	defer c.Close()

	writeCtrlMulti(t, c, "G1 F60\n")
	writeCtrlMulti(t, c, "X10\n")
	st := queryFakeStatus(t, c)
	if st.State != machine.Run {
		t.Fatalf("state after slow move = %s, want Run", st.State)
	}

	if _, err := c.Write(protocol.LsCommand("/sd/gcodes")); err != nil {
		t.Fatal(err)
	}
	f := readFakeFrame(t, c)
	if f.Cmd != protocol.CmdLoadError {
		t.Fatalf("ls while running cmd = %s, want LOAD_ERROR", protocol.CmdName(f.Cmd))
	}

	conn := dialFakeClient(t, m)
	err = conn.Upload("/sd/gcodes/busy.nc", bytes.NewReader([]byte("x")), 1, md5String([]byte("x")), time.Second, nil)
	if err == nil {
		t.Fatal("upload while running succeeded, want cancellation")
	}
}

func TestFakeMachineRealtimeControlTransitionsStatus(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	c := dialFakeMachine(t, m)
	defer c.Close()

	writeCtrlMulti(t, c, "G1 F60\n")
	writeCtrlMulti(t, c, "X10\n")
	if st := queryFakeStatus(t, c); st.State != machine.Run {
		t.Fatalf("initial state = %s, want Run", st.State)
	}

	if _, err := c.Write(protocol.FeedHold()); err != nil {
		t.Fatal(err)
	}
	held := queryFakeStatus(t, c)
	if held.State != machine.Hold {
		t.Fatalf("held state = %s, want Hold", held.State)
	}
	time.Sleep(30 * time.Millisecond)
	stillHeld := queryFakeStatus(t, c)
	assertAxis(t, stillHeld.MPos, "x", held.MPos["x"])

	if _, err := c.Write(protocol.Resume()); err != nil {
		t.Fatal(err)
	}
	if resumed := queryFakeStatus(t, c); resumed.State != machine.Run {
		t.Fatalf("resumed state = %s, want Run", resumed.State)
	}

	if _, err := c.Write(protocol.Halt()); err != nil {
		t.Fatal(err)
	}
	alarm := queryFakeStatus(t, c)
	if alarm.State != machine.Alarm || alarm.HaltReason == nil {
		t.Fatalf("halt status = %+v, want Alarm with H field", alarm)
	}
	writeCtrlMulti(t, c, "$X\n")
	cleared := queryFakeStatus(t, c)
	if cleared.State != machine.Idle || cleared.HaltReason != nil {
		t.Fatalf("unlock status = %+v, want Idle without H field", cleared)
	}
}

func TestFakeMachineDefaultQueryRepliesReflectState(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	m.SetStatus("<Idle|MPos:5,6,7|WPos:1,2,3>")
	c := dialFakeMachine(t, m)
	defer c.Close()

	writeCtrlMulti(t, c, "M114\n")
	f := readFakeFrame(t, c)
	if f.Cmd != protocol.CmdNormalInfo {
		t.Fatalf("M114 cmd = %s, want NORMAL_INFO", protocol.CmdName(f.Cmd))
	}
	if got := string(f.Data); !strings.Contains(got, "ok C: X:1.0000 Y:2.0000 Z:3.0000") {
		t.Fatalf("M114 reply = %q", got)
	}

	writeCtrlMulti(t, c, "$G\n")
	f = readFakeFrame(t, c)
	if got := string(f.Data); !strings.Contains(got, "[GC:G0 G21 G90]") {
		t.Fatalf("$G reply = %q", got)
	}

	writeCtrlMulti(t, c, "version\n")
	f = readFakeFrame(t, c)
	if got := string(f.Data); !strings.Contains(got, "version = 1.0.5") {
		t.Fatalf("version reply = %q", got)
	}

	writeCtrlMulti(t, c, "model\n")
	f = readFakeFrame(t, c)
	if got := string(f.Data); !strings.Contains(got, "model = CA1, 2, 4, 0") {
		t.Fatalf("model reply = %q", got)
	}
}

func TestFakeMachineConfigGetAllAndSetMirrorFirmwareSurface(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	c := dialFakeMachine(t, m)
	defer c.Close()

	writeCtrlMulti(t, c, "config-get-all -e\n")
	f := readFakeFrame(t, c)
	got := string(f.Data)
	if !strings.Contains(got, "coordinate.worksize_x=300.0\n") || !strings.Contains(got, "soft_endstop.x_min=-302.0\n") || !strings.Contains(got, "\x04") {
		t.Fatalf("config-get-all reply = %q", got)
	}

	writeCtrlMulti(t, c, "config-set sd coordinate.worksize_x 250.5\n")
	f = readFakeFrame(t, c)
	if got := string(f.Data); !strings.Contains(got, "sd: coordinate.worksize_x has been set to 250.5") {
		t.Fatalf("config-set reply = %q", got)
	}
	writeCtrlMulti(t, c, "config-set sd coordinate.clearance_x -7.5\n")
	f = readFakeFrame(t, c)
	if got := string(f.Data); !strings.Contains(got, "sd: coordinate.clearance_x has been set to -7.5") {
		t.Fatalf("negative config-set reply = %q", got)
	}

	snap := m.Snapshot()
	if snap.Config["coordinate.worksize_x"] != "250.5" || snap.MachineProfile.WorkSizeXMM != 250.5 {
		t.Fatalf("snapshot config/profile = %q %+v", snap.Config["coordinate.worksize_x"], snap.MachineProfile)
	}
	if snap.MachineProfile.ClearanceX != -7.5 {
		t.Fatalf("snapshot clearance = %+v", snap.MachineProfile)
	}
	if snap.MachineProfile.Model != "CA1" || snap.MachineProfile.MachineModel != 2 || snap.MachineProfile.FuncSetting != 4 {
		t.Fatalf("machine profile identity = %+v", snap.MachineProfile)
	}
}

func TestFakeMachineToolCommandsUpdateStatusTLO(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	c := dialFakeMachine(t, m)
	defer c.Close()

	st := queryFakeStatus(t, c)
	if st.Tool == nil || st.Tool.Active != 0 || st.Tool.Offset != 0 {
		t.Fatalf("default tool status = %+v", st.Tool)
	}

	writeCtrlMulti(t, c, "M493.2T3\n")
	st = queryFakeStatus(t, c)
	if st.Tool == nil || st.Tool.Active != 3 || st.Tool.Offset != 0 {
		t.Fatalf("set current tool status = %+v", st.Tool)
	}

	m.SetStatus("<Idle|MPos:0,0,-12.25|WPos:0,0,-12.25|C:2,4,0,1|T:3,0.000>")
	writeCtrlMulti(t, c, "M491\n")
	st = queryFakeStatus(t, c)
	if st.Tool == nil || st.Tool.Active != 3 || math.Abs(st.Tool.Offset-(-12.25)) > 0.001 {
		t.Fatalf("calibrated tool status = %+v", st.Tool)
	}

	writeCtrlMulti(t, c, "M6T-1\n")
	st = queryFakeStatus(t, c)
	if st.Tool == nil || st.Tool.Active != -1 || st.Tool.Offset != 0 {
		t.Fatalf("drop tool status = %+v", st.Tool)
	}
}

func TestFakeMachineInsertedToolCalibrationUsesReference(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	c := dialFakeMachine(t, m)
	defer c.Close()

	probe, err := m.InsertTool("probe")
	if err != nil {
		t.Fatal(err)
	}
	if probe.Calibrated || !probe.SpindleLocked {
		t.Fatalf("inserted probe state = %+v, want locked and uncalibrated", probe)
	}
	toolrackZ := configFloat(m.config, "coordinate.toolrack_z", -108)
	wantProbeContact := toolrackZ - 40
	if math.Abs(probe.CalibrationMZ-wantProbeContact) > 0.001 {
		t.Fatalf("probe calibration contact = %.3f, want %.3f", probe.CalibrationMZ, wantProbeContact)
	}
	writeCtrlMulti(t, c, "M491\n")
	st := queryFakeStatus(t, c)
	if st.Tool == nil || st.Tool.Active != 0 || math.Abs(st.Tool.Offset) > 0.001 {
		t.Fatalf("probe calibration status = %+v", st.Tool)
	}
	if snap := m.Snapshot(); snap.InsertedTool == nil || snap.InsertedTool.Kind != "probe" || !snap.InsertedTool.Calibrated || snap.LastProbe == nil || snap.LastProbe.Source != fakeCalibrationSwitchSource {
		t.Fatalf("probe calibration snapshot = %+v last=%+v", snap.InsertedTool, snap.LastProbe)
	}

	tool, err := m.InsertTool("tool_3_175")
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(tool.CalibrationMZ-toolrackZ) > 0.001 {
		t.Fatalf("3.175mm calibration contact = %.3f, want %.3f", tool.CalibrationMZ, toolrackZ)
	}
	writeCtrlMulti(t, c, "M491\n")
	st = queryFakeStatus(t, c)
	wantOffset := tool.CalibrationMZ - probe.CalibrationMZ
	if math.Abs(wantOffset-40) > 0.001 {
		t.Fatalf("3.175mm expected offset = %.3f, want 40.000", wantOffset)
	}
	if st.Tool == nil || st.Tool.Active != 1 || math.Abs(st.Tool.Offset-wantOffset) > 0.001 {
		t.Fatalf("3.175mm calibration status = %+v, want offset %.3f", st.Tool, wantOffset)
	}
	assertAxis(t, st.WPos, "z", -wantOffset)
	if snap := m.Snapshot(); snap.InsertedTool == nil || !snap.InsertedTool.Calibrated || math.Abs(snap.InsertedTool.CalibratedOffsetMM-wantOffset) > 0.001 {
		t.Fatalf("calibrated 3.175mm snapshot = %+v, want offset %.3f", snap.InsertedTool, wantOffset)
	}

	writeCtrlMulti(t, c, "G10L20P0Z0\n")
	st = queryFakeStatus(t, c)
	if st.Tool == nil || st.Tool.Active != 1 || math.Abs(st.Tool.Offset) > 0.001 {
		t.Fatalf("G10 reference reset status = %+v", st.Tool)
	}
	tool6, err := m.InsertTool("6")
	if err != nil {
		t.Fatal(err)
	}
	writeCtrlMulti(t, c, "M491\n")
	st = queryFakeStatus(t, c)
	wantOffset = tool6.CalibrationMZ - tool.CalibrationMZ
	if st.Tool == nil || st.Tool.Active != 2 || math.Abs(st.Tool.Offset-wantOffset) > 0.001 {
		t.Fatalf("6mm calibration after reference reset = %+v, want offset %.3f", st.Tool, wantOffset)
	}
	assertAxis(t, st.WPos, "z", -wantOffset)
}

func TestFakeMachineToolChangeWaitsForContinueAndUpdatesTLO(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	c := dialFakeMachine(t, m)
	defer c.Close()

	writeCtrlMulti(t, c, "M6T2\n")
	st := queryFakeStatus(t, c)
	if st.State != machine.Tool {
		t.Fatalf("state after M6T2 = %s, want Tool", st.State)
	}
	if st.Tool == nil || st.Tool.Active != 0 || st.Tool.Target == nil || *st.Tool.Target != 2 || st.Tool.Offset != 0 {
		t.Fatalf("tool target after M6T2 = %+v, want active 0 target 2", st.Tool)
	}

	writeCtrlMulti(t, c, "M490.2\n")
	st = queryFakeStatus(t, c)
	wantOffset := (configFloat(m.config, "coordinate.toolrack_z", -108)) - (configFloat(m.config, "coordinate.toolrack_z", -108) - 40)
	if st.State != machine.Idle {
		t.Fatalf("state after continue = %s, want Idle", st.State)
	}
	if st.Tool == nil || st.Tool.Active != 2 || st.Tool.Target != nil || math.Abs(st.Tool.Offset-wantOffset) > 0.001 {
		t.Fatalf("tool after continue = %+v, want active 2 offset %.3f", st.Tool, wantOffset)
	}
	assertAxis(t, st.WPos, "z", -wantOffset)
	if snap := m.Snapshot(); snap.InsertedTool == nil || snap.InsertedTool.ToolID != 2 || !snap.InsertedTool.Calibrated || math.Abs(snap.InsertedTool.CalibratedOffsetMM-wantOffset) > 0.001 {
		t.Fatalf("snapshot inserted tool = %+v, want calibrated tool 2 offset %.3f", snap.InsertedTool, wantOffset)
	}
}

func TestFakeMachineToolChangeWrongPhysicalToolIsExplicitInSnapshot(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	c := dialFakeMachine(t, m)
	defer c.Close()

	writeCtrlMulti(t, c, "M6T1\n")
	if st := queryFakeStatus(t, c); st.State != machine.Tool || st.Tool == nil || st.Tool.Target == nil || *st.Tool.Target != 1 {
		t.Fatalf("state after M6T1 = %+v, want Tool target 1", st)
	}

	inserted, err := m.InsertTool("tool_6")
	if err != nil {
		t.Fatal(err)
	}
	if inserted.ToolID != 2 || inserted.MatchesFirmwareTool {
		t.Fatalf("inserted mismatch = %+v, want physical T2 against target T1", inserted)
	}
	if inserted.FirmwareTargetToolID == nil || *inserted.FirmwareTargetToolID != 1 {
		t.Fatalf("inserted target = %+v, want T1", inserted.FirmwareTargetToolID)
	}

	writeCtrlMulti(t, c, "M490.2\n")
	st := queryFakeStatus(t, c)
	if st.State != machine.Idle || st.Tool == nil || st.Tool.Active != 1 || st.Tool.Target != nil {
		t.Fatalf("state after mismatched continue = %+v, want firmware active T1", st)
	}
	snap := m.Snapshot()
	if snap.InsertedTool == nil || snap.InsertedTool.ToolID != 2 || snap.InsertedTool.FirmwareToolID != 1 || snap.InsertedTool.MatchesFirmwareTool {
		t.Fatalf("snapshot mismatch = %+v, want physical T2 with firmware T1 mismatch", snap.InsertedTool)
	}
	if !snap.InsertedTool.Calibrated || math.Abs(snap.InsertedTool.CalibratedOffsetMM-st.Tool.Offset) > 0.001 {
		t.Fatalf("snapshot calibration = %+v, want explicit calibrated physical tool and firmware TLO %.3f", snap.InsertedTool, st.Tool.Offset)
	}
}

func TestFakeMachineProbeToolChangeWaitsWhenNoToolIsInserted(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	c := dialFakeMachine(t, m)
	defer c.Close()

	if snap := m.Snapshot(); snap.InsertedTool != nil {
		t.Fatalf("initial inserted tool = %+v, want none", snap.InsertedTool)
	}
	st := queryFakeStatus(t, c)
	if st.Tool == nil || st.Tool.Active != 0 || st.Tool.Offset != 0 || st.Tool.Target != nil {
		t.Fatalf("initial tool status = %+v, want active probe with no target", st.Tool)
	}

	writeCtrlMulti(t, c, "M6T0\n")
	st = queryFakeStatus(t, c)
	if st.State != machine.Tool {
		t.Fatalf("state after M6T0 with no inserted probe = %s, want Tool", st.State)
	}
	if st.Tool == nil || st.Tool.Active != 0 || st.Tool.Target == nil || *st.Tool.Target != 0 || st.Tool.Offset != 0 {
		t.Fatalf("tool target after M6T0 = %+v, want active 0 target 0", st.Tool)
	}

	probe, err := m.InsertTool("probe")
	if err != nil {
		t.Fatal(err)
	}
	if probe.Kind != "probe" || probe.Calibrated {
		t.Fatalf("inserted probe = %+v, want uncalibrated probe", probe)
	}
	st = queryFakeStatus(t, c)
	if st.State != machine.Tool || st.Tool == nil || st.Tool.Target == nil || *st.Tool.Target != 0 {
		t.Fatalf("status after inserting probe during wait = state %s tool %+v, want Tool target 0", st.State, st.Tool)
	}

	writeCtrlMulti(t, c, "M490.2\n")
	st = queryFakeStatus(t, c)
	if st.State != machine.Idle {
		t.Fatalf("state after continue = %s, want Idle", st.State)
	}
	if st.Tool == nil || st.Tool.Active != 0 || st.Tool.Target != nil || math.Abs(st.Tool.Offset) > 0.001 {
		t.Fatalf("tool after probe continue = %+v, want active 0 offset 0", st.Tool)
	}
	assertAxis(t, st.WPos, "z", 0)
	if snap := m.Snapshot(); snap.InsertedTool == nil || snap.InsertedTool.Kind != "probe" || !snap.InsertedTool.Calibrated || math.Abs(snap.InsertedTool.CalibratedOffsetMM) > 0.001 {
		t.Fatalf("snapshot after probe continue = %+v, want calibrated probe offset 0", snap.InsertedTool)
	}
}

func TestFakeMachineToolStickoutAdjustmentRequiresUnlockedSpindle(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()

	if _, err := m.InsertTool("tool_6"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.SetInsertedToolStickout(42); err == nil {
		t.Fatal("stickout changed while spindle locked")
	}
	unlocked, err := m.SetInsertedToolSpindleLocked(false)
	if err != nil {
		t.Fatal(err)
	}
	if unlocked.SpindleLocked {
		t.Fatalf("unlocked tool = %+v", unlocked)
	}
	adjusted, err := m.SetInsertedToolStickout(42)
	if err != nil {
		t.Fatal(err)
	}
	if adjusted.StickoutMM != 42 || adjusted.Calibrated {
		t.Fatalf("adjusted tool = %+v, want 42mm uncalibrated", adjusted)
	}

	c := dialFakeMachine(t, m)
	defer c.Close()
	writeCtrlMulti(t, c, "M491\n")
	st := queryFakeStatus(t, c)
	toolrackZ := configFloat(m.config, "coordinate.toolrack_z", -108)
	nominalStickout := fakeToolPresets[2].StickoutMM
	probeContact := toolrackZ - 40
	wantContact := toolrackZ + (adjusted.StickoutMM - nominalStickout)
	if math.Abs(adjusted.CalibrationMZ-wantContact) > 0.001 {
		t.Fatalf("adjusted calibration contact = %.3f, want %.3f", adjusted.CalibrationMZ, wantContact)
	}
	wantOffset := adjusted.CalibrationMZ - probeContact
	if st.Tool == nil || st.Tool.Active != 2 || math.Abs(st.Tool.Offset-wantOffset) > 0.001 {
		t.Fatalf("calibrated adjusted tool status = %+v, want offset %.3f", st.Tool, wantOffset)
	}
	if snap := m.Snapshot(); snap.InsertedTool == nil || !snap.InsertedTool.Calibrated || math.Abs(snap.InsertedTool.CalibratedMZ-wantContact) > 0.001 {
		t.Fatalf("calibrated adjusted snapshot = %+v, want MZ %.3f", snap.InsertedTool, wantContact)
	}

	if _, err := m.SetInsertedToolStickout(43); err != nil {
		t.Fatal(err)
	}
	if snap := m.Snapshot(); snap.InsertedTool == nil || snap.InsertedTool.Calibrated {
		t.Fatalf("adjustment did not invalidate calibration: %+v", snap.InsertedTool)
	}
}

func TestFakeMachineG386CalibrationProbeSavesToolOffset(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	c := dialFakeMachine(t, m)
	defer c.Close()

	tool, err := m.InsertTool("6.35")
	if err != nil {
		t.Fatal(err)
	}
	m.SetStatus("<Idle|MPos:0,0,-3|WPos:0,0,-3|C:2,4,0,1|T:3,0.000>")

	writeCtrlMulti(t, c, "G38.6 Z-120 F500\n")
	f := readFakeFrame(t, c)
	wantPRB := "[PRB:0.0000,0.0000," + strconv.FormatFloat(tool.CalibrationMZ, 'f', 4, 64) + ":1]"
	if got := string(f.Data); f.Cmd != protocol.CmdNormalInfo || !strings.Contains(got, wantPRB) {
		t.Fatalf("calibration probe reply cmd=%s data=%q want %q", protocol.CmdName(f.Cmd), got, wantPRB)
	}
	snap := m.Snapshot()
	if snap.LastProbe == nil || !snap.LastProbe.Hit || snap.LastProbe.Source != fakeCalibrationSwitchSource {
		t.Fatalf("last calibration probe = %+v", snap.LastProbe)
	}

	writeCtrlMulti(t, c, "M493.1\n")
	st := queryFakeStatus(t, c)
	probeContact := configFloat(m.config, "coordinate.toolrack_z", -108) - 40
	wantOffset := tool.CalibrationMZ - probeContact
	if math.Abs(wantOffset-40) > 0.001 {
		t.Fatalf("M493.1 expected offset = %.3f, want 40.000", wantOffset)
	}
	if st.Tool == nil || st.Tool.Active != 3 || math.Abs(st.Tool.Offset-wantOffset) > 0.001 {
		t.Fatalf("M493.1 tool status = %+v, want offset %.3f", st.Tool, wantOffset)
	}
}

func TestFakeMachineProbeHitsLoadedSTLAndTracksLaser(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	loadProbeModelAt(t, m, "plate.stl", []byte(testPlaneSTL(-5)), 0, 0, -5)
	m.SetStatus("<Idle|MPos:5,5,2|WPos:0,0,7|C:2,4,0,1|T:0,0.000>")
	c := dialFakeMachine(t, m)
	defer c.Close()

	writeCtrlMulti(t, c, "M841\n")
	waitForProbeLaser(t, m, true)

	writeCtrlMulti(t, c, "G38.2 Z-20 F100\n")
	f := readFakeFrame(t, c)
	if got := string(f.Data); f.Cmd != protocol.CmdNormalInfo || !strings.Contains(got, "[PRB:5.0000,5.0000,-5.0000:1]") {
		t.Fatalf("probe reply cmd=%s data=%q", protocol.CmdName(f.Cmd), got)
	}
	st := queryFakeStatus(t, c)
	assertAxis(t, st.MPos, "z", -5)
	assertAxis(t, st.WPos, "z", 0)
	snap := m.Snapshot()
	if snap.LastProbe == nil || !snap.LastProbe.Hit || snap.LastProbe.Source != "plate.stl" {
		t.Fatalf("last probe = %+v", snap.LastProbe)
	}

	writeCtrlMulti(t, c, "M842\n")
	waitForProbeLaser(t, m, false)
}

func TestProbeReplyIsDelayedUntilContact(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	m.SetProbeReplyDelay(300 * time.Millisecond)
	c := dialFakeMachine(t, m)
	defer c.Close()

	start := time.Now()
	writeCtrlMulti(t, c, "G38.2 Z-5 F50\n")
	f := readFakeFrame(t, c)
	if elapsed := time.Since(start); elapsed < 250*time.Millisecond {
		t.Fatalf("probe reply arrived after %v, want delayed contact", elapsed)
	}
	if f.Cmd != protocol.CmdNormalInfo || !strings.Contains(string(f.Data), "[PRB:") {
		t.Fatalf("probe reply cmd=%s data=%q", protocol.CmdName(f.Cmd), f.Data)
	}
}

func TestFakeMachineProbeNoHitLoadedModelOutsideXY(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	if err := m.LoadProbeModel("plate.stl", []byte(testPlaneSTL(-5))); err != nil {
		t.Fatal(err)
	}
	m.SetStatus("<Idle|MPos:20,20,2|WPos:20,20,2|C:2,4,0,1|T:0,0.000>")
	c := dialFakeMachine(t, m)
	defer c.Close()

	writeCtrlMulti(t, c, "G38.2 Z-20 F100\n")
	f := readFakeFrame(t, c)
	if got := string(f.Data); f.Cmd != protocol.CmdNormalInfo || !strings.Contains(got, "[PRB:20.0000,20.0000,-20.0000:0]") {
		t.Fatalf("probe no-hit reply cmd=%s data=%q", protocol.CmdName(f.Cmd), got)
	}
	st := queryFakeStatus(t, c)
	assertAxis(t, st.MPos, "z", -20)
	snap := m.Snapshot()
	if snap.LastProbe == nil || snap.LastProbe.Hit || snap.LastProbe.Source != "" || math.Abs(snap.LastProbe.Machine.Z+20) > 0.001 {
		t.Fatalf("last no-hit probe = %+v", snap.LastProbe)
	}
}

func TestFakeMachineProbeChoosesNearestLoadedModelHit(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	loadProbeModelAt(t, m, "stack.stl", []byte(testStackedPlaneSTL(-8, -3)), 0, 0, -3)
	m.SetStatus("<Idle|MPos:5,5,2|WPos:5,5,2|C:2,4,0,1|T:0,0.000>")
	c := dialFakeMachine(t, m)
	defer c.Close()

	writeCtrlMulti(t, c, "G38.2 Z-20 F100\n")
	f := readFakeFrame(t, c)
	if got := string(f.Data); f.Cmd != protocol.CmdNormalInfo || !strings.Contains(got, "[PRB:5.0000,5.0000,-3.0000:1]") {
		t.Fatalf("nearest probe reply cmd=%s data=%q", protocol.CmdName(f.Cmd), got)
	}
	st := queryFakeStatus(t, c)
	assertAxis(t, st.MPos, "z", -3)
	snap := m.Snapshot()
	if snap.LastProbe == nil || !snap.LastProbe.Hit || snap.LastProbe.Source != "stack.stl" || math.Abs(snap.LastProbe.Machine.Z+3) > 0.001 {
		t.Fatalf("last nearest probe = %+v", snap.LastProbe)
	}
}

func TestFakeMachinePositionsLoadedStockModelForProbeAndSimulation(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	if err := m.LoadProbeModel("block.stl", []byte(testBlockSTL(0, 10, 0, 10, -5, 0))); err != nil {
		t.Fatal(err)
	}
	xMin := 30.0
	yMin := 40.0
	topZ := -10.0
	model, err := m.SetModelPlacement(ModelPlacementUpdate{XMinMM: &xMin, YMinMM: &yMin, TopZMM: &topZ})
	if err != nil {
		t.Fatal(err)
	}
	if model.Placement.XMinMM != xMin || model.Placement.YMinMM != yMin || model.Placement.TopZMM != topZ {
		t.Fatalf("placement = %+v", model.Placement)
	}
	if model.Bounds.Min.X != xMin || model.Bounds.Min.Y != yMin || model.Bounds.Max.Z != topZ {
		t.Fatalf("placed bounds = %+v", model.Bounds)
	}
	if model.SourceBounds.Min.X != 0 || model.SourceBounds.Max.Z != 0 {
		t.Fatalf("source bounds changed = %+v", model.SourceBounds)
	}
	mesh, ok := m.ProbeModelMesh()
	if !ok {
		t.Fatal("missing probe mesh")
	}
	if mesh.Placement.XMinMM != xMin || mesh.Bounds.Min.X != xMin || mesh.Positions[0] < xMin-0.001 {
		t.Fatalf("mesh placement = %+v first=%v", mesh.Placement, mesh.Positions[:3])
	}
	stock, ok := m.StockState()
	if !ok {
		t.Fatal("missing stock")
	}
	if stock.XMin != xMin || stock.YMin != yMin || math.Abs(stock.TopZ-topZ) > 0.001 {
		t.Fatalf("stock placement = x %.3f y %.3f top %.3f", stock.XMin, stock.YMin, stock.TopZ)
	}

	m.SetStatus("<Idle|MPos:35,45,5|WPos:35,45,5|C:2,4,0,1|T:0,0.000>")
	c := dialFakeMachine(t, m)
	defer c.Close()

	writeCtrlMulti(t, c, "G38.2 Z-30 F100\n")
	f := readFakeFrame(t, c)
	if got := string(f.Data); f.Cmd != protocol.CmdNormalInfo || !strings.Contains(got, "[PRB:35.0000,45.0000,-10.0000:1]") {
		t.Fatalf("placed probe reply cmd=%s data=%q", protocol.CmdName(f.Cmd), got)
	}
	snap := m.Snapshot()
	if snap.LastProbe == nil || !snap.LastProbe.Hit || snap.LastProbe.Source != "block.stl" || math.Abs(snap.LastProbe.Machine.Z-topZ) > 0.001 {
		t.Fatalf("last placed probe = %+v", snap.LastProbe)
	}
}

func TestFakeMachineRotatesLoadedStockAroundCurrentCenter(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	loadProbeModelAt(t, m, "block.stl", []byte(testBlockSTL(0, 20, 0, 10, -5, 0)), 30, 40, -10)

	before := m.Snapshot().ProbeModel
	if before == nil {
		t.Fatal("missing probe model")
	}
	centerX := (before.Bounds.Min.X + before.Bounds.Max.X) / 2
	centerY := (before.Bounds.Min.Y + before.Bounds.Max.Y) / 2
	rot := 90.0
	rotated, err := m.SetModelPlacement(ModelPlacementUpdate{RotationDeg: &rot})
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(rotated.Placement.RotationDeg-90) > 0.001 {
		t.Fatalf("rotation = %.3f, want 90", rotated.Placement.RotationDeg)
	}
	if got := (rotated.Bounds.Min.X + rotated.Bounds.Max.X) / 2; math.Abs(got-centerX) > 0.001 {
		t.Fatalf("rotated center X = %.3f, want %.3f", got, centerX)
	}
	if got := (rotated.Bounds.Min.Y + rotated.Bounds.Max.Y) / 2; math.Abs(got-centerY) > 0.001 {
		t.Fatalf("rotated center Y = %.3f, want %.3f", got, centerY)
	}
	if math.Abs((rotated.Bounds.Max.X-rotated.Bounds.Min.X)-10) > 0.001 || math.Abs((rotated.Bounds.Max.Y-rotated.Bounds.Min.Y)-20) > 0.001 {
		t.Fatalf("rotated bounds = %+v, want width 10 depth 20", rotated.Bounds)
	}

	m.SetStatus("<Idle|MPos:40,54,5|WPos:40,54,5|C:2,4,0,1|T:0,0.000>")
	c := dialFakeMachine(t, m)
	defer c.Close()
	writeCtrlMulti(t, c, "G38.2 Z-30 F100\n")
	f := readFakeFrame(t, c)
	if got := string(f.Data); f.Cmd != protocol.CmdNormalInfo || !strings.Contains(got, "[PRB:40.0000,54.0000,-10.0000:1]") {
		t.Fatalf("rotated probe reply cmd=%s data=%q", protocol.CmdName(f.Cmd), got)
	}
	snap := m.Snapshot()
	if snap.LastProbe == nil || !snap.LastProbe.Hit || snap.LastProbe.Source != "block.stl" || math.Abs(snap.LastProbe.Machine.Z+10) > 0.001 {
		t.Fatalf("last rotated probe = %+v", snap.LastProbe)
	}
}

func TestFakeMachineAutoZProbeUsesCalibratedProbeTipAgainstStock(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	loadProbeModelAt(t, m, "block.stl", []byte(testBlockSTL(0, 20, 0, 20, -80, -70)), 0, 0, -70)
	probe, err := m.InsertTool("probe")
	if err != nil {
		t.Fatal(err)
	}
	m.SetStatus("<Idle|MPos:10,10,-3|WPos:10,10,-3|C:2,4,0,1|T:0,0.000>")
	c := dialFakeMachine(t, m)
	defer c.Close()

	writeCtrlMulti(t, c, "M491\n")
	st := queryFakeStatus(t, c)
	if st.Tool == nil || st.Tool.Active != 0 || math.Abs(st.Tool.Offset) > 0.001 {
		t.Fatalf("probe calibration status = %+v", st.Tool)
	}

	writeCtrlMulti(t, c, "M495 X10Y10O0F0\n")
	st = queryFakeStatus(t, c)
	wantContactMZ := -70.0 + probe.StickoutMM
	wantRetract := configFloat(m.config, "atc.probe.retract_mm", 2)
	assertAxis(t, st.MPos, "x", 10)
	assertAxis(t, st.MPos, "y", 10)
	assertAxis(t, st.MPos, "z", wantContactMZ+wantRetract)
	assertAxis(t, st.WPos, "z", wantRetract)
	snap := m.Snapshot()
	if snap.ProbeLaserActive {
		t.Fatal("probe laser left active after M495")
	}
	if snap.LastProbe == nil || !snap.LastProbe.Hit || snap.LastProbe.Source != "block.stl" || math.Abs(snap.LastProbe.Machine.Z-wantContactMZ) > 0.001 {
		t.Fatalf("auto z probe last probe = %+v, want contact %.3f", snap.LastProbe, wantContactMZ)
	}
	if !strings.Contains(snap.LastProbe.Command, "F60") {
		t.Fatalf("auto z probe slow command = %q, want firmware default F60", snap.LastProbe.Command)
	}
}

func TestFakeMachineAutoZProbeSetsZ0AtFlatProbeTipContactOnSlopedModel(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	loadProbeModelAt(t, m, "slope.stl", []byte(testSlopedPlaneSTL(0, 20, 0, 20, -80, -60)), 0, 0, -60)
	probe, err := m.InsertTool("probe")
	if err != nil {
		t.Fatal(err)
	}
	m.SetStatus("<Idle|MPos:10,10,-3|WPos:10,10,-3|C:2,4,0,1|T:0,0.000>")
	c := dialFakeMachine(t, m)
	defer c.Close()
	writeCtrlMulti(t, c, "M491\n")
	_ = queryFakeStatus(t, c)

	writeCtrlMulti(t, c, "M495 X10Y10O0F0\n")
	st := queryFakeStatus(t, c)
	// The probe has a flat 2 mm tip, so a centered probe at X10 contacts the
	// rising slope at X11, not at the center X10 and not at the 3.175 mm shoulder.
	wantTipSurfaceZ := -69.0
	wantContactMZ := wantTipSurfaceZ + probe.StickoutMM
	wantRetract := configFloat(m.config, "atc.probe.retract_mm", 2)
	assertAxis(t, st.MPos, "z", wantContactMZ+wantRetract)
	assertAxis(t, st.WPos, "z", wantRetract)
	snap := m.Snapshot()
	if snap.LastProbe == nil || !snap.LastProbe.Hit || snap.LastProbe.Source != "slope.stl" || math.Abs(snap.LastProbe.Machine.Z-wantContactMZ) > 0.001 {
		t.Fatalf("sloped flat-tip probe = %+v, want contact %.3f", snap.LastProbe, wantContactMZ)
	}
	if centerContact := -70.0 + probe.StickoutMM; math.Abs(snap.LastProbe.Machine.Z-centerContact) < 0.5 {
		t.Fatalf("sloped flat-tip probe used center contact %.3f instead of disk contact %.3f", centerContact, wantContactMZ)
	}
}

func TestFakeMachineAutoZProbeUsesProbeTipDiameterOverlap(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	loadProbeModelAt(t, m, "tip-overlap.stl", []byte(testBlockSTL(10.75, 12, 9.5, 10.5, -80, -70)), 10.75, 9.5, -70)
	probe, err := m.InsertTool("probe")
	if err != nil {
		t.Fatal(err)
	}
	m.SetStatus("<Idle|MPos:10,10,-3|WPos:10,10,-3|C:2,4,0,1|T:0,0.000>")
	c := dialFakeMachine(t, m)
	defer c.Close()
	writeCtrlMulti(t, c, "M491\n")
	_ = queryFakeStatus(t, c)

	writeCtrlMulti(t, c, "M495 X10Y10O0F0\n")
	st := queryFakeStatus(t, c)
	wantContactMZ := -70.0 + probe.StickoutMM
	assertAxis(t, st.MPos, "z", wantContactMZ+configFloat(m.config, "atc.probe.retract_mm", 2))
	snap := m.Snapshot()
	if snap.LastProbe == nil || !snap.LastProbe.Hit || snap.LastProbe.Source != "tip-overlap.stl" || math.Abs(snap.LastProbe.Machine.Z-wantContactMZ) > 0.001 {
		t.Fatalf("tip footprint probe = %+v, want %.3f", snap.LastProbe, wantContactMZ)
	}
}

func TestFakeMachineAutoZProbeDoesNotUseShoulderAsZContact(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	loadProbeModelAt(t, m, "shoulder-only.stl", []byte(testBlockSTL(-8.8, -8, -10.5, -9.5, -80, -68)), -8.8, -10.5, -68)
	probe, err := m.InsertTool("probe")
	if err != nil {
		t.Fatal(err)
	}
	m.SetStatus("<Idle|MPos:-10,-10,-3|WPos:-10,-10,-3|C:2,4,0,1|T:0,0.000>")
	c := dialFakeMachine(t, m)
	defer c.Close()
	writeCtrlMulti(t, c, "M491\n")
	_ = queryFakeStatus(t, c)

	writeCtrlMulti(t, c, "M495 X-10Y-10O0F0\n")
	st := queryFakeStatus(t, c)
	wantContactMZ := configFloat(m.config, "soft_endstop.z_min", -121) + probe.StickoutMM
	assertAxis(t, st.MPos, "z", wantContactMZ+configFloat(m.config, "atc.probe.retract_mm", 2))
	snap := m.Snapshot()
	if snap.LastProbe == nil || !snap.LastProbe.Hit || snap.LastProbe.Source != "bed" || math.Abs(snap.LastProbe.Machine.Z-wantContactMZ) > 0.001 {
		t.Fatalf("shoulder-only probe = %+v, want bed contact %.3f", snap.LastProbe, wantContactMZ)
	}
}

func TestFakeStockMaxSurfaceZInDiskUsesTriangulatedSurface(t *testing.T) {
	stock := &fakeStock{
		XMin:   0,
		XMax:   10,
		YMin:   0,
		YMax:   10,
		CellsX: 2,
		CellsY: 2,
		StepX:  10,
		StepY:  10,
		Heights: []float64{
			-70, -60,
			-70, -60,
		},
	}

	z, ok := stock.maxSurfaceZInDisk(5, 5, 1)
	if !ok || math.Abs(z-(-64)) > 0.001 {
		t.Fatalf("stock disk max z = %.3f ok=%v, want -64", z, ok)
	}
}

func TestFakeMachineDefaultsLoadedStockToConfiguredBedLowerLeft(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	if err := m.LoadProbeModel("block.stl", []byte(testBlockSTL(0, 10, 0, 10, -5, 0))); err != nil {
		t.Fatal(err)
	}
	snap := m.Snapshot()
	if snap.ProbeModel == nil {
		t.Fatal("missing probe model")
	}
	if snap.ProbeModel.Placement.XMinMM != -300 || snap.ProbeModel.Placement.YMinMM != -200 {
		t.Fatalf("default placement = %+v, want lower-left work area", snap.ProbeModel.Placement)
	}
	if snap.ProbeModel.Bounds.Min.X != -300 || snap.ProbeModel.Bounds.Min.Y != -200 {
		t.Fatalf("default bounds = %+v", snap.ProbeModel.Bounds)
	}
	if snap.ProbeModel.Bounds.Min.Z != -121 || snap.ProbeModel.Bounds.Max.Z != -116 {
		t.Fatalf("default z bounds = %+v, want stock bottom on bed", snap.ProbeModel.Bounds)
	}
	stock, ok := m.StockState()
	if !ok {
		t.Fatal("missing stock")
	}
	if stock.XMin != -300 || stock.YMin != -200 {
		t.Fatalf("default stock = x %.3f y %.3f", stock.XMin, stock.YMin)
	}
	if math.Abs(stock.BaseZ-(-121)) > 0.001 || math.Abs(stock.TopZ-(-116)) > 0.001 {
		t.Fatalf("default stock z = base %.3f top %.3f, want bed contact", stock.BaseZ, stock.TopZ)
	}
	for i, h := range stock.Heights {
		if math.Abs(h-stock.TopZ) > 0.001 {
			t.Fatalf("default stock height[%d] = %.3f, want untouched top %.3f", i, h, stock.TopZ)
		}
	}
}

func TestFakeMachineProbeHitsLoadedGLTFAndGLB(t *testing.T) {
	for _, tc := range []struct {
		name string
		data []byte
	}{
		{name: "tri.gltf", data: testTriangleGLTF(t)},
		{name: "tri.glb", data: testTriangleGLB(t)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, err := New()
			if err != nil {
				t.Fatal(err)
			}
			defer m.Close()
			loadProbeModelAt(t, m, tc.name, tc.data, 0, 0, -4)
			m.SetStatus("<Idle|MPos:0.25,0.25,2|WPos:0.25,0.25,2|C:2,4,0,1|T:0,0.000>")
			c := dialFakeMachine(t, m)
			defer c.Close()

			writeCtrlMulti(t, c, "G38.2 Z-10 F100\n")
			f := readFakeFrame(t, c)
			if got := string(f.Data); f.Cmd != protocol.CmdNormalInfo || !strings.Contains(got, "[PRB:0.2500,0.2500,-4.0000:1]") {
				t.Fatalf("probe reply cmd=%s data=%q", protocol.CmdName(f.Cmd), got)
			}
			snap := m.Snapshot()
			if snap.LastProbe == nil || !snap.LastProbe.Hit || snap.LastProbe.Source != tc.name || math.Abs(snap.LastProbe.Machine.Z+4) > 0.001 {
				t.Fatalf("last probe = %+v", snap.LastProbe)
			}
		})
	}
}

func TestProbeModelParsesGLTFAndGLB(t *testing.T) {
	for _, tc := range []struct {
		name string
		data []byte
	}{
		{name: "tri.gltf", data: testTriangleGLTF(t)},
		{name: "tri.glb", data: testTriangleGLB(t)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, err := New()
			if err != nil {
				t.Fatal(err)
			}
			defer m.Close()
			if err := m.LoadProbeModel(tc.name, tc.data); err != nil {
				t.Fatal(err)
			}
			mesh, ok := m.ProbeModelMesh()
			if !ok {
				t.Fatal("missing probe mesh")
			}
			if mesh.Triangles != 1 || len(mesh.Positions) != 9 {
				t.Fatalf("mesh = %+v", mesh)
			}
			if mesh.SourceBounds.Min.Z != -4 || mesh.SourceBounds.Max.X != 1 || mesh.SourceBounds.Max.Y != 1 {
				t.Fatalf("source bounds = %+v", mesh.SourceBounds)
			}
			if mesh.Bounds.Min.X != -300 || mesh.Bounds.Min.Y != -200 || math.Abs(mesh.Bounds.Min.Z-(-121)) > 0.001 {
				t.Fatalf("placed bounds = %+v", mesh.Bounds)
			}
		})
	}
}

func TestFakeMachinePlayRunsUploadedProgramAndProgress(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	conn := dialFakeClient(t, m)
	uploadFakeContent(t, conn, "/sd/gcodes/run.nc", []byte("G4 P0.15\nG0 X1\n"))

	c := dialFakeMachine(t, m)
	defer c.Close()
	writeCtrlMulti(t, c, protocol.PlayLine("/sd/gcodes/run.nc"))
	running := queryFakeStatus(t, c)
	if running.State != machine.Run || running.Fields["P"] == "" {
		t.Fatalf("play status = %+v, want Run with progress field", running)
	}

	time.Sleep(250 * time.Millisecond)
	done := queryFakeStatus(t, c)
	if done.State != machine.Idle {
		t.Fatalf("final state = %s, want Idle", done.State)
	}
	if _, ok := done.Fields["P"]; ok {
		t.Fatalf("final status kept progress field: %+v", done.Fields)
	}
	assertAxis(t, done.MPos, "x", 1)
}

func TestFakeMachineStockSimulationCutsUploadedProgram(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	loadProbeModelAt(t, m, "block.stl", []byte(testBlockSTL(0, 20, 0, 12, -41, -36)), 0, 0, -36)
	if _, err := m.InsertTool("tool_6"); err != nil {
		t.Fatal(err)
	}
	speed := 100.0
	shape := "flat"
	if _, err := m.UpdateSimulationSettings(SimulationSettingsUpdate{SpeedScale: &speed, ToolShape: &shape}); err != nil {
		t.Fatal(err)
	}
	conn := dialFakeClient(t, m)
	uploadFakeContent(t, conn, "/sd/gcodes/slot.nc", []byte(strings.Join([]string{
		"G21 G90",
		"G0 X2 Y6 Z2",
		"G1 Z-3 F600",
		"G1 X18 F600",
		"G0 Z2",
	}, "\n")+"\n"))

	c := dialFakeMachine(t, m)
	defer c.Close()
	writeCtrlMulti(t, c, protocol.PlayLine("/sd/gcodes/slot.nc"))
	waitForFakeState(t, c, machine.Idle, time.Second)

	stock, ok := m.StockState()
	if !ok {
		t.Fatal("missing stock")
	}
	center := stockHeightNearest(stock, 10, 6)
	outside := stockHeightNearest(stock, 10, 0)
	if center > -36.8 {
		t.Fatalf("slot center height = %.3f, want cut near -37", center)
	}
	if math.Abs(outside-(-36)) > 0.001 {
		t.Fatalf("outside height = %.3f, want untouched top -36", outside)
	}
	if stock.RemovedVolumeMM3 <= 0 {
		t.Fatalf("removed volume = %.3f, want positive", stock.RemovedVolumeMM3)
	}
	if stl, ok := m.StockSTL(); !ok || !strings.Contains(string(stl[:min(len(stl), 64)]), "solid fakemachine-stock") {
		t.Fatalf("stock stl ok=%v header=%q", ok, string(stl[:min(len(stl), 64)]))
	}

	if _, err := m.ResetStock(); err != nil {
		t.Fatal(err)
	}
	reset, ok := m.StockState()
	if !ok {
		t.Fatal("missing reset stock")
	}
	if got := stockHeightNearest(reset, 10, 6); math.Abs(got-(-36)) > 0.001 || reset.RemovedVolumeMM3 != 0 {
		t.Fatalf("reset stock center=%.3f removed=%.3f, want top and zero volume", got, reset.RemovedVolumeMM3)
	}
}

func TestFakeMachineStockSimulationCutsInterpolatedArc(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	loadProbeModelAt(t, m, "block.stl", []byte(testBlockSTL(0, 20, 0, 12, -41, -36)), 0, 0, -36)
	if _, err := m.InsertTool("tool_3_175"); err != nil {
		t.Fatal(err)
	}
	speed := 120.0
	if _, err := m.UpdateSimulationSettings(SimulationSettingsUpdate{SpeedScale: &speed}); err != nil {
		t.Fatal(err)
	}
	conn := dialFakeClient(t, m)
	uploadFakeContent(t, conn, "/sd/gcodes/arc.nc", []byte(strings.Join([]string{
		"G21 G90 G17",
		"G0 X10 Y6 Z2",
		"G1 Z-3 F600",
		"G2 X14 Y6 I2 J0 F600",
		"G0 Z2",
	}, "\n")+"\n"))

	c := dialFakeMachine(t, m)
	defer c.Close()
	writeCtrlMulti(t, c, protocol.PlayLine("/sd/gcodes/arc.nc"))
	waitForFakeState(t, c, machine.Idle, time.Second)

	stock, ok := m.StockState()
	if !ok {
		t.Fatal("missing stock")
	}
	if got := stockHeightNearest(stock, 12, 8); got > -36.8 {
		t.Fatalf("arc midpoint height = %.3f, want cut below stock top", got)
	}
}

func TestFakeMachineStockSimulationCutsDrillingCycle(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	loadProbeModelAt(t, m, "block.stl", []byte(testBlockSTL(0, 20, 0, 12, -41, -36)), 0, 0, -36)
	if _, err := m.InsertTool("tool_6"); err != nil {
		t.Fatal(err)
	}
	speed := 100.0
	if _, err := m.UpdateSimulationSettings(SimulationSettingsUpdate{SpeedScale: &speed}); err != nil {
		t.Fatal(err)
	}
	conn := dialFakeClient(t, m)
	uploadFakeContent(t, conn, "/sd/gcodes/drill.nc", []byte(strings.Join([]string{
		"G21 G90 G98",
		"G81 X10 Y6 Z-3 R2 F600",
		"G80",
	}, "\n")+"\n"))

	c := dialFakeMachine(t, m)
	defer c.Close()
	writeCtrlMulti(t, c, protocol.PlayLine("/sd/gcodes/drill.nc"))
	waitForFakeState(t, c, machine.Idle, time.Second)

	stock, ok := m.StockState()
	if !ok {
		t.Fatal("missing stock")
	}
	if got := stockHeightNearest(stock, 10, 6); got > -36.8 {
		t.Fatalf("drilled height = %.3f, want cut below stock top", got)
	}
	if snap := m.Snapshot(); snap.Modal.Motion != "G0" {
		t.Fatalf("modal after G80 = %s, want G0", snap.Modal.Motion)
	}
}

func TestFakeMachineStockSimulationHonorsG92WorkPosition(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	loadProbeModelAt(t, m, "block.stl", []byte(testBlockSTL(0, 20, 0, 12, -41, -36)), 0, 0, -36)
	if _, err := m.InsertTool("tool_6"); err != nil {
		t.Fatal(err)
	}
	speed := 100.0
	if _, err := m.UpdateSimulationSettings(SimulationSettingsUpdate{SpeedScale: &speed}); err != nil {
		t.Fatal(err)
	}
	conn := dialFakeClient(t, m)
	uploadFakeContent(t, conn, "/sd/gcodes/g92.nc", []byte(strings.Join([]string{
		"G21 G90",
		"G53 G0 X10 Y6 Z2",
		"G92 X0 Y0 Z2",
		"G1 Z-3 F600",
		"G1 X5 F600",
	}, "\n")+"\n"))

	c := dialFakeMachine(t, m)
	defer c.Close()
	writeCtrlMulti(t, c, protocol.PlayLine("/sd/gcodes/g92.nc"))
	st := waitForFakeState(t, c, machine.Idle, time.Second)
	assertAxis(t, st.MPos, "x", 15)
	assertAxis(t, st.WPos, "x", 5)

	stock, ok := m.StockState()
	if !ok {
		t.Fatal("missing stock")
	}
	if got := stockHeightNearest(stock, 10, 6); got > -36.8 {
		t.Fatalf("G92 physical start height = %.3f, want cut below stock top", got)
	}
}

func TestFakeMachineSnapshotReportsVisualizedState(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	m.SetFtype("lz")
	m.SetCompressDownloads(true)
	m.PutFile("/sd/gcodes/visual.nc", []byte("G1 X2\n"))

	c := dialFakeMachine(t, m)
	defer c.Close()
	writeCtrlMulti(t, c, "G91\n")
	writeCtrlMulti(t, c, "G1 F60\n")
	writeCtrlMulti(t, c, "X5\n")
	if _, err := c.Write(protocol.FeedHold()); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for len(m.Controls()) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}

	snap := m.Snapshot()
	if snap.Status.State != machine.Hold {
		t.Fatalf("snapshot state = %s, want Hold", snap.Status.State)
	}
	if !snap.HoldActive {
		t.Fatal("snapshot did not report hold_active")
	}
	if snap.Modal.DistanceMode != "G91" || snap.Modal.Motion != "G1" || snap.Modal.FeedMMMin != 60 {
		t.Fatalf("snapshot modal = %+v", snap.Modal)
	}
	if len(snap.Motion) == 0 {
		t.Fatal("snapshot missing queued motion segment")
	}
	if len(snap.Files) != 1 || snap.Files[0].Path != "/sd/gcodes/visual.nc" || snap.Files[0].Size != len("G1 X2\n") {
		t.Fatalf("snapshot files = %+v", snap.Files)
	}
	if snap.Ftype != "lz" || !snap.CompressDownloads {
		t.Fatalf("snapshot transfer features = ftype %q compress %v", snap.Ftype, snap.CompressDownloads)
	}
	if len(snap.Controls) != 1 || snap.Controls[0].Byte != protocol.CtrlFeedHold {
		t.Fatalf("snapshot controls = %+v", snap.Controls)
	}
}

func dialFakeMachine(t *testing.T, m *FakeMachine) net.Conn {
	t.Helper()
	c, err := net.Dial("tcp", m.Addr())
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func dialFakeClient(t *testing.T, m *FakeMachine) *client.Conn {
	t.Helper()
	conn, err := client.Dial(m.Addr(), time.Second, client.WithUploadStartDelay(0))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func loadProbeModelAt(t *testing.T, m *FakeMachine, name string, data []byte, xMin, yMin, topZ float64) {
	t.Helper()
	if err := m.LoadProbeModel(name, data); err != nil {
		t.Fatal(err)
	}
	if _, err := m.SetModelPlacement(ModelPlacementUpdate{
		XMinMM: &xMin,
		YMinMM: &yMin,
		TopZMM: &topZ,
	}); err != nil {
		t.Fatal(err)
	}
}

func uploadFakeContent(t *testing.T, conn *client.Conn, path string, content []byte) {
	t.Helper()
	if err := conn.Upload(path, bytes.NewReader(content), int64(len(content)), md5String(content), time.Second, nil); err != nil {
		t.Fatalf("upload %s: %v", path, err)
	}
}

func md5String(content []byte) string {
	sum := md5.Sum(content)
	return hex.EncodeToString(sum[:])
}

func testPlaneSTL(z float64) string {
	return strings.Join([]string{
		"solid plate",
		"facet normal 0 0 1",
		"outer loop",
		"vertex 0 0 " + strconvFloat(z),
		"vertex 10 0 " + strconvFloat(z),
		"vertex 10 10 " + strconvFloat(z),
		"endloop",
		"endfacet",
		"facet normal 0 0 1",
		"outer loop",
		"vertex 0 0 " + strconvFloat(z),
		"vertex 10 10 " + strconvFloat(z),
		"vertex 0 10 " + strconvFloat(z),
		"endloop",
		"endfacet",
		"endsolid plate",
	}, "\n")
}

func testStackedPlaneSTL(zs ...float64) string {
	lines := []string{"solid stack"}
	for _, z := range zs {
		lines = append(lines,
			"facet normal 0 0 1",
			"outer loop",
			"vertex 0 0 "+strconvFloat(z),
			"vertex 10 0 "+strconvFloat(z),
			"vertex 10 10 "+strconvFloat(z),
			"endloop",
			"endfacet",
			"facet normal 0 0 1",
			"outer loop",
			"vertex 0 0 "+strconvFloat(z),
			"vertex 10 10 "+strconvFloat(z),
			"vertex 0 10 "+strconvFloat(z),
			"endloop",
			"endfacet",
		)
	}
	lines = append(lines, "endsolid stack")
	return strings.Join(lines, "\n")
}

func testSlopedPlaneSTL(xMin, xMax, yMin, yMax, zAtXMin, zAtXMax float64) string {
	v := []fakeVec3{
		{xMin, yMin, zAtXMin},
		{xMax, yMin, zAtXMax},
		{xMax, yMax, zAtXMax},
		{xMin, yMax, zAtXMin},
	}
	faces := [][3]int{{0, 1, 2}, {0, 2, 3}}
	lines := []string{"solid slope"}
	for _, f := range faces {
		lines = append(lines,
			"facet normal 0 0 0",
			"outer loop",
			"vertex "+strconvFloat(v[f[0]].X)+" "+strconvFloat(v[f[0]].Y)+" "+strconvFloat(v[f[0]].Z),
			"vertex "+strconvFloat(v[f[1]].X)+" "+strconvFloat(v[f[1]].Y)+" "+strconvFloat(v[f[1]].Z),
			"vertex "+strconvFloat(v[f[2]].X)+" "+strconvFloat(v[f[2]].Y)+" "+strconvFloat(v[f[2]].Z),
			"endloop",
			"endfacet",
		)
	}
	lines = append(lines, "endsolid slope")
	return strings.Join(lines, "\n")
}

func testBlockSTL(xMin, xMax, yMin, yMax, zMin, zMax float64) string {
	v := []fakeVec3{
		{xMin, yMin, zMin}, {xMax, yMin, zMin}, {xMax, yMax, zMin}, {xMin, yMax, zMin},
		{xMin, yMin, zMax}, {xMax, yMin, zMax}, {xMax, yMax, zMax}, {xMin, yMax, zMax},
	}
	faces := [][3]int{
		{4, 5, 6}, {4, 6, 7},
		{0, 2, 1}, {0, 3, 2},
		{0, 1, 5}, {0, 5, 4},
		{1, 2, 6}, {1, 6, 5},
		{2, 3, 7}, {2, 7, 6},
		{3, 0, 4}, {3, 4, 7},
	}
	lines := []string{"solid block"}
	for _, f := range faces {
		lines = append(lines,
			"facet normal 0 0 0",
			"outer loop",
			"vertex "+strconvFloat(v[f[0]].X)+" "+strconvFloat(v[f[0]].Y)+" "+strconvFloat(v[f[0]].Z),
			"vertex "+strconvFloat(v[f[1]].X)+" "+strconvFloat(v[f[1]].Y)+" "+strconvFloat(v[f[1]].Z),
			"vertex "+strconvFloat(v[f[2]].X)+" "+strconvFloat(v[f[2]].Y)+" "+strconvFloat(v[f[2]].Z),
			"endloop",
			"endfacet",
		)
	}
	lines = append(lines, "endsolid block")
	return strings.Join(lines, "\n")
}

func testTriangleGLTF(t *testing.T) []byte {
	t.Helper()
	bin := testTriangleGLTFBIN()
	uri := "data:application/octet-stream;base64," + base64.StdEncoding.EncodeToString(bin)
	return testTriangleGLTFJSON(strconvQuote(uri))
}

func testTriangleGLTFJSON(bufferURI string) []byte {
	json := `{
		"asset":{"version":"2.0"},
		"buffers":[{` + bufferURIField(bufferURI) + `"byteLength":42}],
		"bufferViews":[{"buffer":0,"byteOffset":0,"byteLength":36},{"buffer":0,"byteOffset":36,"byteLength":6}],
		"accessors":[
			{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3"},
			{"bufferView":1,"componentType":5123,"count":3,"type":"SCALAR"}
		],
		"meshes":[{"primitives":[{"attributes":{"POSITION":0},"indices":1}]}],
		"nodes":[{"mesh":0}],
		"scenes":[{"nodes":[0]}],
		"scene":0
	}`
	return []byte(json)
}

func testTriangleGLB(t *testing.T) []byte {
	t.Helper()
	jsonChunk := pad4(testTriangleGLTFJSON(""))
	binChunk := pad4(testTriangleGLTFBIN())
	total := 12 + 8 + len(jsonChunk) + 8 + len(binChunk)
	var out bytes.Buffer
	out.Write([]byte{'g', 'l', 'T', 'F'})
	binary.Write(&out, binary.LittleEndian, uint32(2))
	binary.Write(&out, binary.LittleEndian, uint32(total))
	binary.Write(&out, binary.LittleEndian, uint32(len(jsonChunk)))
	binary.Write(&out, binary.LittleEndian, uint32(0x4e4f534a))
	out.Write(jsonChunk)
	binary.Write(&out, binary.LittleEndian, uint32(len(binChunk)))
	binary.Write(&out, binary.LittleEndian, uint32(0x004e4942))
	out.Write(binChunk)
	return out.Bytes()
}

func bufferURIField(uri string) string {
	if uri == "" {
		return ""
	}
	return `"uri":` + uri + `,`
}

func testTriangleGLTFBIN() []byte {
	var b bytes.Buffer
	for _, f := range []float32{0, 0, -4, 1, 0, -4, 0, 1, -4} {
		binary.Write(&b, binary.LittleEndian, f)
	}
	for _, idx := range []uint16{0, 1, 2} {
		binary.Write(&b, binary.LittleEndian, idx)
	}
	return b.Bytes()
}

func pad4(in []byte) []byte {
	out := append([]byte(nil), in...)
	for len(out)%4 != 0 {
		out = append(out, ' ')
	}
	return out
}

func strconvFloat(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}

func strconvQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func writeCtrlMulti(t *testing.T, c net.Conn, line string) {
	t.Helper()
	if _, err := c.Write(protocol.Encode(protocol.CmdCtrlMulti, []byte(line))); err != nil {
		t.Fatal(err)
	}
}

func queryFakeStatus(t *testing.T, c net.Conn) machine.Status {
	t.Helper()
	if _, err := c.Write(protocol.QueryStatus()); err != nil {
		t.Fatal(err)
	}
	var scan protocol.Scanner
	buf := make([]byte, 1024)
	deadline := time.Now().Add(time.Second)
	for {
		if err := c.SetReadDeadline(deadline); err != nil {
			t.Fatal(err)
		}
		n, err := c.Read(buf)
		if err != nil {
			t.Fatal(err)
		}
		for _, f := range scan.Push(buf[:n]) {
			if f.Cmd != protocol.CmdStatusRes {
				continue
			}
			st, ok := machine.ParseStatusPayload(string(f.Data))
			if !ok {
				t.Fatalf("malformed status payload %q", string(f.Data))
			}
			return st
		}
	}
}

func waitForFakeState(t *testing.T, c net.Conn, want machine.State, timeout time.Duration) machine.Status {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var st machine.Status
	for time.Now().Before(deadline) {
		st = queryFakeStatus(t, c)
		if st.State == want {
			return st
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("state = %s, want %s", st.State, want)
	return st
}

func stockHeightNearest(stock StockState, x, y float64) float64 {
	xi := int(math.Round((x - stock.XMin) / stock.StepX))
	yi := int(math.Round((y - stock.YMin) / stock.StepY))
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

func waitForProbeLaser(t *testing.T, m *FakeMachine, want bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if got := m.Snapshot().ProbeLaserActive; got == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("probe laser active = %v, want %v", m.Snapshot().ProbeLaserActive, want)
}

func readFakeFrame(t *testing.T, c net.Conn) protocol.Frame {
	t.Helper()
	var scan protocol.Scanner
	buf := make([]byte, 1024)
	deadline := time.Now().Add(time.Second)
	for {
		if err := c.SetReadDeadline(deadline); err != nil {
			t.Fatal(err)
		}
		n, err := c.Read(buf)
		if err != nil {
			t.Fatal(err)
		}
		if n == 0 {
			continue
		}
		frames := scan.Push(buf[:n])
		if len(frames) > 0 {
			return frames[0]
		}
	}
}

func assertAxis(t *testing.T, vals machine.AxisValues, axis string, want float64) {
	t.Helper()
	got, ok := vals[axis]
	if !ok {
		t.Fatalf("axis %s missing from %+v", axis, vals)
	}
	if math.Abs(got-want) > 0.0001 {
		t.Fatalf("axis %s = %v, want %v (all axes %+v)", axis, got, want, vals)
	}
}

func TestFakeSuspendResumeRestoresPositionAndDistanceMode(t *testing.T) {
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	m.SetStatus("<Run|MPos:0,0,-10|WPos:0,0,-10|S:12000,12000,100>")
	c, err := client.Dial(m.Addr(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	console := func(line string) {
		t.Helper()
		if _, err := c.SendConsoleCommand(line, client.GcodeOpts{ExpectReply: true, Cap: time.Second}); err != nil {
			t.Fatal(err)
		}
	}
	gcode := func(line string) {
		t.Helper()
		if _, err := c.SendGcodeLine(line, client.GcodeOpts{ExpectReply: false, Cap: time.Second}); err != nil {
			t.Fatal(err)
		}
	}
	waitZ := func(z float64) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			raw, err := c.QueryState(time.Second)
			if err != nil {
				t.Fatal(err)
			}
			st, ok := machine.ParseStatusPayload(raw)
			if ok && math.Abs(st.MPos["z"]-z) < 0.001 {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatalf("never reached Z=%v", z)
	}
	console("suspend")
	gcode("G91 G0 Z5")
	waitZ(-5)
	gcode("M5")
	gcode("M3 S12000")
	console("resume")
	waitZ(-10)
	// The manually-selected relative mode must not leak back into the job.
	gcode("G0 Z-8")
	waitZ(-8)
}
