package service

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/uwin/cnc-proxy/internal/client"
	"github.com/uwin/cnc-proxy/internal/filepolicy"
	"github.com/uwin/cnc-proxy/internal/gcodelog"
	"github.com/uwin/cnc-proxy/internal/machine"
	"github.com/uwin/cnc-proxy/internal/protocol"
	"github.com/uwin/cnc-proxy/internal/session"
	"github.com/uwin/cnc-proxy/internal/store"
)

const (
	previewArcSegment = 0.5
	previewArcError   = 0.01

	maxPreviewOverviewSegments = 4000
	maxGcodeSegmentWindow      = 10000
	maxGcodeSourceWindow       = 1000

	activeGcodeProbeInterval = 5 * time.Second
	activePlaybackTimeout    = 2 * time.Second
)

var errMachineProgressUnsupported = errors.New("service: machine does not support the progress command")

type activeGcodeState struct {
	Path          string
	Preview       GcodePreview
	SourceOffsets []int64
	SelectedAt    time.Time
}

// ActiveGcode is the currently selected file and its cached preview.
type ActiveGcode struct {
	Path      string        `json:"path,omitempty"`
	Entry     *store.Entry  `json:"entry,omitempty"`
	Preview   *GcodePreview `json:"preview,omitempty"`
	Runnable  bool          `json:"runnable"`
	Message   string        `json:"message,omitempty"`
	UpdatedAt time.Time     `json:"updated_at,omitempty"`
}

// GcodePreview is a 3D/4-axis toolpath summary. Full geometry stays server-side
// and is exposed through bounded windows; OverviewSegments is a small complete
// path used by the recording dashboard.
type GcodePreview struct {
	LineCount        int            `json:"line_count"`
	MoveCount        int            `json:"move_count"`
	PlottedSegments  int            `json:"plotted_segments"`
	Truncated        bool           `json:"truncated"`
	TotalDistance    float64        `json:"total_distance"`
	Has4Axis         bool           `json:"has_4axis"`
	Bounds           *GcodeBounds   `json:"bounds,omitempty"`
	Tools            []int          `json:"tools,omitempty"`
	Segments         []GcodeSegment `json:"segments,omitempty"`
	OverviewSegments []GcodeSegment `json:"overview_segments,omitempty"`
}

type GcodeSegmentWindow struct {
	Start    int            `json:"start"`
	Total    int            `json:"total"`
	Segments []GcodeSegment `json:"segments"`
}

type GcodeSourceWindow struct {
	StartLine  int      `json:"start_line"`
	TotalLines int      `json:"total_lines"`
	Lines      []string `json:"lines"`
}

type GcodeBounds struct {
	Min  [3]float64 `json:"min"`
	Max  [3]float64 `json:"max"`
	MinA float64    `json:"min_a,omitempty"`
	MaxA float64    `json:"max_a,omitempty"`
}

type GcodeSegment struct {
	Kind          string     `json:"kind"`
	Line          int        `json:"line"`
	Tool          int        `json:"tool,omitempty"`
	From          [4]float64 `json:"from"`
	To            [4]float64 `json:"to"`
	DistanceStart float64    `json:"distance_start"`
	DistanceEnd   float64    `json:"distance_end"`
}

// MachineActionResult is returned by synchronous machine-action endpoints.
type MachineActionResult struct {
	Action   string             `json:"action"`
	Path     string             `json:"path,omitempty"`
	ToolID   int                `json:"tool_id,omitempty"`
	Command  string             `json:"command,omitempty"`
	Output   string             `json:"output,omitempty"`
	Message  string             `json:"message"`
	Verified bool               `json:"verified"`
	Machine  machine.AxisValues `json:"machine,omitempty"`
}

// ActiveGcode returns the current proxy-side file selection.
func (s *Service) ActiveGcode() ActiveGcode {
	s.activeMu.Lock()
	active := s.activeGcode
	s.activeMu.Unlock()
	storedPath := s.store.ActiveGcodePath()
	if storedPath == "" {
		if active.Path != "" {
			s.clearActiveGcode(active.Path)
		}
		return ActiveGcode{Message: "No active gcode selected."}
	}
	if active.Path == "" || active.Path != storedPath {
		return s.activeGcodeFromStoredPath(storedPath)
	}
	entry, ok := s.store.GetEntry(active.Path)
	if !ok {
		s.clearActiveGcode(active.Path)
		return ActiveGcode{Message: "No active gcode selected."}
	}
	return s.activeGcodeSnapshot(active, entry)
}

func (s *Service) activeGcodeFromStoredPath(remotePath string) ActiveGcode {
	entry, ok := s.store.GetEntry(remotePath)
	if !ok {
		s.clearActiveGcode(remotePath)
		return ActiveGcode{Message: "No active gcode selected."}
	}
	if !entry.IsDir {
		rc, cacheEntry, err := s.ReadCache(remotePath)
		if err == nil {
			defer rc.Close()
			preview, offsets, err := parseGcodePreview(rc)
			if err == nil {
				active := activeGcodeState{Path: cacheEntry.Path, Preview: preview, SourceOffsets: offsets, SelectedAt: time.Now()}
				s.activeMu.Lock()
				// The persisted selection is authoritative. In particular, firmware
				// playback discovery can replace a previously selected file while its
				// parsed preview is still resident in memory. Only publish the parse if
				// the selection did not change again while the cache was being read.
				if s.store.ActiveGcodePath() == active.Path {
					s.activeGcode = active
				}
				s.activeMu.Unlock()
				return s.activeGcodeSnapshot(active, cacheEntry)
			}
		}
	}
	entryCopy := entry
	runnable, message := runnableGcode(entry)
	return ActiveGcode{
		Path:      entry.Path,
		Entry:     &entryCopy,
		Runnable:  runnable,
		Message:   message,
		UpdatedAt: time.Time{},
	}
}

func (s *Service) clearActiveGcode(remotePath string) {
	s.activeMu.Lock()
	if s.activeGcode.Path == remotePath {
		s.activeGcode = activeGcodeState{}
	}
	s.activeMu.Unlock()
	if s.store.ActiveGcodePath() == remotePath {
		_ = s.store.SetActiveGcodePath("")
	}
}

// SelectActiveGcode selects a catalog file and parses a preview from its local
// cache, fetching remote-only files through the existing download-on-demand path.
func (s *Service) SelectActiveGcode(remotePath string) (ActiveGcode, error) {
	rc, entry, err := s.Open(remotePath)
	if err != nil {
		return ActiveGcode{}, err
	}
	defer rc.Close()
	if entry.IsDir {
		return ActiveGcode{}, fmt.Errorf("%w: active gcode must be a file", ErrInvalidArgument)
	}
	preview, offsets, err := parseGcodePreview(rc)
	if err != nil {
		return ActiveGcode{}, err
	}
	active := activeGcodeState{Path: entry.Path, Preview: preview, SourceOffsets: offsets, SelectedAt: time.Now()}
	if err := s.store.SetActiveGcodePath(entry.Path); err != nil {
		return ActiveGcode{}, err
	}
	s.activeMu.Lock()
	s.activeGcode = active
	s.activeMu.Unlock()
	return s.activeGcodeSnapshot(active, entry), nil
}

func (s *Service) activeGcodeSnapshot(active activeGcodeState, entry store.Entry) ActiveGcode {
	entryCopy := entry
	previewCopy := copyPreviewSummary(active.Preview)
	runnable, message := runnableGcode(entry)
	return ActiveGcode{
		Path:      active.Path,
		Entry:     &entryCopy,
		Preview:   &previewCopy,
		Runnable:  runnable,
		Message:   message,
		UpdatedAt: active.SelectedAt,
	}
}

func (s *Service) maybeLoadActiveGcodeFromMachine(st machine.Status) {
	// Ignore synthetic state-only observations used by tests. Real machine status
	// comes through ParseStatusPayload and keeps Raw populated.
	if st.Raw == "" {
		return
	}
	if !stateMayReportActiveGcode(st.State) {
		s.activeProbeMu.Lock()
		s.activeProbeLoaded = false
		s.activeProbeLast = time.Time{}
		s.activeProbeMu.Unlock()
		return
	}
	model := s.store.UISettings().Machine.Learned.Identity.Model
	playStatus := supportsMachinePlayStatus(model)
	if !playStatus && (len(st.Progress) < 3 || !supportsMachineProgressCommand(model)) {
		return
	}

	now := time.Now()
	s.activeProbeMu.Lock()
	if s.activeProbeUnsupported || s.activeProbeLoaded || s.activeProbeInFlight || (!s.activeProbeLast.IsZero() && now.Sub(s.activeProbeLast) < activeGcodeProbeInterval) {
		s.activeProbeMu.Unlock()
		return
	}
	s.activeProbeInFlight = true
	s.activeProbeLast = now
	s.activeProbeMu.Unlock()

	go s.loadActiveGcodeFromMachine(playStatus)
}

func stateMayReportActiveGcode(st machine.State) bool {
	switch st {
	case machine.Run, machine.Hold, machine.Pause, machine.Wait, machine.Tool:
		return true
	default:
		return false
	}
}

// supportsMachineProgressCommand is deliberately a whitelist. The Z1 reports
// numeric player progress in its status payload but does not implement the
// separate console command named "progress". Sending that command repeatedly
// makes the machine surface an operator-visible error. Known Carvera models do
// implement it; unknown models remain query-free until their identity has been
// learned.
func supportsMachineProgressCommand(model string) bool {
	model = strings.ToLower(strings.TrimSpace(model))
	return strings.Contains(model, "carvera") && !strings.Contains(model, "z1")
}

// supportsMachinePlayStatus includes an empty identity so a fresh standalone
// Sensei installation can discover a running Z1 job before auto-learning has
// completed. Known non-Z1 Carvera machines retain their console progress path.
func supportsMachinePlayStatus(model string) bool {
	model = strings.ToLower(strings.TrimSpace(model))
	return model == "" || strings.Contains(model, "z1")
}

func (s *Service) loadActiveGcodeFromMachine(playStatus bool) {
	loaded := false
	defer func() {
		s.activeProbeMu.Lock()
		s.activeProbeInFlight = false
		if loaded {
			s.activeProbeLoaded = true
		}
		s.activeProbeMu.Unlock()
	}()

	remote, expectedMD5, ok, err := s.queryMachineActiveGcode(playStatus)
	if errors.Is(err, errMachineProgressUnsupported) {
		s.activeProbeMu.Lock()
		s.activeProbeUnsupported = true
		s.activeProbeMu.Unlock()
		return
	}
	if err != nil || !ok {
		return
	}
	if err := s.setMachineReportedActiveGcode(remote, expectedMD5); err != nil {
		return
	}
	// Metadata is useful immediately. The official controller can download the
	// active source while it is playing, so owner mode may mirror that read-only
	// transfer into the local cache. In relay mode the official controller owns
	// the conversation and Sensei stays a passive observer.
	if _, _, err := s.ReadCache(remote); err == nil {
		loaded = true
		return
	}
	if s.arb.Mode() != session.ModeOwner {
		loaded = true
		return
	}
	if err := s.fetchToCache(remote, false, expectedMD5); err != nil {
		// The active file remains known even if this best-effort background
		// cache fill cannot complete. Avoid turning status updates into a
		// repeated transfer loop while a job is in progress.
		loaded = true
		return
	}
	loaded = true
}

func (s *Service) queryMachineActiveGcode(playStatus bool) (string, string, bool, error) {
	if playStatus {
		var status protocol.PlayStatus
		err := s.arb.WithMachine(false, func(c *client.Conn) error {
			var e error
			status, e = c.QueryActivePlayback(activePlaybackTimeout)
			return e
		})
		if err != nil {
			return "", "", false, err
		}
		if status.Path == "" {
			return "", status.MD5, false, nil
		}
		remote, err := normalizeRemote(status.Path)
		if err != nil {
			return "", "", false, err
		}
		return remote, status.MD5, true, nil
	}

	var out string
	err := s.arb.WithMachine(false, func(c *client.Conn) error {
		o, e := c.SendConsoleCommand("progress\n", client.GcodeOpts{
			ExpectReply: true,
			Cap:         gcodeReplyCap,
		})
		out = o
		return e
	})
	if machineCommandUnsupported(out, "progress") || (err != nil && machineCommandUnsupported(err.Error(), "progress")) {
		return "", "", false, errMachineProgressUnsupported
	}
	if err != nil {
		return "", "", false, err
	}
	remote, ok := parseMachineProgressGcodePath(out)
	return remote, "", ok, nil
}

func machineCommandUnsupported(out, command string) bool {
	lower := strings.ToLower(protocol.Unescape(out))
	return strings.Contains(lower, "unsupported command") && strings.Contains(lower, strings.ToLower(command))
}

func parseMachineProgressGcodePath(out string) (string, bool) {
	scanner := bufio.NewScanner(strings.NewReader(out))
	for scanner.Scan() {
		line := strings.TrimSpace(protocol.Unescape(scanner.Text()))
		if len(line) < len("file: ") || !strings.EqualFold(line[:len("file: ")], "file: ") {
			continue
		}
		rest := strings.TrimSpace(line[len("file: "):])
		name, _, _ := strings.Cut(rest, ",")
		remote, err := normalizeRemote(strings.TrimSpace(name))
		if err != nil {
			return "", false
		}
		return remote, true
	}
	return "", false
}

func (s *Service) setMachineReportedActiveGcode(remotePath, expectedMD5 string) error {
	remote, err := normalizeRemote(remotePath)
	if err != nil {
		return err
	}
	// B7 reports the active file's content MD5. When it matches a persisted
	// cache entry, that is stronger evidence than the Z1 startup fallback based
	// on directory size alone and is safe to use even while the machine is busy
	// or paused (when the idle-gated reconcile cannot run).
	cacheVerified := false
	if existing, ok := s.store.GetEntry(remote); ok &&
		expectedMD5 != "" && strings.EqualFold(existing.MD5, expectedMD5) &&
		existing.CacheState == store.CacheValidating && existing.CachePath != "" &&
		filepolicy.IsWithinDir(s.cacheDir, existing.CachePath) {
		if info, statErr := os.Stat(existing.CachePath); statErr == nil && info.Mode().IsRegular() && info.Size() == existing.Size {
			cacheVerified = true
		}
	}
	return s.store.Batch(func(b *store.Batch) error {
		if entry, ok := b.GetEntry(remote); !ok {
			b.PutEntry(store.Entry{
				Path:       remote,
				MD5:        expectedMD5,
				Sync:       store.RemoteOnly,
				CacheState: store.CacheNone,
			})
		} else {
			if expectedMD5 != "" && entry.Sync == store.RemoteOnly && entry.MD5 != expectedMD5 {
				entry.MD5 = expectedMD5
			}
			if cacheVerified && entry.CacheState == store.CacheValidating && strings.EqualFold(entry.MD5, expectedMD5) {
				entry.CacheState = store.CacheReady
				entry.CacheCheckedAt = time.Now()
				entry.Error = ""
			}
			b.PutEntry(entry)
		}
		b.SetActiveGcodePath(remote)
		return nil
	})
}

func runnableGcode(entry store.Entry) (bool, string) {
	if entry.IsDir {
		return false, "Active gcode is a directory."
	}
	switch entry.Sync {
	case store.Synced, store.RemoteOnly:
		return true, ""
	case store.PendingUpload, store.Uploading:
		return false, "Waiting for upload sync before this file can run."
	case store.PendingDelete, store.Deleting:
		return false, "This file is queued for deletion."
	case store.Error:
		return false, "Resolve the file sync error before running."
	default:
		return false, "This file is not synced to the machine."
	}
}

func copyPreviewSummary(in GcodePreview) GcodePreview {
	out := in
	if in.Bounds != nil {
		b := *in.Bounds
		out.Bounds = &b
	}
	out.Tools = append([]int(nil), in.Tools...)
	out.Segments = nil
	out.OverviewSegments = previewOverview(in.Segments, maxPreviewOverviewSegments)
	return out
}

func previewOverview(segments []GcodeSegment, limit int) []GcodeSegment {
	if len(segments) == 0 || limit <= 0 {
		return nil
	}
	if len(segments) <= limit {
		return append([]GcodeSegment(nil), segments...)
	}
	if limit == 1 {
		return []GcodeSegment{segments[len(segments)-1]}
	}
	out := make([]GcodeSegment, limit)
	for i := range out {
		index := i * (len(segments) - 1) / (limit - 1)
		out[i] = segments[index]
	}
	return out
}

func (s *Service) ActiveGcodeSegments(start, limit int) (GcodeSegmentWindow, error) {
	if start < 0 || limit <= 0 || limit > maxGcodeSegmentWindow {
		return GcodeSegmentWindow{}, fmt.Errorf("%w: segment window requires start >= 0 and limit between 1 and %d", ErrInvalidArgument, maxGcodeSegmentWindow)
	}
	active := s.ensureActiveGcodeLoaded()
	if active.Path == "" {
		return GcodeSegmentWindow{}, ErrNoActiveGcode
	}
	total := len(active.Preview.Segments)
	if start > total {
		start = total
	}
	end := min(total, start+limit)
	return GcodeSegmentWindow{
		Start: start, Total: total,
		Segments: append([]GcodeSegment(nil), active.Preview.Segments[start:end]...),
	}, nil
}

func (s *Service) ActiveGcodeSource(startLine, limit int) (GcodeSourceWindow, error) {
	if startLine < 1 || limit <= 0 || limit > maxGcodeSourceWindow {
		return GcodeSourceWindow{}, fmt.Errorf("%w: source window requires start_line >= 1 and limit between 1 and %d", ErrInvalidArgument, maxGcodeSourceWindow)
	}
	active := s.ensureActiveGcodeLoaded()
	if active.Path == "" {
		return GcodeSourceWindow{}, ErrNoActiveGcode
	}
	total := max(0, len(active.SourceOffsets)-1)
	startIndex := min(total, startLine-1)
	endIndex := min(total, startIndex+limit)
	window := GcodeSourceWindow{StartLine: startIndex + 1, TotalLines: total, Lines: []string{}}
	if startIndex == endIndex {
		return window, nil
	}

	rc, _, err := s.ReadCache(active.Path)
	if err != nil {
		return GcodeSourceWindow{}, err
	}
	defer rc.Close()
	seeker, ok := rc.(io.ReadSeeker)
	if !ok {
		return GcodeSourceWindow{}, ErrNotCached
	}
	startOffset := active.SourceOffsets[startIndex]
	endOffset := active.SourceOffsets[endIndex]
	if _, err := seeker.Seek(startOffset, io.SeekStart); err != nil {
		return GcodeSourceWindow{}, err
	}
	data, err := io.ReadAll(io.LimitReader(seeker, endOffset-startOffset))
	if err != nil {
		return GcodeSourceWindow{}, err
	}
	window.Lines = splitSourceWindow(data, endIndex-startIndex)
	return window, nil
}

func (s *Service) ensureActiveGcodeLoaded() activeGcodeState {
	storedPath := s.store.ActiveGcodePath()
	s.activeMu.Lock()
	active := s.activeGcode
	s.activeMu.Unlock()
	if active.Path != "" && active.Path == storedPath && len(active.SourceOffsets) > 0 {
		return active
	}
	_ = s.ActiveGcode()
	s.activeMu.Lock()
	active = s.activeGcode
	s.activeMu.Unlock()
	return active
}

func splitSourceWindow(data []byte, expected int) []string {
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	lines := strings.Split(text, "\n")
	if len(lines) > expected {
		lines = lines[:expected]
	}
	for len(lines) < expected {
		lines = append(lines, "")
	}
	return lines
}

// RunActiveGcode sends the same controller-compatible `play <path>` command
// that the official UI sends for its selected remote file.
func (s *Service) RunActiveGcode() (MachineActionResult, error) {
	path := s.store.ActiveGcodePath()
	if path == "" {
		s.activeMu.Lock()
		path = s.activeGcode.Path
		s.activeMu.Unlock()
	}
	if path == "" {
		return MachineActionResult{Action: "run_gcode", Message: ErrNoActiveGcode.Error()}, ErrNoActiveGcode
	}
	entry, ok := s.store.GetEntry(path)
	if !ok {
		return MachineActionResult{Action: "run_gcode", Path: path, Message: ErrNotFound.Error()}, ErrNotFound
	}
	if runnable, message := runnableGcode(entry); !runnable {
		return MachineActionResult{Action: "run_gcode", Path: path, Message: message}, ErrActiveGcodeUnavailable
	}
	display := "play " + path
	out, err := s.sendConsoleMachineAction(display, protocol.PlayLine(path))
	res := MachineActionResult{
		Action:  "run_gcode",
		Path:    path,
		Command: display,
		Output:  out,
		Message: "Run command sent for " + path + "; machine confirmation was not available.",
	}
	if err != nil {
		res.Message = err.Error()
		return res, err
	}
	return res, nil
}

func validCurrentToolID(toolID int) bool {
	return toolID == -1 || toolID == ToolIDProbe || toolID == ToolIDLaser || toolID == ToolID3DProbe || (toolID >= 1 && toolID <= 999)
}

func validChangeToolID(toolID int) bool {
	return toolID == ToolIDProbe || toolID == ToolIDLaser || toolID == ToolID3DProbe || (toolID >= 1 && toolID <= 999)
}

func toolDisplayName(toolID int) string {
	switch toolID {
	case -1:
		return "Empty"
	case ToolIDProbe:
		return "Probe"
	case ToolIDLaser:
		return "Laser"
	case ToolID3DProbe:
		return "3D Probe"
	default:
		return fmt.Sprintf("Tool %d", toolID)
	}
}

// SetCurrentToolID mirrors the controller's M493.2T<n> action for manually
// declaring which tool is currently installed.
func (s *Service) SetCurrentToolID(toolID int) (MachineActionResult, error) {
	if !validCurrentToolID(toolID) {
		err := fmt.Errorf("%w: tool_id must be Empty (-1), Probe (0), Laser (8888), 3D Probe (9999), or between 1 and 999", ErrInvalidArgument)
		return MachineActionResult{Action: "set_tool", ToolID: toolID, Message: err.Error()}, err
	}
	display := strings.TrimSpace(protocol.SetCurrentToolLine(toolID))
	out, err := s.sendToolMachineAction(display, protocol.SetCurrentToolLine(toolID))
	res := MachineActionResult{
		Action:  "set_tool",
		ToolID:  toolID,
		Command: display,
		Output:  out,
		Message: fmt.Sprintf("Set-tool command sent for %s; machine confirmation was not available.", toolDisplayName(toolID)),
	}
	if err != nil {
		res.Message = err.Error()
		return res, err
	}
	return res, nil
}

// ChangeTool mirrors the controller's M6T<n> action for changing to a selected
// tool with the firmware's normal tool-change flow.
func (s *Service) ChangeTool(toolID int) (MachineActionResult, error) {
	if !validChangeToolID(toolID) {
		err := fmt.Errorf("%w: tool_id must be Probe (0), Laser (8888), 3D Probe (9999), or between 1 and 999", ErrInvalidArgument)
		return MachineActionResult{Action: "change_tool", ToolID: toolID, Message: err.Error()}, err
	}
	display := strings.TrimSpace(protocol.ChangeToolLine(toolID))
	out, err := s.sendToolMachineAction(display, protocol.ChangeToolLine(toolID))
	res := MachineActionResult{
		Action:  "change_tool",
		ToolID:  toolID,
		Command: display,
		Output:  out,
		Message: fmt.Sprintf("Change-tool command sent for %s; machine confirmation was not available.", toolDisplayName(toolID)),
	}
	if err != nil {
		res.Message = err.Error()
		return res, err
	}
	return res, nil
}

// ContinueToolChange mirrors the controller's M490.2 action, which clears the
// firmware's manual tool-change waiting state after the operator confirms.
func (s *Service) ContinueToolChange() (MachineActionResult, error) {
	display := strings.TrimSpace(protocol.ContinueToolChangeLine())
	out, err := s.sendToolContinueAction(display, protocol.ContinueToolChangeLine())
	res := MachineActionResult{
		Action:  "continue_tool_change",
		Command: display,
		Output:  out,
		Message: "Tool-change continue command sent; machine confirmation was not available.",
	}
	if err != nil {
		res.Message = err.Error()
		return res, err
	}
	return res, nil
}

// DropCurrentTool mirrors the controller's M6T-1 drop-tool action.
func (s *Service) DropCurrentTool() (MachineActionResult, error) {
	display := strings.TrimSpace(protocol.ChangeToolLine(-1))
	out, err := s.sendToolMachineAction(display, protocol.ChangeToolLine(-1))
	res := MachineActionResult{
		Action:  "drop_tool",
		ToolID:  -1,
		Command: display,
		Output:  out,
		Message: "Drop-tool command sent; machine confirmation was not available.",
	}
	if err != nil {
		res.Message = err.Error()
		return res, err
	}
	return res, nil
}

// CalibrateCurrentTool mirrors the controller's M491 current-tool calibration.
func (s *Service) CalibrateCurrentTool() (MachineActionResult, error) {
	display := strings.TrimSpace(protocol.CalibrateCurrentToolLine())
	out, err := s.sendToolMachineAction(display, protocol.CalibrateCurrentToolLine())
	res := MachineActionResult{
		Action:  "calibrate_tool",
		Command: display,
		Output:  out,
		Message: "Calibration command sent; machine confirmation was not available.",
	}
	if err != nil {
		res.Message = err.Error()
		return res, err
	}
	return res, nil
}

// AutoZProbe probes the current XY from the current machine Z and sets the
// current work Z to zero at the contact point. Unlike the firmware's M495
// automation, this must not first lift to the firmware clearance Z: that
// clearance can lie outside a configured Z soft limit.
func (s *Service) AutoZProbe() (MachineActionResult, error) {
	return s.zProbeSetWorkZero(false)
}

// ProbeFloor probes the current XY, sets work Z zero at the verified contact,
// then retracts to the configured safe Z (or remains higher if it started
// above that target).
func (s *Service) ProbeFloor() (MachineActionResult, error) {
	return s.zProbeSetWorkZero(true)
}

func (s *Service) zProbeSetWorkZero(retractSafe bool) (MachineActionResult, error) {
	action := "auto_z_probe"
	if retractSafe {
		action = "probe_floor"
	}
	res := MachineActionResult{Action: action}
	var out string
	var display string
	var verified bool
	var contact machine.AxisValues
	err := s.arb.WithMachine(true, func(c *client.Conn) error {
		st, err := s.queryRecoveryStatus(c)
		if err != nil {
			if errors.Is(err, ErrMachineStatusStale) {
				return err
			}
			return fmt.Errorf("%w: %v", ErrMachineStatusStale, err)
		}
		if st.State != machine.Idle {
			return fmt.Errorf("%w: machine reports %s", ErrMachineStatusStale, statusSummary(st))
		}
		startZ, ok := finiteAxisValue(st.MPos, "z")
		if !ok {
			return fmt.Errorf("%w: current machine Z is unavailable", ErrProbeUnavailable)
		}
		// This is intentionally not SafeZTargetMM(startZ). The target equals a
		// freshly observed in-range machine coordinate, so clamping it would
		// move away from the requested start height.
		if _, err := s.sendProbeLine(c, fmt.Sprintf("G53 G0 Z%.4f", startZ), false); err != nil {
			return err
		}
		probeLine := "G38.2 Z-20.0000 F50.0000"
		display = probeLine + " → G10 L20 P0 Z0"
		o, err := s.sendProbeLine(c, probeLine, true)
		out = o
		if err != nil {
			return err
		}
		pos, hit, err := parseProbeResult(out)
		if err != nil {
			return err
		} else if !hit {
			return fmt.Errorf("%w: probe did not report contact", ErrProbeUnavailable)
		}
		contact = pos
		if _, err := s.sendProbeLine(c, "G10 L20 P0 Z0", false); err != nil {
			return err
		}
		verifiedStatus, err := s.queryRecoveryStatus(c)
		if err != nil {
			return fmt.Errorf("%w: could not verify work Z after probing: %v", ErrMachineStatusStale, err)
		}
		workZ, ok := finiteAxisValue(verifiedStatus.WPos, "z")
		if !ok || math.Abs(workZ) > 0.01 {
			return fmt.Errorf("%w: work Z did not reach zero after probing", ErrProbeUnavailable)
		}
		verified = true
		retractZ := startZ
		if retractSafe {
			configuredSafeZ := s.store.UISettings().Machine.SafeZMM
			retractZ = math.Max(startZ, s.SafeZTargetMM(configuredSafeZ))
		}
		if _, err := s.sendProbeLine(c, fmt.Sprintf("G53 G0 Z%.4f", retractZ), false); err != nil {
			return err
		}
		if retractSafe {
			retractStatus, err := s.waitMachineIdle(c, probeIdleTimeout)
			if err != nil {
				return fmt.Errorf("%w: could not verify floor-probe retract: %v", ErrMachineStatusStale, err)
			}
			if retractStatus.State != machine.Idle {
				return fmt.Errorf("%w: floor-probe retract did not finish (%s)", ErrMachineStatusStale, statusSummary(retractStatus))
			}
			retractedZ, ok := finiteAxisValue(retractStatus.MPos, "z")
			if !ok || math.Abs(retractedZ-retractZ) > 0.01 {
				return fmt.Errorf("%w: floor probe did not reach safe Z %.4f", ErrProbeUnavailable, retractZ)
			}
		}
		s.refreshStatusBestEffort(c)
		return nil
	})
	res.Command = display
	res.Output = out
	res.Verified = verified
	res.Machine = contact
	res.Message = "Work Z zero verified at probe contact."
	if retractSafe {
		res.Message = "Floor zero verified and spindle retracted to safe Z."
	}
	if err != nil {
		res.Message = err.Error()
		return res, err
	}
	return res, nil
}

// Probe3D starts the official controller's wired 3D-probe workflow. Firmware
// tool 9999 enables the wired probe input; M480 owns the complete motion
// sequence and work-origin update. The command remains unverified because the
// WiFi protocol has no correlated completion reply for this automation.
func (s *Service) Probe3D(req Probe3DRequest) (MachineActionResult, error) {
	line, label, err := probe3DLine(req)
	if err != nil {
		err = fmt.Errorf("%w: %v", ErrInvalidArgument, err)
		return MachineActionResult{Action: "probe_3d", Message: err.Error()}, err
	}
	display := strings.TrimSpace(line)
	res := MachineActionResult{
		Action:  "probe_3d",
		ToolID:  ToolID3DProbe,
		Command: display,
		Message: "3D probe command sent for " + label + "; machine completion was not available.",
	}
	err = s.arb.WithMachine(true, func(c *client.Conn) error {
		st, statusErr := s.queryRecoveryStatus(c)
		if statusErr != nil {
			if errors.Is(statusErr, ErrMachineStatusStale) {
				return statusErr
			}
			return fmt.Errorf("%w: %v", ErrMachineStatusStale, statusErr)
		}
		if st.State != machine.Idle {
			return fmt.Errorf("%w: machine reports %s", ErrMachineStatusStale, statusSummary(st))
		}
		if st.Tool == nil || st.Tool.Active != ToolID3DProbe {
			return fmt.Errorf("%w: active tool is %s; 3D Probe (9999) is required", ErrProbeUnavailable, toolStatusLabel(st.Tool))
		}
		if limitErr := probe3DInitialPositionLimitError(req, st.MPos, s.store.UISettings().Machine.Learned.SoftEndstop); limitErr != nil {
			return fmt.Errorf("%w: %v", ErrInvalidArgument, limitErr)
		}
		s.gcodeLog.Append(gcodelog.DirSend, gcodelog.SourceAPI, "3d probe "+display)
		out, sendErr := c.SendConsoleCommand(ensureWireLine(line), client.GcodeOpts{Cap: gcodeReplyCap})
		res.Output = out
		if sendErr != nil {
			return sendErr
		}
		s.refreshStatusBestEffort(c)
		return nil
	})
	if res.Output != "" {
		s.gcodeLog.Append(gcodelog.DirRecv, gcodelog.SourceAPI, res.Output)
	}
	if err != nil {
		s.gcodeLog.Append(gcodelog.DirRecv, gcodelog.SourceAPI, "error: "+err.Error())
		res.Message = err.Error()
		return res, err
	}
	if res.Output == "" {
		s.gcodeLog.Append(gcodelog.DirRecv, gcodelog.SourceAPI, "sent: no reply observed")
	}
	return res, nil
}

func probe3DLine(req Probe3DRequest) (string, string, error) {
	values := map[string]float64{
		"x offset": req.XOffsetMM,
		"y offset": req.YOffsetMM,
		"z offset": req.ZOffsetMM,
		"diameter": req.DiameterMM,
	}
	for name, value := range values {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return "", "", fmt.Errorf("service: 3D probe %s must be finite", name)
		}
		if math.Abs(value) > maxMachineSpanMM {
			return "", "", fmt.Errorf("service: 3D probe %s magnitude must not exceed %.0f mm", name, float64(maxMachineSpanMM))
		}
	}
	if req.DiameterMM == 0 {
		return "", "", fmt.Errorf("service: 3D probe diameter must be greater than zero")
	}

	x := math.Abs(req.XOffsetMM)
	y := math.Abs(req.YOffsetMM)
	z := math.Abs(req.ZOffsetMM)
	d := math.Abs(req.DiameterMM)
	var subcode int
	var label string
	switch strings.ToLower(strings.TrimSpace(req.Kind)) {
	case "outside_top_left":
		subcode, label = 1, "outside top-left corner"
	case "outside_top_right":
		subcode, label = 2, "outside top-right corner"
	case "outside_bottom_right":
		subcode, label = 3, "outside bottom-right corner"
	case "outside_bottom_left":
		subcode, label = 4, "outside bottom-left corner"
	case "inside_top_left":
		subcode, label = 5, "inside top-left corner"
	case "inside_top_right":
		subcode, label = 6, "inside top-right corner"
	case "inside_bottom_right":
		subcode, label = 7, "inside bottom-right corner"
	case "inside_bottom_left":
		subcode, label = 8, "inside bottom-left corner"
	case "bore_pocket":
		subcode, label = 9, "bore/pocket center"
	case "bore_pocket_x":
		subcode, label, y = 9, "bore/pocket X center", 0
	case "bore_pocket_y":
		subcode, label, x = 9, "bore/pocket Y center", 0
	case "boss_block":
		subcode, label = 10, "boss/block center"
	case "boss_block_x":
		subcode, label, y = 10, "boss/block X center", 0
	case "boss_block_y":
		subcode, label, x = 10, "boss/block Y center", 0
	default:
		return "", "", fmt.Errorf("service: unsupported 3D probe kind %q", req.Kind)
	}
	return protocol.Probe3DLine(subcode, x, y, z, d), label, nil
}

// probe3DInitialPositionLimitError mirrors the deterministic, non-probing XY
// positioning moves generated by the firmware's M480 corner and boss/block
// routines. Probe moves and post-contact moves are deliberately excluded:
// their endpoints depend on physical contact and cannot be known beforehand.
func probe3DInitialPositionLimitError(req Probe3DRequest, mpos machine.AxisValues, limits store.MachineSoftEndstopProfile) error {
	x, xOK := finiteAxisValue(mpos, "x")
	y, yOK := finiteAxisValue(mpos, "y")
	xOffset := math.Abs(req.XOffsetMM)
	yOffset := math.Abs(req.YOffsetMM)
	var dx, dy float64
	var checkX, checkY bool
	switch strings.ToLower(strings.TrimSpace(req.Kind)) {
	case "outside_top_left":
		dx, dy, checkX, checkY = -xOffset, yOffset, true, true
	case "outside_top_right":
		dx, dy, checkX, checkY = xOffset, yOffset, true, true
	case "outside_bottom_right":
		dx, dy, checkX, checkY = xOffset, -yOffset, true, true
	case "outside_bottom_left":
		dx, dy, checkX, checkY = -xOffset, -yOffset, true, true
	case "inside_top_left":
		dx, dy, checkX, checkY = xOffset, -yOffset, true, true
	case "inside_top_right":
		dx, dy, checkX, checkY = -xOffset, -yOffset, true, true
	case "inside_bottom_right":
		dx, dy, checkX, checkY = -xOffset, yOffset, true, true
	case "inside_bottom_left":
		dx, dy, checkX, checkY = xOffset, yOffset, true, true
	case "boss_block":
		dx, dy, checkX, checkY = -xOffset, -yOffset, true, true
	case "boss_block_x":
		dx, checkX = -xOffset, true
	case "boss_block_y":
		dy, checkY = -yOffset, true
	default:
		return nil
	}
	if checkX && xOK {
		if err := probe3DAxisLimitError("X", x, dx, limits.XMin, limits.XMax); err != nil {
			return err
		}
	}
	if checkY && yOK {
		if err := probe3DAxisLimitError("Y", y, dy, limits.YMin, limits.YMax); err != nil {
			return err
		}
	}
	return nil
}

func probe3DAxisLimitError(axis string, current, delta, min, max float64) error {
	if !finite(current) || !finite(delta) || !finite(min) || !finite(max) || min >= max {
		return nil
	}
	target := current + delta
	switch {
	case target < min:
		safeOffset := math.Max(0, current-min)
		return fmt.Errorf("3D probe %s positioning target %.3f mm is below learned minimum %.3f mm; reduce %s Offset to at most %.3f mm or reposition the probe", axis, target, min, axis, safeOffset)
	case target > max:
		safeOffset := math.Max(0, max-current)
		return fmt.Errorf("3D probe %s positioning target %.3f mm is above learned maximum %.3f mm; reduce %s Offset to at most %.3f mm or reposition the probe", axis, target, max, axis, safeOffset)
	default:
		return nil
	}
}

func currentWorkXY(st machine.Status) (float64, float64, bool) {
	x, okX := finiteAxisValue(st.WPos, "x")
	y, okY := finiteAxisValue(st.WPos, "y")
	return x, y, okX && okY
}

func finiteAxisValue(values machine.AxisValues, axis string) (float64, bool) {
	if values == nil {
		return 0, false
	}
	v, ok := values[strings.ToLower(axis)]
	return v, ok && !math.IsNaN(v) && !math.IsInf(v, 0)
}

func (s *Service) sendConsoleMachineAction(displayLine, wireLine string) (string, error) {
	s.gcodeLog.Append(gcodelog.DirSend, gcodelog.SourceAPI, displayLine)
	var out string
	err := s.arb.WithMachine(true, func(c *client.Conn) error {
		o, e := c.SendConsoleCommand(ensureWireLine(wireLine), client.GcodeOpts{Cap: gcodeReplyCap})
		out = o
		return e
	})
	if out != "" {
		s.gcodeLog.Append(gcodelog.DirRecv, gcodelog.SourceAPI, out)
	}
	if err != nil {
		s.gcodeLog.Append(gcodelog.DirRecv, gcodelog.SourceAPI, "error: "+err.Error())
	} else if out == "" {
		s.gcodeLog.Append(gcodelog.DirRecv, gcodelog.SourceAPI, "sent: no reply observed")
	}
	return out, err
}

func (s *Service) sendToolMachineAction(displayLine, wireLine string) (string, error) {
	s.gcodeLog.Append(gcodelog.DirSend, gcodelog.SourceAPI, displayLine)
	var out string
	err := s.arb.WithMachine(true, func(c *client.Conn) error {
		o, e := c.SendConsoleCommand(ensureWireLine(wireLine), client.GcodeOpts{Cap: gcodeReplyCap})
		out = o
		if e != nil {
			return e
		}
		s.refreshStatusBestEffort(c)
		return nil
	})
	if out != "" {
		s.gcodeLog.Append(gcodelog.DirRecv, gcodelog.SourceAPI, out)
	}
	if err != nil {
		s.gcodeLog.Append(gcodelog.DirRecv, gcodelog.SourceAPI, "error: "+err.Error())
	} else if out == "" {
		s.gcodeLog.Append(gcodelog.DirRecv, gcodelog.SourceAPI, "sent: no reply observed")
	}
	return out, err
}

func (s *Service) sendToolContinueAction(displayLine, wireLine string) (string, error) {
	s.gcodeLog.Append(gcodelog.DirSend, gcodelog.SourceAPI, displayLine)
	var out string
	err := s.arb.WithMachine(false, func(c *client.Conn) error {
		st, err := s.queryRecoveryStatus(c)
		if err != nil {
			if errors.Is(err, ErrMachineStatusStale) {
				return err
			}
			return fmt.Errorf("%w: %v", ErrMachineStatusStale, err)
		}
		if st.State != machine.Tool {
			return fmt.Errorf("%w: machine reports %s", ErrToolChangeUnavailable, statusSummary(st))
		}
		o, e := c.SendConsoleCommand(ensureWireLine(wireLine), client.GcodeOpts{Cap: gcodeReplyCap})
		out = o
		if e != nil {
			return e
		}
		s.refreshStatusBestEffort(c)
		return nil
	})
	if out != "" {
		s.gcodeLog.Append(gcodelog.DirRecv, gcodelog.SourceAPI, out)
	}
	if err != nil {
		s.gcodeLog.Append(gcodelog.DirRecv, gcodelog.SourceAPI, "error: "+err.Error())
	} else if out == "" {
		s.gcodeLog.Append(gcodelog.DirRecv, gcodelog.SourceAPI, "sent: no reply observed")
	}
	return out, err
}

func (s *Service) refreshStatusBestEffort(c *client.Conn) {
	_, _ = s.queryRecoveryStatus(c)
}

func ensureWireLine(line string) string {
	if line == "" || line[len(line)-1] == '\n' {
		return line
	}
	return line + "\n"
}

type previewParser struct {
	unit                  float64
	absolute              bool
	arcAbsolute           bool
	motion                int
	plane                 int
	pos                   [4]float64
	axisKnown             [3]bool
	currentTool           int
	tools                 map[int]bool
	preview               GcodePreview
	bounds                GcodeBounds
	haveBounds            bool
	cycleStarted          bool
	cycleRetractToInitial bool
	cycleInitialZ         float64
	cycleSticky           cycleSticky
}

type gword struct {
	letter byte
	value  float64
}

type cycleSticky struct {
	z float64
	r float64
	f float64
	q float64
	p float64
}

const (
	previewPlaneXY = iota
	previewPlaneXZ
	previewPlaneYZ
)

// ParseGcodePreview scans the Carvera-supported explicit motion surface into a
// complete segment list: G0/G1/G2/G3, G38.2-G38.6, G17-G19 planes, G90/G91,
// G90.1/G91.1 arc centers, inch/mm units, A-axis moves, G92 coordinate resets,
// and firmware-supported G80-G83/G98/G99 drilling cycles.
func ParseGcodePreview(r io.Reader) (GcodePreview, error) {
	preview, _, err := parseGcodePreview(r)
	return preview, err
}

func parseGcodePreview(r io.Reader) (GcodePreview, []int64, error) {
	p := previewParser{
		unit:     1,
		absolute: true,
		motion:   -1,
		tools:    map[int]bool{},
	}
	offsets := []int64{0}
	var offset int64
	br := bufio.NewReaderSize(r, 64*1024)
	for {
		line, err := br.ReadString('\n')
		if line != "" {
			p.preview.LineCount++
			p.parseLine(line, p.preview.LineCount)
			offset += int64(len(line))
			offsets = append(offsets, offset)
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return GcodePreview{}, nil, err
		}
	}
	if p.haveBounds {
		b := p.bounds
		p.preview.Bounds = &b
	}
	for tool := range p.tools {
		p.preview.Tools = append(p.preview.Tools, tool)
	}
	sort.Ints(p.preview.Tools)
	return p.preview, offsets, nil
}

func (p *previewParser) parseLine(line string, lineNo int) {
	words := parseGcodeWords(stripGcodeComments(line))
	if len(words) == 0 {
		return
	}
	values := map[byte]float64{}
	hasValue := map[byte]bool{}
	hasAxis := false
	lineMotion := -1
	cycleCode := 0
	setPosition := false
	for _, w := range words {
		switch w.letter {
		case 'G':
			code, subcode := splitGCode(w.value)
			switch code {
			case 0, 1, 2, 3:
				lineMotion = code
				p.motion = code
			case 17:
				p.plane = previewPlaneXY
			case 18:
				p.plane = previewPlaneXZ
			case 19:
				p.plane = previewPlaneYZ
			case 20:
				p.unit = 25.4
			case 21:
				p.unit = 1
			case 38:
				if subcode >= 2 && subcode <= 6 {
					lineMotion = 38
				}
			case 80:
				p.endCycle(lineNo)
			case 81, 82, 83:
				cycleCode = code
			case 90:
				if subcode == 1 {
					p.arcAbsolute = true
				} else {
					p.absolute = true
				}
			case 91:
				if subcode == 1 {
					p.arcAbsolute = false
				} else {
					p.absolute = false
				}
			case 92:
				setPosition = true
			case 98:
				p.startCycle(true)
			case 99:
				p.startCycle(false)
			}
		case 'T':
			tool := int(math.Round(w.value))
			p.currentTool = tool
			p.tools[tool] = true
		case 'M':
			if int(math.Round(w.value)) == 321 {
				p.currentTool = 7
				p.tools[7] = true
			}
		case 'X', 'Y', 'Z', 'I', 'J', 'K', 'R', 'Q', 'F':
			values[w.letter] = w.value * p.unit
			hasValue[w.letter] = true
			if w.letter == 'X' || w.letter == 'Y' || w.letter == 'Z' {
				hasAxis = true
			}
		case 'A':
			values[w.letter] = -w.value
			hasValue[w.letter] = true
			hasAxis = true
			p.preview.Has4Axis = true
		case 'L', 'P', 'S':
			values[w.letter] = w.value
			hasValue[w.letter] = true
		}
	}
	if setPosition {
		p.setPosition(values, hasValue)
		return
	}
	if cycleCode != 0 {
		p.runCycle(cycleCode, values, hasValue, lineNo)
		return
	}
	if lineMotion < 0 {
		lineMotion = p.motion
	}
	hasArcCenter := hasValue['I'] || hasValue['J'] || hasValue['K'] || hasValue['R']
	if lineMotion < 0 {
		return
	}
	if !hasAxis && !(hasArcCenter && (lineMotion == 2 || lineMotion == 3)) {
		return
	}
	target := p.targetFromValues(values, hasValue)
	switch lineMotion {
	case 0:
		p.addLinearMove("rapid", lineNo, target)
	case 1:
		p.addLinearMove("cut", lineNo, target)
	case 2, 3:
		p.addArcMove(lineMotion == 2, lineNo, target, values, hasValue)
	case 38:
		p.addLinearMove("probe", lineNo, target)
	}
	p.pos = target
	p.markAxesKnown(hasValue)
}

// markAxesKnown records which linear axes the file has explicitly commanded.
// Until all of X, Y, and Z are anchored, the parser's current position is an
// assumption (the machine could be anywhere when the program starts).
func (p *previewParser) markAxesKnown(hasValue map[byte]bool) {
	if hasValue['X'] {
		p.axisKnown[0] = true
	}
	if hasValue['Y'] {
		p.axisKnown[1] = true
	}
	if hasValue['Z'] {
		p.axisKnown[2] = true
	}
}

func (p *previewParser) positionAnchored() bool {
	return p.axisKnown[0] && p.axisKnown[1] && p.axisKnown[2]
}

func splitGCode(v float64) (int, int) {
	code := int(math.Trunc(v))
	subcode := int(math.Round((v - float64(code)) * 10))
	return code, subcode
}

func (p *previewParser) targetFromValues(values map[byte]float64, hasValue map[byte]bool) [4]float64 {
	target := p.pos
	for _, axis := range []struct {
		letter byte
		index  int
	}{
		{'X', 0},
		{'Y', 1},
		{'Z', 2},
		{'A', 3},
	} {
		if !hasValue[axis.letter] {
			continue
		}
		v := values[axis.letter]
		if p.absolute {
			target[axis.index] = v
		} else {
			target[axis.index] += v
		}
	}
	return target
}

func (p *previewParser) setPosition(values map[byte]float64, hasValue map[byte]bool) {
	if len(hasValue) == 0 {
		p.pos = [4]float64{}
		p.axisKnown = [3]bool{true, true, true}
		return
	}
	p.markAxesKnown(hasValue)
	for _, axis := range []struct {
		letter byte
		index  int
	}{
		{'X', 0},
		{'Y', 1},
		{'Z', 2},
		{'A', 3},
	} {
		if hasValue[axis.letter] {
			p.pos[axis.index] = values[axis.letter]
		}
	}
}

func (p *previewParser) startCycle(retractToInitial bool) {
	p.cycleStarted = true
	p.cycleRetractToInitial = retractToInitial
	p.cycleInitialZ = p.pos[2]
	p.cycleSticky = cycleSticky{}
}

func (p *previewParser) endCycle(lineNo int) {
	if p.cycleStarted && !p.cycleRetractToInitial {
		target := p.pos
		target[2] = p.cycleInitialZ
		p.addLinearMove("rapid", lineNo, target)
		p.pos = target
	}
	p.cycleStarted = false
}

func (p *previewParser) runCycle(code int, values map[byte]float64, hasValue map[byte]bool, lineNo int) {
	if !p.cycleStarted || !p.absolute {
		return
	}
	p.updateCycleSticky(values, hasValue)
	xy := p.pos
	if hasValue['X'] {
		xy[0] = values['X']
	}
	if hasValue['Y'] {
		xy[1] = values['Y']
	}
	p.addLinearMove("rapid", lineNo, xy)
	p.pos = xy
	// Canned cycles command absolute coordinates: the given X/Y words and the
	// absolute R/Z planes anchor those axes from here on.
	p.markAxesKnown(hasValue)
	p.axisKnown[2] = true

	retract := p.pos
	retract[2] = p.cycleSticky.r
	p.addLinearMove("rapid", lineNo, retract)
	p.pos = retract

	if code == 83 && p.cycleSticky.q > 0 {
		p.runPeckCycle(lineNo)
	} else {
		drill := p.pos
		drill[2] = p.cycleSticky.z
		p.addLinearMove("cut", lineNo, drill)
		p.pos = drill
	}

	finalRetract := p.pos
	if p.cycleRetractToInitial {
		finalRetract[2] = p.cycleInitialZ
	} else {
		finalRetract[2] = p.cycleSticky.r
	}
	p.addLinearMove("rapid", lineNo, finalRetract)
	p.pos = finalRetract
}

func (p *previewParser) updateCycleSticky(values map[byte]float64, hasValue map[byte]bool) {
	if hasValue['Z'] {
		p.cycleSticky.z = values['Z']
	}
	if hasValue['R'] {
		p.cycleSticky.r = values['R']
	}
	if hasValue['F'] {
		p.cycleSticky.f = values['F']
	}
	if hasValue['Q'] {
		p.cycleSticky.q = values['Q']
	}
	if hasValue['P'] {
		p.cycleSticky.p = values['P']
	}
}

func (p *previewParser) runPeckCycle(lineNo int) {
	if p.cycleSticky.q <= 0 {
		return
	}
	for z := p.cycleSticky.r - p.cycleSticky.q; z > p.cycleSticky.z; z -= p.cycleSticky.q {
		drill := p.pos
		drill[2] = z
		p.addLinearMove("cut", lineNo, drill)
		p.pos = drill
		retract := p.pos
		retract[2] = p.cycleSticky.r
		p.addLinearMove("rapid", lineNo, retract)
		p.pos = retract
	}
	drill := p.pos
	drill[2] = p.cycleSticky.z
	p.addLinearMove("cut", lineNo, drill)
	p.pos = drill
}

func (p *previewParser) addLinearMove(kind string, lineNo int, target [4]float64) {
	if samePreviewPoint(p.pos, target) {
		return
	}
	p.preview.MoveCount++
	if kind == "rapid" && !p.positionAnchored() {
		// A lead-in rapid from a position the file never established would
		// plot a fabricated streak from the assumed origin; skip the segment
		// so the plotted path starts at the first anchored position.
		return
	}
	p.addSegment(GcodeSegment{Kind: kind, Line: lineNo, Tool: p.currentTool, From: p.pos, To: target})
}

func (p *previewParser) addArcMove(clockwise bool, lineNo int, target [4]float64, values map[byte]float64, hasValue map[byte]bool) {
	offset, ok := p.arcOffset(clockwise, target, values, hasValue)
	if !ok {
		p.addLinearMove("arc", lineNo, target)
		return
	}
	u, v, w := p.planeAxes()
	start := p.pos
	radius := math.Hypot(offset[u], offset[v])
	if radius <= 0.000001 {
		p.addLinearMove("arc", lineNo, target)
		return
	}
	centerU := start[u] + offset[u]
	centerV := start[v] + offset[v]
	r0U := -offset[u]
	r0V := -offset[v]
	rtU := target[u] - centerU
	rtV := target[v] - centerV
	angularTravel := 0.0
	if nearlyEqual(start[u], target[u]) && nearlyEqual(start[v], target[v]) {
		if clockwise {
			angularTravel = -2 * math.Pi
		} else {
			angularTravel = 2 * math.Pi
		}
	} else {
		angularTravel = math.Atan2(r0U*rtV-r0V*rtU, r0U*rtU+r0V*rtV)
		effectiveClockwise := clockwise
		if w == 1 {
			effectiveClockwise = !effectiveClockwise
		}
		if effectiveClockwise {
			if angularTravel > 0 {
				angularTravel -= 2 * math.Pi
			}
		} else if angularTravel < 0 {
			angularTravel += 2 * math.Pi
		}
	}
	travel := math.Hypot(angularTravel*radius, math.Abs(target[w]-start[w]))
	if travel <= 0.000001 && nearlyEqual(start[3], target[3]) {
		return
	}
	arcSegment := previewArcSegment
	if previewArcError > 0 && 2*radius > previewArcError {
		minErrSegment := 2 * math.Sqrt(previewArcError*(2*radius-previewArcError))
		if arcSegment < minErrSegment {
			arcSegment = minErrSegment
		}
	}
	if arcSegment < 0.0001 {
		arcSegment = 0.5
	}
	segments := int(math.Floor(travel / arcSegment))
	if segments < 1 {
		segments = 1
	}
	p.preview.MoveCount++
	startAngle := math.Atan2(start[v]-centerV, start[u]-centerU)
	prev := start
	for i := 1; i <= segments; i++ {
		t := float64(i) / float64(segments)
		next := start
		angle := startAngle + angularTravel*t
		next[u] = centerU + radius*math.Cos(angle)
		next[v] = centerV + radius*math.Sin(angle)
		next[w] = start[w] + (target[w]-start[w])*t
		next[3] = start[3] + (target[3]-start[3])*t
		if i == segments {
			next = target
		}
		if !samePreviewPoint(prev, next) {
			p.addSegment(GcodeSegment{Kind: "arc", Line: lineNo, Tool: p.currentTool, From: prev, To: next})
		}
		prev = next
	}
}

func (p *previewParser) arcOffset(clockwise bool, target [4]float64, values map[byte]float64, hasValue map[byte]bool) ([3]float64, bool) {
	var offset [3]float64
	if hasValue['R'] {
		return p.arcOffsetFromRadius(clockwise, target, values['R'])
	}
	seen := false
	for _, word := range []struct {
		letter byte
		axis   int
	}{
		{'I', 0},
		{'J', 1},
		{'K', 2},
	} {
		if !hasValue[word.letter] {
			continue
		}
		seen = true
		if p.arcAbsolute {
			offset[word.axis] = values[word.letter] - p.pos[word.axis]
		} else {
			offset[word.axis] = values[word.letter]
		}
	}
	return offset, seen
}

func (p *previewParser) arcOffsetFromRadius(clockwise bool, target [4]float64, radiusWord float64) ([3]float64, bool) {
	var offset [3]float64
	u, v, _ := p.planeAxes()
	startU := p.pos[u]
	startV := p.pos[v]
	targetU := target[u]
	targetV := target[v]
	du := targetU - startU
	dv := targetV - startV
	chord := math.Hypot(du, dv)
	if chord <= 0.000001 {
		return offset, false
	}
	radius := math.Abs(radiusWord)
	if radius <= 0.000001 {
		return offset, false
	}
	halfChord := chord / 2
	if radius < halfChord {
		radius = halfChord
	}
	oc := math.Sqrt(math.Max(radius*radius-halfChord*halfChord, 0))
	if clockwise {
		oc = -oc
	}
	if radiusWord < 0 {
		oc = -oc
	}
	centerU := 0.5*(startU+targetU) - oc*dv/chord
	centerV := 0.5*(startV+targetV) + oc*du/chord
	offset[u] = centerU - startU
	offset[v] = centerV - startV
	return offset, true
}

func (p *previewParser) planeAxes() (int, int, int) {
	switch p.plane {
	case previewPlaneXZ:
		return 0, 2, 1
	case previewPlaneYZ:
		return 1, 2, 0
	default:
		return 0, 1, 2
	}
}

func samePreviewPoint(a, b [4]float64) bool {
	for i := 0; i < len(a); i++ {
		if !nearlyEqual(a[i], b[i]) {
			return false
		}
	}
	return true
}

func nearlyEqual(a, b float64) bool {
	return math.Abs(a-b) < 0.0000001
}

func previewSegmentDistance(from, to [4]float64) float64 {
	dx := to[0] - from[0]
	dy := to[1] - from[1]
	dz := to[2] - from[2]
	d := math.Sqrt(dx*dx + dy*dy + dz*dz)
	if d <= 0.0000001 {
		d = math.Abs(to[3] - from[3])
	}
	return d
}

func (p *previewParser) addSegment(seg GcodeSegment) {
	d := previewSegmentDistance(seg.From, seg.To)
	seg.DistanceStart = p.preview.TotalDistance
	p.preview.TotalDistance += d
	seg.DistanceEnd = p.preview.TotalDistance
	p.includeBounds(seg.From)
	p.includeBounds(seg.To)
	p.preview.Segments = append(p.preview.Segments, seg)
	p.preview.PlottedSegments = len(p.preview.Segments)
}

func (p *previewParser) includeBounds(pos [4]float64) {
	if !p.haveBounds {
		p.bounds.Min = [3]float64{pos[0], pos[1], pos[2]}
		p.bounds.Max = [3]float64{pos[0], pos[1], pos[2]}
		p.bounds.MinA = pos[3]
		p.bounds.MaxA = pos[3]
		p.haveBounds = true
		return
	}
	for i := 0; i < 3; i++ {
		if pos[i] < p.bounds.Min[i] {
			p.bounds.Min[i] = pos[i]
		}
		if pos[i] > p.bounds.Max[i] {
			p.bounds.Max[i] = pos[i]
		}
	}
	if pos[3] < p.bounds.MinA {
		p.bounds.MinA = pos[3]
	}
	if pos[3] > p.bounds.MaxA {
		p.bounds.MaxA = pos[3]
	}
}

func stripGcodeComments(line string) string {
	var b strings.Builder
	inParen := false
	for i := 0; i < len(line); i++ {
		c := line[i]
		if inParen {
			if c == ')' {
				inParen = false
			}
			continue
		}
		switch c {
		case '(':
			inParen = true
		case ';':
			return b.String()
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

func parseGcodeWords(line string) []gword {
	var out []gword
	for i := 0; i < len(line); {
		c := line[i]
		if c >= 'a' && c <= 'z' {
			c -= 'a' - 'A'
		}
		if c < 'A' || c > 'Z' {
			i++
			continue
		}
		i++
		for i < len(line) && (line[i] == ' ' || line[i] == '\t') {
			i++
		}
		start := i
		if i < len(line) && (line[i] == '+' || line[i] == '-') {
			i++
		}
		digits := false
		exponent := false
		for i < len(line) {
			ch := line[i]
			if ch >= '0' && ch <= '9' {
				digits = true
				i++
				continue
			}
			if ch == '.' {
				i++
				continue
			}
			if (ch == 'e' || ch == 'E') && digits && !exponent {
				exponent = true
				i++
				if i < len(line) && (line[i] == '+' || line[i] == '-') {
					i++
				}
				continue
			}
			break
		}
		if !digits {
			continue
		}
		v, err := strconv.ParseFloat(line[start:i], 64)
		if err != nil {
			continue
		}
		out = append(out, gword{letter: c, value: v})
	}
	return out
}
