// Package runhistory derives operator run history from observed status reports
// and gcode log lines. It never talks to the machine; it only consumes signals
// the proxy already observes.
package runhistory

import (
	"strings"
	"sync"
	"time"

	"github.com/uwin/cnc-proxy/internal/gcodelog"
	"github.com/uwin/cnc-proxy/internal/machine"
)

const maxCommandsPerRun = 40
const pendingFileHintMaxAge = 10 * time.Minute

// Run is one observed machine run.
type Run struct {
	ID               int64             `json:"id"`
	Source           string            `json:"source,omitempty"`
	File             string            `json:"file,omitempty"`
	StartedAt        time.Time         `json:"started_at"`
	EndedAt          *time.Time        `json:"ended_at,omitempty"`
	DurationMs       int64             `json:"duration_ms"`
	Active           bool              `json:"active"`
	StartState       machine.State     `json:"start_state"`
	EndState         machine.State     `json:"end_state,omitempty"`
	StateTransitions []StateTransition `json:"state_transitions,omitempty"`
	Alarms           []AlarmEvent      `json:"alarms,omitempty"`
	FeedOverrides    []OverrideEvent   `json:"feed_overrides,omitempty"`
	SpindleOverrides []OverrideEvent   `json:"spindle_overrides,omitempty"`
	Commands         []CommandEvent    `json:"commands,omitempty"`
	Progress         []float64         `json:"progress,omitempty"`
}

// StateTransition records an observed machine state change during a run.
type StateTransition struct {
	Time  time.Time     `json:"time"`
	State machine.State `json:"state"`
	Raw   string        `json:"raw,omitempty"`
}

// AlarmEvent records an alarm observed during a run.
type AlarmEvent struct {
	Time       time.Time           `json:"time"`
	HaltReason *machine.HaltReason `json:"halt_reason,omitempty"`
	Raw        string              `json:"raw,omitempty"`
}

// OverrideEvent records feed or spindle override changes observed in status.
type OverrideEvent struct {
	Time     time.Time `json:"time"`
	Current  float64   `json:"current"`
	Target   float64   `json:"target"`
	Override float64   `json:"override"`
}

// CommandEvent records a bounded command trail for a run.
type CommandEvent struct {
	Time   time.Time `json:"time"`
	Source string    `json:"source,omitempty"`
	Text   string    `json:"text"`
}

type pendingFile struct {
	source string
	file   string
	at     time.Time
}

// History keeps a bounded in-memory list of recent runs.
type History struct {
	mu        sync.Mutex
	cap       int
	runs      []Run
	nextID    int64
	active    *Run
	lastState machine.State
	lastFeed  *machine.Triple
	lastSpin  *machine.Spindle
	pending   pendingFile
}

// New creates a run history retaining at most capacity runs.
func New(capacity int) *History {
	if capacity <= 0 {
		capacity = 100
	}
	return &History{cap: capacity, nextID: 1}
}

// ObserveLine consumes one gcode log line. Outgoing play commands are used as
// the best available file/source hint for the next observed Run state.
func (h *History) ObserveLine(ln gcodelog.Line) {
	if ln.Dir != gcodelog.DirSend {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()

	when := lineTime(ln.Time)
	if file := extractRunFile(ln.Text); file != "" {
		h.pending = pendingFile{source: ln.Source, file: file, at: when}
		if h.active != nil && h.active.File == "" {
			h.active.File = file
			h.active.Source = ln.Source
		}
	}
	if h.active != nil {
		h.active.Commands = append(h.active.Commands, CommandEvent{Time: when, Source: ln.Source, Text: ln.Text})
		if len(h.active.Commands) > maxCommandsPerRun {
			h.active.Commands = append([]CommandEvent(nil), h.active.Commands[len(h.active.Commands)-maxCommandsPerRun:]...)
		}
	}
}

// ObserveStatus consumes one parsed machine status.
func (h *History) ObserveStatus(st machine.Status) {
	when := statusTime(st)
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.active == nil && startsRun(st) {
		h.startLocked(st, when)
	}
	if h.active != nil {
		h.updateActiveLocked(st, when)
		if endsRun(st) {
			h.endLocked(st, when)
		}
	}
	h.lastState = st.State
}

// Recent returns recent runs newest first.
func (h *History) Recent() []Run {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]Run, 0, len(h.runs))
	for i := len(h.runs) - 1; i >= 0; i-- {
		out = append(out, copyRun(h.runs[i]))
	}
	return out
}

// Clear removes all retained run history and resets the in-memory tracker.
func (h *History) Clear() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.runs = nil
	h.nextID = 1
	h.active = nil
	h.lastState = machine.Unknown
	h.lastFeed = nil
	h.lastSpin = nil
	h.pending = pendingFile{}
}

// Snapshot returns recent runs oldest first for backup/export.
func (h *History) Snapshot() []Run {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]Run, 0, len(h.runs))
	for _, r := range h.runs {
		out = append(out, copyRun(r))
	}
	return out
}

// Replace imports a run history snapshot.
func (h *History) Replace(runs []Run) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.runs = make([]Run, 0, min(len(runs), h.cap))
	maxID := int64(0)
	start := 0
	if len(runs) > h.cap {
		start = len(runs) - h.cap
	}
	for _, r := range runs[start:] {
		cp := copyRun(r)
		if cp.ID > maxID {
			maxID = cp.ID
		}
		h.runs = append(h.runs, cp)
	}
	h.nextID = maxID + 1
	if h.nextID <= 0 {
		h.nextID = 1
	}
	h.active = nil
	for i := range h.runs {
		if h.runs[i].Active {
			h.active = &h.runs[i]
		}
	}
}

func (h *History) startLocked(st machine.Status, when time.Time) {
	source, file := h.pending.source, h.pending.file
	if !h.pending.at.IsZero() && when.Sub(h.pending.at) > pendingFileHintMaxAge {
		source, file = "", ""
		h.pending = pendingFile{}
	}
	if source == "" {
		source = gcodelog.SourceController
	}
	r := Run{
		ID:         h.nextID,
		Source:     source,
		File:       file,
		StartedAt:  when,
		Active:     true,
		StartState: st.State,
	}
	h.nextID++
	h.runs = append(h.runs, r)
	if len(h.runs) > h.cap {
		h.runs = append([]Run(nil), h.runs[len(h.runs)-h.cap:]...)
	}
	h.active = &h.runs[len(h.runs)-1]
	h.lastFeed = nil
	h.lastSpin = nil
	h.addTransitionLocked(st, when)
	h.lastState = st.State
}

func (h *History) updateActiveLocked(st machine.Status, when time.Time) {
	h.active.DurationMs = when.Sub(h.active.StartedAt).Milliseconds()
	h.active.Progress = append([]float64(nil), st.Progress...)
	if h.lastState != st.State {
		h.addTransitionLocked(st, when)
	}
	if st.State == machine.Alarm {
		h.addAlarmLocked(st, when)
	}
	if st.Feed != nil && tripleChanged(h.lastFeed, st.Feed) {
		v := *st.Feed
		h.active.FeedOverrides = append(h.active.FeedOverrides, OverrideEvent{
			Time: when, Current: v.Current, Target: v.Target, Override: v.Override,
		})
		h.lastFeed = &v
	}
	if st.Spindle != nil && spindleChanged(h.lastSpin, st.Spindle) {
		v := *st.Spindle
		h.active.SpindleOverrides = append(h.active.SpindleOverrides, OverrideEvent{
			Time: when, Current: v.CurrentRPM, Target: v.TargetRPM, Override: v.Override,
		})
		h.lastSpin = &v
	}
}

func (h *History) addTransitionLocked(st machine.Status, when time.Time) {
	h.active.StateTransitions = append(h.active.StateTransitions, StateTransition{
		Time:  when,
		State: st.State,
		Raw:   st.Raw,
	})
}

func (h *History) addAlarmLocked(st machine.Status, when time.Time) {
	var reason *machine.HaltReason
	if st.HaltReason != nil {
		cp := *st.HaltReason
		reason = &cp
	}
	n := len(h.active.Alarms)
	if n > 0 && h.active.Alarms[n-1].HaltReason != nil && reason != nil &&
		h.active.Alarms[n-1].HaltReason.Code == reason.Code {
		return
	}
	h.active.Alarms = append(h.active.Alarms, AlarmEvent{Time: when, HaltReason: reason, Raw: st.Raw})
}

func (h *History) endLocked(st machine.Status, when time.Time) {
	h.active.Active = false
	h.active.EndState = st.State
	h.active.EndedAt = &when
	h.active.DurationMs = when.Sub(h.active.StartedAt).Milliseconds()
	h.active = nil
	h.pending = pendingFile{}
}

func startsRun(st machine.Status) bool {
	if st.State == machine.Run {
		return true
	}
	return len(st.Progress) > 0 && st.State != machine.Idle && st.State != machine.Unknown
}

func endsRun(st machine.Status) bool {
	switch st.State {
	case machine.Idle, machine.Sleep, machine.Alarm, machine.Unknown:
		return true
	default:
		return false
	}
}

func statusTime(st machine.Status) time.Time {
	if !st.ObservedAt.IsZero() {
		return st.ObservedAt
	}
	return time.Now()
}

func lineTime(t time.Time) time.Time {
	if !t.IsZero() {
		return t
	}
	return time.Now()
}

func extractRunFile(text string) string {
	trimmed := strings.TrimSpace(text)
	lower := strings.ToLower(trimmed)
	for _, prefix := range []string{"play ", "m32 ", "m23 "} {
		if strings.HasPrefix(lower, prefix) {
			return strings.Trim(strings.TrimSpace(trimmed[len(prefix):]), `"'`)
		}
	}
	return ""
}

func tripleChanged(a, b *machine.Triple) bool {
	if a == nil || b == nil {
		return a != b
	}
	// Current feed continuously follows the toolpath and is not an operator
	// override. Retaining it here would turn every status poll into history.
	return a.Target != b.Target || a.Override != b.Override
}

func spindleChanged(a, b *machine.Spindle) bool {
	if a == nil || b == nil {
		return a != b
	}
	// Actual RPM naturally drifts around the requested value. The timeline
	// records only a programmed target or override change.
	return a.TargetRPM != b.TargetRPM || a.Override != b.Override
}

func copyRun(in Run) Run {
	out := in
	if in.EndedAt != nil {
		t := *in.EndedAt
		out.EndedAt = &t
	}
	out.StateTransitions = append([]StateTransition(nil), in.StateTransitions...)
	out.Alarms = append([]AlarmEvent(nil), in.Alarms...)
	for i := range out.Alarms {
		if out.Alarms[i].HaltReason != nil {
			reason := *out.Alarms[i].HaltReason
			out.Alarms[i].HaltReason = &reason
		}
	}
	out.FeedOverrides = append([]OverrideEvent(nil), in.FeedOverrides...)
	out.SpindleOverrides = append([]OverrideEvent(nil), in.SpindleOverrides...)
	out.Commands = append([]CommandEvent(nil), in.Commands...)
	out.Progress = append([]float64(nil), in.Progress...)
	return out
}
