package service

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/uwin/cnc-proxy/internal/machine"
	"github.com/uwin/cnc-proxy/internal/store"
)

func TestAlignmentSetupChecksCapturedWorkZeroAndTool(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "alignment-holes-test.nc")
	program := "; Sensei alignment setup v1 3 41.0000 -180.0000 -150.0000 -50.0000\nG21\n"
	if err := os.WriteFile(filename, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	setup, err := readAlignmentSetup(store.Entry{CachePath: filename, CacheState: store.CacheReady})
	if err != nil {
		t.Fatal(err)
	}
	status := machine.Status{
		State: machine.Idle, Fields: map[string]string{"R": "0"}, Tool: &machine.ToolStatus{Active: 3, Offset: 41},
		MPos: machine.AxisValues{"x": -90, "y": -120, "z": -10},
		WPos: machine.AxisValues{"x": 90, "y": 30, "z": 40},
	}
	if err := setup.verify(status); err != nil {
		t.Fatal(err)
	}
	status.WPos["z"]++
	if err := setup.verify(status); err == nil || !strings.Contains(err.Error(), "work zero") {
		t.Fatalf("changed work zero: %v", err)
	}
	status.WPos["z"]--
	status.Tool.Offset++
	if err := setup.verify(status); err == nil || !strings.Contains(err.Error(), "calibrated tool") {
		t.Fatalf("changed tool offset: %v", err)
	}
	status.Tool.Offset--
	status.Fields["R"] = "1"
	if err := setup.verify(status); err == nil || !strings.Contains(err.Error(), "rotation") {
		t.Fatalf("changed rotation: %v", err)
	}
}
