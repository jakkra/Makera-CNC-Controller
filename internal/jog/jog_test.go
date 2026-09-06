package jog

import (
	"context"
	"math"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/uwin/cnc-proxy/internal/carveratest"
	"github.com/uwin/cnc-proxy/internal/client"
	"github.com/uwin/cnc-proxy/internal/gcodelog"
	"github.com/uwin/cnc-proxy/internal/machine"
	"github.com/uwin/cnc-proxy/internal/protocol"
	"github.com/uwin/cnc-proxy/internal/relay"
	"github.com/uwin/cnc-proxy/internal/session"
)

type manualClock struct {
	mu  sync.RWMutex
	now time.Time
}

func newManualClock(now time.Time) *manualClock {
	return &manualClock{now: now}
}

func (c *manualClock) Now() time.Time {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.now
}

func (c *manualClock) Set(now time.Time) {
	c.mu.Lock()
	c.now = now
	c.mu.Unlock()
}

func (c *manualClock) Add(d time.Duration) time.Time {
	c.mu.Lock()
	c.now = c.now.Add(d)
	now := c.now
	c.mu.Unlock()
	return now
}

func TestNormalizeDeadzoneClampAndSlow(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Tick = 50 * time.Millisecond
	got := Normalize(Axes{X: 0.10, Y: 2, Z: -1}, true, cfg)
	if got.X != 0 {
		t.Fatalf("deadzone X = %v, want 0", got.X)
	}
	if got.Y <= 0 || got.Z >= 0 {
		t.Fatalf("unexpected directions: %+v", got)
	}
	if got.Y > cfg.MaxXYMMMin*cfg.Tick.Minutes()*slowScale {
		t.Fatalf("Y exceeds slow max: %+v", got)
	}
	if -got.Z > cfg.MaxZMMMin*cfg.Tick.Minutes()*slowScale {
		t.Fatalf("Z exceeds slow max: %+v", got)
	}
}

func TestNormalizeClampsFastJogCadence(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Tick = 5 * time.Millisecond
	cfg.StatusInterval = 5 * time.Millisecond
	cfg.DeadmanTimeout = 150 * time.Millisecond
	got := cfg.normalize()
	if got.Tick != minJogTick {
		t.Fatalf("tick = %s, want %s", got.Tick, minJogTick)
	}
	if got.StatusInterval != minStatusEvery {
		t.Fatalf("status interval = %s, want %s", got.StatusInterval, minStatusEvery)
	}
	if got.DeadmanTimeout != minDeadmanTimeout {
		t.Fatalf("deadman timeout = %s, want %s", got.DeadmanTimeout, minDeadmanTimeout)
	}
}

func TestClampJogTargetUsesEnabledLearnedEnvelope(t *testing.T) {
	from := machine.AxisValues{"x": -2, "y": -10, "z": -2}
	target := machine.AxisValues{"x": 3, "y": -30, "z": 4}
	limits := SoftLimits{
		Enabled: true,
		XMin:    -20, XMax: -1,
		YMin: -25, YMax: -1,
		ZMin: -15, ZMax: -1,
	}
	got := clampJogTarget(from, target, limits)
	if got["x"] != -1 || got["y"] != -25 || got["z"] != -1 {
		t.Fatalf("clamped target = %+v, want exact XYZ soft limits", got)
	}

	limits.Enabled = false
	got = clampJogTarget(from, target, limits)
	if got["x"] != 3 || got["y"] != -30 || got["z"] != 4 {
		t.Fatalf("disabled limits changed target: %+v", got)
	}
}

func TestContinuousJogStopsAtSoftLimitWithoutQueuingOvershoot(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()
	mgr.cfg.Tick = time.Hour
	mgr.cfg.DeadmanTimeout = 2 * time.Hour
	mgr.cfg.SoftLimits = func() SoftLimits {
		return SoftLimits{
			Enabled: true,
			XMin:    -10, XMax: 1,
			YMin: -10, YMax: 1,
			ZMin: -10, ZMax: 1,
		}
	}

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")

	now := time.Now()
	mgr.now = func() time.Time { return now }
	s.SetInput(Input{Seq: 2, Deadman: true, Axes: Axes{X: 1}, At: now})
	s.motionTick()
	drainUntil(t, s, "motion")
	waitForGcodeCount(t, fm, 1)
	if got := fm.Gcodes(); len(got) != 1 || !strings.Contains(got[0], "X1.0000") {
		t.Fatalf("boundary jog commands = %v, want one segment ending exactly at X max", got)
	}

	for i := 0; i < 5; i++ {
		now = now.Add(100 * time.Millisecond)
		s.motionTick()
	}
	if got := fm.Gcodes(); len(got) != 1 {
		t.Fatalf("jog queued %d commands beyond the soft limit: %v", len(got)-1, got)
	}
}

func TestStepAndTargetJogClampToSoftLimit(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()
	mgr.cfg.SoftLimits = func() SoftLimits {
		return SoftLimits{
			Enabled: true,
			XMin:    -10, XMax: 1,
			YMin: -10, YMax: 1,
			ZMin: -10, ZMax: 1,
		}
	}

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")

	s.Step(2, "x", 5)
	stepAck := drainUntil(t, s, "ack")
	if stepAck.Target["x"] != 1 {
		t.Fatalf("step ack target = %+v, want X max", stepAck.Target)
	}
	waitForGcodeCount(t, fm, 1)
	if got := fm.Gcodes()[0]; !strings.Contains(got, "X1.0000") {
		t.Fatalf("step command = %q, want clamped X delta", got)
	}

	s.mu.Lock()
	settledAt := s.queuedUntil.Add(time.Millisecond)
	s.mu.Unlock()
	mgr.now = func() time.Time { return settledAt }
	status := "<Idle|MPos:1,0,0|WPos:1,0,0>"
	if err := s.applyStatusPayload(status); err != nil {
		t.Fatal(err)
	}
	drainUntil(t, s, "status")
	s.Target(3, machine.AxisValues{"x": 25, "y": -25}, 600, false, 0)
	targetAck := drainUntil(t, s, "ack")
	if targetAck.Target["x"] != 1 || targetAck.Target["y"] != -10 {
		t.Fatalf("target ack = %+v, want clamped X/Y limits", targetAck.Target)
	}
	waitForGcodeCount(t, fm, 2)
	if got := fm.Gcodes()[1]; strings.Contains(got, "X") || !strings.Contains(got, "Y-10.0000") {
		t.Fatalf("target command = %q, want only clamped Y delta", got)
	}
}

func TestRotaryAStepUsesRelativeInstantJog(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()
	status := "<Idle|MPos:0,0,0,45|WPos:0,0,0,45>"
	fm.SetStatus(status)
	if !mgr.arb.Tracker().ObserveStatusPayload(status) {
		t.Fatal("rotary status precondition failed")
	}
	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")
	s.Step(2, "a", 5)
	ack := drainUntil(t, s, "ack")
	if ack.Target["a"] != 50 {
		t.Fatalf("A step target = %+v, want A50", ack.Target)
	}
	waitForGcodeCount(t, fm, 1)
	if got := fm.Gcodes()[0]; got != "$J A5.0000 F1.0000" {
		t.Fatalf("A step command = %q, want relative instant jog", got)
	}
}

func TestRotaryAFullTurnStepUsesDegrees(t *testing.T) {
	delta, err := stepDelta("a", 360)
	if err != nil {
		t.Fatal(err)
	}
	if delta.A != 360 || delta.X != 0 || delta.Y != 0 || delta.Z != 0 {
		t.Fatalf("A full-turn delta = %+v, want exactly 360 degrees", delta)
	}
	cfg := DefaultConfig()
	dur := stepJogDuration(delta, cfg)
	if dur != 6*time.Second {
		t.Fatalf("A full-turn duration = %s, want 6s at %.0f deg/min", dur, cfg.MaxADegMin)
	}
	if got := jogCommandForDuration(machine.AxisValues{"a": 405}, delta, cfg, dur); got != "$J A360.0000 F1.0000" {
		t.Fatalf("A full-turn command = %q, want relative 360-degree jog", got)
	}
	if _, err := stepDelta("a", 360.01); err == nil {
		t.Fatal("A step over one revolution was accepted")
	}
}

func TestContinuousRotaryAHoldEmitsInstantJog(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()
	status := "<Idle|MPos:0,0,0,45|WPos:0,0,0,45>"
	fm.SetStatus(status)
	if !mgr.arb.Tracker().ObserveStatusPayload(status) {
		t.Fatal("rotary status precondition failed")
	}

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")
	s.SetInput(Input{Seq: 2, Deadman: true, Axes: Axes{A: 1}, At: time.Now()})
	drainUntil(t, s, "motion")
	waitForGcodeCount(t, fm, 1)
	if got := fm.Gcodes()[0]; !strings.HasPrefix(got, "$J A") || strings.Contains(got, "G53") {
		t.Fatalf("A hold command = %q, want relative instant jog", got)
	}
	s.SetInput(Input{Seq: 3, Deadman: false, Axes: Axes{}, At: time.Now()})
}

func TestStatusQueryTimeoutToleratesTransportLatency(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Tick = 5 * time.Millisecond
	cfg.StatusInterval = 100 * time.Millisecond
	if got := statusQueryTimeout(cfg); got != 200*time.Millisecond {
		t.Fatalf("fast status query timeout = %s, want 200ms", got)
	}

	cfg.Tick = 50 * time.Millisecond
	cfg.StatusInterval = 500 * time.Millisecond
	if got := statusQueryTimeout(cfg); got != 250*time.Millisecond {
		t.Fatalf("capped status query timeout = %s, want 250ms", got)
	}
}

func TestActiveMotionRequestsBoundedStatusPolling(t *testing.T) {
	mgr, _, cleanup := newJogManager(t)
	defer cleanup()
	base := time.Unix(100, 0)
	now := base
	mgr.now = func() time.Time { return now }
	mgr.cfg.Tick = minJogTick
	mgr.cfg.StatusInterval = minStatusEvery
	mgr.cfg.DeadmanTimeout = time.Second

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")
	s.SetInput(Input{Seq: 2, Deadman: true, Axes: Axes{X: 1}, At: base})

	now = base.Add(mgr.cfg.StatusInterval)
	if s.shouldRequestStatus(now) {
		t.Fatal("active jog should use the less frequent active-motion status interval")
	}

	now = base.Add(activeStatusPollInterval(mgr.cfg))
	if !s.shouldRequestStatus(now) {
		t.Fatal("active jog should periodically poll status while motion input is live")
	}

	s.SetInput(Input{Seq: 3, Deadman: true, Axes: Axes{}, At: now})
	if !s.shouldRequestStatus(now) {
		t.Fatal("jog should poll status once active axis input stops")
	}
}

func TestManagerAllowsMultipleObserverSessions(t *testing.T) {
	mgr, _, cleanup := newJogManager(t)
	defer cleanup()

	s1, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s1.Close()
	hello1 := drainUntil(t, s1, "hello")
	s2, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	hello2 := drainUntil(t, s2, "hello")
	if hello1.Capabilities == nil || !hello1.Capabilities.Availability.Available {
		t.Fatalf("first observer availability = %+v, want available", hello1.Capabilities)
	}
	if hello2.Capabilities == nil || !hello2.Capabilities.Availability.Available {
		t.Fatalf("second observer availability = %+v, want available", hello2.Capabilities)
	}
}

func TestManagerDisarmActiveWaitsForLeaseRelease(t *testing.T) {
	mgr, _, cleanup := newJogManager(t)
	defer cleanup()

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")
	armed := drainUntil(t, s, "state")
	if armed.Armed == nil || !*armed.Armed || !s.hasLease() {
		t.Fatalf("armed state = %+v lease=%t, want active lease", armed, s.hasLease())
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := mgr.DisarmActive(ctx); err != nil {
		t.Fatal(err)
	}
	disarmed := drainUntil(t, s, "state")
	if disarmed.Seq != 0 || disarmed.Armed == nil || *disarmed.Armed || s.hasLease() {
		t.Fatalf("external disarm state = %+v lease=%t, want released lease", disarmed, s.hasLease())
	}
	if err := mgr.arb.WithMachine(true, func(*client.Conn) error { return nil }); err != nil {
		t.Fatalf("machine operation after DisarmActive: %v", err)
	}
}

func TestObserverCanDisarmAndTakeMovementControl(t *testing.T) {
	mgr, _, cleanup := newJogManager(t)
	defer cleanup()

	first, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	drainUntil(t, first, "hello")
	second, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	drainUntil(t, second, "hello")

	first.Arm(1)
	drainUntil(t, first, "ack")
	firstArmed := drainUntil(t, first, "state")
	if firstArmed.Armed == nil || !*firstArmed.Armed || firstArmed.Availability == nil || !firstArmed.Availability.Available {
		t.Fatalf("first armed state = %+v, want armed owner", firstArmed)
	}
	secondBusy := drainUntil(t, second, "state")
	if secondBusy.Armed == nil || *secondBusy.Armed || secondBusy.Availability == nil || secondBusy.Availability.Reason != CodeBusy {
		t.Fatalf("second observer state = %+v, want unarmed and busy", secondBusy)
	}
	if ext := mgr.Availability(); ext.Available || ext.Reason != CodeBusy {
		t.Fatalf("external availability while first owns movement = %+v, want busy", ext)
	}

	second.Disarm(2)
	drainUntil(t, second, "ack")
	secondReady := drainUntil(t, second, "state")
	if secondReady.Armed == nil || *secondReady.Armed || secondReady.Availability == nil || !secondReady.Availability.Available {
		t.Fatalf("second state after takeover disarm = %+v, want ready observer", secondReady)
	}
	firstDisarmed := drainUntilState(t, first, func(ev Event) bool {
		return ev.Armed != nil && !*ev.Armed && ev.Availability != nil && ev.Availability.Available
	})
	if firstDisarmed.Armed == nil || *firstDisarmed.Armed {
		t.Fatalf("first state after remote disarm = %+v, want disarmed", firstDisarmed)
	}

	second.Arm(3)
	drainUntil(t, second, "ack")
	secondArmed := drainUntilState(t, second, func(ev Event) bool {
		return ev.Armed != nil && *ev.Armed
	})
	if secondArmed.Availability == nil || !secondArmed.Availability.Available {
		t.Fatalf("second armed state = %+v, want movement owner", secondArmed)
	}
	firstBusy := drainUntilState(t, first, func(ev Event) bool {
		return ev.Armed != nil && !*ev.Armed && ev.Availability != nil && ev.Availability.Reason == CodeBusy
	})
	if firstBusy.Availability == nil || firstBusy.Availability.Reason != CodeBusy {
		t.Fatalf("first observer after takeover = %+v, want busy", firstBusy)
	}
}

func TestArmVerifiesCachedIdleOnAcquiredMachinePath(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()
	// The shared tracker still contains the fresh Idle status seeded by the
	// fixture, but the machine changed before the operator armed movement.
	fm.SetStatus("<Alarm|MPos:0,0,0|WPos:0,0,0|H:10>")

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	ev := readEvent(t, s, "error")
	if ev.Seq != 1 || ev.Code != CodeNotIdle {
		t.Fatalf("arm result = %+v, want current machine not_idle", ev)
	}
	if s.hasLease() {
		t.Fatal("arm retained a jog lease after current Alarm status")
	}
}

func TestActiveJogAvailabilityAllowsOwnRunState(t *testing.T) {
	mgr, _, cleanup := newJogManager(t)
	defer cleanup()

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")
	if !mgr.arb.Tracker().ObserveStatusPayload("<Run|MPos:0,0,0|WPos:0,0,0>") {
		t.Fatal("status precondition failed")
	}

	s.emitState(2)
	ev := readEvent(t, s, "state")
	if ev.Availability == nil || !ev.Availability.Available {
		t.Fatalf("active jog availability during Run = %+v, want available", ev.Availability)
	}
	if ev.Availability.Message != "Jog session active." {
		t.Fatalf("active jog availability message = %q", ev.Availability.Message)
	}
}

func TestJogOwnerEmitsInstantSegments(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")

	s.Arm(1)
	drainUntil(t, s, "ack")
	s.SetInput(Input{Seq: 2, Deadman: true, Axes: Axes{X: 1}, At: time.Now()})

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		for _, line := range fm.Gcodes() {
			if strings.HasPrefix(line, "$J X") && !strings.Contains(line, "G91") {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no instant jog command observed; gcodes=%v", fm.Gcodes())
}

func TestJogG53FallbackCommand(t *testing.T) {
	target := machine.AxisValues{"x": 1.25, "y": -2.5, "z": 3.75}
	delta := Axes{X: 0.5, Z: -0.25}
	cfg := DefaultConfig()
	cfg.MotionPrimitive = MotionPrimitiveG53
	got := jogCommand(target, delta, cfg)
	if got != "G53 G0 X1.2500 Z3.7500" {
		t.Fatalf("G53 fallback command = %q", got)
	}
}

func TestInstantJogCommandIncludesVelocityScale(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Tick = 20 * time.Millisecond
	cfg.MaxXYMMMin = 1200
	delta := Normalize(Axes{X: 1}, false, cfg)
	got := jogCommand(machine.AxisValues{"x": 0, "y": 0, "z": 0}, delta, cfg)
	if got != "$J X0.4000 F0.4000" {
		t.Fatalf("instant jog command = %q, want velocity-matched F scale", got)
	}
}

func TestInstantJogCommandAllowsScaleAboveFirmwareDefault(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Tick = 20 * time.Millisecond
	cfg.MaxXYMMMin = 6000
	delta := Normalize(Axes{X: 1}, false, cfg)
	got := jogCommand(machine.AxisValues{"x": 0, "y": 0, "z": 0}, delta, cfg)
	if got != "$J X2.0000 F2.0000" {
		t.Fatalf("instant jog command = %q, want configured speed above firmware default", got)
	}
}

func TestMotionDeltaUsesBufferedSegment(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Tick = 20 * time.Millisecond
	cfg.MaxXYMMMin = 1200
	delta := MotionDelta(Axes{X: 1}, false, cfg)
	if math.Abs(delta.X-1.6) > 0.0001 {
		t.Fatalf("buffered X delta = %.4f, want 1.6000", delta.X)
	}
	got := jogCommandForDuration(machine.AxisValues{"x": delta.X, "y": 0, "z": 0}, delta, cfg, jogSegmentDuration(cfg))
	if got != "$J X1.6000 F0.4000" {
		t.Fatalf("buffered instant jog command = %q, want velocity-matched 80ms segment", got)
	}
}

func TestJogSessionAllowsScaleAboveFirmwareDefault(t *testing.T) {
	mgr, _, cleanup := newJogManager(t)
	defer cleanup()
	mgr.cfg.MaxXYMMMin = 6000

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")

	s.Arm(1)
	drainUntil(t, s, "ack")
	s.SetInput(Input{Seq: 2, Deadman: true, Axes: Axes{X: 1}, At: time.Now()})
	ev := drainUntil(t, s, "motion")
	if ev.Motion == nil || !strings.Contains(ev.Motion.Command, " F2.0000") {
		t.Fatalf("motion command = %+v, want F2.0000 scale", ev.Motion)
	}
}

func TestJogEmitsMotionEventAndLog(t *testing.T) {
	mgr, _, cleanup := newJogManager(t)
	defer cleanup()
	log := gcodelog.New(20)
	mgr.cfg.Log = log

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")

	s.Arm(1)
	drainUntil(t, s, "ack")
	s.SetInput(Input{Seq: 2, Deadman: true, Axes: Axes{X: 1, Y: -0.5}, At: time.Now()})
	ev := drainUntil(t, s, "motion")
	if ev.Motion == nil || !strings.HasPrefix(ev.Motion.Command, "$J") || ev.Motion.Target["x"] == 0 {
		t.Fatalf("motion event = %+v", ev.Motion)
	}

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		for _, ln := range log.Recent() {
			if ln.Source == gcodelog.SourceJog && ln.Dir == gcodelog.DirSend && strings.HasPrefix(ln.Text, "$J") {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("jog motion was not logged: %+v", log.Recent())
}

func TestJogTargetUsesFreshStatusWhileStatusPollInFlight(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()
	fm.SetStatusReplyDelay(50 * time.Millisecond)

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")

	s.requestStatus()
	s.Target(2, machine.AxisValues{"x": 10, "y": -5}, 600, false, 0)
	ack := drainUntil(t, s, "ack")
	if ack.Seq != 2 {
		t.Fatalf("target ack = %+v, want seq 2", ack)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		for _, line := range fm.Gcodes() {
			if strings.Contains(line, "X10.0000") && strings.Contains(line, "Y-5.0000") {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no target jog command observed: %v", fm.Gcodes())
}

func TestJogTargetRemainsExclusiveUntilObservedAtTarget(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")

	s.Target(2, machine.AxisValues{"x": 10, "y": -5}, 600, false, 0)
	ack := drainUntil(t, s, "ack")
	if ack.Seq != 2 {
		t.Fatalf("target ack = %+v, want seq 2", ack)
	}
	deadline := time.Now().Add(time.Second)
	for len(fm.Gcodes()) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if len(fm.Gcodes()) == 0 {
		t.Fatal("first target did not reach fake machine")
	}
	before := len(fm.Gcodes())
	s.SetInput(Input{Seq: 3, Deadman: true, Axes: Axes{X: 1}, At: time.Now()})
	s.motionTick()
	if got := len(fm.Gcodes()); got != before {
		t.Fatalf("continuous input wrote %d commands while target was pending, want %d", got, before)
	}

	s.Target(4, machine.AxisValues{"x": 20, "y": 5}, 600, false, 0)
	busy := readEvent(t, s, "error")
	if busy.Seq != 4 || busy.Code != CodeBusy {
		t.Fatalf("second target event = %+v, want busy error for seq 4", busy)
	}
	if got := len(fm.Gcodes()); got != before {
		t.Fatalf("second target wrote %d commands while first target was pending, want %d", got, before)
	}

	status := "<Idle|MPos:10,-5,0|WPos:10,-5,0>"
	fm.SetStatus(status)
	if err := s.applyStatusPayload(status); err != nil {
		t.Fatal(err)
	}
	complete := drainUntil(t, s, "target_complete")
	if complete.Seq != 2 || complete.Target["x"] != 10 || complete.Target["y"] != -5 {
		t.Fatalf("target completion = %+v, want observed target for seq 2", complete)
	}

	s.Target(5, machine.AxisValues{"x": 20, "y": 5}, 600, false, 0)
	ack = drainUntil(t, s, "ack")
	if ack.Seq != 5 {
		t.Fatalf("target ack after observed completion = %+v, want seq 5", ack)
	}
}

func TestJogTargetThatStopsShortTerminatesAndAllowsNextTarget(t *testing.T) {
	mgr, _, cleanup := newJogManager(t)
	defer cleanup()
	base := time.Now()
	now := base
	mgr.now = func() time.Time { return now }
	mgr.cfg.StatusInterval = time.Hour

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")

	s.Target(2, machine.AxisValues{"x": 10, "y": -5}, 600, false, 0)
	ack := drainUntil(t, s, "ack")
	if ack.Seq != 2 {
		t.Fatalf("target ack = %+v, want seq 2", ack)
	}
	s.mu.Lock()
	verifyAfter := s.targetPending.verifyAfter
	s.mu.Unlock()

	now = verifyAfter.Add(time.Millisecond)
	status := "<Idle|MPos:9.5,-5,0|WPos:9.5,-5,0>"
	if err := s.applyStatusPayload(status); err != nil {
		t.Fatal(err)
	}
	failed := readEvent(t, s, "error")
	if failed.Seq != 2 || failed.Code != CodeTargetNotReached {
		t.Fatalf("short target result = %+v, want terminal target_not_reached for seq 2", failed)
	}
	s.mu.Lock()
	pending := s.targetPending
	s.mu.Unlock()
	if pending != nil {
		t.Fatalf("short target remained pending: %+v", pending)
	}

	s.Target(3, machine.AxisValues{"x": 8, "y": -4}, 600, false, 0)
	ack = drainUntil(t, s, "ack")
	if ack.Seq != 3 {
		t.Fatalf("next target ack = %+v, want seq 3", ack)
	}
}

func TestJogTargetWithoutFreshCompletionStatusDisarms(t *testing.T) {
	mgr, _, cleanup := newJogManager(t)
	defer cleanup()
	base := time.Now()
	now := base
	mgr.now = func() time.Time { return now }
	mgr.cfg.StatusInterval = time.Hour

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")

	s.Target(2, machine.AxisValues{"x": 10, "y": -5}, 600, false, 0)
	ack := drainUntil(t, s, "ack")
	if ack.Seq != 2 {
		t.Fatalf("target ack = %+v, want seq 2", ack)
	}
	s.mu.Lock()
	verifyAfter := s.targetPending.verifyAfter
	s.lastStatusAt = s.targetPending.motionDoneAt.Add(-time.Millisecond)
	s.statusInFlight = false
	s.mu.Unlock()

	now = verifyAfter.Add(statusQueryTimeout(mgr.cfg) + time.Millisecond)
	s.motionTick()
	failed := readEvent(t, s, "error")
	if failed.Seq != 2 || failed.Code != CodeStaleStatus {
		t.Fatalf("unverified target result = %+v, want terminal stale_status for seq 2", failed)
	}
	s.mu.Lock()
	pending := s.targetPending
	armed := s.armed
	lease := s.lease
	s.mu.Unlock()
	if pending != nil || armed || lease != nil {
		t.Fatalf("unverified target state pending=%+v armed=%t lease=%v, want fully disarmed", pending, armed, lease)
	}
}

func TestJogTargetWaitsForQueuedManualMotion(t *testing.T) {
	mgr, _, cleanup := newJogManager(t)
	defer cleanup()

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")

	s.SetInput(Input{Seq: 2, Deadman: true, Axes: Axes{X: 1}, At: time.Now()})
	drainUntil(t, s, "motion")
	s.Target(3, machine.AxisValues{"x": 10, "y": -5}, 600, false, 0)
	busy := readEvent(t, s, "error")
	if busy.Seq != 3 || busy.Code != CodeBusy {
		t.Fatalf("target during queued manual motion = %+v, want busy error for seq 3", busy)
	}
}

func TestJogTargetMovesToSafeZBeforeXY(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()
	status := "<Idle|MPos:0,0,-5|WPos:0,0,-5>"
	fm.SetStatus(status)
	if !mgr.arb.Tracker().ObserveStatusPayload(status) {
		t.Fatal("failed to seed tracker status")
	}

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")

	s.Target(2, machine.AxisValues{"x": 10, "y": -5}, 600, true, 0)
	ack := drainUntil(t, s, "ack")
	if ack.Seq != 2 {
		t.Fatalf("target ack = %+v, want seq 2", ack)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		gcodes := fm.Gcodes()
		if len(gcodes) >= 2 {
			if !strings.Contains(gcodes[0], "Z5.0000") {
				t.Fatalf("first target command = %q, want safe Z lift; all=%v", gcodes[0], gcodes)
			}
			if !strings.Contains(gcodes[1], "X10.0000") || !strings.Contains(gcodes[1], "Y-5.0000") {
				t.Fatalf("second target command = %q, want XY target; all=%v", gcodes[1], gcodes)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("safe Z target did not emit two jog commands: %v", fm.Gcodes())
}

func TestJogTargetWithUnchangedXYDoesNotLiftToSafeZ(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()
	status := "<Idle|MPos:0,0,-5|WPos:0,0,-5>"
	fm.SetStatus(status)
	if !mgr.arb.Tracker().ObserveStatusPayload(status) {
		t.Fatal("failed to seed tracker status")
	}

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")

	// Work-coordinate inputs include the live X/Y values. They are targets but
	// not an XY move, so a Z-only request must not take a Safe Z detour.
	s.Target(2, machine.AxisValues{"x": 0, "y": 0, "z": -2}, 600, true, 0)
	ack := drainUntil(t, s, "ack")
	if ack.Seq != 2 {
		t.Fatalf("target ack = %+v, want seq 2", ack)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		gcodes := fm.Gcodes()
		if len(gcodes) == 0 {
			time.Sleep(10 * time.Millisecond)
			continue
		}
		if len(gcodes) != 1 || !strings.Contains(gcodes[0], "Z3.0000") || strings.Contains(gcodes[0], "Z5.0000") {
			t.Fatalf("Z-only target gcodes = %v, want one direct Z move", gcodes)
		}
		return
	}
	t.Fatalf("Z-only target did not reach fake machine: %v", fm.Gcodes())
}

func TestJogTargetWithRoundedUnchangedXYDoesNotLiftToSafeZ(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()
	status := "<Idle|MPos:68.9980,-49.9240,-5.0000|WPos:-49.9240,-10.0000,-5.0000>"
	fm.SetStatus(status)
	if !mgr.arb.Tracker().ObserveStatusPayload(status) {
		t.Fatal("failed to seed tracker status")
	}

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")

	// The browser reconstructs a machine target as WPos + (MPos - WPos).
	// With ordinary decimal coordinates that can differ from the reported MPos
	// by a floating-point rounding residue even though the axis is unchanged.
	mposX := 68.998
	wposX := -49.924
	roundedX := wposX + (mposX - wposX)
	if roundedX == mposX {
		t.Fatal("test coordinates did not produce the expected rounding residue")
	}
	s.Target(2, machine.AxisValues{"x": roundedX, "y": -49.924, "z": -2}, 600, true, 0)
	ack := drainUntil(t, s, "ack")
	if ack.Seq != 2 {
		t.Fatalf("target ack = %+v, want seq 2", ack)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		gcodes := fm.Gcodes()
		if len(gcodes) == 0 {
			time.Sleep(10 * time.Millisecond)
			continue
		}
		if len(gcodes) != 1 || !strings.Contains(gcodes[0], "Z3.0000") || strings.Contains(gcodes[0], "X") {
			t.Fatalf("rounded Z-only target gcodes = %v, want one direct Z move", gcodes)
		}
		return
	}
	t.Fatalf("rounded Z-only target did not reach fake machine: %v", fm.Gcodes())
}

func TestJogTargetFeedIsNotCappedByContinuousJogLimit(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()
	mgr.cfg.MaxXYMMMin = 1200

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")

	s.Target(2, machine.AxisValues{"x": 10}, 3000, false, 0)
	ack := drainUntil(t, s, "ack")
	if ack.Seq != 2 {
		t.Fatalf("target ack = %+v, want seq 2", ack)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		for _, line := range fm.Gcodes() {
			if strings.Contains(line, "X10.0000") {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("high-feed target did not reach fake machine: %v", fm.Gcodes())
}

func TestJogTargetMovesXYZWithSafeZSequence(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()
	status := "<Idle|MPos:0,0,-5|WPos:0,0,-5>"
	fm.SetStatus(status)
	if !mgr.arb.Tracker().ObserveStatusPayload(status) {
		t.Fatal("failed to seed tracker status")
	}

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")

	s.Target(2, machine.AxisValues{"x": 10, "y": -5, "z": -2}, 600, true, 0)
	ack := drainUntil(t, s, "ack")
	if ack.Seq != 2 {
		t.Fatalf("target ack = %+v, want seq 2", ack)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		gcodes := fm.Gcodes()
		if len(gcodes) >= 3 {
			if !strings.Contains(gcodes[0], "Z5.0000") {
				t.Fatalf("first target command = %q, want safe Z lift; all=%v", gcodes[0], gcodes)
			}
			if !strings.Contains(gcodes[1], "X10.0000") || !strings.Contains(gcodes[1], "Y-5.0000") || strings.Contains(gcodes[1], "Z") {
				t.Fatalf("second target command = %q, want XY only; all=%v", gcodes[1], gcodes)
			}
			if !strings.Contains(gcodes[2], "Z-2.0000") {
				t.Fatalf("third target command = %q, want final Z; all=%v", gcodes[2], gcodes)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("safe XYZ target did not emit three jog commands: %v", fm.Gcodes())
}

func TestJogSetOriginSendsControllerCommand(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")

	s.SetOrigin(2, "z", 0)
	ack := drainUntil(t, s, "ack")
	if ack.Seq != 2 {
		t.Fatalf("origin ack = %+v, want seq 2", ack)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		for _, line := range fm.Gcodes() {
			if line == "G10L20P0Z0.0000" {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no origin command observed: %v", fm.Gcodes())
}

func TestJogSetMachineOriginUsesOneVendorG10L2Command(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()
	status := "<Idle|MPos:-100,-80,-3|WPos:0,0,0>"
	fm.SetStatus(status)
	if !mgr.arb.Tracker().ObserveStatusPayload(status) {
		t.Fatal("failed to seed tracker status")
	}

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")

	s.SetMachineOrigin(2, machine.AxisValues{"x": -287.51, "y": -202.11})
	ack := drainUntil(t, s, "ack")
	if ack.Seq != 2 {
		t.Fatalf("origin ack = %+v, want seq 2", ack)
	}
	if math.Abs(ack.Target["x"]-187.51) > 1e-9 || math.Abs(ack.Target["y"]-122.11) > 1e-9 {
		t.Fatalf("origin verification target = %+v", ack.Target)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		for _, line := range fm.Gcodes() {
			if line == "G10L2P0X-287.5100Y-202.1100" {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no machine-origin command observed: %v", fm.Gcodes())
}

func TestJogFastTickMaintainsBoundedBackToBackLookahead(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()
	base := time.Unix(100, 0)
	clock := newManualClock(base)
	mgr.now = clock.Now
	mgr.cfg.Tick = minJogTick
	mgr.cfg.StatusInterval = time.Hour
	mgr.cfg.DeadmanTimeout = time.Second

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")
	s.SetInput(Input{Seq: 2, Deadman: true, Axes: Axes{X: 1}, At: base})

	for i := 0; i < 20; i++ {
		clock.Set(base.Add(time.Duration(i) * mgr.cfg.Tick))
		s.motionTick()
	}
	waitForGcodeCount(t, fm, 3)
	got := fm.Gcodes()
	if len(got) < 3 {
		t.Fatalf("jog did not establish back-to-back planner segments: %v", got)
	}
	s.mu.Lock()
	lead := queueLead(clock.Now(), s.queuedUntil)
	lastStatusAt := s.lastStatusAt
	s.mu.Unlock()
	if lead < jogLookahead(mgr.cfg) || lead > jogLookahead(mgr.cfg)+jogSegmentDuration(mgr.cfg) {
		t.Fatalf("queued lead = %s, want refill-threshold cushion in [%s,%s]", lead, jogLookahead(mgr.cfg), jogLookahead(mgr.cfg)+jogSegmentDuration(mgr.cfg))
	}
	if physicalLeadCheckDue(clock.Now(), lastStatusAt, mgr.cfg) {
		t.Fatal("an old physical-position sample should not throttle a healthy buffered jog")
	}
	motions := drainAvailableEvents(s, "motion")
	if motions == 0 {
		t.Fatal("expected at least one motion event")
	}
	if motions > 4 {
		t.Fatalf("motion events should be UI-rate limited, got %d events across 20 fast ticks", motions)
	}
}

func TestGamepadJogQueuesNextSegmentWhileMachineIsRun(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()
	base := time.Unix(100, 0)
	clock := newManualClock(base)
	mgr.now = clock.Now
	mgr.cfg.Tick = 20 * time.Millisecond
	mgr.cfg.StatusInterval = time.Hour
	mgr.cfg.DeadmanTimeout = 2 * time.Second

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")
	s.SetInput(Input{Seq: 2, Deadman: true, Axes: Axes{X: 1}, At: base})
	s.motionTick()
	waitForGcodeCount(t, fm, 2)
	if got := len(fm.Gcodes()); got != 2 {
		t.Fatalf("initial lookahead = %d commands, want two back-to-back segments: %v", got, fm.Gcodes())
	}

	// The lookahead is a refill threshold, not a ceiling. One normal 20ms tick
	// later, append the third 80ms block so scheduler and transport jitter cannot
	// drain the firmware planner down to its currently executing block.
	clock.Set(base.Add(mgr.cfg.Tick))
	s.SetInput(Input{Seq: 3, Deadman: true, Axes: Axes{X: 1}, At: clock.Now()})
	s.motionTick()
	waitForGcodeCount(t, fm, 3)
	if got := len(fm.Gcodes()); got != 3 {
		t.Fatalf("refilled lookahead = %d commands, want one block beyond the low-water mark: %v", got, fm.Gcodes())
	}

	clock.Set(base.Add(100 * time.Millisecond))
	if err := s.applyStatusPayload("<Run|MPos:5,0,0|WPos:5,0,0>"); err != nil {
		t.Fatal(err)
	}
	s.SetInput(Input{Seq: 4, Deadman: true, Axes: Axes{X: 1}, At: clock.Now()})
	s.motionTick()
	waitForGcodeCount(t, fm, 4)
	if got := len(fm.Gcodes()); got <= 3 {
		t.Fatalf("Run status did not admit the next back-to-back segment: %v", fm.Gcodes())
	}
	if !s.hasLease() {
		t.Fatal("continuous Run status released the armed jog lease")
	}
}

func TestGamepadStopCeasesQueueAdmissionWithoutRealtimeControl(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()
	base := time.Unix(100, 0)
	clock := newManualClock(base)
	mgr.now = clock.Now
	mgr.cfg.Tick = minJogTick
	mgr.cfg.StatusInterval = time.Hour
	mgr.cfg.DeadmanTimeout = 2 * time.Second

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")
	s.SetInput(Input{Seq: 2, Deadman: true, Axes: Axes{X: 1}, At: base})
	s.motionTick()
	waitForGcodeCount(t, fm, 2)
	before := len(fm.Gcodes())

	s.SetInput(Input{Seq: 3, Deadman: false, Axes: Axes{}, At: base})
	for i := 1; i <= 50; i++ {
		clock.Set(base.Add(time.Duration(i) * mgr.cfg.Tick))
		s.motionTick()
	}
	if got := len(fm.Gcodes()); got != before {
		t.Fatalf("released gamepad admitted %d additional segments: before=%d commands=%v", got-before, before, fm.Gcodes())
	}
	if controls := fm.Controls(); len(controls) != 0 {
		t.Fatalf("gamepad stop sent realtime hold/halt controls: %v", controls)
	}
	if !s.hasLease() {
		t.Fatal("stopping gamepad motion should leave Movement armed")
	}
}

func TestGamepadJogSustainsBackToBackMotionThenDrainsPromptlyOnRelease(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()
	mgr.cfg.Tick = 20 * time.Millisecond
	mgr.cfg.StatusInterval = minStatusEvery
	mgr.cfg.DeadmanTimeout = minDeadmanTimeout

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")

	end := time.Now().Add(800 * time.Millisecond)
	seq := int64(2)
	for time.Now().Before(end) {
		s.SetInput(Input{Seq: seq, Deadman: true, Axes: Axes{X: 1}, At: time.Now()})
		seq++
		time.Sleep(15 * time.Millisecond)
	}
	if got := len(fm.Gcodes()); got < 8 {
		t.Fatalf("sustained gamepad input produced only %d segments; want continuous buffered motion: %v", got, fm.Gcodes())
	}
	if !s.hasLease() {
		t.Fatal("sustained back-to-back motion dropped the armed jog lease")
	}

	s.SetInput(Input{Seq: seq, Deadman: false, Axes: Axes{}, At: time.Now()})
	// Allow a write already inside the socket call to finish, then no new $J
	// frames may be admitted. The accepted lookahead drains without hold/halt.
	time.Sleep(30 * time.Millisecond)
	stoppedCount := len(fm.Gcodes())
	time.Sleep(jogLookahead(mgr.cfg) + jogSegmentDuration(mgr.cfg) + 100*time.Millisecond)
	if got := len(fm.Gcodes()); got != stoppedCount {
		t.Fatalf("gamepad release kept refilling motion: stopped=%d later=%d commands=%v", stoppedCount, got, fm.Gcodes())
	}
	first := fm.Snapshot().Status
	time.Sleep(150 * time.Millisecond)
	second := fm.Snapshot().Status
	if first.State != machine.Idle || second.State != machine.Idle {
		t.Fatalf("released jog did not drain to Idle: first=%s second=%s", first.State, second.State)
	}
	if math.Abs(first.MPos["x"]-second.MPos["x"]) > targetPositionToleranceMM {
		t.Fatalf("machine kept moving after released queue drained: first=%+v second=%+v", first.MPos, second.MPos)
	}
	if controls := fm.Controls(); len(controls) != 0 {
		t.Fatalf("normal gamepad release used realtime controls: %v", controls)
	}
}

func TestGamepadReleaseDuringSlowTransportWriteAdmitsAtMostCurrentFrame(t *testing.T) {
	mgr, fm, gate, cleanup := newGatedJogManager(t)
	defer cleanup()
	mgr.cfg.Tick = time.Hour
	mgr.cfg.StatusInterval = time.Hour
	mgr.cfg.DeadmanTimeout = 5 * time.Second

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")
	s.SetInput(Input{Seq: 2, Deadman: true, Axes: Axes{X: 1}, At: time.Now()})

	done := make(chan struct{})
	go func() {
		s.motionTick()
		close(done)
	}()
	select {
	case <-gate.started:
	case <-time.After(time.Second):
		t.Fatal("jog frame never entered the slow transport")
	}
	s.SetInput(Input{Seq: 3, Deadman: false, Axes: Axes{}, At: time.Now()})
	close(gate.allow)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("motion tick did not finish after transport resumed")
	}
	waitForGcodeCount(t, fm, 1)
	time.Sleep(30 * time.Millisecond)
	if got := fm.Gcodes(); len(got) != 1 {
		t.Fatalf("release during a transport write admitted stale follow-up frames: %v", got)
	}
	if !s.hasLease() {
		t.Fatal("normal gamepad release disarmed the session")
	}
}

func TestCapturePositionFreezesStoppedBoundaryAcrossLaterMotion(t *testing.T) {
	mgr, fm, gate, cleanup := newGatedJogManager(t)
	defer cleanup()
	mgr.cfg.Tick = time.Hour
	mgr.cfg.StatusInterval = time.Hour
	mgr.cfg.DeadmanTimeout = 5 * time.Second

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")

	now := time.Now()
	mgr.now = func() time.Time { return now }
	s.SetInput(Input{Seq: 2, Deadman: true, Axes: Axes{X: 1}, At: now})
	tickDone := make(chan struct{})
	go func() {
		s.motionTick()
		close(tickDone)
	}()
	select {
	case <-gate.started:
	case <-time.After(time.Second):
		t.Fatal("jog frame never entered the slow transport")
	}

	// A stop is never delayed behind the transport. Capture, however, must wait
	// for that already-admitted frame so its endpoint is included exactly once.
	stopDone := make(chan struct{})
	go func() {
		s.SetInput(Input{Seq: 3, Deadman: false, Axes: Axes{}, At: now})
		close(stopDone)
	}()
	select {
	case <-stopDone:
	case <-time.After(time.Second):
		t.Fatal("stop input waited for the in-flight transport write")
	}
	captureDone := make(chan struct{})
	go func() {
		s.CapturePosition(4)
		close(captureDone)
	}()
	select {
	case <-captureDone:
		t.Fatal("capture returned before the in-flight segment committed")
	case <-time.After(30 * time.Millisecond):
	}

	close(gate.allow)
	select {
	case <-tickDone:
	case <-time.After(time.Second):
		t.Fatal("motion tick did not finish after transport resumed")
	}
	select {
	case <-captureDone:
	case <-time.After(time.Second):
		t.Fatal("capture did not complete after the in-flight segment committed")
	}
	first := readEvent(t, s, "position_capture")
	if first.Seq != 4 || first.Position == nil || first.Position.MPos["x"] <= 0 || first.Position.MotionRevision == 0 {
		t.Fatalf("first capture = %+v, want committed X stop boundary", first)
	}
	if first.Position.WPos["x"] != first.Position.MPos["x"] {
		t.Fatalf("first work position = %+v, want zero-offset machine position %+v", first.Position.WPos, first.Position.MPos)
	}
	frozenX := first.Position.MPos["x"]

	// Resume immediately in another direction without waiting for a status
	// report. The first event remains frozen and the next press captures a new
	// endpoint.
	now = now.Add(jogSegmentDuration(mgr.cfg))
	s.SetInput(Input{Seq: 5, Deadman: true, Axes: Axes{Y: 1}, At: now})
	s.motionTick()
	s.SetInput(Input{Seq: 6, Deadman: false, Axes: Axes{}, At: now})
	s.CapturePosition(7)
	second := readEvent(t, s, "position_capture")
	if second.Seq != 7 || second.Position == nil || second.Position.MPos["y"] <= 0 {
		t.Fatalf("second capture = %+v, want later Y stop boundary", second)
	}
	if first.Position.MPos["x"] != frozenX || first.Position.MPos["y"] != 0 {
		t.Fatalf("later motion mutated first capture: %+v", first.Position)
	}
	waitForGcodeCount(t, fm, 2)
	if got := fm.Gcodes(); len(got) < 2 {
		t.Fatalf("gcode commands = %v, want motion on both sides of capture", got)
	}
}

func TestGamepadDirectionChangeDuringSlowWriteUpdatesNextFrame(t *testing.T) {
	mgr, fm, gate, cleanup := newGatedJogManager(t)
	defer cleanup()
	mgr.cfg.Tick = time.Hour
	mgr.cfg.StatusInterval = time.Hour
	mgr.cfg.DeadmanTimeout = 5 * time.Second

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")
	s.SetInput(Input{Seq: 2, Deadman: true, Axes: Axes{X: 1}, At: time.Now()})

	done := make(chan struct{})
	go func() {
		s.motionTick()
		close(done)
	}()
	select {
	case <-gate.started:
	case <-time.After(time.Second):
		t.Fatal("jog frame never entered the slow transport")
	}
	s.SetInput(Input{Seq: 3, Deadman: true, Axes: Axes{Y: 1}, At: time.Now()})
	close(gate.allow)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("motion tick did not finish after transport resumed")
	}
	waitForGcodeCount(t, fm, 2)
	got := fm.Gcodes()
	if !strings.HasPrefix(got[0], "$J X") || !strings.HasPrefix(got[1], "$J Y") {
		t.Fatalf("direction change reused stale axes across refill: %v", got)
	}
}

func TestGamepadJogIsContinuousAcrossWiFiAndUSBLikeTransports(t *testing.T) {
	for _, tc := range []struct {
		name       string
		writeChunk int
		writeDelay time.Duration
	}{
		{name: "wifi_tcp"},
		{name: "usb_serial_pacing", writeChunk: 8, writeDelay: 500 * time.Microsecond},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mgr, fm, cleanup := newPacedJogManager(t, tc.writeChunk, tc.writeDelay)
			defer cleanup()
			s, err := mgr.Start(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			drainUntil(t, s, "hello")
			s.Arm(1)
			drainUntil(t, s, "ack")

			end := time.Now().Add(1300 * time.Millisecond)
			seq := int64(2)
			for time.Now().Before(end) {
				s.SetInput(Input{Seq: seq, Deadman: true, Axes: Axes{X: 1}, At: time.Now()})
				seq++
				time.Sleep(15 * time.Millisecond)
			}
			if got := len(fm.Gcodes()); got < 12 {
				t.Fatalf("%s transport starved buffered jogging: commands=%d gcodes=%v", tc.name, got, fm.Gcodes())
			}
			if fm.StatusQueries() < 2 {
				t.Fatalf("%s transport never completed an active-motion status poll", tc.name)
			}
			if !s.hasLease() {
				t.Fatalf("%s transport dropped the armed jog lease", tc.name)
			}

			s.SetInput(Input{Seq: seq, Deadman: false, Axes: Axes{}, At: time.Now()})
			time.Sleep(40 * time.Millisecond)
			stopped := len(fm.Gcodes())
			time.Sleep(jogLookahead(mgr.cfg) + jogSegmentDuration(mgr.cfg) + 100*time.Millisecond)
			if got := len(fm.Gcodes()); got != stopped {
				t.Fatalf("%s transport continued queue admission after release: stopped=%d got=%d", tc.name, stopped, got)
			}
		})
	}
}

func TestGamepadJogStatusTimeoutRetriesWithoutDroppingBufferedMotion(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()
	base := time.Unix(100, 0)
	clock := newManualClock(base)
	mgr.now = clock.Now
	mgr.cfg.Tick = 20 * time.Millisecond
	mgr.cfg.StatusInterval = minStatusEvery
	mgr.cfg.DeadmanTimeout = 5 * time.Second

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")
	s.SetInput(Input{Seq: 2, Deadman: true, Axes: Axes{X: 1}, At: base})
	s.motionTick()
	waitForGcodeCount(t, fm, 2)
	before := len(fm.Gcodes())

	clock.Set(base.Add(activeStatusPollInterval(mgr.cfg)))
	if err := s.applyStatusPayload("<Run|MPos:5,0,0|WPos:5,0,0>"); err != nil {
		t.Fatal(err)
	}
	fm.SetDropStatusReplies(true)
	s.requestStatus()
	s.SetInput(Input{Seq: 3, Deadman: true, Axes: Axes{X: 1}, At: clock.Now()})
	s.motionTick()
	waitForGcodeCount(t, fm, before+1)
	ev := readEvent(t, s, "error")
	if ev.Code != CodeStatusWaiting {
		t.Fatalf("dropped status result = %+v, want retryable status_waiting", ev)
	}
	if !s.hasLease() {
		t.Fatal("status timeout dropped the armed jog lease")
	}
	if !s.statusTransactionBusy() {
		t.Fatal("status timeout did not leave a retry pending")
	}
}

func TestStatusRetryBackoffPreventsPollHammering(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()
	base := time.Unix(100, 0)
	clock := newManualClock(base)
	mgr.now = clock.Now
	mgr.cfg.StatusInterval = minStatusEvery

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")
	fm.SetDropStatusReplies(true)
	s.requestStatus()
	ev := readEvent(t, s, "error")
	if ev.Code != CodeStatusWaiting {
		t.Fatalf("status timeout = %+v, want status_waiting", ev)
	}
	queries := fm.StatusQueries()
	for i := 0; i < 20; i++ {
		s.requestStatus()
	}
	time.Sleep(20 * time.Millisecond)
	if got := fm.StatusQueries(); got != queries {
		t.Fatalf("retry backoff admitted %d immediate extra polls", got-queries)
	}

	delay := statusRetryDelay(1, mgr.cfg)
	clock.Set(base.Add(delay - time.Millisecond))
	s.requestStatus()
	time.Sleep(10 * time.Millisecond)
	if got := fm.StatusQueries(); got != queries {
		t.Fatalf("status poll retried before backoff: got=%d want=%d", got, queries)
	}
	clock.Set(base.Add(delay))
	s.requestStatus()
	waitForStatusQueryCount(t, fm, queries+1)
}

func TestPersistentJogStatusTimeoutReleasesLeaseAndAllowsReconnect(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()
	base := time.Unix(100, 0)
	clock := newManualClock(base)
	mgr.now = clock.Now
	mgr.cfg.Tick = time.Hour
	mgr.cfg.StatusInterval = minStatusEvery

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")
	armedGeneration := mgr.arb.ConnectionGeneration()

	fm.SetDropStatusReplies(true)
	s.requestStatus()
	if ev := readEvent(t, s, "error"); ev.Code != CodeStatusWaiting {
		t.Fatalf("first status timeout = %+v, want retryable status_waiting", ev)
	}
	if !s.hasLease() {
		t.Fatal("one status timeout must not release the jog lease")
	}

	// Once the last good sample is older than the arbiter's freshness bound,
	// keeping the exclusive jog lease would permanently block the normal owner
	// poller from dropping and redialing the timed-out TCP connection.
	clock.Set(base.Add(mgr.arb.StateMaxAge() + time.Millisecond))
	s.requestStatus()
	if ev := readEvent(t, s, "error"); ev.Code != CodeStaleStatus {
		t.Fatalf("expired status retry = %+v, want terminal stale_status", ev)
	}
	if s.hasLease() {
		t.Fatal("persistent status timeout retained the exclusive jog lease")
	}

	// No process restart is required: after replies resume, the next owner-mode
	// transaction can acquire the arbiter and establish a fresh conversation.
	fm.SetDropStatusReplies(false)
	err = mgr.arb.WithMachine(false, func(c *client.Conn) error {
		payload, err := c.QueryState(500 * time.Millisecond)
		if err != nil {
			return err
		}
		if !mgr.arb.Tracker().ObserveStatusPayload(payload) {
			t.Fatalf("reconnect returned malformed status %q", payload)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("owner transaction after automatic jog release: %v", err)
	}
	if got := mgr.arb.ConnectionGeneration(); got <= armedGeneration {
		t.Fatalf("connection generation after recovery = %d, want greater than armed generation %d", got, armedGeneration)
	}
	if !mgr.arb.Tracker().Fresh(mgr.arb.StateMaxAge()) {
		t.Fatal("machine tracker did not recover without a proxy restart")
	}
}

func TestGamepadJogRetriesUncorrelatedBusyDiagnosticWithoutDisarming(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()
	mgr.cfg.Tick = 20 * time.Millisecond
	mgr.cfg.StatusInterval = minStatusEvery
	mgr.cfg.DeadmanTimeout = time.Second
	fm.SetStatusReplyDelay(50 * time.Millisecond)
	fm.RejectGcode("$J X4.0000 F1.0000", "error: planner busy")

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")

	s.requestStatus()
	s.SetInput(Input{Seq: 2, Deadman: true, Axes: Axes{X: 1}, At: time.Now()})
	s.motionTick()
	ev := readEvent(t, s, "error")
	if ev.Code != CodeStatusWaiting {
		t.Fatalf("uncorrelated planner diagnostic = %+v, want retryable status_waiting", ev)
	}
	if !s.hasLease() {
		t.Fatal("uncorrelated planner diagnostic disarmed gamepad movement")
	}
	if !s.statusTransactionBusy() {
		t.Fatal("uncorrelated planner diagnostic did not schedule a status retry")
	}
	rejectedCount := len(fm.Gcodes())

	// Once the transient diagnostic clears, bounded retries reopen the normal
	// command/status path without requiring the operator to re-arm. More than
	// one diagnostic may already be waiting because the initial refill contained
	// multiple planner blocks.
	fm.RejectGcode("$J X4.0000 F1.0000", "")
	fm.SetStatusReplyDelay(0)
	drainStatusThroughRetries(t, s)
	if s.statusTransactionBusy() || !s.hasLease() {
		t.Fatalf("successful status retry did not recover in place: busy=%t armed=%t", s.statusTransactionBusy(), s.hasLease())
	}
	deadline := time.Now().Add(time.Second)
	seq := int64(3)
	for time.Now().Before(deadline) && fm.Snapshot().Status.MPos["x"] <= 0 {
		s.SetInput(Input{Seq: seq, Deadman: true, Axes: Axes{X: 1}, At: time.Now()})
		seq++
		s.motionTick()
		time.Sleep(20 * time.Millisecond)
	}
	if got := fm.Snapshot().Status.MPos["x"]; got <= 0 {
		t.Fatalf("recovered jog never requeued rejected movement; gcodes=%v", fm.Gcodes())
	}
	if got := len(fm.Gcodes()); got <= rejectedCount {
		t.Fatalf("recovered jog did not submit a replacement segment: rejected=%d after=%d", rejectedCount, got)
	}
}

func TestGamepadJogRetriesMalformedStatusButStopsOnWellFormedUnknown(t *testing.T) {
	mgr, _, cleanup := newJogManager(t)
	defer cleanup()

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")
	s.mu.Lock()
	leaseID := s.leaseID
	s.statusInFlight = true
	s.mu.Unlock()

	s.handleStatusResult(statusResult{leaseID: leaseID, payload: "truncated"})
	ev := readEvent(t, s, "error")
	if ev.Code != CodeStatusWaiting || !s.hasLease() {
		t.Fatalf("malformed status result = %+v armed=%t, want retryable armed session", ev, s.hasLease())
	}

	// A syntactically valid but unknown firmware state must replace cached Idle
	// and stop the lease; retry tolerance must never turn stale Idle into motion
	// authorization.
	if err := s.applyStatusPayload("<FutureState|MPos:0,0,0|WPos:0,0,0>"); err != nil {
		t.Fatal(err)
	}
	ev = readEvent(t, s, "error")
	if ev.Code != CodeNotIdle || s.hasLease() {
		t.Fatalf("well-formed unknown status result = %+v armed=%t, want terminal not_idle", ev, s.hasLease())
	}
}

func TestJogEmitsEstimatedMotionFromQueuedSegments(t *testing.T) {
	mgr, _, cleanup := newJogManager(t)
	defer cleanup()
	base := time.Unix(100, 0)
	clock := newManualClock(base)
	mgr.now = clock.Now
	mgr.cfg.Tick = minJogTick
	mgr.cfg.StatusInterval = time.Hour
	mgr.cfg.DeadmanTimeout = time.Second

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")
	drainAvailableEvents(s, "state")
	s.SetInput(Input{Seq: 2, Deadman: true, Axes: Axes{X: 1}, At: base})

	s.motionTick()
	drainAvailableEvents(s, "motion")
	clock.Set(base.Add(40 * time.Millisecond))
	s.motionTick()
	ev := readEvent(t, s, "motion")
	if ev.Motion == nil {
		t.Fatal("missing motion event")
	}
	est := ev.Motion.Estimated
	if est == nil {
		t.Fatalf("motion event missing estimated position: %+v", ev.Motion)
	}
	if est["x"] <= 0 || est["x"] >= ev.Motion.Target["x"] {
		t.Fatalf("estimated X = %.4f, target X = %.4f; want interpolated position ahead of observed and behind target", est["x"], ev.Motion.Target["x"])
	}
	if ev.Motion.EstimatedWPos == nil || math.Abs(ev.Motion.EstimatedWPos["x"]-est["x"]) > 0.0001 {
		t.Fatalf("estimated WPos = %+v, estimated MPos = %+v", ev.Motion.EstimatedWPos, est)
	}
	if ev.Motion.QueueLeadMs <= 0 {
		t.Fatalf("queue lead = %dms, want positive queued motion", ev.Motion.QueueLeadMs)
	}
}

func TestJogStatusIdentifiesTheMotionRevisionItsPositionSettles(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()
	base := time.Unix(100, 0)
	clock := newManualClock(base)
	mgr.now = clock.Now
	mgr.cfg.Tick = time.Hour
	mgr.cfg.StatusInterval = time.Hour

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")

	s.Step(2, "x", 1)
	motion := drainUntil(t, s, "motion")
	if motion.Motion == nil || motion.Motion.Revision == 0 {
		t.Fatalf("motion event = %+v, want a non-zero planner revision", motion)
	}
	drainUntil(t, s, "ack")

	s.mu.Lock()
	queuedUntil := s.queuedUntil
	s.mu.Unlock()
	clock.Set(queuedUntil.Add(time.Millisecond))
	time.Sleep(75 * time.Millisecond)
	fm.SetStatus("<Idle|MPos:1,0,0|WPos:1,0,0>")
	if err := s.refreshStatus(); err != nil {
		t.Fatal(err)
	}
	status := drainUntil(t, s, "status")
	if status.Status == nil {
		t.Fatalf("status event = %+v", status)
	}
	if status.Status.MotionRevision != motion.Motion.Revision || status.Status.SettledMotionRevision != motion.Motion.Revision {
		s.mu.Lock()
		serverQueueEnd := s.queuedUntil
		s.mu.Unlock()
		t.Fatalf("settled status revisions = motion %d settled %d, want %d (state=%s now=%s queue_end=%s)", status.Status.MotionRevision, status.Status.SettledMotionRevision, motion.Motion.Revision, status.Status.State, clock.Now(), serverQueueEnd)
	}
	if got := status.Status.MPos["x"]; got != 1 {
		t.Fatalf("settled status X = %v, want 1", got)
	}
}

func TestJogStatusTransactionDoesNotInterruptSilentMotionWrites(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()
	base := time.Unix(100, 0)
	clock := newManualClock(base)
	mgr.now = clock.Now
	mgr.cfg.Tick = time.Hour
	mgr.cfg.StatusInterval = time.Hour
	mgr.cfg.DeadmanTimeout = time.Second
	fm.SetStatusReplyDelay(150 * time.Millisecond)

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")
	s.requestStatus()
	s.SetInput(Input{Seq: 2, Deadman: true, Axes: Axes{X: 1}, At: base})

	for i := 0; i < 8; i++ {
		clock.Set(base.Add(time.Duration(i) * minJogTick))
		s.motionTick()
	}
	time.Sleep(75 * time.Millisecond)
	if got := fm.Gcodes(); len(got) < 2 {
		t.Fatalf("status transaction interrupted buffered $J writes: %v", got)
	}
	drainUntil(t, s, "status")
	if !s.hasLease() {
		t.Fatal("successful concurrent status transaction released jog lease")
	}
}

func TestJogStatusTimeoutKeepsBoundedMotionAndArmed(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()
	mgr.cfg.Tick = time.Hour
	mgr.cfg.StatusInterval = time.Hour
	mgr.cfg.DeadmanTimeout = time.Second

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")
	drainAvailableEvents(s, "state")
	if !s.hasLease() {
		t.Fatal("expected armed lease")
	}

	fm.SetStatusReplyDelay(500 * time.Millisecond)
	s.requestStatus()
	ev := readEvent(t, s, "error")
	if ev.Code != CodeStatusWaiting {
		t.Fatalf("status timeout event = %+v, want status_waiting", ev)
	}
	if !s.statusTransactionBusy() {
		t.Fatal("status timeout should leave a retry pending")
	}
	if !s.hasLease() {
		t.Fatal("status timeout during active jog should not release the lease")
	}
	now := time.Now()
	s.SetInput(Input{Seq: 2, Deadman: true, Axes: Axes{X: 1}, At: now})
	s.motionTick()
	waitForGcodeCount(t, fm, 1)
	s.mu.Lock()
	planned := copyAxes(s.planned)
	observed := copyAxes(s.lastStatus.MPos)
	s.mu.Unlock()
	if jogLeadTooLarge(planned, observed, mgr.cfg) {
		t.Fatalf("motion during status retry exceeded physical lead bound: planned=%+v observed=%+v", planned, observed)
	}
}

func TestJogStaleStatusRequestsRefreshWithoutWritingOrDisarming(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()
	base := time.Unix(100, 0)
	now := base
	mgr.now = func() time.Time { return now }
	mgr.cfg.Tick = 5 * time.Millisecond
	mgr.cfg.StatusInterval = 20 * time.Millisecond
	mgr.cfg.DeadmanTimeout = 150 * time.Millisecond

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")
	drainAvailableEvents(s, "state")
	s.SetInput(Input{Seq: 2, Deadman: true, Axes: Axes{X: 1}, At: base})

	now = base.Add(activeStatusMaxAge(mgr.cfg) + time.Millisecond)
	s.SetInput(Input{Seq: 3, Deadman: true, Axes: Axes{X: 1}, At: now})
	s.motionTick()
	if !s.hasLease() {
		t.Fatal("stale status should pause motion, not release the jog lease")
	}
	if got := fm.Gcodes(); len(got) != 0 {
		t.Fatalf("stale status should not emit motion, got %v", got)
	}
}

func TestJogLogsAlarmWithLastMotion(t *testing.T) {
	mgr, _, cleanup := newJogManager(t)
	defer cleanup()
	log := gcodelog.New(20)
	mgr.cfg.Log = log

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")

	s.Arm(1)
	drainUntil(t, s, "ack")
	s.SetInput(Input{Seq: 2, Deadman: true, Axes: Axes{X: 1}, At: time.Now()})
	drainUntil(t, s, "motion")

	if err := s.applyStatusPayload("<Alarm|MPos:0.1,0,0|WPos:0.1,0,0|H:10>"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		for _, ln := range log.Recent() {
			if ln.Source == gcodelog.SourceJog && ln.Dir == gcodelog.DirRecv &&
				strings.Contains(ln.Text, "alarm status:") &&
				strings.Contains(ln.Text, "H:10 Soft limit triggered") &&
				strings.Contains(ln.Text, "after $J") {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("jog alarm diagnostic was not logged: %+v", log.Recent())
}

func TestJogRequiresDeadman(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")
	s.SetInput(Input{Seq: 2, Deadman: false, Axes: Axes{X: 1}, At: time.Now()})
	time.Sleep(150 * time.Millisecond)
	if got := fm.Gcodes(); len(got) != 0 {
		t.Fatalf("motion emitted without deadman: %v", got)
	}
}

func TestJogControlBypassesLease(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")
	s.Control(2, "halt")
	drainUntil(t, s, "ack")

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if got := fm.Controls(); len(got) == 1 && got[0] == 0x18 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("halt did not reach fake machine; controls=%v", fm.Controls())
}

func TestJogKeepsLeaseWhileRefreshingStaleStatus(t *testing.T) {
	mgr, _, cleanup := newJogManager(t)
	defer cleanup()
	base := time.Unix(100, 0)
	mgr.cfg.Tick = time.Hour
	mgr.cfg.StatusInterval = 100 * time.Millisecond
	mgr.cfg.DeadmanTimeout = time.Second
	mgr.now = func() time.Time { return base }

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")
	if !s.hasLease() {
		t.Fatal("expected armed lease")
	}

	now := base.Add(2 * time.Second)
	mgr.now = func() time.Time { return now }
	s.SetInput(Input{Seq: 2, Deadman: true, Axes: Axes{X: 1}, At: now})
	s.motionTick()

	if !s.hasLease() {
		t.Fatal("stale status should pause motion without releasing the jog lease")
	}
}

func TestJogReleasesLeaseOnAlarmStatusWithoutDeadman(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()
	mgr.cfg.Tick = time.Hour
	mgr.cfg.StatusInterval = time.Hour
	mgr.cfg.DeadmanTimeout = time.Second

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")
	if !s.hasLease() {
		t.Fatal("expected armed lease")
	}

	fm.SetStatus("<Alarm|MPos:0,0,0|WPos:0,0,0|H:10>")
	if err := s.refreshStatus(); err != nil {
		t.Fatalf("refresh alarm status: %v", err)
	}
	ev := readEvent(t, s, "error")
	if ev.Code != CodeNotIdle {
		t.Fatalf("error event = %+v, want not_idle", ev)
	}
	if s.hasLease() {
		t.Fatal("alarm status without deadman should release the jog lease")
	}
}

func TestJogKeepsLeaseDuringOwnRunStatus(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()
	mgr.cfg.Tick = time.Hour
	mgr.cfg.StatusInterval = time.Hour
	mgr.cfg.DeadmanTimeout = time.Second

	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")
	if !s.hasLease() {
		t.Fatal("expected armed lease")
	}

	fm.SetStatus("<Run|MPos:0,0,0|WPos:0,0,0>")
	if err := s.refreshStatus(); err != nil {
		t.Fatalf("refresh Run status: %v", err)
	}
	ev := readEvent(t, s, "status")
	if ev.Status == nil || ev.Status.State != machine.Run {
		t.Fatalf("status event = %+v, want Run", ev)
	}
	if !s.hasLease() {
		t.Fatal("Run during active jog should not release the jog lease")
	}

	now := time.Now()
	s.SetInput(Input{Seq: 2, Deadman: true, Axes: Axes{X: 1}, At: now})
	s.motionTick()
	drainUntil(t, s, "motion")
}

func TestJogRelayIdleController(t *testing.T) {
	fm, err := carveratest.New()
	if err != nil {
		t.Fatal(err)
	}
	defer fm.Close()
	status := "<Idle|MPos:0,0,0|WPos:0,0,0>"
	fm.SetStatus(status)
	tr := machine.NewTracker()
	if !tr.ObserveStatusPayload(status) {
		t.Fatal("status precondition failed")
	}
	arb := session.New(session.Config{
		Tracker:     tr,
		StateMaxAge: time.Second,
		Dial:        func() (*client.Conn, error) { return client.Dial(fm.Addr(), 2*time.Second) },
	})
	rs := &relay.Server{
		Dial:     func() (string, error) { return fm.Addr(), nil },
		Observer: arb,
	}
	arb.SetInjector(relayAdapter{rs})
	arb.SetControlWriter(rs)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go rs.Serve(ln)

	controller, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer controller.Close()
	waitMode(t, arb, session.ModeRelay)
	controller.Write(protocol.QueryStatus())
	readStatusFrame(t, controller)

	cfg := DefaultConfig()
	cfg.Tick = 20 * time.Millisecond
	cfg.StatusInterval = 40 * time.Millisecond
	cfg.DeadmanTimeout = 120 * time.Millisecond
	mgr := New(arb, cfg)
	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")

	controller.Write(protocol.QueryStatus())
	readStatusFrame(t, controller)

	queriesBeforeMotion := fm.StatusQueries()
	seq := int64(2)
	end := time.Now().Add(1300 * time.Millisecond)
	for time.Now().Before(end) {
		s.SetInput(Input{Seq: seq, Deadman: true, Axes: Axes{X: 1}, At: time.Now()})
		seq++
		time.Sleep(15 * time.Millisecond)
	}
	if got := len(fm.Gcodes()); got < 12 {
		t.Fatalf("relay path starved continuous instant jogging: commands=%d gcodes=%v", got, fm.Gcodes())
	}
	if fm.StatusQueries() <= queriesBeforeMotion {
		t.Fatal("relay jog did not complete its active-motion machine status poll")
	}
	if !s.hasLease() {
		t.Fatal("relay path dropped the armed lease during continuous motion")
	}

	// Controller heartbeats stay on the mux cache and must neither enter nor
	// interrupt the interactive machine conversation.
	queriesBeforeControllerPoll := fm.StatusQueries()
	controller.Write(protocol.QueryStatus())
	readStatusFrame(t, controller)
	if got := fm.StatusQueries(); got != queriesBeforeControllerPoll {
		t.Fatalf("controller heartbeat leaked through interactive relay lease: before=%d after=%d", queriesBeforeControllerPoll, got)
	}

	s.SetInput(Input{Seq: seq, Deadman: false, Axes: Axes{}, At: time.Now()})
	time.Sleep(40 * time.Millisecond)
	stopped := len(fm.Gcodes())
	time.Sleep(jogLookahead(mgr.cfg) + jogSegmentDuration(mgr.cfg) + 100*time.Millisecond)
	if got := len(fm.Gcodes()); got != stopped {
		t.Fatalf("relay path admitted movement after release: stopped=%d got=%d", stopped, got)
	}
}

func newJogManager(t *testing.T) (*Manager, *carveratest.FakeMachine, func()) {
	t.Helper()
	fm, err := carveratest.New()
	if err != nil {
		t.Fatal(err)
	}
	status := "<Idle|MPos:0,0,0|WPos:0,0,0|F:0,0,100|S:0,0,100>"
	fm.SetStatus(status)
	tr := machine.NewTracker()
	if !tr.ObserveStatusPayload(status) {
		t.Fatal("status precondition failed")
	}
	arb := session.New(session.Config{
		Tracker:     tr,
		StateMaxAge: time.Second,
		Dial:        func() (*client.Conn, error) { return client.Dial(fm.Addr(), 2*time.Second) },
	})
	cfg := DefaultConfig()
	cfg.Tick = 20 * time.Millisecond
	cfg.StatusInterval = 40 * time.Millisecond
	cfg.DeadmanTimeout = 120 * time.Millisecond
	mgr := New(arb, cfg)
	return mgr, fm, fm.Close
}

type gatedJogConn struct {
	net.Conn
	started chan struct{}
	allow   chan struct{}
	once    sync.Once
}

func (c *gatedJogConn) Write(p []byte) (int, error) {
	var scan protocol.Scanner
	frames := scan.Push(p)
	for _, frame := range frames {
		if frame.Cmd != protocol.CmdCtrlMulti || !strings.HasPrefix(strings.TrimSpace(string(frame.Data)), "$J") {
			continue
		}
		c.once.Do(func() {
			close(c.started)
			<-c.allow
		})
		break
	}
	return c.Conn.Write(p)
}

func newGatedJogManager(t *testing.T) (*Manager, *carveratest.FakeMachine, *gatedJogConn, func()) {
	t.Helper()
	fm, err := carveratest.New()
	if err != nil {
		t.Fatal(err)
	}
	status := "<Idle|MPos:0,0,0|WPos:0,0,0>"
	fm.SetStatus(status)
	tr := machine.NewTracker()
	if !tr.ObserveStatusPayload(status) {
		t.Fatal("status precondition failed")
	}
	gate := &gatedJogConn{started: make(chan struct{}), allow: make(chan struct{})}
	arb := session.New(session.Config{
		Tracker:     tr,
		StateMaxAge: time.Second,
		Dial: func() (*client.Conn, error) {
			raw, err := net.DialTimeout("tcp", fm.Addr(), 2*time.Second)
			if err != nil {
				return nil, err
			}
			gate.Conn = raw
			return client.New(gate), nil
		},
	})
	mgr := New(arb, DefaultConfig())
	cleanup := func() {
		if gate.Conn != nil {
			_ = gate.Conn.Close()
		}
		fm.Close()
	}
	return mgr, fm, gate, cleanup
}

type pacedJogConn struct {
	net.Conn
	chunk int
	delay time.Duration
}

func (c *pacedJogConn) Write(p []byte) (int, error) {
	if c.chunk > 0 && len(p) > c.chunk {
		p = p[:c.chunk]
	}
	if c.delay > 0 {
		time.Sleep(c.delay)
	}
	return c.Conn.Write(p)
}

func newPacedJogManager(t *testing.T, chunk int, delay time.Duration) (*Manager, *carveratest.FakeMachine, func()) {
	t.Helper()
	fm, err := carveratest.New()
	if err != nil {
		t.Fatal(err)
	}
	status := "<Idle|MPos:0,0,0|WPos:0,0,0>"
	fm.SetStatus(status)
	tr := machine.NewTracker()
	if !tr.ObserveStatusPayload(status) {
		t.Fatal("status precondition failed")
	}
	var raw net.Conn
	arb := session.New(session.Config{
		Tracker:     tr,
		StateMaxAge: 3 * time.Second,
		Dial: func() (*client.Conn, error) {
			conn, err := net.DialTimeout("tcp", fm.Addr(), 2*time.Second)
			if err != nil {
				return nil, err
			}
			raw = conn
			return client.New(&pacedJogConn{Conn: conn, chunk: chunk, delay: delay}), nil
		},
	})
	mgr := New(arb, DefaultConfig())
	cleanup := func() {
		if raw != nil {
			_ = raw.Close()
		}
		fm.Close()
	}
	return mgr, fm, cleanup
}

func drainUntil(t *testing.T, s *Session, typ string) Event {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case ev, ok := <-s.Events():
			if !ok {
				t.Fatalf("events closed before %q", typ)
			}
			if ev.Type == "error" {
				t.Fatalf("unexpected jog error waiting for %q: %+v", typ, ev)
			}
			if ev.Type == typ {
				return ev
			}
		case <-deadline:
			t.Fatalf("timeout waiting for event %q", typ)
		}
	}
}

func readEvent(t *testing.T, s *Session, typ string) Event {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case ev, ok := <-s.Events():
			if !ok {
				t.Fatalf("events closed before %q", typ)
			}
			if ev.Type == typ {
				return ev
			}
		case <-deadline:
			t.Fatalf("timeout waiting for event %q", typ)
		}
	}
}

func drainUntilState(t *testing.T, s *Session, match func(Event) bool) Event {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case ev, ok := <-s.Events():
			if !ok {
				t.Fatal("events closed before matching state")
			}
			if ev.Type == "error" {
				t.Fatalf("unexpected jog error waiting for state: %+v", ev)
			}
			if ev.Type == "state" && match(ev) {
				return ev
			}
		case <-deadline:
			t.Fatal("timeout waiting for matching state")
		}
	}
}

func drainStatusThroughRetries(t *testing.T, s *Session) Event {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case ev, ok := <-s.Events():
			if !ok {
				t.Fatal("events closed before status retry recovered")
			}
			if ev.Type == "status" {
				return ev
			}
			if ev.Type == "error" && ev.Code != CodeStatusWaiting {
				t.Fatalf("unexpected status retry error: %+v", ev)
			}
		case <-deadline:
			t.Fatal("timeout waiting for status retry recovery")
		}
	}
}

func drainAvailableEvents(s *Session, typ string) int {
	n := 0
	for {
		select {
		case ev, ok := <-s.Events():
			if !ok {
				return n
			}
			if ev.Type == typ {
				n++
			}
		default:
			return n
		}
	}
}

func failOnAvailableErrors(t *testing.T, s *Session) {
	t.Helper()
	for {
		select {
		case ev, ok := <-s.Events():
			if !ok {
				return
			}
			if ev.Type == "error" {
				t.Fatalf("unexpected jog error: %+v", ev)
			}
		default:
			return
		}
	}
}

func waitForGcodeCount(t *testing.T, fm *carveratest.FakeMachine, want int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if len(fm.Gcodes()) >= want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("received %d gcode commands, want at least %d: %v", len(fm.Gcodes()), want, fm.Gcodes())
}

func waitForStatusQueryCount(t *testing.T, fm *carveratest.FakeMachine, want int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if fm.StatusQueries() >= want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("received %d status queries, want at least %d", fm.StatusQueries(), want)
}

type relayAdapter struct{ srv *relay.Server }

func (a relayAdapter) AcquireMachine() (session.InjectTransport, func(), error) {
	it, release, err := a.srv.AcquireMachine()
	if err != nil {
		return nil, nil, err
	}
	return it, release, nil
}

func (a relayAdapter) AcquireInteractive() (session.InjectTransport, <-chan struct{}, func(), error) {
	it, abort, release, err := a.srv.AcquireInteractive()
	if err != nil {
		return nil, nil, nil, err
	}
	return it, abort, release, nil
}

func waitMode(t *testing.T, arb *session.Arbiter, want session.Mode) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if arb.Mode() == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("mode = %s, want %s", arb.Mode(), want)
}

func readStatusFrame(t *testing.T, c net.Conn) protocol.Frame {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(2 * time.Second))
	var scan protocol.Scanner
	buf := make([]byte, 1024)
	for {
		n, err := c.Read(buf)
		for _, f := range scan.Push(buf[:n]) {
			if f.Cmd == protocol.CmdStatusRes {
				return f
			}
		}
		if err != nil {
			t.Fatalf("read status frame: %v", err)
		}
	}
}
