package service

import (
	"bufio"
	"io"
	"strconv"
	"strings"

	"github.com/uwin/cnc-proxy/internal/machine"
)

// Program-authored pauses (M0/M1/M600) commonly sit before a tool change and
// spindle start: the Fusion plugin's "pause before each setup" writes M600
// ahead of `T<n>M6 … S<rpm> M3`. Resuming such a pause cannot cut with a
// stopped spindle, because the program itself starts the spindle before its
// next feed move. The spindle-ready resume gate exists to protect an operator
// pause that interrupted a cut, so it is relaxed only when the active program
// provably restarts the spindle first.

const (
	// pausedScanLookback is how many lines before the reported player line
	// may hold the pause code itself. The firmware stops reading at the pause
	// line, but this keeps the scan robust to an off-by-a-few progress value.
	pausedScanLookback = 8
	// pausedScanMaxLines bounds the forward scan. A program that has not
	// started the spindle within this many lines is treated as unsafe.
	pausedScanMaxLines = 2000
)

type pausedSpindleScanKey struct {
	path   string
	line   int64
	source string
}

// pausedProgramRestartsSpindle reports whether the active job, from the
// player's current paused line, starts the spindle before any feed motion.
// Results are memoized per job/line/cache identity so per-status snapshots do
// not reread the G-code.
func (s *Service) pausedProgramRestartsSpindle(st machine.Status) bool {
	if st.State != machine.Pause || len(st.Progress) == 0 || !finite(st.Progress[0]) {
		return false
	}
	line := int64(st.Progress[0])
	if line <= 0 {
		return false
	}
	path := strings.TrimSpace(s.store.ActiveGcodePath())
	if path == "" {
		return false
	}
	key := pausedSpindleScanKey{path: path, line: line, source: s.attentionMarkerSource(path)}

	s.pausedSpindleScanMu.Lock()
	if s.pausedSpindleScanValid && s.pausedSpindleScanKey == key {
		result := s.pausedSpindleScanResult
		s.pausedSpindleScanMu.Unlock()
		return result
	}
	s.pausedSpindleScanMu.Unlock()

	result := false
	if rc, _, err := s.ReadCache(path); err == nil {
		result, err = programRestartsSpindleAfterPause(rc, line)
		rc.Close()
		if err != nil {
			result = false
		}
	} else {
		// Do not memoize a missing/validating cache; it may become readable.
		return false
	}

	s.pausedSpindleScanMu.Lock()
	s.pausedSpindleScanKey = key
	s.pausedSpindleScanResult = result
	s.pausedSpindleScanValid = true
	s.pausedSpindleScanMu.Unlock()
	return result
}

// programRestartsSpindleAfterPause scans forward from the pause near
// pausedLine (1-based). It returns true only when M3/M4 appears before any
// feed/probe motion, or when the program reaches another pause or its end
// without moving at feed. Unknown modal motion is treated as feed.
func programRestartsSpindleAfterPause(r io.Reader, pausedLine int64) (bool, error) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)

	windowStart := pausedLine - pausedScanLookback
	windowEnd := pausedLine + 2
	var window []string
	var windowFirst int64
	lineNo := int64(0)
	for lineNo < windowEnd && scanner.Scan() {
		lineNo++
		if lineNo >= windowStart {
			if window == nil {
				windowFirst = lineNo
			}
			window = append(window, scanner.Text())
		}
	}
	if err := scanner.Err(); err != nil {
		return false, err
	}
	if lineNo < pausedLine {
		return false, nil
	}

	// Start after the last pause code in the window; otherwise after the
	// reported line itself.
	startIdx := int(pausedLine - windowFirst + 1)
	for i := len(window) - 1; i >= 0; i-- {
		if gcodeLineIsPause(parseGcodeLineWords(window[i])) {
			startIdx = i + 1
			break
		}
	}

	feedModal := true // unknown modal motion is treated as feed
	scanned := 0
	visit := func(text string) (decided, result bool) {
		scanned++
		w := parseGcodeLineWords(text)
		for _, m := range w.m {
			switch m {
			case 3, 4:
				return true, true
			case 0, 1, 2, 30, 600:
				return true, true
			}
		}
		for _, g := range w.g {
			switch {
			case g == 0:
				feedModal = false
			case g == 1 || g == 2 || g == 3:
				feedModal = true
			case g >= 38 && g < 39:
				return true, false
			}
		}
		if w.hasAxis && feedModal && !w.nonModalRapid {
			return true, false
		}
		return false, false
	}
	for i := startIdx; i < len(window); i++ {
		if decided, result := visit(window[i]); decided {
			return result, nil
		}
	}
	for scanned < pausedScanMaxLines && scanner.Scan() {
		if decided, result := visit(scanner.Text()); decided {
			return result, nil
		}
	}
	if err := scanner.Err(); err != nil {
		return false, err
	}
	// End of file without any feed move: nothing left to cut.
	return scanned < pausedScanMaxLines, nil
}

type gcodeLineWords struct {
	g       []float64
	m       []int
	hasAxis bool
	// nonModalRapid is set for G28/G30/G53 lines that carry an explicit G0 or
	// home move; G28/G30 always travel at rapid.
	nonModalRapid bool
}

func gcodeLineIsPause(w gcodeLineWords) bool {
	for _, m := range w.m {
		if m == 0 || m == 1 || m == 600 {
			return true
		}
	}
	return false
}

func parseGcodeLineWords(line string) gcodeLineWords {
	if i := strings.IndexAny(line, ";("); i >= 0 {
		line = line[:i]
	}
	line = strings.ToUpper(line)
	var w gcodeLineWords
	for i := 0; i < len(line); {
		letter := line[i]
		if letter < 'A' || letter > 'Z' {
			i++
			continue
		}
		start := i + 1
		i = start
		for i < len(line) && line[i] == ' ' {
			i++
		}
		numStart := i
		if i < len(line) && (line[i] == '+' || line[i] == '-') {
			i++
		}
		for i < len(line) && ((line[i] >= '0' && line[i] <= '9') || line[i] == '.') {
			i++
		}
		if numStart == i {
			continue
		}
		value, err := strconv.ParseFloat(line[numStart:i], 64)
		if err != nil || !finite(value) {
			continue
		}
		switch letter {
		case 'G':
			w.g = append(w.g, value)
			if value == 28 || value == 30 {
				w.nonModalRapid = true
			}
		case 'M':
			w.m = append(w.m, int(value))
		case 'X', 'Y', 'Z', 'A', 'B', 'C':
			w.hasAxis = true
		}
	}
	return w
}
