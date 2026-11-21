package service

import (
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/uwin/cnc-proxy/internal/machine"
)

// fusionSetupPause mirrors the Fusion plugin's "pause before each setup"
// output: M600 precedes the tool change and the spindle start.
const fusionSetupPause = "G90 G94\nG17\nG21\nM600\n\nT4M6 \n(5)\nM400\nM851 S100\nS12000 M3\nG54\nG0 A0.\nG0 X1 Y1\nG1 Z-1 F100\nX2\n"

func TestProgramRestartsSpindleAfterPause(t *testing.T) {
	for _, tc := range []struct {
		name string
		src  string
		line int64
		want bool
	}{
		{"fusion setup pause at pause line", fusionSetupPause, 4, true},
		{"fusion setup pause progress past pause", fusionSetupPause, 6, true},
		{"rapids and tool change before M3", "M600\nG53 G0 Z-3\nG0 A90\nT2M6\nM3 S9000\nG1 X1 F100\n", 1, true},
		{"feed move before spindle start", "M600\nG1 X1 F100\nM3 S9000\n", 1, false},
		{"modal feed move before spindle start", "G1 X0 F100\nM600\nX1 Y1\nM3 S9000\n", 2, false},
		{"unknown modal treated as feed", "M600\nX1\nM3 S9000\n", 1, false},
		{"probe before spindle start", "M600\nG38.2 Z-10 F50\nM3 S9000\n", 1, false},
		{"program ends without cutting", "M600\nG0 Z10\nM30\n", 1, true},
		{"operator pause mid cut", "M3 S12000\nG1 X0 F100\nX1\nX2\nX3\nX4\nX5\nX6\nX7\nX8\nX9\nX10\nX11\nX12\n", 10, false},
		{"line beyond file", "M600\n", 50, false},
	} {
		got, err := programRestartsSpindleAfterPause(strings.NewReader(tc.src), tc.line)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if got != tc.want {
			t.Fatalf("%s: got %v want %v", tc.name, got, tc.want)
		}
	}
}

func TestProgramPauseBeforeSpindleStartCanResume(t *testing.T) {
	svc, m, _ := serviceWithMachine(t)
	if _, err := svc.Upload("setup-pause.cnc", strings.NewReader(fusionSetupPause)); err != nil {
		t.Fatal(err)
	}
	if err := svc.store.SetActiveGcodePath("/sd/gcodes/setup-pause.cnc"); err != nil {
		t.Fatal(err)
	}
	// The player has reached the M600 on line 4; the spindle never started.
	m.SetStatus("<Run|MPos:10,20,-10|WPos:1,2,-3|S:0,0,100|P:4,30,5>")
	if paused, err := svc.PauseJob(); err != nil || paused.State != machine.Pause {
		t.Fatalf("pause: %+v %v", paused, err)
	}
	if control := svc.Status().JobControl; !control.Paused || !control.CanResume {
		t.Fatalf("program pause before spindle start: %+v, want resumable", control)
	}
	resumed, err := svc.ResumeJob()
	if err != nil || !resumed.Verified || resumed.State != machine.Run {
		t.Fatalf("resume: %+v %v", resumed, err)
	}
	if !slices.Contains(m.Gcodes(), "resume") {
		t.Fatal("resume did not reach firmware")
	}
}

func TestPauseBeforeFeedMoveStillRequiresSpindle(t *testing.T) {
	svc, m, _ := serviceWithMachine(t)
	src := "M3 S12000\nG1 X0 F100\nX1\nX2\nX3\nX4\nX5\nX6\nX7\nX8\nX9\nX10\n"
	if _, err := svc.Upload("mid-cut.cnc", strings.NewReader(src)); err != nil {
		t.Fatal(err)
	}
	if err := svc.store.SetActiveGcodePath("/sd/gcodes/mid-cut.cnc"); err != nil {
		t.Fatal(err)
	}
	m.SetStatus("<Run|MPos:10,20,-10|WPos:1,2,-3|S:0,12000,100|P:8,30,5>")
	if paused, err := svc.PauseJob(); err != nil || paused.State != machine.Pause {
		t.Fatalf("pause: %+v %v", paused, err)
	}
	if control := svc.Status().JobControl; control.CanResume {
		t.Fatalf("mid-cut pause with stopped spindle: %+v, want not resumable", control)
	}
	if _, err := svc.ResumeJob(); !errors.Is(err, ErrJobControlUnavailable) {
		t.Fatalf("mid-cut resume: %v", err)
	}
	if slices.Contains(m.Gcodes(), "resume") {
		t.Fatal("resume reached firmware with spindle stopped mid-cut")
	}
}
