// Package jog implements the low-latency, server-side gamepad jogging engine.
package jog

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/uwin/cnc-proxy/internal/client"
	"github.com/uwin/cnc-proxy/internal/gcodelog"
	"github.com/uwin/cnc-proxy/internal/machine"
	"github.com/uwin/cnc-proxy/internal/protocol"
	"github.com/uwin/cnc-proxy/internal/session"
)

const (
	CodeDisabled          = "disabled"
	CodeNotIdle           = "not_idle"
	CodeBusy              = "busy"
	CodeStaleStatus       = "stale_status"
	CodeStatusWaiting     = "status_waiting"
	CodeTargetNotReached  = "target_not_reached"
	CodeBadInput          = "bad_input"
	CodeControllerWaiting = "controller_waiting"
	CodeMachineError      = "machine_error"
	CodeUnauthorized      = "unauthorized"

	deadzone        = 0.12
	slowScale       = 0.2
	baseMaxXYLeadMM = 2.5
	baseMaxZLeadMM  = 1.0
	baseMaxALeadDeg = 8.0
	// The firmware's `$J ... F` argument is a scale of the slowest selected
	// actuator max rate, not a feedrate. These match CarveraFirmware
	// config.default for XYZ. Firmware accepts scales above 1; the firmware
	// planner may still cap real hardware at configured machine limits.
	firmwareMaxXYMMMin        = 3000.0
	firmwareMaxZMMMin         = 2000.0
	firmwareMaxADegMin        = 3600.0
	minJogTick                = 5 * time.Millisecond
	minStatusEvery            = 100 * time.Millisecond
	minDeadmanTimeout         = 300 * time.Millisecond
	minJogSegment             = 60 * time.Millisecond
	maxJogSegment             = 100 * time.Millisecond
	minJogLookahead           = 120 * time.Millisecond
	maxJogLookahead           = 180 * time.Millisecond
	minActiveStatusGap        = time.Second
	maxActiveStatusGap        = 2 * time.Second
	maxSegmentsPerTick        = 2
	motionLogGap              = time.Second
	motionEventGap            = 33 * time.Millisecond
	statusWaitGap             = 500 * time.Millisecond
	maxManualStepMM           = 50.0
	maxManualStepDegrees      = 360.0
	maxTargetFeedMMMin        = 10000.0
	jogCoordinateResolutionMM = 0.0001
	targetPositionToleranceMM = 0.02
	minTargetVerifyGrace      = 2 * time.Second
)

// Config controls the jog engine.
type Config struct {
	Enabled         bool
	MaxXYMMMin      float64
	MaxZMMMin       float64
	MaxADegMin      float64
	Tick            time.Duration
	StatusInterval  time.Duration
	DeadmanTimeout  time.Duration
	MotionPrimitive MotionPrimitive
	SoftLimits      func() SoftLimits
	Log             Logger
}

// SoftLimits is the learned machine-coordinate envelope enforced by the
// firmware. The callback in Config keeps this profile current after a machine
// learning refresh without rebuilding active browser sessions.
type SoftLimits struct {
	Enabled    bool
	XMin, XMax float64
	YMin, YMax float64
	ZMin, ZMax float64
}

// MotionPrimitive selects the wire command used for one jog segment.
type MotionPrimitive string

const (
	// MotionPrimitiveInstant uses the firmware SimpleShell `$J` path. It plans a
	// relative XYZ delta without touching modal G90/G91 state and force-starts
	// the conveyor queue, which makes gamepad jogs lower latency than normal G0.
	MotionPrimitiveInstant MotionPrimitive = "instant"
	// MotionPrimitiveG53 keeps the older absolute machine-coordinate G53 G0
	// segment path as a fallback.
	MotionPrimitiveG53 MotionPrimitive = "g53"
)

// Logger records operational jog activity without coupling the jog engine to
// the API/service layer.
type Logger interface {
	Append(dir, source, text string)
}

// DefaultConfig returns production-safe defaults.
func DefaultConfig() Config {
	return Config{
		Enabled:         true,
		MaxXYMMMin:      firmwareMaxXYMMMin,
		MaxZMMMin:       300,
		MaxADegMin:      firmwareMaxADegMin,
		Tick:            20 * time.Millisecond,
		StatusInterval:  100 * time.Millisecond,
		DeadmanTimeout:  minDeadmanTimeout,
		MotionPrimitive: MotionPrimitiveInstant,
	}
}

func (c Config) normalize() Config {
	d := DefaultConfig()
	if c.MaxXYMMMin <= 0 {
		c.MaxXYMMMin = d.MaxXYMMMin
	}
	if c.MaxZMMMin <= 0 {
		c.MaxZMMMin = d.MaxZMMMin
	}
	if c.MaxADegMin <= 0 {
		c.MaxADegMin = d.MaxADegMin
	}
	if c.Tick <= 0 {
		c.Tick = d.Tick
	}
	if c.Tick < minJogTick {
		c.Tick = minJogTick
	}
	if c.StatusInterval <= 0 {
		c.StatusInterval = d.StatusInterval
	}
	if c.StatusInterval < minStatusEvery {
		c.StatusInterval = minStatusEvery
	}
	if c.DeadmanTimeout <= 0 {
		c.DeadmanTimeout = d.DeadmanTimeout
	}
	if c.DeadmanTimeout < minDeadmanTimeout {
		c.DeadmanTimeout = minDeadmanTimeout
	}
	switch c.MotionPrimitive {
	case "", MotionPrimitiveInstant:
		c.MotionPrimitive = MotionPrimitiveInstant
	case MotionPrimitiveG53:
	default:
		c.MotionPrimitive = d.MotionPrimitive
	}
	return c
}

// Axes is a normalized XYZ+A jog vector. XYZ values are linear motion and A is
// rotary motion; normalized inputs remain dimensionless while generated
// deltas use millimetres for XYZ and degrees for A.
type Axes struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	Z float64 `json:"z"`
	A float64 `json:"a"`
}

// Input is the latest operator intent from the gamepad client.
type Input struct {
	Seq     int64
	Axes    Axes
	Deadman bool
	Slow    bool
	At      time.Time
}

// Availability explains whether a new jog session can arm right now.
type Availability struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
	Message   string `json:"message,omitempty"`
}

// Capabilities is returned by /api/jog/capabilities.
type Capabilities struct {
	Enabled          bool         `json:"enabled"`
	Axes             []string     `json:"axes"`
	MaxXYMMMin       float64      `json:"max_xy_mm_min"`
	MaxZMMMin        float64      `json:"max_z_mm_min"`
	MaxADegMin       float64      `json:"max_a_deg_min"`
	TickMs           int64        `json:"tick_ms"`
	StatusIntervalMs int64        `json:"status_interval_ms"`
	DeadmanTimeoutMs int64        `json:"deadman_timeout_ms"`
	Availability     Availability `json:"availability"`
}

// Event is a WebSocket-ready server message.
type Event struct {
	Type         string             `json:"type"`
	Seq          int64              `json:"seq,omitempty"`
	Code         string             `json:"code,omitempty"`
	Message      string             `json:"message,omitempty"`
	Armed        *bool              `json:"armed,omitempty"`
	Mode         string             `json:"mode,omitempty"`
	Availability *Availability      `json:"availability,omitempty"`
	Capabilities *Capabilities      `json:"capabilities,omitempty"`
	Status       *StatusEvent       `json:"status,omitempty"`
	Motion       *MotionEvent       `json:"motion,omitempty"`
	Position     *PositionEvent     `json:"position,omitempty"`
	Target       machine.AxisValues `json:"target,omitempty"`
	LatencyMs    int64              `json:"latency_ms,omitempty"`
}

// StatusEvent is the status subset streamed to jog clients.
type StatusEvent struct {
	State                 machine.State      `json:"state"`
	AgeMs                 int64              `json:"age_ms"`
	ObservedAt            time.Time          `json:"observed_at,omitempty"`
	Raw                   string             `json:"raw,omitempty"`
	MPos                  machine.AxisValues `json:"mpos,omitempty"`
	WPos                  machine.AxisValues `json:"wpos,omitempty"`
	MotionRevision        uint64             `json:"motion_revision"`
	SettledMotionRevision uint64             `json:"settled_motion_revision"`
}

// MotionEvent reports one server-generated jog segment for visualization and
// low-rate telemetry. It is best-effort; slow clients may miss motion events.
type MotionEvent struct {
	Target        machine.AxisValues `json:"target,omitempty"`
	Observed      machine.AxisValues `json:"observed,omitempty"`
	Estimated     machine.AxisValues `json:"estimated,omitempty"`
	EstimatedWPos machine.AxisValues `json:"estimated_wpos,omitempty"`
	Delta         Axes               `json:"delta"`
	Lead          Axes               `json:"lead"`
	QueueLeadMs   int64              `json:"queue_lead_ms,omitempty"`
	Revision      uint64             `json:"revision"`
	Command       string             `json:"command,omitempty"`
}

// PositionEvent is an immutable machine/work-coordinate snapshot of the
// planned stop boundary. It lets an operator capture a point and immediately
// resume jogging without a later status report moving that captured point.
type PositionEvent struct {
	MPos           machine.AxisValues `json:"mpos"`
	WPos           machine.AxisValues `json:"wpos"`
	MotionRevision uint64             `json:"motion_revision"`
}

type motionRevisions struct {
	motion  uint64
	settled uint64
}

type command struct {
	typ      string
	seq      int64
	complete chan struct{}
	action   string
	axis     string
	distance float64
	value    float64
	target   machine.AxisValues
	feed     float64
	safeZOn  bool
	safeZ    float64
}

type statusResult struct {
	leaseID int64
	payload string
	err     error
}

// statusReconnectError marks a jog connection as unusable after it has failed
// to produce any valid status for the arbiter's full freshness window. It
// implements net.Error so JogLease.Release discards the owner connection and
// lets the normal poller establish a new machine conversation.
type statusReconnectError struct {
	cause error
}

func (e statusReconnectError) Error() string {
	return "machine status stopped responding; movement was disarmed so the proxy can reconnect"
}

func (e statusReconnectError) Unwrap() error   { return e.cause }
func (e statusReconnectError) Timeout() bool   { return false }
func (e statusReconnectError) Temporary() bool { return false }

type plannedSegment struct {
	start time.Time
	end   time.Time
	from  machine.AxisValues
	to    machine.AxisValues
}

type pendingTarget struct {
	seq          int64
	target       machine.AxisValues
	motionDoneAt time.Time
	verifyAfter  time.Time
}

// Manager owns all connected jog UI sessions and the single session allowed to
// hold movement control. Observers stay connected while another UI is armed.
type Manager struct {
	cfg Config
	arb *session.Arbiter

	mu       sync.Mutex
	sessions map[*Session]struct{}
	owner    *Session
	now      func() time.Time

	motionRevision  uint64
	settledRevision uint64
}

// New creates a Manager.
func New(arb *session.Arbiter, cfg Config) *Manager {
	cfg = cfg.normalize()
	return &Manager{cfg: cfg, arb: arb, sessions: make(map[*Session]struct{}), now: time.Now}
}

// Config returns the normalized config.
func (m *Manager) Config() Config { return m.cfg }

func (m *Manager) softLimits() SoftLimits {
	if m.cfg.SoftLimits == nil {
		return SoftLimits{}
	}
	return m.cfg.SoftLimits()
}

func (m *Manager) markMotion() uint64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.motionRevision++
	return m.motionRevision
}

func (m *Manager) markSettled() motionRevisions {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.settledRevision = m.motionRevision
	return motionRevisions{motion: m.motionRevision, settled: m.settledRevision}
}

func (m *Manager) motionRevisions() motionRevisions {
	m.mu.Lock()
	defer m.mu.Unlock()
	return motionRevisions{motion: m.motionRevision, settled: m.settledRevision}
}

// Capabilities reports static limits plus current availability.
func (m *Manager) Capabilities() Capabilities {
	return m.capabilities(nil)
}

func (m *Manager) capabilities(ignore *Session) Capabilities {
	return Capabilities{
		Enabled:          m.cfg.Enabled,
		Axes:             []string{"x", "y", "z", "a"},
		MaxXYMMMin:       m.cfg.MaxXYMMMin,
		MaxZMMMin:        m.cfg.MaxZMMMin,
		MaxADegMin:       m.cfg.MaxADegMin,
		TickMs:           m.cfg.Tick.Milliseconds(),
		StatusIntervalMs: m.cfg.StatusInterval.Milliseconds(),
		DeadmanTimeoutMs: m.cfg.DeadmanTimeout.Milliseconds(),
		Availability:     m.availability(ignore),
	}
}

// Availability reports whether a new session can arm right now.
func (m *Manager) Availability() Availability {
	return m.availability(nil)
}

func (m *Manager) availability(ignore *Session) Availability {
	if !m.cfg.Enabled {
		return Availability{Available: false, Reason: CodeDisabled, Message: "Jogging is disabled."}
	}
	m.mu.Lock()
	owner := m.owner
	m.mu.Unlock()
	if owner != nil && owner != ignore {
		return Availability{Available: false, Reason: CodeBusy, Message: "Movement control is held by another UI. Disarm it before taking control."}
	}
	st, _ := m.arb.Tracker().Current()
	activeJog := ignore != nil && owner == ignore && ignore.hasLease()
	if !m.arb.Tracker().Fresh(m.arb.StateMaxAge()) {
		return Availability{Available: false, Reason: CodeStaleStatus, Message: "Machine status is stale. Wait for a fresh Idle status before jogging."}
	}
	if activeJog && canContinueJog(st.State) && len(st.MPos) > 0 {
		return Availability{Available: true, Message: "Jog session active."}
	}
	if st.State != machine.Idle {
		return Availability{Available: false, Reason: CodeNotIdle, Message: "Machine is " + stateLabel(st.State) + ". Jogging requires fresh Idle status."}
	}
	if len(st.MPos) == 0 {
		return Availability{Available: false, Reason: CodeStaleStatus, Message: "Machine position is unavailable. Wait for a status report with MPos before jogging."}
	}
	return Availability{Available: true, Message: "Ready to arm jog."}
}

// Start opens a connected UI session. Sessions remain observers until one of
// them exclusively arms movement and acquires the machine lease.
func (m *Manager) Start(ctx context.Context) (*Session, error) {
	if !m.cfg.Enabled {
		return nil, Error{Code: CodeDisabled, Message: "jogging is disabled"}
	}
	ctx, cancel := context.WithCancel(ctx)
	s := &Session{
		mgr:      m,
		ctx:      ctx,
		cancel:   cancel,
		cmds:     make(chan command, 16),
		statusCh: make(chan statusResult, 4),
		events:   make(chan Event, 128),
		done:     make(chan struct{}),
	}
	s.admissionCond = sync.NewCond(&s.admissionMu)
	m.mu.Lock()
	m.sessions[s] = struct{}{}
	m.mu.Unlock()
	go s.run()
	return s, nil
}

func (m *Manager) unregister(s *Session) {
	m.mu.Lock()
	delete(m.sessions, s)
	if m.owner == s {
		m.owner = nil
	}
	m.mu.Unlock()
}

func (m *Manager) claimOwner(s *Session) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.owner != nil && m.owner != s {
		return false
	}
	m.owner = s
	return true
}

func (m *Manager) clearOwner(s *Session) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.owner != s {
		return false
	}
	m.owner = nil
	return true
}

func (m *Manager) ownerSession() *Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.owner
}

func (m *Manager) broadcastState(source *Session, seq int64) {
	for _, s := range m.connectedSessions() {
		eventSeq := int64(0)
		if s == source {
			eventSeq = seq
		}
		s.emitOwnState(eventSeq)
	}
}

func (m *Manager) broadcastEvent(ev Event) {
	for _, s := range m.connectedSessions() {
		s.emit(ev)
	}
}

func (m *Manager) connectedSessions() []*Session {
	m.mu.Lock()
	sessions := make([]*Session, 0, len(m.sessions))
	for s := range m.sessions {
		sessions = append(sessions, s)
	}
	m.mu.Unlock()
	return sessions
}

// DisarmActive releases the machine lease held by the current jog session.
// It waits for the session loop to process the disarm so callers may safely
// begin work that needs the arbiter operation lock after this method returns.
func (m *Manager) DisarmActive(ctx context.Context) error {
	owner := m.ownerSession()
	if owner == nil {
		return nil
	}
	return owner.disarmAndWait(ctx)
}

// Error is a stable jog error with an API code.
type Error struct {
	Code    string
	Message string
}

func (e Error) Error() string {
	if e.Message == "" {
		return e.Code
	}
	return e.Message
}

// Session is one active WebSocket jog session.
type Session struct {
	mgr    *Manager
	ctx    context.Context
	cancel context.CancelFunc

	cmds     chan command
	statusCh chan statusResult
	events   chan Event
	done     chan struct{}
	once     sync.Once
	emitMu   sync.Mutex
	closed   bool
	// admissionMu coordinates latest-input changes with continuous-jog segment
	// admission without delaying a stop behind a slow socket write. Capture
	// closes the admission gate, waits for the one in-flight segment to commit,
	// then snapshots a boundary that later input cannot change.
	admissionMu       sync.Mutex
	admissionCond     *sync.Cond
	admissionInFlight bool
	captureBarrier    bool

	mu              sync.Mutex
	latest          Input
	haveInput       bool
	armed           bool
	lease           *session.JogLease
	leaseID         int64
	statusInFlight  bool
	statusRetry     bool
	statusFailures  int
	nextStatusAt    time.Time
	statusWG        sync.WaitGroup
	lastStatus      machine.Status
	lastStatusAt    time.Time
	planned         machine.AxisValues
	queuedUntil     time.Time
	segments        []plannedSegment
	lastMotionCmd   string
	lastMotionEvent time.Time
	lastStatusWait  time.Time
	lastAlarmRaw    string
	lastMotionLog   time.Time
	targetPending   *pendingTarget
}

// Events streams server messages until the session closes.
func (s *Session) Events() <-chan Event { return s.events }

// Close ends the session.
func (s *Session) Close() {
	s.once.Do(func() {
		s.cancel()
		<-s.done
	})
}

// Arm requests the machine lease.
func (s *Session) Arm(seq int64) { s.enqueue(command{typ: "arm", seq: seq}) }

// Disarm releases the machine lease.
func (s *Session) Disarm(seq int64) { s.enqueue(command{typ: "disarm", seq: seq}) }

func (s *Session) disarmAndWait(ctx context.Context) error {
	complete := make(chan struct{})
	cmd := command{typ: "disarm", complete: complete}
	select {
	case s.cmds <- cmd:
	case <-s.ctx.Done():
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case <-complete:
		return nil
	case <-s.ctx.Done():
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Control sends an out-of-band realtime control.
func (s *Session) Control(seq int64, action string) {
	s.enqueue(command{typ: "control", seq: seq, action: action})
}

// Step requests one explicit axis jog from an armed session.
func (s *Session) Step(seq int64, axis string, distance float64) {
	s.enqueue(command{typ: "step", seq: seq, axis: axis, distance: distance})
}

// SetOrigin sets the current work-coordinate axis value.
func (s *Session) SetOrigin(seq int64, axis string, value float64) {
	s.enqueue(command{typ: "origin", seq: seq, axis: axis, value: value})
}

// SetMachineOrigin sets the XY work offset from an absolute machine-coordinate
// origin, matching the vendor controller's single G10 L2 P0 transaction.
func (s *Session) SetMachineOrigin(seq int64, origin machine.AxisValues) {
	s.enqueue(command{typ: "machine_origin", seq: seq, target: copyAxes(origin)})
}

// Target requests one explicit XY move from an armed session.
func (s *Session) Target(seq int64, target machine.AxisValues, feedMMMin float64, safeZEnabled bool, safeZMM float64) {
	s.enqueue(command{typ: "target", seq: seq, target: copyAxes(target), feed: feedMMMin, safeZOn: safeZEnabled, safeZ: safeZMM})
}

// ReportError emits a client-facing validation error.
func (s *Session) ReportError(seq int64, code, msg string) {
	s.emit(Event{Type: "error", Seq: seq, Code: code, Message: msg})
}

// SetInput replaces the latest gamepad intent. Inputs are never queued. It
// records a stop without waiting on a slow socket write; that in-flight segment
// observes the changed input after it commits and no follow-up is admitted.
func (s *Session) SetInput(in Input) {
	if in.At.IsZero() {
		in.At = s.mgr.now()
	}
	s.admissionMu.Lock()
	s.mu.Lock()
	s.latest = in
	s.haveInput = true
	s.mu.Unlock()
	s.admissionMu.Unlock()
}

// CapturePosition freezes the endpoint at which the currently admitted jog
// queue will stop. Capture is a movement-admission barrier: it cancels the
// current input intent, waits for any segment write already in progress, and
// snapshots planned before a later input can resume motion.
func (s *Session) CapturePosition(seq int64) {
	s.admissionMu.Lock()
	now := s.mgr.now()
	s.mu.Lock()
	if s.lease == nil || !s.armed {
		s.mu.Unlock()
		s.admissionMu.Unlock()
		s.emit(Event{Type: "error", Seq: seq, Code: CodeBadInput, Message: "arm movement before capturing an outline point"})
		return
	}
	// The capture itself defines a stop boundary even if the browser's neutral
	// input frame was delayed. A later input frame resumes from this boundary.
	s.latest = Input{Seq: seq, At: now}
	s.haveInput = true
	s.captureBarrier = true
	s.mu.Unlock()
	for s.admissionInFlight {
		s.admissionCond.Wait()
	}
	s.mu.Lock()
	if s.lease == nil || !s.armed {
		s.mu.Unlock()
		s.captureBarrier = false
		s.admissionCond.Broadcast()
		s.admissionMu.Unlock()
		s.emit(Event{Type: "error", Seq: seq, Code: CodeMachineError, Message: "movement stopped before the outline position was captured"})
		return
	}
	mpos := copyAxes(s.planned)
	st := s.lastStatus
	if len(mpos) == 0 {
		mpos = copyAxes(st.MPos)
	}
	wpos := estimatedWorkPosition(mpos, st)
	revisions := s.mgr.motionRevisions()
	s.mu.Unlock()
	s.captureBarrier = false
	s.admissionCond.Broadcast()
	s.admissionMu.Unlock()

	if !hasXYZ(mpos) || !hasXYZ(wpos) {
		s.emit(Event{Type: "error", Seq: seq, Code: CodeStaleStatus, Message: "machine and work positions are unavailable for outline capture"})
		return
	}
	s.emit(Event{
		Type: "position_capture",
		Seq:  seq,
		Position: &PositionEvent{
			MPos:           copyAxes(mpos),
			WPos:           copyAxes(wpos),
			MotionRevision: revisions.motion,
		},
	})
}

func (s *Session) enqueue(cmd command) {
	select {
	case s.cmds <- cmd:
	case <-s.ctx.Done():
	default:
		s.emit(Event{Type: "error", Seq: cmd.seq, Code: CodeBusy, Message: "jog command queue is full"})
	}
}

func (s *Session) run() {
	defer func() {
		s.release(nil)
		s.mgr.unregister(s)
		s.closeEvents()
		s.mgr.broadcastState(nil, 0)
		close(s.done)
	}()
	s.emit(Event{Type: "hello", Capabilities: ptr(s.mgr.capabilities(s))})

	tick := time.NewTicker(s.mgr.cfg.Tick)
	defer tick.Stop()
	statusTick := time.NewTicker(s.mgr.cfg.StatusInterval)
	defer statusTick.Stop()
	var deferred []command

	for {
		if len(deferred) > 0 && !s.statusTransactionBusy() {
			cmd := deferred[0]
			deferred = deferred[1:]
			s.handleCommand(cmd)
			continue
		}
		var abort <-chan struct{}
		s.mu.Lock()
		if s.lease != nil {
			abort = s.lease.Abort
		}
		s.mu.Unlock()

		select {
		case <-s.ctx.Done():
			return
		case <-abort:
			s.release(nil)
			s.emit(Event{Type: "error", Code: CodeControllerWaiting, Message: "controller requested the machine connection"})
			s.emitState(0)
		case cmd := <-s.cmds:
			if commandNeedsClearStatusTransaction(cmd.typ) && s.statusTransactionBusy() {
				if len(deferred) >= cap(s.cmds) {
					s.emit(Event{Type: "error", Seq: cmd.seq, Code: CodeBusy, Message: "jog command queue is full"})
					continue
				}
				deferred = append(deferred, cmd)
				continue
			}
			if commandReleasesLease(cmd) {
				for _, pending := range deferred {
					s.emit(Event{Type: "error", Seq: pending.seq, Code: CodeBusy, Message: "movement command was canceled before it could run"})
				}
				deferred = nil
			}
			s.handleCommand(cmd)
		case res := <-s.statusCh:
			s.handleStatusResult(res)
		case <-statusTick.C:
			if s.shouldRequestStatus(s.mgr.now()) {
				s.requestStatus()
			}
		case <-tick.C:
			if s.hasLease() {
				s.motionTick()
			}
		}
	}
}

func (s *Session) handleCommand(cmd command) {
	if cmd.complete != nil {
		defer close(cmd.complete)
	}
	switch cmd.typ {
	case "arm":
		s.handleArm(cmd.seq)
	case "disarm":
		owner := s.mgr.ownerSession()
		if owner != nil && owner != s {
			ctx, cancel := context.WithTimeout(s.ctx, 2*time.Second)
			err := owner.disarmAndWait(ctx)
			cancel()
			if err != nil {
				s.emit(Event{Type: "error", Seq: cmd.seq, Code: CodeBusy, Message: "could not disarm movement control: " + err.Error()})
				return
			}
		} else {
			s.release(nil)
		}
		if cmd.seq != 0 {
			s.emit(Event{Type: "ack", Seq: cmd.seq})
		}
		s.emitState(cmd.seq)
	case "control":
		if err := s.sendControl(cmd.action); err != nil {
			s.emit(Event{Type: "error", Seq: cmd.seq, Code: CodeBadInput, Message: err.Error()})
			return
		}
		if cmd.action == "hold" || cmd.action == "feedhold" || cmd.action == "pause" || cmd.action == "halt" || cmd.action == "stop" || cmd.action == "estop" {
			s.release(nil)
		}
		s.emit(Event{Type: "ack", Seq: cmd.seq})
		s.emitState(cmd.seq)
	case "step":
		s.handleStep(cmd.seq, cmd.axis, cmd.distance)
	case "origin":
		s.handleOrigin(cmd.seq, cmd.axis, cmd.value)
	case "machine_origin":
		s.handleMachineOrigin(cmd.seq, cmd.target)
	case "target":
		s.handleTarget(cmd.seq, cmd.target, cmd.feed, cmd.safeZOn, cmd.safeZ)
	}
}

func (s *Session) handleStep(seq int64, axis string, distance float64) {
	axis = strings.ToLower(strings.TrimSpace(axis))
	delta, err := stepDelta(axis, distance)
	if err != nil {
		s.emit(Event{Type: "error", Seq: seq, Code: CodeBadInput, Message: err.Error()})
		return
	}
	now := s.mgr.now()
	s.mu.Lock()
	lease := s.lease
	st := s.lastStatus
	lastStatusAt := s.lastStatusAt
	planned := copyAxes(s.planned)
	queuedUntil := s.queuedUntil
	statusInFlight := s.statusInFlight
	targetPending := s.targetPending != nil
	s.mu.Unlock()
	if lease == nil {
		s.emit(Event{Type: "error", Seq: seq, Code: CodeBadInput, Message: "arm jog before using step buttons"})
		s.emitState(seq)
		return
	}
	if targetPending {
		s.emit(Event{Type: "error", Seq: seq, Code: CodeBusy, Message: "wait for the current tap move to reach its target"})
		return
	}
	if !canContinueJog(st.State) {
		if st.State == machine.Alarm {
			s.logAlarmStatus(st)
		}
		s.release(nil)
		s.emit(Event{Type: "error", Seq: seq, Code: CodeNotIdle, Message: "machine left joggable state: " + stateLabel(st.State)})
		s.emitState(seq)
		return
	}
	queuedLead := queueLead(now, queuedUntil)
	if (len(st.MPos) == 0 || now.Sub(lastStatusAt) > activeStatusMaxAge(s.mgr.cfg)) && queuedLead == 0 {
		if statusInFlight {
			s.emit(Event{Type: "error", Seq: seq, Code: CodeStatusWaiting, Message: "Waiting for fresh machine status before step jog."})
			return
		}
		s.emit(Event{Type: "error", Seq: seq, Code: CodeStatusWaiting, Message: "Waiting for fresh machine status before step jog."})
		s.requestStatus()
		return
	}
	if planned == nil || (queuedLead == 0 && statusObservedAfterQueue(lastStatusAt, queuedUntil)) {
		planned = copyAxes(st.MPos)
	}
	if planned == nil {
		s.emit(Event{Type: "error", Seq: seq, Code: CodeStaleStatus, Message: "machine position is unavailable"})
		return
	}
	if delta.A != 0 {
		a, ok := planned["a"]
		if !ok || math.IsNaN(a) || math.IsInf(a, 0) {
			s.emit(Event{Type: "error", Seq: seq, Code: CodeStaleStatus, Message: "machine A position is unavailable"})
			return
		}
	}

	target := copyAxes(planned)
	target["x"] += delta.X
	target["y"] += delta.Y
	target["z"] += delta.Z
	if delta.A != 0 {
		target["a"] += delta.A
	}
	target = clampJogTarget(planned, target, s.mgr.softLimits())
	delta = axesDelta(planned, target)
	if axesEmpty(delta) {
		s.emitMotionEstimate(now, st, target, delta, "", queuedLead)
		s.emit(Event{Type: "ack", Seq: seq, Target: target})
		return
	}
	dur := stepJogDuration(delta, s.mgr.cfg)
	cmd := jogCommandForDuration(target, delta, s.mgr.cfg, dur)
	if err := lease.Conn.WriteGcodeLine(cmd); err != nil {
		s.failLease(CodeMachineError, err)
		return
	}
	segStart := queuedUntil
	if segStart.Before(now) {
		segStart = now
	}
	segEnd := segStart.Add(dur)
	queuedUntil = segEnd
	queuedLead = queueLead(now, queuedUntil)
	s.mu.Lock()
	s.planned = target
	s.queuedUntil = queuedUntil
	s.segments = appendPlannedSegment(s.segments, plannedSegment{
		start: segStart,
		end:   segEnd,
		from:  copyAxes(planned),
		to:    copyAxes(target),
	}, now)
	s.mgr.markMotion()
	s.lastMotionCmd = cmd
	s.mu.Unlock()
	s.logMotion(now, cmd)
	s.emitMotionEstimate(now, st, target, delta, cmd, queuedLead)
	s.emit(Event{Type: "ack", Seq: seq, Target: target})
}

func (s *Session) handleOrigin(seq int64, axis string, value float64) {
	cmd, err := originCommand(axis, value)
	if err != nil {
		s.emit(Event{Type: "error", Seq: seq, Code: CodeBadInput, Message: err.Error()})
		return
	}
	s.handleOriginCommand(seq, cmd, nil)
}

func (s *Session) handleMachineOrigin(seq int64, origin machine.AxisValues) {
	cmd, err := machineOriginCommand(origin)
	if err != nil {
		s.emit(Event{Type: "error", Seq: seq, Code: CodeBadInput, Message: err.Error()})
		return
	}
	s.handleOriginCommand(seq, cmd, origin)
}

func (s *Session) handleOriginCommand(seq int64, cmd string, machineOrigin machine.AxisValues) {
	now := s.mgr.now()
	s.mu.Lock()
	lease := s.lease
	st := s.lastStatus
	lastStatusAt := s.lastStatusAt
	queuedUntil := s.queuedUntil
	statusInFlight := s.statusInFlight
	targetPending := s.targetPending != nil
	s.mu.Unlock()
	if lease == nil {
		s.emit(Event{Type: "error", Seq: seq, Code: CodeBadInput, Message: "arm tap move before setting origin"})
		s.emitState(seq)
		return
	}
	if targetPending {
		s.emit(Event{Type: "error", Seq: seq, Code: CodeBusy, Message: "wait for the current tap move to reach its target"})
		return
	}
	if st.State != machine.Idle {
		if st.State == machine.Alarm {
			s.logAlarmStatus(st)
			s.release(nil)
		} else if !canContinueJog(st.State) {
			s.release(nil)
		}
		s.emit(Event{Type: "error", Seq: seq, Code: CodeNotIdle, Message: "machine must be Idle to set origin: " + stateLabel(st.State)})
		s.emitState(seq)
		return
	}
	queuedLead := queueLead(now, queuedUntil)
	if queuedLead > 0 {
		s.emit(Event{Type: "error", Seq: seq, Code: CodeBusy, Message: "wait for queued jog motion to finish before setting origin"})
		return
	}
	if !statusObservedAfterQueue(lastStatusAt, queuedUntil) {
		s.emit(Event{Type: "error", Seq: seq, Code: CodeStatusWaiting, Message: "Waiting for fresh machine status before setting origin."})
		s.requestStatus()
		return
	}
	if len(st.MPos) == 0 || now.Sub(lastStatusAt) > activeStatusMaxAge(s.mgr.cfg) {
		if statusInFlight {
			s.emit(Event{Type: "error", Seq: seq, Code: CodeStatusWaiting, Message: "Waiting for fresh machine status before setting origin."})
			return
		}
		s.emit(Event{Type: "error", Seq: seq, Code: CodeStatusWaiting, Message: "Waiting for fresh machine status before setting origin."})
		s.requestStatus()
		return
	}
	if len(machineOrigin) > 0 {
		_, xOK := st.MPos["x"]
		_, yOK := st.MPos["y"]
		if !xOK || !yOK {
			s.emit(Event{Type: "error", Seq: seq, Code: CodeStaleStatus, Message: "machine XY position is unavailable"})
			return
		}
	}
	if err := lease.Conn.WriteGcodeLine(cmd); err != nil {
		s.failLease(CodeMachineError, err)
		return
	}
	s.log(gcodelog.DirSend, cmd)
	s.log(gcodelog.DirRecv, "ok")
	ack := Event{Type: "ack", Seq: seq}
	if len(machineOrigin) > 0 {
		ack.Target = machine.AxisValues{
			"x": st.MPos["x"] - machineOrigin["x"],
			"y": st.MPos["y"] - machineOrigin["y"],
		}
	}
	s.emit(ack)
	s.requestStatus()
}

func (s *Session) handleTarget(seq int64, targetAxes machine.AxisValues, feedMMMin float64, safeZEnabled bool, safeZMM float64) {
	if len(targetAxes) == 0 {
		s.emit(Event{Type: "error", Seq: seq, Code: CodeBadInput, Message: "target requires at least one axis"})
		return
	}
	for axis, value := range targetAxes {
		if axis != "x" && axis != "y" && axis != "z" {
			s.emit(Event{Type: "error", Seq: seq, Code: CodeBadInput, Message: "target axis must be one of: x, y, z"})
			return
		}
		if math.IsNaN(value) || math.IsInf(value, 0) {
			s.emit(Event{Type: "error", Seq: seq, Code: CodeBadInput, Message: "target requires finite coordinates"})
			return
		}
	}
	if safeZEnabled && (math.IsNaN(safeZMM) || math.IsInf(safeZMM, 0)) {
		s.emit(Event{Type: "error", Seq: seq, Code: CodeBadInput, Message: "safe Z must be finite"})
		return
	}
	cfg := s.mgr.cfg.normalize()
	if math.IsNaN(feedMMMin) || math.IsInf(feedMMMin, 0) || feedMMMin <= 0 || feedMMMin > maxTargetFeedMMMin {
		s.emit(Event{Type: "error", Seq: seq, Code: CodeBadInput, Message: fmt.Sprintf("feed must be between 1 and %.0f mm/min", maxTargetFeedMMMin)})
		return
	}
	now := s.mgr.now()
	s.mu.Lock()
	lease := s.lease
	st := s.lastStatus
	lastStatusAt := s.lastStatusAt
	planned := copyAxes(s.planned)
	queuedUntil := s.queuedUntil
	statusInFlight := s.statusInFlight
	targetPending := s.targetPending != nil
	s.mu.Unlock()
	if lease == nil {
		s.emit(Event{Type: "error", Seq: seq, Code: CodeBadInput, Message: "arm tap move before selecting a target"})
		s.emitState(seq)
		return
	}
	if targetPending {
		s.emit(Event{Type: "error", Seq: seq, Code: CodeBusy, Message: "tap move is awaiting the previous target"})
		return
	}
	if !canContinueJog(st.State) {
		if st.State == machine.Alarm {
			s.logAlarmStatus(st)
		}
		s.release(nil)
		s.emit(Event{Type: "error", Seq: seq, Code: CodeNotIdle, Message: "machine left joggable state: " + stateLabel(st.State)})
		s.emitState(seq)
		return
	}
	queuedLead := queueLead(now, queuedUntil)
	if queuedLead > 0 {
		s.emit(Event{Type: "error", Seq: seq, Code: CodeBusy, Message: "wait for queued jog motion to finish before selecting a tap target"})
		return
	}
	if !statusObservedAfterQueue(lastStatusAt, queuedUntil) {
		s.emit(Event{Type: "error", Seq: seq, Code: CodeStatusWaiting, Message: "Waiting for fresh machine status before tap move."})
		s.requestStatus()
		return
	}
	if (len(st.MPos) == 0 || now.Sub(lastStatusAt) > activeStatusMaxAge(cfg)) && queuedLead == 0 {
		if statusInFlight {
			s.emit(Event{Type: "error", Seq: seq, Code: CodeStatusWaiting, Message: "Waiting for fresh machine status before tap move."})
			return
		}
		s.emit(Event{Type: "error", Seq: seq, Code: CodeStatusWaiting, Message: "Waiting for fresh machine status before tap move."})
		s.requestStatus()
		return
	}
	if planned == nil || (queuedLead == 0 && statusObservedAfterQueue(lastStatusAt, queuedUntil)) {
		planned = copyAxes(st.MPos)
	}
	if planned == nil {
		s.emit(Event{Type: "error", Seq: seq, Code: CodeStaleStatus, Message: "machine position is unavailable"})
		return
	}
	for axis := range targetAxes {
		if _, ok := planned[axis]; !ok {
			s.emit(Event{Type: "error", Seq: seq, Code: CodeStaleStatus, Message: "machine " + strings.ToUpper(axis) + " position is unavailable"})
			return
		}
	}

	// Status and jog commands both carry four decimal places. Work-coordinate
	// targets are reconstructed in the browser as WPos + (MPos - WPos), which
	// can leave a floating-point residue on an unchanged axis. Snap residues
	// smaller than half a wire unit back to the observed position; otherwise a
	// Z-only request can be misplanned as a safe-Z/XY/Z sequence containing an
	// invalid `$J X0.0000` segment.
	effectiveTargetAxes := copyAxes(targetAxes)
	for axis, value := range effectiveTargetAxes {
		if math.Abs(value-planned[axis]) < jogCoordinateResolutionMM/2 {
			effectiveTargetAxes[axis] = planned[axis]
		}
	}

	finalTarget := copyAxes(planned)
	for axis, value := range effectiveTargetAxes {
		finalTarget[axis] = value
	}
	finalTarget = clampJogTarget(planned, finalTarget, s.mgr.softLimits())
	for axis := range effectiveTargetAxes {
		effectiveTargetAxes[axis] = finalTarget[axis]
	}
	fullDelta := axesDelta(planned, finalTarget)
	if fullDelta.X == 0 && fullDelta.Y == 0 && fullDelta.Z == 0 {
		s.emitMotionEstimate(now, st, finalTarget, fullDelta, "", queuedLead)
		s.emit(Event{Type: "ack", Seq: seq, Target: finalTarget})
		s.emit(Event{Type: "target_complete", Seq: seq, Target: finalTarget})
		return
	}
	hasXYMove := fullDelta.X != 0 || fullDelta.Y != 0

	lastCmd := ""
	if safeZEnabled && hasXYMove {
		plannedZ, ok := planned["z"]
		if !ok || math.IsNaN(plannedZ) || math.IsInf(plannedZ, 0) {
			s.emit(Event{Type: "error", Seq: seq, Code: CodeStaleStatus, Message: "machine Z position is unavailable for safe tap move"})
			return
		}
		if plannedZ < safeZMM {
			safeTarget := copyAxes(planned)
			safeTarget["z"] = safeZMM
			safeTarget = clampJogTarget(planned, safeTarget, s.mgr.softLimits())
			safeDelta := axesDelta(planned, safeTarget)
			if safeDelta.Z != 0 {
				var err error
				planned, queuedUntil, queuedLead, lastCmd, err = s.writePlannedJogSegment(now, lease, planned, safeTarget, safeDelta, stepJogDuration(safeDelta, cfg), queuedUntil, cfg)
				if err != nil {
					s.failLease(CodeMachineError, err)
					return
				}
			}
		}
	}
	if safeZEnabled && hasXYMove {
		xyTarget := copyAxes(planned)
		if x, ok := effectiveTargetAxes["x"]; ok {
			xyTarget["x"] = x
		}
		if y, ok := effectiveTargetAxes["y"]; ok {
			xyTarget["y"] = y
		}
		xyDelta := axesDelta(planned, xyTarget)
		if xyDelta.X != 0 || xyDelta.Y != 0 {
			var err error
			planned, queuedUntil, queuedLead, lastCmd, err = s.writePlannedJogSegment(now, lease, planned, xyTarget, xyDelta, targetMoveDuration(xyDelta, feedMMMin, cfg), queuedUntil, cfg)
			if err != nil {
				s.failLease(CodeMachineError, err)
				return
			}
		}
	}

	target := copyAxes(planned)
	for axis, value := range effectiveTargetAxes {
		target[axis] = value
	}
	delta := axesDelta(planned, target)
	if delta.X != 0 || delta.Y != 0 || delta.Z != 0 {
		var err error
		_, queuedUntil, queuedLead, lastCmd, err = s.writePlannedJogSegment(now, lease, planned, target, delta, targetMoveDuration(delta, feedMMMin, cfg), queuedUntil, cfg)
		if err != nil {
			s.failLease(CodeMachineError, err)
			return
		}
	}
	s.emitMotionEstimate(now, st, target, delta, lastCmd, queuedLead)
	s.mu.Lock()
	s.targetPending = &pendingTarget{
		seq:          seq,
		target:       copyAxes(target),
		motionDoneAt: queuedUntil,
		verifyAfter:  queuedUntil.Add(targetVerifyGrace(cfg)),
	}
	s.haveInput = false
	s.mu.Unlock()
	s.emit(Event{Type: "ack", Seq: seq, Target: target})
	s.requestStatus()
}

func (s *Session) writePlannedJogSegment(now time.Time, lease *session.JogLease, from, target machine.AxisValues, delta Axes, dur time.Duration, queuedUntil time.Time, cfg Config) (machine.AxisValues, time.Time, time.Duration, string, error) {
	cmd := jogCommandForDuration(target, delta, cfg, dur)
	if err := lease.Conn.WriteGcodeLine(cmd); err != nil {
		return from, queuedUntil, queueLead(now, queuedUntil), "", err
	}
	segStart := queuedUntil
	if segStart.Before(now) {
		segStart = now
	}
	segEnd := segStart.Add(dur)
	queuedUntil = segEnd
	queuedLead := queueLead(now, queuedUntil)
	s.mu.Lock()
	s.planned = target
	s.queuedUntil = queuedUntil
	s.segments = appendPlannedSegment(s.segments, plannedSegment{
		start: segStart,
		end:   segEnd,
		from:  copyAxes(from),
		to:    copyAxes(target),
	}, now)
	s.mgr.markMotion()
	s.lastMotionCmd = cmd
	s.mu.Unlock()
	s.logMotion(now, cmd)
	return copyAxes(target), queuedUntil, queuedLead, cmd, nil
}

func (s *Session) handleArm(seq int64) {
	if !s.mgr.cfg.Enabled {
		s.emit(Event{Type: "error", Seq: seq, Code: CodeDisabled, Message: "jogging is disabled"})
		return
	}
	if s.hasLease() {
		s.emit(Event{Type: "ack", Seq: seq})
		s.emitState(seq)
		return
	}
	if !s.mgr.claimOwner(s) {
		s.emit(Event{Type: "error", Seq: seq, Code: CodeBusy, Message: "movement control is held by another UI; disarm it before taking control"})
		s.emitState(seq)
		return
	}
	armSucceeded := false
	defer func() {
		if armSucceeded {
			return
		}
		if s.mgr.clearOwner(s) {
			s.mgr.broadcastState(s, 0)
		}
	}()
	s.mgr.broadcastState(s, 0)
	ctx, cancel := context.WithTimeout(s.ctx, 2*time.Second)
	defer cancel()
	lease, err := s.mgr.arb.AcquireJog(ctx)
	if err != nil {
		s.emit(Event{Type: "error", Seq: seq, Code: codeForErr(err), Message: err.Error()})
		s.emitState(seq)
		return
	}
	// AcquireJog gates on the shared tracker so it can safely choose the owner
	// or relay path, but that cached Idle report may be several seconds old.
	// Once the exclusive path is ours, verify state and position through that
	// exact connection before claiming that movement is armed.
	payload, err := lease.Conn.QueryState(statusQueryTimeout(s.mgr.cfg))
	if err != nil {
		code := CodeMachineError
		message := err.Error()
		timedOut := isTimeout(err)
		if timedOut {
			// Preserve a transport that merely answered late, matching the jog
			// retry path and the USB owner-poll policy. QueryState drains a late
			// STATUS_RES before attributing a later response.
			lease.Release(nil)
			code = CodeStaleStatus
			message = "machine did not return fresh status while arming jog"
		} else {
			lease.Release(err)
		}
		if !timedOut && channelClosed(lease.Abort) {
			code = CodeControllerWaiting
			message = "controller requested the machine connection"
		}
		s.emit(Event{Type: "error", Seq: seq, Code: code, Message: message})
		s.emitState(seq)
		return
	}
	if !s.mgr.arb.Tracker().ObserveStatusPayload(payload) {
		lease.Release(nil)
		s.emit(Event{Type: "error", Seq: seq, Code: CodeStaleStatus, Message: "machine returned malformed status while arming jog"})
		s.emitState(seq)
		return
	}
	st, age := s.mgr.arb.Tracker().Current()
	if !s.mgr.arb.Tracker().Fresh(s.mgr.arb.StateMaxAge()) || st.State != machine.Idle || len(st.MPos) == 0 {
		lease.Release(nil)
		code := CodeNotIdle
		if !s.mgr.arb.Tracker().Fresh(s.mgr.arb.StateMaxAge()) || len(st.MPos) == 0 {
			code = CodeStaleStatus
		}
		s.emit(Event{Type: "error", Seq: seq, Code: code, Message: "machine is not ready to jog"})
		s.emitState(seq)
		return
	}
	now := s.mgr.now()
	s.mu.Lock()
	s.lease = lease
	s.leaseID++
	s.statusInFlight = false
	s.statusRetry = false
	s.statusFailures = 0
	s.nextStatusAt = time.Time{}
	s.armed = true
	s.haveInput = false
	s.lastStatus = st
	s.lastStatusAt = now
	s.planned = copyAxes(st.MPos)
	s.queuedUntil = time.Time{}
	s.segments = nil
	s.mu.Unlock()
	armSucceeded = true
	s.mgr.broadcastEvent(Event{Type: "status", Status: statusEvent(st, age, s.mgr.markSettled())})
	s.emit(Event{Type: "ack", Seq: seq})
	s.emitState(seq)
}

func (s *Session) sendControl(action string) error {
	var c byte
	switch action {
	case "hold", "feedhold", "pause":
		c = protocol.CtrlFeedHold
	case "resume":
		c = protocol.CtrlResume
	case "halt", "stop", "estop":
		c = protocol.CtrlHalt
	default:
		return fmt.Errorf("action must be one of: hold, resume, halt")
	}
	if err := s.mgr.arb.SendControl(c); err != nil {
		return err
	}
	s.log(gcodelog.DirSend, "control "+action)
	return nil
}

func (s *Session) refreshStatus() error {
	s.mu.Lock()
	lease := s.lease
	s.mu.Unlock()
	if lease == nil {
		return nil
	}
	payload, err := lease.Conn.QueryState(statusQueryTimeout(s.mgr.cfg))
	if err != nil {
		if isTimeout(err) {
			s.emitStatusWaiting(s.mgr.now())
			return nil
		}
		return err
	}
	return s.applyStatusPayload(payload)
}

func (s *Session) requestStatus() {
	s.mu.Lock()
	lease := s.lease
	if lease == nil || s.statusInFlight {
		s.mu.Unlock()
		return
	}
	now := s.mgr.now()
	if !s.nextStatusAt.IsZero() && now.Before(s.nextStatusAt) {
		s.mu.Unlock()
		return
	}
	leaseID := s.leaseID
	timeout := statusQueryTimeout(s.mgr.cfg)
	s.statusInFlight = true
	s.statusWG.Add(1)
	s.mu.Unlock()

	go func() {
		defer s.statusWG.Done()
		payload, err := lease.Conn.QueryState(timeout)
		res := statusResult{leaseID: leaseID, payload: payload, err: err}
		select {
		case s.statusCh <- res:
		case <-s.ctx.Done():
		}
	}()
}

func (s *Session) shouldRequestStatus(now time.Time) bool {
	s.mu.Lock()
	lease := s.lease
	in := s.latest
	haveInput := s.haveInput
	inFlight := s.statusInFlight
	targetPending := s.targetPending != nil
	lastStatusAt := s.lastStatusAt
	s.mu.Unlock()
	if lease == nil || inFlight {
		return false
	}
	gap := s.mgr.cfg.StatusInterval
	if !targetPending && motionInputActive(haveInput, in, now, s.mgr.cfg) {
		gap = activeStatusPollInterval(s.mgr.cfg)
	}
	return lastStatusAt.IsZero() || now.Sub(lastStatusAt) >= gap
}

func (s *Session) handleStatusResult(res statusResult) {
	s.mu.Lock()
	if res.leaseID != s.leaseID {
		s.mu.Unlock()
		return
	}
	s.statusInFlight = false
	if s.lease == nil {
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()

	if res.err != nil {
		if client.IsConnectionError(res.err) && !isTimeout(res.err) {
			s.failLease(CodeMachineError, res.err)
			return
		}
		// A status query shares the interactive stream with silent $J frames.
		// A delayed reply or an immediate firmware diagnostic has no request ID,
		// so neither proves the lease is unusable or that a particular queued jog
		// was rejected. Keep queue admission time-bounded and retry the poll with
		// backoff; a real Alarm status remains terminal below.
		now := s.mgr.now()
		if s.statusLeaseExpired(now) {
			s.failLease(CodeStaleStatus, statusReconnectError{cause: res.err})
			return
		}
		s.scheduleStatusRetry(now)
		s.emitStatusWaiting(now)
		return
	}
	if err := s.applyStatusPayload(res.payload); err != nil {
		// A malformed/truncated STATUS_RES leaves the previous observation to age
		// out. It is not evidence that the machine connection or jog lease died.
		// Stop extending the bounded queue once that observation becomes stale,
		// but retry in place so one damaged WiFi frame cannot disarm Movement.
		now := s.mgr.now()
		if s.statusLeaseExpired(now) {
			s.failLease(CodeStaleStatus, statusReconnectError{cause: err})
			return
		}
		s.scheduleStatusRetry(now)
		s.emitStatusWaiting(now)
	}
}

func (s *Session) statusLeaseExpired(now time.Time) bool {
	s.mu.Lock()
	lastStatusAt := s.lastStatusAt
	s.mu.Unlock()
	if lastStatusAt.IsZero() {
		return true
	}
	age := now.Sub(lastStatusAt)
	return age >= 0 && age > s.mgr.arb.StateMaxAge()
}

func (s *Session) scheduleStatusRetry(now time.Time) {
	s.mu.Lock()
	s.statusRetry = true
	if s.statusFailures < 30 {
		s.statusFailures++
	}
	s.nextStatusAt = now.Add(statusRetryDelay(s.statusFailures, s.mgr.cfg))
	s.mu.Unlock()
}

func (s *Session) applyStatusPayload(payload string) error {
	if !s.mgr.arb.Tracker().ObserveStatusPayload(payload) {
		return Error{Code: CodeStaleStatus, Message: "machine returned malformed status"}
	}
	st, age := s.mgr.arb.Tracker().Current()
	s.mu.Lock()
	s.lastStatus = st
	now := s.mgr.now()
	s.lastStatusAt = now
	s.statusRetry = false
	s.statusFailures = 0
	s.nextStatusAt = time.Time{}
	var completed *pendingTarget
	var notReached *pendingTarget
	if pending := s.targetPending; pending != nil {
		switch {
		case targetReached(st.MPos, pending.target):
			completed = copyPendingTarget(pending)
			s.targetPending = nil
		case !now.Before(pending.verifyAfter) && st.State == machine.Idle:
			notReached = copyPendingTarget(pending)
			s.targetPending = nil
		}
		if completed != nil || notReached != nil {
			s.planned = copyAxes(st.MPos)
			s.queuedUntil = time.Time{}
			s.segments = nil
		}
	}
	// During Run, MPos is the physical position while planned is the end of the
	// firmware queue. A wall-clock estimate reaching zero does not prove that
	// queue has drained; resetting planned here would lose our only bound on how
	// far ahead we have submitted. Idle is the firmware's actual drain signal.
	settled := queueLead(now, s.queuedUntil) == 0 && st.State == machine.Idle
	if settled {
		s.planned = copyAxes(st.MPos)
		s.segments = nil
	}
	s.mu.Unlock()
	if st.State == machine.Alarm {
		s.logAlarmStatus(st)
	}
	revisions := s.mgr.motionRevisions()
	if settled {
		revisions = s.mgr.markSettled()
	}
	s.mgr.broadcastEvent(Event{Type: "status", Status: statusEvent(st, age, revisions)})
	if completed != nil {
		s.emit(Event{Type: "target_complete", Seq: completed.seq, Target: completed.target})
	}
	if notReached != nil {
		s.emit(Event{
			Type:    "error",
			Seq:     notReached.seq,
			Code:    CodeTargetNotReached,
			Message: "machine stopped before reaching the requested tap target",
		})
	}
	if !canContinueJog(st.State) {
		s.release(nil)
		s.emit(Event{Type: "error", Code: CodeNotIdle, Message: "machine left joggable state: " + stateLabel(st.State)})
		s.emitState(0)
	}
	return nil
}

func (s *Session) motionTick() {
	now := s.mgr.now()
	s.mu.Lock()
	in := s.latest
	haveInput := s.haveInput
	st := s.lastStatus
	planned := copyAxes(s.planned)
	lastStatusAt := s.lastStatusAt
	queuedUntil := s.queuedUntil
	statusInFlight := s.statusInFlight
	statusRetry := s.statusRetry
	targetPending := copyPendingTarget(s.targetPending)
	s.mu.Unlock()

	queuedLead := queueLead(now, queuedUntil)
	activeMotion := motionInputActive(haveInput, in, now, s.mgr.cfg)
	if !canContinueJog(st.State) {
		if st.State == machine.Alarm {
			s.logAlarmStatus(st)
		}
		s.release(nil)
		s.emit(Event{Type: "error", Code: CodeNotIdle, Message: "machine left joggable state: " + stateLabel(st.State)})
		s.emitState(0)
		return
	}
	if targetPending != nil {
		if !now.Before(targetPending.verifyAfter) {
			statusAfterMotion := !lastStatusAt.Before(targetPending.motionDoneAt)
			statusFresh := !lastStatusAt.IsZero() && now.Sub(lastStatusAt) <= activeStatusMaxAge(s.mgr.cfg)
			if statusAfterMotion && statusFresh && st.State != machine.Run {
				if s.clearPendingTarget(targetPending.seq) {
					s.emit(Event{
						Type:    "error",
						Seq:     targetPending.seq,
						Code:    CodeTargetNotReached,
						Message: "machine stopped before reaching the requested tap target",
					})
				}
				return
			}
			verifyTimeout := targetPending.verifyAfter.Add(statusQueryTimeout(s.mgr.cfg))
			if !statusFresh && !statusInFlight && !now.Before(verifyTimeout) {
				if s.clearPendingTarget(targetPending.seq) {
					s.release(nil)
					s.emit(Event{
						Type:    "error",
						Seq:     targetPending.seq,
						Code:    CodeStaleStatus,
						Message: "tap move ended without a fresh position report; movement was disarmed",
					})
					s.emitState(targetPending.seq)
				}
				return
			}
		}
		if queuedLead > 0 {
			s.emitMotionEstimate(now, st, planned, Axes{}, "", queuedLead)
		}
		if statusRetry && !statusInFlight {
			s.requestStatus()
		}
		return
	}
	// $J is a silent planner append. It is safe to keep the bounded lookahead
	// filled while the one STATUS_RES reader is outstanding: writes are atomic,
	// and the status frame has its own type. Poll failures are retryable and must
	// not turn a short firmware delay into a dropped jog lease.
	if statusRetry && !statusInFlight {
		s.requestStatus()
	}
	if activeMotion && !statusInFlight && (lastStatusAt.IsZero() || now.Sub(lastStatusAt) >= activeStatusPollInterval(s.mgr.cfg)) {
		s.requestStatus()
	}
	if !activeMotion {
		if queuedLead > 0 {
			s.emitMotionEstimate(now, st, planned, Axes{}, "", queuedLead)
		}
		return
	}
	staleCorrectionStatus := len(st.MPos) == 0 || now.Sub(lastStatusAt) > activeStatusMaxAge(s.mgr.cfg)
	if staleCorrectionStatus {
		if queuedLead > 0 {
			s.emitMotionEstimate(now, st, planned, Axes{}, "", queuedLead)
		}
		s.emitStatusWaiting(now)
		s.requestStatus()
		return
	}
	// A cached Idle sample from before the most recently queued segment cannot
	// prove that segment drained. Rewinding planned to that old MPos would submit
	// the same relative $J block again on every tick, eventually overrunning the
	// firmware planner and its soft limits. Only a status observed after the
	// predicted queue end may re-anchor the planner.
	if planned == nil || (queuedLead == 0 && st.State == machine.Idle && !lastStatusAt.Before(queuedUntil)) {
		planned = copyAxes(st.MPos)
	}
	segDur := jogSegmentDuration(s.mgr.cfg)
	lookahead := jogLookahead(s.mgr.cfg)

	delta := MotionDelta(in.Axes, in.Slow, s.mgr.cfg)
	if axesEmpty(delta) {
		if queuedLead > 0 {
			s.emitMotionEstimate(now, st, planned, Axes{}, "", queuedLead)
		}
		return
	}

	s.mu.Lock()
	lease := s.lease
	s.mu.Unlock()
	if lease == nil {
		return
	}
	lastCmd := ""
	for sent := 0; sent < maxSegmentsPerTick; sent++ {
		s.admissionMu.Lock()
		if s.captureBarrier {
			s.admissionMu.Unlock()
			break
		}
		admitAt := s.mgr.now()
		queuedLead = queueLead(admitAt, queuedUntil)
		if queuedLead >= lookahead {
			s.admissionMu.Unlock()
			break
		}
		s.mu.Lock()
		latest := s.latest
		inputCurrent := s.haveInput && motionInputActive(true, latest, admitAt, s.mgr.cfg)
		s.mu.Unlock()
		if !inputCurrent {
			s.admissionMu.Unlock()
			break
		}
		// Input is latest-wins and may change while the first frame in this refill
		// is being written (especially over USB). Recompute every block so a
		// direction, speed, or slow-mode change never causes a second stale block.
		delta = MotionDelta(latest.Axes, latest.Slow, s.mgr.cfg)
		if axesEmpty(delta) {
			s.admissionMu.Unlock()
			break
		}
		target := copyAxes(planned)
		target["x"] += delta.X
		target["y"] += delta.Y
		target["z"] += delta.Z
		if delta.A != 0 {
			target["a"] += delta.A
		}
		target = clampJogTarget(planned, target, s.mgr.softLimits())
		delta = axesDelta(planned, target)
		if axesEmpty(delta) {
			s.admissionMu.Unlock()
			break
		}
		// Compare planned and physical position only immediately after a new
		// sample. Between samples, a healthy
		// machine is expected to move away from the old MPos; continuously using
		// that old value as a hard fence periodically starves the planner.
		if physicalLeadCheckDue(admitAt, lastStatusAt, s.mgr.cfg) && jogLeadTooLarge(target, st.MPos, s.mgr.cfg) {
			s.admissionMu.Unlock()
			break
		}
		s.admissionInFlight = true
		s.admissionMu.Unlock()
		cmd := jogCommandForDuration(target, delta, s.mgr.cfg, segDur)
		if err := lease.Conn.WriteGcodeLine(cmd); err != nil {
			s.failLease(CodeMachineError, err)
			s.finishSegmentAdmission()
			return
		}
		writtenAt := s.mgr.now()
		segStart := queuedUntil
		if segStart.Before(writtenAt) {
			segStart = writtenAt
		}
		segEnd := segStart.Add(segDur)
		queuedUntil = segEnd
		queuedLead = queueLead(writtenAt, queuedUntil)
		s.mu.Lock()
		s.planned = target
		s.queuedUntil = queuedUntil
		s.segments = appendPlannedSegment(s.segments, plannedSegment{
			start: segStart,
			end:   segEnd,
			from:  copyAxes(planned),
			to:    copyAxes(target),
		}, writtenAt)
		s.mgr.markMotion()
		s.lastMotionCmd = cmd
		latest = s.latest
		inputUnchanged := s.haveInput && motionInputActive(true, latest, s.mgr.now(), s.mgr.cfg)
		s.mu.Unlock()
		s.finishSegmentAdmission()
		planned = target
		lastCmd = cmd
		s.logMotion(writtenAt, cmd)
		// SetInput runs directly from the WebSocket reader. If the deadman or
		// stick was released while this tick was filling the planner, stop
		// admission after the command already written instead of appending
		// another stale segment. No halt/feed-hold is sent and the armed lease is
		// preserved.
		if !inputUnchanged {
			break
		}
	}
	emitAt := s.mgr.now()
	s.emitMotionEstimate(emitAt, st, planned, delta, lastCmd, queueLead(emitAt, queuedUntil))
}

func (s *Session) finishSegmentAdmission() {
	s.admissionMu.Lock()
	s.admissionInFlight = false
	s.admissionCond.Broadcast()
	s.admissionMu.Unlock()
}

// Normalize converts raw axes into one tick of motion in mm for XYZ and
// degrees for A.
func Normalize(axes Axes, slow bool, cfg Config) Axes {
	cfg = cfg.normalize()
	return normalizeForDuration(axes, slow, cfg, cfg.Tick)
}

// MotionDelta converts raw axes into one jog segment in mm for XYZ and degrees
// for A.
func MotionDelta(axes Axes, slow bool, cfg Config) Axes {
	cfg = cfg.normalize()
	return normalizeForDuration(axes, slow, cfg, jogSegmentDuration(cfg))
}

func normalizeForDuration(axes Axes, slow bool, cfg Config, d time.Duration) Axes {
	cfg = cfg.normalize()
	x := response(axes.X)
	y := response(axes.Y)
	z := response(axes.Z)
	a := response(axes.A)
	if mag := math.Hypot(x, y); mag > 1 {
		x /= mag
		y /= mag
	}
	scale := 1.0
	if slow {
		scale = slowScale
	}
	dtMin := d.Minutes()
	return Axes{
		X: x * cfg.MaxXYMMMin * dtMin * scale,
		Y: y * cfg.MaxXYMMMin * dtMin * scale,
		Z: z * cfg.MaxZMMMin * dtMin * scale,
		A: a * cfg.MaxADegMin * dtMin * scale,
	}
}

func stepDelta(axis string, distance float64) (Axes, error) {
	axis = strings.ToLower(strings.TrimSpace(axis))
	if axis != "x" && axis != "y" && axis != "z" && axis != "a" {
		return Axes{}, fmt.Errorf("axis must be one of: x, y, z, a")
	}
	if math.IsNaN(distance) || math.IsInf(distance, 0) || distance == 0 {
		return Axes{}, fmt.Errorf("distance must be non-zero")
	}
	if axis == "a" && math.Abs(distance) > maxManualStepDegrees {
		return Axes{}, fmt.Errorf("A distance must be between %.0f and %.0f degrees", -maxManualStepDegrees, maxManualStepDegrees)
	}
	if axis != "a" && math.Abs(distance) > maxManualStepMM {
		return Axes{}, fmt.Errorf("distance must be between %.1f and %.1f mm", -maxManualStepMM, maxManualStepMM)
	}
	switch axis {
	case "x":
		return Axes{X: distance}, nil
	case "y":
		return Axes{Y: distance}, nil
	case "z":
		return Axes{Z: distance}, nil
	default:
		return Axes{A: distance}, nil
	}
}

func originCommand(axis string, value float64) (string, error) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return "", fmt.Errorf("origin value must be finite")
	}
	axis = strings.ToLower(strings.TrimSpace(axis))
	switch axis {
	case "x", "y", "z":
		return fmt.Sprintf("G10L20P0%s%.4f", strings.ToUpper(axis), value), nil
	default:
		return "", fmt.Errorf("axis must be one of: x, y, z")
	}
}

func machineOriginCommand(origin machine.AxisValues) (string, error) {
	x, xOK := origin["x"]
	y, yOK := origin["y"]
	if !xOK || !yOK || math.IsNaN(x) || math.IsInf(x, 0) || math.IsNaN(y) || math.IsInf(y, 0) {
		return "", fmt.Errorf("machine origin requires finite x and y")
	}
	return fmt.Sprintf("G10L2P0X%.4fY%.4f", x, y), nil
}

func stepJogDuration(delta Axes, cfg Config) time.Duration {
	cfg = cfg.normalize()
	xyDist := math.Hypot(delta.X, delta.Y)
	zDist := math.Abs(delta.Z)
	aDist := math.Abs(delta.A)
	mins := 0.0
	if xyDist > 0 && cfg.MaxXYMMMin > 0 {
		mins = xyDist / cfg.MaxXYMMMin
	}
	if zDist > 0 && cfg.MaxZMMMin > 0 {
		zMins := zDist / cfg.MaxZMMMin
		if zMins > mins {
			mins = zMins
		}
	}
	if aDist > 0 && cfg.MaxADegMin > 0 {
		aMins := aDist / cfg.MaxADegMin
		if aMins > mins {
			mins = aMins
		}
	}
	d := time.Duration(mins * float64(time.Minute))
	if d < minJogSegment {
		return minJogSegment
	}
	return d
}

func axesDelta(from, target machine.AxisValues) Axes {
	return Axes{
		X: target["x"] - from["x"],
		Y: target["y"] - from["y"],
		Z: target["z"] - from["z"],
		A: target["a"] - from["a"],
	}
}

func axesEmpty(axes Axes) bool {
	return axes.X == 0 && axes.Y == 0 && axes.Z == 0 && axes.A == 0
}

func clampJogTarget(from, target machine.AxisValues, limits SoftLimits) machine.AxisValues {
	clamped := copyAxes(target)
	if !limits.Enabled || len(from) == 0 || len(clamped) == 0 {
		return clamped
	}
	for _, bound := range []struct {
		axis     string
		min, max float64
	}{
		{axis: "x", min: limits.XMin, max: limits.XMax},
		{axis: "y", min: limits.YMin, max: limits.YMax},
		{axis: "z", min: limits.ZMin, max: limits.ZMax},
	} {
		start, startOK := from[bound.axis]
		wanted, targetOK := clamped[bound.axis]
		if !startOK || !targetOK || !validSoftLimitRange(bound.min, bound.max) || start < bound.min || start > bound.max {
			continue
		}
		if wanted < bound.min {
			clamped[bound.axis] = bound.min
		} else if wanted > bound.max {
			clamped[bound.axis] = bound.max
		}
	}
	return clamped
}

func validSoftLimitRange(min, max float64) bool {
	return !math.IsNaN(min) && !math.IsInf(min, 0) && !math.IsNaN(max) && !math.IsInf(max, 0) && min < max
}

func targetReached(position, target machine.AxisValues) bool {
	if len(position) == 0 || len(target) == 0 {
		return false
	}
	for axis, wanted := range target {
		actual, ok := position[axis]
		if !ok || math.Abs(actual-wanted) > targetPositionToleranceMM {
			return false
		}
	}
	return true
}

func targetVerifyGrace(cfg Config) time.Duration {
	cfg = cfg.normalize()
	grace := 4 * cfg.StatusInterval
	if grace < minTargetVerifyGrace {
		return minTargetVerifyGrace
	}
	return grace
}

func copyPendingTarget(in *pendingTarget) *pendingTarget {
	if in == nil {
		return nil
	}
	return &pendingTarget{
		seq:          in.seq,
		target:       copyAxes(in.target),
		motionDoneAt: in.motionDoneAt,
		verifyAfter:  in.verifyAfter,
	}
}

func (s *Session) clearPendingTarget(seq int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.targetPending == nil || s.targetPending.seq != seq {
		return false
	}
	s.targetPending = nil
	s.planned = copyAxes(s.lastStatus.MPos)
	s.queuedUntil = time.Time{}
	s.segments = nil
	return true
}

func targetMoveDuration(delta Axes, feedMMMin float64, cfg Config) time.Duration {
	cfg = cfg.normalize()
	xyDist := math.Hypot(delta.X, delta.Y)
	zDist := math.Abs(delta.Z)
	mins := 0.0
	if xyDist > 0 && feedMMMin > 0 {
		mins = xyDist / feedMMMin
	}
	if zDist > 0 && cfg.MaxZMMMin > 0 {
		zMins := zDist / cfg.MaxZMMMin
		if zMins > mins {
			mins = zMins
		}
	}
	if mins <= 0 {
		return minJogSegment
	}
	d := time.Duration(mins * float64(time.Minute))
	if d < minJogSegment {
		return minJogSegment
	}
	return d
}

func response(v float64) float64 {
	if v > 1 {
		v = 1
	} else if v < -1 {
		v = -1
	}
	sign := 1.0
	if v < 0 {
		sign = -1
		v = -v
	}
	if v < deadzone {
		return 0
	}
	n := (v - deadzone) / (1 - deadzone)
	return sign * n * n * n
}

func jogCommand(target machine.AxisValues, delta Axes, cfg Config) string {
	return jogCommandForDuration(target, delta, cfg, cfg.normalize().Tick)
}

func jogCommandForDuration(target machine.AxisValues, delta Axes, cfg Config, d time.Duration) string {
	cfg = cfg.normalize()
	// A has no usable machine/work coordinate split on Carvera and must remain
	// relative. The firmware's $J path accepts ABC axes without changing the
	// controller's modal G90/G91 state, so it is also the safe rotary fallback.
	if cfg.MotionPrimitive == MotionPrimitiveG53 && delta.A == 0 {
		return g53JogCommand(target, delta)
	}
	return instantJogCommand(delta, cfg, d)
}

func instantJogCommand(delta Axes, cfg Config, d time.Duration) string {
	parts := "$J"
	if delta.X != 0 {
		parts += fmt.Sprintf(" X%.4f", delta.X)
	}
	if delta.Y != 0 {
		parts += fmt.Sprintf(" Y%.4f", delta.Y)
	}
	if delta.Z != 0 {
		parts += fmt.Sprintf(" Z%.4f", delta.Z)
	}
	if delta.A != 0 {
		parts += fmt.Sprintf(" A%.4f", delta.A)
	}
	parts += fmt.Sprintf(" F%.4f", jogFeedScale(delta, cfg, d))
	return parts
}

func g53JogCommand(target machine.AxisValues, delta Axes) string {
	parts := "G53 G0"
	if delta.X != 0 {
		parts += fmt.Sprintf(" X%.4f", target["x"])
	}
	if delta.Y != 0 {
		parts += fmt.Sprintf(" Y%.4f", target["y"])
	}
	if delta.Z != 0 {
		parts += fmt.Sprintf(" Z%.4f", target["z"])
	}
	return parts
}

func jogFeedScale(delta Axes, cfg Config, d time.Duration) float64 {
	cfg = cfg.normalize()
	dist := math.Sqrt(delta.X*delta.X + delta.Y*delta.Y + delta.Z*delta.Z + delta.A*delta.A)
	if dist == 0 || d <= 0 {
		return 1
	}
	desiredMMMin := dist / d.Minutes()
	machineMax := selectedJogMachineMax(delta)
	if machineMax <= 0 {
		return 1
	}
	scale := desiredMMMin / machineMax
	if scale < 0.001 {
		return 0.001
	}
	return scale
}

func selectedJogMachineMax(delta Axes) float64 {
	maxRate := 0.0
	if delta.X != 0 || delta.Y != 0 {
		maxRate = firmwareMaxXYMMMin
	}
	if delta.Z != 0 && (maxRate == 0 || firmwareMaxZMMMin < maxRate) {
		maxRate = firmwareMaxZMMMin
	}
	if delta.A != 0 && (maxRate == 0 || firmwareMaxADegMin < maxRate) {
		maxRate = firmwareMaxADegMin
	}
	return maxRate
}

func jogSegmentDuration(cfg Config) time.Duration {
	cfg = cfg.normalize()
	// Keep the established 80ms default block cadence. The refill threshold is
	// two blocks and motionTick may append one block beyond it, giving the
	// firmware enough junction-planning cushion for continuous high-speed jogs.
	d := 4 * cfg.Tick
	if d < minJogSegment {
		d = minJogSegment
	}
	if d > maxJogSegment {
		d = maxJogSegment
	}
	return d
}

func jogLookahead(cfg Config) time.Duration {
	d := 2 * jogSegmentDuration(cfg.normalize())
	if d < minJogLookahead {
		d = minJogLookahead
	}
	if d > maxJogLookahead {
		d = maxJogLookahead
	}
	return d
}

// jogLeadTooLarge bounds commands by physical progress, not only by elapsed
// wall time. Under normal execution the temporal lookahead is the tighter
// bound. If acceleration, planner pressure, or transport latency makes the
// firmware drain more slowly than predicted, this extra one-segment margin
// stops us filling its planner indefinitely while preserving continuous moves.
func jogLeadTooLarge(target, observed machine.AxisValues, cfg Config) bool {
	if len(target) == 0 || len(observed) == 0 {
		return true
	}
	cfg = cfg.normalize()
	window := jogLookahead(cfg) + jogSegmentDuration(cfg)
	xyLimit := cfg.MaxXYMMMin * window.Minutes()
	if xyLimit < baseMaxXYLeadMM {
		xyLimit = baseMaxXYLeadMM
	}
	zLimit := cfg.MaxZMMMin * window.Minutes()
	if zLimit < baseMaxZLeadMM {
		zLimit = baseMaxZLeadMM
	}
	for _, axis := range []string{"x", "y"} {
		to, toOK := target[axis]
		at, atOK := observed[axis]
		if !toOK || !atOK || math.Abs(to-at) > xyLimit {
			return true
		}
	}
	to, toOK := target["z"]
	at, atOK := observed["z"]
	if !toOK || !atOK || math.Abs(to-at) > zLimit {
		return true
	}
	aLimit := cfg.MaxADegMin * window.Minutes()
	if aLimit < baseMaxALeadDeg {
		aLimit = baseMaxALeadDeg
	}
	to, toOK = target["a"]
	at, atOK = observed["a"]
	if !toOK && !atOK {
		return false
	}
	return !toOK || !atOK || math.Abs(to-at) > aLimit
}

func physicalLeadCheckDue(now, observedAt time.Time, cfg Config) bool {
	if observedAt.IsZero() {
		return true
	}
	cfg = cfg.normalize()
	age := now.Sub(observedAt)
	return age >= 0 && age <= 2*cfg.Tick
}

func statusRetryDelay(failures int, cfg Config) time.Duration {
	cfg = cfg.normalize()
	base := 2 * cfg.StatusInterval
	if base < 250*time.Millisecond {
		base = 250 * time.Millisecond
	}
	capDelay := activeStatusPollInterval(cfg)
	if base > capDelay {
		base = capDelay
	}
	if failures < 1 {
		failures = 1
	}
	d := base
	for i := 1; i < failures && d < capDelay; i++ {
		if d > capDelay/2 {
			return capDelay
		}
		d *= 2
	}
	if d > capDelay {
		return capDelay
	}
	return d
}

func queueLead(now, queuedUntil time.Time) time.Duration {
	if queuedUntil.IsZero() || !queuedUntil.After(now) {
		return 0
	}
	return queuedUntil.Sub(now)
}

func statusObservedAfterQueue(observedAt, queuedUntil time.Time) bool {
	return queuedUntil.IsZero() || !observedAt.Before(queuedUntil)
}

func motionInputActive(haveInput bool, in Input, now time.Time, cfg Config) bool {
	cfg = cfg.normalize()
	if !haveInput || !in.Deadman || now.Sub(in.At) > cfg.DeadmanTimeout {
		return false
	}
	return response(in.Axes.X) != 0 || response(in.Axes.Y) != 0 || response(in.Axes.Z) != 0 || response(in.Axes.A) != 0
}

func commandNeedsClearStatusTransaction(typ string) bool {
	switch typ {
	case "step", "origin", "machine_origin", "target":
		return true
	default:
		return false
	}
}

func commandReleasesLease(cmd command) bool {
	if cmd.typ == "disarm" {
		return true
	}
	if cmd.typ != "control" {
		return false
	}
	switch cmd.action {
	case "hold", "feedhold", "pause", "halt", "stop", "estop":
		return true
	default:
		return false
	}
}

func (s *Session) statusTransactionBusy() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.statusInFlight || s.statusRetry
}

func activeStatusPollInterval(cfg Config) time.Duration {
	cfg = cfg.normalize()
	d := 8 * cfg.StatusInterval
	if d < minActiveStatusGap {
		d = minActiveStatusGap
	}
	if d > maxActiveStatusGap {
		d = maxActiveStatusGap
	}
	return d
}

func activeStatusMaxAge(cfg Config) time.Duration {
	cfg = cfg.normalize()
	maxAge := activeStatusPollInterval(cfg) + statusQueryTimeout(cfg) + 500*time.Millisecond
	if maxAge < cfg.DeadmanTimeout {
		maxAge = cfg.DeadmanTimeout
	}
	return maxAge
}

func canContinueJog(st machine.State) bool {
	return st == machine.Idle || st == machine.Run
}

func stateLabel(st machine.State) string {
	if st == machine.Unknown {
		return "Unknown"
	}
	return string(st)
}

func appendPlannedSegment(segments []plannedSegment, seg plannedSegment, now time.Time) []plannedSegment {
	segments = trimPlannedSegments(segments, now)
	return append(segments, seg)
}

func trimPlannedSegments(segments []plannedSegment, now time.Time) []plannedSegment {
	keep := 0
	for keep+1 < len(segments) && !segments[keep].end.After(now) {
		keep++
	}
	if keep == 0 {
		return segments
	}
	out := append([]plannedSegment(nil), segments[keep:]...)
	return out
}

func estimateFromSegments(segments []plannedSegment, now time.Time, fallback machine.AxisValues) machine.AxisValues {
	if len(segments) == 0 {
		return copyAxes(fallback)
	}
	for _, seg := range segments {
		if now.Before(seg.start) || seg.end.Equal(seg.start) {
			return copyAxes(seg.from)
		}
		if now.Before(seg.end) || now.Equal(seg.end) {
			t := now.Sub(seg.start).Seconds() / seg.end.Sub(seg.start).Seconds()
			return interpolateAxes(seg.from, seg.to, t)
		}
	}
	return copyAxes(segments[len(segments)-1].to)
}

func interpolateAxes(from, to machine.AxisValues, t float64) machine.AxisValues {
	if t < 0 {
		t = 0
	} else if t > 1 {
		t = 1
	}
	out := copyAxes(from)
	if out == nil {
		out = machine.AxisValues{}
	}
	for axis, target := range to {
		out[axis] = out[axis] + (target-out[axis])*t
	}
	return out
}

func estimatedWorkPosition(estimated machine.AxisValues, st machine.Status) machine.AxisValues {
	if len(estimated) == 0 || len(st.MPos) == 0 || len(st.WPos) == 0 {
		return nil
	}
	out := copyAxes(st.WPos)
	if out == nil {
		out = machine.AxisValues{}
	}
	for _, axis := range []string{"x", "y", "z", "a"} {
		m, mok := st.MPos[axis]
		w, wok := st.WPos[axis]
		e, eok := estimated[axis]
		if mok && wok && eok {
			out[axis] = e - (m - w)
		}
	}
	return out
}

func motionEvent(target, observed, estimated machine.AxisValues, delta Axes, cmd string, queuedLead time.Duration, st machine.Status) *MotionEvent {
	if estimated == nil {
		estimated = observed
	}
	leadFrom := estimated
	if leadFrom == nil {
		leadFrom = observed
	}
	return &MotionEvent{
		Target:        copyAxes(target),
		Observed:      copyAxes(observed),
		Estimated:     copyAxes(estimated),
		EstimatedWPos: estimatedWorkPosition(estimated, st),
		Delta:         delta,
		Lead: Axes{
			X: target["x"] - leadFrom["x"],
			Y: target["y"] - leadFrom["y"],
			Z: target["z"] - leadFrom["z"],
			A: target["a"] - leadFrom["a"],
		},
		QueueLeadMs: queuedLead.Milliseconds(),
		Command:     cmd,
	}
}

func statusQueryTimeout(cfg Config) time.Duration {
	cfg = cfg.normalize()
	timeout := 2 * cfg.StatusInterval
	if timeout < 100*time.Millisecond {
		timeout = 100 * time.Millisecond
	}
	if timeout > 250*time.Millisecond {
		timeout = 250 * time.Millisecond
	}
	return timeout
}

func isTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

func channelClosed(ch <-chan struct{}) bool {
	if ch == nil {
		return false
	}
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

func (s *Session) emitStatusWaiting(now time.Time) {
	s.mu.Lock()
	last := s.lastStatusWait
	if !last.IsZero() && now.Sub(last) < statusWaitGap {
		s.mu.Unlock()
		return
	}
	s.lastStatusWait = now
	s.mu.Unlock()
	s.emit(Event{Type: "error", Code: CodeStatusWaiting, Message: "Waiting for fresh machine status before continuing jog."})
}

func (s *Session) emitMotionEstimate(now time.Time, st machine.Status, target machine.AxisValues, delta Axes, cmd string, queuedLead time.Duration) {
	s.mu.Lock()
	s.segments = trimPlannedSegments(s.segments, now)
	estimated := estimateFromSegments(s.segments, now, target)
	s.mu.Unlock()
	revision := s.mgr.motionRevisions().motion
	if target == nil {
		target = estimated
	}
	if target == nil && estimated == nil {
		return
	}
	ev := motionEvent(target, st.MPos, estimated, delta, cmd, queuedLead, st)
	ev.Revision = revision
	s.emitMotion(now, ev)
}

func (s *Session) emitMotion(now time.Time, ev *MotionEvent) {
	s.mu.Lock()
	last := s.lastMotionEvent
	if !last.IsZero() && now.Sub(last) < motionEventGap {
		s.mu.Unlock()
		return
	}
	s.lastMotionEvent = now
	s.mu.Unlock()
	s.mgr.broadcastEvent(Event{Type: "motion", Motion: ev})
}

func (s *Session) logMotion(now time.Time, cmd string) {
	s.mu.Lock()
	last := s.lastMotionLog
	if !last.IsZero() && now.Sub(last) < motionLogGap {
		s.mu.Unlock()
		return
	}
	s.lastMotionLog = now
	s.mu.Unlock()
	s.log(gcodelog.DirSend, cmd)
}

func (s *Session) logAlarmStatus(st machine.Status) {
	raw := st.Raw
	if raw == "" {
		raw = string(st.State)
	}
	s.mu.Lock()
	if s.lastAlarmRaw == raw {
		s.mu.Unlock()
		return
	}
	s.lastAlarmRaw = raw
	lastCmd := s.lastMotionCmd
	s.mu.Unlock()

	text := "alarm status: " + raw
	if st.HaltReason != nil {
		text += fmt.Sprintf(" (H:%d %s; recovery: %s)", st.HaltReason.Code, st.HaltReason.Message, st.HaltReason.Recovery)
	}
	if lastCmd != "" {
		text += " after " + lastCmd
	}
	s.log(gcodelog.DirRecv, text)
}

func (s *Session) log(dir, text string) {
	if s.mgr.cfg.Log == nil {
		return
	}
	s.mgr.cfg.Log.Append(dir, gcodelog.SourceJog, text)
}

func (s *Session) release(err error) {
	s.mu.Lock()
	lease := s.lease
	s.lease = nil
	if lease != nil {
		s.leaseID++
	}
	s.armed = false
	s.statusInFlight = false
	s.statusRetry = false
	s.statusFailures = 0
	s.nextStatusAt = time.Time{}
	s.planned = nil
	s.queuedUntil = time.Time{}
	s.segments = nil
	s.lastMotionCmd = ""
	s.lastMotionEvent = time.Time{}
	s.lastStatusWait = time.Time{}
	s.lastAlarmRaw = ""
	s.lastMotionLog = time.Time{}
	s.targetPending = nil
	s.mu.Unlock()
	if lease != nil {
		s.statusWG.Wait()
		lease.Release(err)
	}
	s.mgr.clearOwner(s)
}

func (s *Session) failLease(code string, err error) {
	s.release(err)
	s.emit(Event{Type: "error", Code: code, Message: err.Error()})
	s.emitState(0)
}

func (s *Session) hasLease() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lease != nil
}

func (s *Session) emitState(seq int64) {
	s.mgr.broadcastState(s, seq)
}

func (s *Session) emitOwnState(seq int64) {
	avail := s.mgr.availability(s)
	s.mu.Lock()
	armed := s.armed
	mode := ""
	if s.lease != nil {
		mode = s.lease.Mode.String()
	}
	s.mu.Unlock()
	s.emit(Event{Type: "state", Seq: seq, Armed: &armed, Mode: mode, Availability: &avail})
}

func (s *Session) emit(ev Event) {
	s.emitMu.Lock()
	defer s.emitMu.Unlock()
	if s.closed {
		return
	}
	select {
	case s.events <- ev:
	case <-s.ctx.Done():
	default:
		if ev.Type != "status" && ev.Type != "motion" {
			select {
			case s.events <- ev:
			case <-s.ctx.Done():
			}
		}
	}
}

func (s *Session) closeEvents() {
	s.emitMu.Lock()
	defer s.emitMu.Unlock()
	if s.closed {
		return
	}
	s.closed = true
	close(s.events)
}

func statusEvent(st machine.Status, age time.Duration, revisions motionRevisions) *StatusEvent {
	return &StatusEvent{
		State:                 st.State,
		AgeMs:                 age.Milliseconds(),
		ObservedAt:            st.ObservedAt,
		Raw:                   st.Raw,
		MPos:                  copyAxes(st.MPos),
		WPos:                  copyAxes(st.WPos),
		MotionRevision:        revisions.motion,
		SettledMotionRevision: revisions.settled,
	}
}

func codeForErr(err error) string {
	switch {
	case errors.Is(err, session.ErrNotIdle):
		return CodeNotIdle
	case errors.Is(err, session.ErrBusy), errors.Is(err, session.ErrRelayActive), errors.Is(err, context.DeadlineExceeded):
		return CodeBusy
	default:
		return CodeMachineError
	}
}

func copyAxes(in machine.AxisValues) machine.AxisValues {
	if len(in) == 0 {
		return nil
	}
	out := make(machine.AxisValues, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func hasXYZ(in machine.AxisValues) bool {
	for _, axis := range []string{"x", "y", "z"} {
		value, ok := in[axis]
		if !ok || math.IsNaN(value) || math.IsInf(value, 0) {
			return false
		}
	}
	return true
}

func ptr[T any](v T) *T { return &v }
