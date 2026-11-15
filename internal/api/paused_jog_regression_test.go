package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/uwin/cnc-proxy/internal/jog"
	"github.com/uwin/cnc-proxy/internal/service"
)

// Real HTTP and WebSocket routes, serialized arbiter and framed TCP fake:
// suspend -> jog in Pause -> stop -> separate start -> resume saved XYZ.
func TestPausedJobJogStopStartResume(t *testing.T) {
	srv, m, tr, svc := serverWithJogState(t, false)
	if _, err := svc.SendGcode("M3 S12000"); err != nil {
		t.Fatal(err)
	}
	raw := "<Run|MPos:1,2,-10|WPos:1,2,-10|S:12000,12000,100|P:10,20,1>"
	m.SetStatus(raw)
	m.SetSilentJobControl(true)
	tr.ObserveStatusPayload(raw)
	action := func(path, body string, want int) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		req, _ := http.NewRequestWithContext(ctx, "POST", srv.URL+path, bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s blocked: %v", body, err)
		}
		defer resp.Body.Close()
		data, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != want {
			t.Fatalf("%s HTTP %d: %s", body, resp.StatusCode, data)
		}
	}
	machineStatus := func() service.MachineStatus {
		t.Helper()
		resp := get(t, srv.URL+"/api/machine")
		defer resp.Body.Close()
		var st service.MachineStatus
		if err := json.NewDecoder(resp.Body).Decode(&st); err != nil {
			t.Fatal(err)
		}
		return st
	}
	action("/api/control", `{"action":"pause_job"}`, http.StatusAccepted)
	c := dialWS(t, srv.URL)
	defer c.Close(websocket.StatusNormalClosure, "")
	hello := readWSEvent(t, c, "hello")
	if !hello.Capabilities.Availability.Available {
		t.Fatalf("Pause availability: %+v", hello)
	}
	arm := func(seq int) {
		t.Helper()
		writeWS(t, c, map[string]any{"type": "arm", "seq": seq})
		readWSEvent(t, c, "ack")
		readWSStateWhere(t, c, func(ev jog.Event) bool { return ev.Armed != nil && *ev.Armed })
	}
	arm(1)
	writeWS(t, c, map[string]any{"type": "step", "seq": 2, "axis": "z", "distance": 10})
	step := readWSEvent(t, c, "ack")
	if math.Abs(step.Target["z"]) > .001 {
		t.Fatalf("step target %+v", step.Target)
	}
	// The lease is still armed. HTTP must wait for motion and release it before M5.
	action("/api/gcode/active/paused-command", `{"action":"stop_spindle"}`, http.StatusOK)
	readWSStateWhere(t, c, func(ev jog.Event) bool { return ev.Armed != nil && !*ev.Armed })
	stopped := machineStatus()
	if math.Abs(stopped.MPos["z"]) > .001 || stopped.Spindle.CurrentRPM != 0 || stopped.Spindle.TargetRPM != 12000 {
		t.Fatalf("stopped before jog finished or lost setpoint: %+v", stopped)
	}
	if !stopped.JobControl.CanStartSpindle || stopped.JobControl.CanResume || stopped.JobControl.CanStopSpindle {
		t.Fatalf("stopped button contract %+v", stopped.JobControl)
	}
	action("/api/control", `{"action":"resume_job"}`, http.StatusConflict)
	if slices.Contains(m.Gcodes(), "resume") {
		t.Fatal("resumed without separate Start spindle")
	}
	// Jogging also works with spindle off, including fine steps.
	arm(3)
	writeWS(t, c, map[string]any{"type": "step", "seq": 4, "axis": "x", "distance": .01})
	readWSEvent(t, c, "ack")
	action("/api/gcode/active/paused-command", `{"action":"start_spindle","direction":"M3","speed_rpm":12000}`, http.StatusOK)
	started := machineStatus()
	if !started.JobControl.CanResume || started.Spindle.CurrentRPM != 12000 {
		t.Fatalf("started %+v", started)
	}
	// Resume also releases an armed lease, even without a motion request.
	arm(5)
	action("/api/control", `{"action":"resume_job"}`, http.StatusAccepted)
	st := machineStatus()
	if math.Abs(st.MPos["z"]+10) > .001 || math.Abs(st.MPos["x"]-1) > .001 || math.Abs(st.MPos["y"]-2) > .001 {
		t.Fatalf("saved position not restored: %+v", st.MPos)
	}
}
