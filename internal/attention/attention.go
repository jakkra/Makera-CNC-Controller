// Package attention derives human-attention events from the machine status
// stream. It is deliberately read-only: observing or resolving an event never
// sends a command to the machine.
package attention

import (
	"path"
	"sync"
	"time"

	"github.com/uwin/cnc-proxy/internal/machine"
)

// Kind is the operator-facing class of an attention event.
type Kind string

const (
	KindToolChange  Kind = "tool_change"
	KindRotaryIndex Kind = "rotary_index"
	KindPause       Kind = "pause"
	KindWait        Kind = "wait"
	KindHold        Kind = "hold"
	KindAlarm       Kind = "alarm"
)

// ChangeKind describes how a retained event changed.
type ChangeKind string

const (
	ChangeOpened   ChangeKind = "opened"
	ChangeUpdated  ChangeKind = "updated"
	ChangeResolved ChangeKind = "resolved"
)

// Context supplies job metadata known outside the firmware status payload.
type Context struct {
	JobPath string
	Marker  *Marker
}

// Marker is trusted metadata parsed from a generated G-code attention marker.
// It describes why an intentional firmware pause exists.
type Marker struct {
	Type        string   `json:"type"`
	Axis        string   `json:"axis,omitempty"`
	Target      *float64 `json:"target,omitempty"`
	Operation   string   `json:"operation,omitempty"`
	Instruction string   `json:"instruction,omitempty"`
	Line        int64    `json:"line,omitempty"`
}

// Event is one period in which the machine needs human attention.
type Event struct {
	ID         int64               `json:"id"`
	Kind       Kind                `json:"kind"`
	State      machine.State       `json:"state"`
	JobPath    string              `json:"job_path,omitempty"`
	JobName    string              `json:"job_name,omitempty"`
	StartedAt  time.Time           `json:"started_at"`
	ResolvedAt *time.Time          `json:"resolved_at,omitempty"`
	Active     bool                `json:"active"`
	Tool       *machine.ToolStatus `json:"tool,omitempty"`
	HaltReason *machine.HaltReason `json:"halt_reason,omitempty"`
	Marker     *Marker             `json:"marker,omitempty"`
	Raw        string              `json:"raw,omitempty"`
}

// Change is published to live subscribers whenever an event opens, gains
// material detail, or resolves.
type Change struct {
	Kind  ChangeKind `json:"change"`
	Event Event      `json:"event"`
}

// Snapshot is the read model returned by the API.
type Snapshot struct {
	Active *Event  `json:"active"`
	Events []Event `json:"events"`
}

// Monitor keeps a bounded in-memory event history and deduplicates repeated
// status polls. Durable restoration can be added later without changing the
// public event shape.
type Monitor struct {
	mu        sync.Mutex
	cap       int
	now       func() time.Time
	events    []Event
	nextID    int64
	active    int // index in events, -1 when none
	lastState machine.State
	subs      map[int]chan Change
	nextSub   int
}

// New creates a monitor retaining at most capacity events.
func New(capacity int) *Monitor {
	if capacity <= 0 {
		capacity = 100
	}
	return &Monitor{
		cap:    capacity,
		now:    time.Now,
		nextID: 1,
		active: -1,
		subs:   map[int]chan Change{},
	}
}

// ObserveStatus consumes a status already observed by the proxy. Repeated
// reports of the same state do not create duplicate events.
func (m *Monitor) ObserveStatus(st machine.Status, ctx Context) {
	when := st.ObservedAt
	if when.IsZero() {
		when = m.now()
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if st.State == m.lastState {
		if m.updateActiveLocked(st, ctx) {
			m.publishLocked(Change{Kind: ChangeUpdated, Event: copyEvent(m.events[m.active])})
		}
		return
	}

	kind, opensAttention := kindForStatus(st.State, ctx)
	if m.active >= 0 && opensAttention && continuesEpisode(m.events[m.active], st.State, kind) {
		event := &m.events[m.active]
		event.State = st.State
		if kind == KindRotaryIndex {
			event.Kind = kind
		}
		m.updateActiveLocked(st, ctx)
		m.lastState = st.State
		m.publishLocked(Change{Kind: ChangeUpdated, Event: copyEvent(*event)})
		return
	}

	if m.active >= 0 {
		m.resolveActiveLocked(when)
	}
	m.lastState = st.State

	if !opensAttention {
		return
	}

	event := Event{
		ID:         m.nextID,
		Kind:       kind,
		State:      st.State,
		JobPath:    ctx.JobPath,
		JobName:    jobName(ctx.JobPath),
		StartedAt:  when,
		Active:     true,
		Tool:       copyTool(st.Tool),
		HaltReason: copyHaltReason(st.HaltReason),
		Marker:     copyMarker(ctx.Marker),
		Raw:        st.Raw,
	}
	m.nextID++
	m.events = append(m.events, event)
	if len(m.events) > m.cap {
		drop := len(m.events) - m.cap
		m.events = append([]Event(nil), m.events[drop:]...)
	}
	m.active = len(m.events) - 1
	m.publishLocked(Change{Kind: ChangeOpened, Event: copyEvent(m.events[m.active])})
}

// Snapshot returns the active event and recent history, newest first.
func (m *Monitor) Snapshot() Snapshot {
	m.mu.Lock()
	defer m.mu.Unlock()

	out := Snapshot{Events: make([]Event, 0, len(m.events))}
	for i := len(m.events) - 1; i >= 0; i-- {
		out.Events = append(out.Events, copyEvent(m.events[i]))
	}
	if m.active >= 0 {
		active := copyEvent(m.events[m.active])
		out.Active = &active
	}
	return out
}

// Subscribe returns future changes. Call Snapshot first when an initial view is
// required; current state is intentionally not replayed on this channel.
func (m *Monitor) Subscribe() (<-chan Change, func()) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id := m.nextSub
	m.nextSub++
	ch := make(chan Change, 32)
	m.subs[id] = ch
	return ch, func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		if current, ok := m.subs[id]; ok {
			delete(m.subs, id)
			close(current)
		}
	}
}

func (m *Monitor) updateActiveLocked(st machine.Status, ctx Context) bool {
	if m.active < 0 || m.events[m.active].State != st.State {
		return false
	}
	event := &m.events[m.active]
	changed := false
	if event.JobPath == "" && ctx.JobPath != "" {
		event.JobPath = ctx.JobPath
		event.JobName = jobName(ctx.JobPath)
		changed = true
	}
	if !sameTool(event.Tool, st.Tool) && st.Tool != nil {
		event.Tool = copyTool(st.Tool)
		changed = true
	}
	if !sameHaltReason(event.HaltReason, st.HaltReason) && st.HaltReason != nil {
		event.HaltReason = copyHaltReason(st.HaltReason)
		changed = true
	}
	if event.Marker == nil && ctx.Marker != nil {
		event.Marker = copyMarker(ctx.Marker)
		event.Kind = KindRotaryIndex
		changed = true
	}
	if event.Raw == "" && st.Raw != "" {
		event.Raw = st.Raw
		changed = true
	}
	return changed
}

func (m *Monitor) resolveActiveLocked(when time.Time) {
	event := &m.events[m.active]
	event.Active = false
	resolved := when
	event.ResolvedAt = &resolved
	m.publishLocked(Change{Kind: ChangeResolved, Event: copyEvent(*event)})
	m.active = -1
}

func (m *Monitor) publishLocked(change Change) {
	for _, ch := range m.subs {
		select {
		case ch <- change:
		default:
		}
	}
}

func kindForStatus(state machine.State, ctx Context) (Kind, bool) {
	if ctx.Marker != nil && ctx.Marker.Type == string(KindRotaryIndex) && (state == machine.Wait || state == machine.Pause) {
		return KindRotaryIndex, true
	}
	switch state {
	case machine.Tool:
		return KindToolChange, true
	case machine.Pause:
		return KindPause, true
	case machine.Wait:
		return KindWait, true
	case machine.Hold:
		return KindHold, true
	case machine.Alarm:
		return KindAlarm, true
	default:
		return "", false
	}
}

func continuesEpisode(active Event, nextState machine.State, nextKind Kind) bool {
	if active.Kind == KindAlarm || nextKind == KindAlarm {
		return false
	}
	if active.Kind == KindRotaryIndex {
		return nextState == machine.Wait || nextState == machine.Pause
	}
	if active.Kind == KindToolChange {
		return nextState == machine.Tool || nextState == machine.Wait || nextState == machine.Pause
	}
	return (active.State == machine.Wait || active.State == machine.Pause || active.State == machine.Hold) &&
		(nextState == machine.Wait || nextState == machine.Pause || nextState == machine.Hold)
}

func jobName(jobPath string) string {
	if jobPath == "" {
		return ""
	}
	return path.Base(jobPath)
}

func copyEvent(in Event) Event {
	out := in
	if in.ResolvedAt != nil {
		v := *in.ResolvedAt
		out.ResolvedAt = &v
	}
	out.Tool = copyTool(in.Tool)
	out.HaltReason = copyHaltReason(in.HaltReason)
	out.Marker = copyMarker(in.Marker)
	return out
}

func copyMarker(in *Marker) *Marker {
	if in == nil {
		return nil
	}
	out := *in
	if in.Target != nil {
		v := *in.Target
		out.Target = &v
	}
	return &out
}

func copyTool(in *machine.ToolStatus) *machine.ToolStatus {
	if in == nil {
		return nil
	}
	out := *in
	if in.Target != nil {
		v := *in.Target
		out.Target = &v
	}
	return &out
}

func copyHaltReason(in *machine.HaltReason) *machine.HaltReason {
	if in == nil {
		return nil
	}
	out := *in
	return &out
}

func sameTool(a, b *machine.ToolStatus) bool {
	if a == nil || b == nil {
		return a == b
	}
	if a.Active != b.Active || a.Offset != b.Offset {
		return false
	}
	if a.Target == nil || b.Target == nil {
		return a.Target == nil && b.Target == nil
	}
	return *a.Target == *b.Target
}

func sameHaltReason(a, b *machine.HaltReason) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Code == b.Code && a.Message == b.Message && a.Recovery == b.Recovery && a.Severity == b.Severity
}
