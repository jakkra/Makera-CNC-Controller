package attention

import (
	"bufio"
	"encoding/json"
	"io"
	"math"
	"strings"
)

const markerPrefix = "(@z1-attention "

// ParseGcodeMarkers extracts bounded, validated attention metadata from G-code
// comments. Malformed or unknown markers are ignored; ordinary G-code is never
// interpreted or modified.
func ParseGcodeMarkers(r io.Reader, maxMarkers int) []Marker {
	if maxMarkers <= 0 {
		maxMarkers = 100
	}
	var out []Marker
	scanner := bufio.NewScanner(r)
	// Post output lines are normally tiny, but tolerate descriptive metadata
	// without accepting unbounded scanner allocation.
	scanner.Buffer(make([]byte, 4096), 64<<10)
	lineNumber := 0
	for scanner.Scan() {
		lineNumber++
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, markerPrefix) || !strings.HasSuffix(line, ")") {
			continue
		}
		raw := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(line, markerPrefix), ")"))
		var marker Marker
		if err := json.Unmarshal([]byte(raw), &marker); err != nil || !validMarker(marker) {
			continue
		}
		marker.Line = int64(lineNumber)
		marker.Axis = strings.ToUpper(strings.TrimSpace(marker.Axis))
		marker.Operation = truncate(strings.TrimSpace(marker.Operation), 120)
		marker.Instruction = truncate(strings.TrimSpace(marker.Instruction), 240)
		out = append(out, marker)
		if len(out) >= maxMarkers {
			break
		}
	}
	return out
}

func validMarker(marker Marker) bool {
	if marker.Type != string(KindRotaryIndex) {
		return false
	}
	if strings.ToUpper(strings.TrimSpace(marker.Axis)) != "A" || marker.Target == nil {
		return false
	}
	return !math.IsNaN(*marker.Target) && !math.IsInf(*marker.Target, 0) && *marker.Target >= -36000 && *marker.Target <= 36000
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}
