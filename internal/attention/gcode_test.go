package attention

import (
	"strings"
	"testing"
)

func TestParseGcodeMarkers(t *testing.T) {
	gcode := strings.Join([]string{
		"G21",
		`(@z1-attention {"type":"rotary_index","axis":"A","target":90,"operation":"Side two","instruction":"Inspect clearance, then resume"})`,
		"M600",
		"G90 G54 G0 A90",
	}, "\n")
	markers := ParseGcodeMarkers(strings.NewReader(gcode), 10)
	if len(markers) != 1 {
		t.Fatalf("markers = %+v", markers)
	}
	marker := markers[0]
	if marker.Type != "rotary_index" || marker.Axis != "A" || marker.Target == nil || *marker.Target != 90 || marker.Operation != "Side two" || marker.Line != 2 {
		t.Fatalf("marker = %+v", marker)
	}
}

func TestParseGcodeMarkersRejectsMalformedAndUnknown(t *testing.T) {
	gcode := strings.Join([]string{
		`(@z1-attention nope)`,
		`(@z1-attention {"type":"run_command","axis":"A","target":90})`,
		`(@z1-attention {"type":"rotary_index","axis":"X","target":90})`,
		`(@z1-attention {"type":"rotary_index","axis":"A"})`,
	}, "\n")
	if markers := ParseGcodeMarkers(strings.NewReader(gcode), 10); len(markers) != 0 {
		t.Fatalf("unexpected markers = %+v", markers)
	}
}

func TestParseGcodeMarkersHonorsBound(t *testing.T) {
	line := `(@z1-attention {"type":"rotary_index","axis":"A","target":10})`
	markers := ParseGcodeMarkers(strings.NewReader(line+"\n"+line+"\n"+line), 2)
	if len(markers) != 2 {
		t.Fatalf("markers = %d, want 2", len(markers))
	}
}
