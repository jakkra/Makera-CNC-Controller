package jog

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/uwin/cnc-proxy/internal/client"
	"github.com/uwin/cnc-proxy/internal/machine"
)

func suspendedJogManager(t *testing.T) (*Manager, func()) {
	t.Helper()
	mgr, fm, cleanup := newJogManager(t)
	fm.SetStatus("<Run|MPos:0,0,-20|WPos:0,0,-20|S:12000,12000,100>")
	err := mgr.arb.WithMachine(false, func(c *client.Conn) error {
		if _, err := c.SendConsoleCommand("suspend", client.GcodeOpts{Cap: time.Second}); err != nil {
			return err
		}
		raw, err := c.QueryState(time.Second)
		if err == nil {
			mgr.arb.Tracker().ObserveStatusPayload(raw)
		}
		return err
	})
	if err != nil {
		cleanup()
		t.Fatal(err)
	}
	return mgr, cleanup
}

func TestPausedJogActionWaitsForPositionAndBlocksNewArms(t *testing.T) {
	mgr, cleanup := suspendedJogManager(t)
	defer cleanup()
	s, _ := mgr.Start(context.Background())
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")
	s.Step(2, "z", 10)
	drainUntil(t, s, "ack")
	// A wall-clock estimate or Pause alone cannot prove movement finished.
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	finish, err := mgr.BeginJobAction(ctx)
	cancel()
	if err == nil {
		finish()
		t.Fatal("accepted job action before physical target was reached")
	}
	if !s.hasLease() {
		t.Fatal("failed verification lost the last planned position")
	}
	ctx, cancel = context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	finish, err = mgr.BeginJobAction(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer finish()
	if s.hasLease() {
		t.Fatal("job action did not release the jog lease")
	}
	st, _ := mgr.arb.Tracker().Current()
	if st.State != machine.Pause || st.MPos["z"] != -10 {
		t.Fatalf("settled status: %+v", st)
	}
	observer, _ := mgr.Start(context.Background())
	defer observer.Close()
	drainUntil(t, observer, "hello")
	observer.Arm(3)
	ev := readEvent(t, observer, "error")
	if ev.Code != CodeBusy || observer.hasLease() {
		t.Fatalf("armed during job action: %+v", ev)
	}
	if _, err := mgr.BeginJobAction(ctx); err == nil {
		t.Fatal("overlapping job action accepted")
	}
}

func TestPausedJogDoesNotRewindSmallStepOrSetOrigin(t *testing.T) {
	mgr, cleanup := suspendedJogManager(t)
	defer cleanup()
	s, _ := mgr.Start(context.Background())
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")
	// Both commands must be cumulative while firmware still reports Pause.
	s.Step(2, "x", .01)
	first := drainUntil(t, s, "ack")
	s.Step(3, "x", .01)
	second := drainUntil(t, s, "ack")
	if first.Target["x"] != .01 || second.Target["x"] != .02 {
		t.Fatalf("fine steps: %+v %+v", first, second)
	}
	s.SetOrigin(4, "x", 0)
	ev := readEvent(t, s, "error")
	if ev.Code != CodeNotIdle || !strings.Contains(ev.Message, "Idle") {
		t.Fatalf("origin allowed while paused: %+v", ev)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	finish, err := mgr.BeginJobAction(ctx)
	if err != nil {
		t.Fatal(err)
	}
	finish()
}

func TestPausedJogDisarmsOnExternalResume(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()
	raw := "<Pause|MPos:0,0,0|WPos:0,0,0>"
	fm.SetStatus(raw)
	mgr.arb.Tracker().ObserveStatusPayload(raw)
	s, _ := mgr.Start(context.Background())
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")
	fm.SetStatus("<Run|MPos:0,0,0|WPos:0,0,0>")
	ev := readEvent(t, s, "error")
	if ev.Code != CodeNotIdle || s.hasLease() {
		t.Fatalf("continued jogging running job: %+v", ev)
	}
}

// A 0.01 mm tap is smaller than the general tap tolerance. During Pause it
// must not be declared complete from the unchanged pre-motion position.
func TestPausedTapRequiresMeasuredEndpointBeforeCompleting(t *testing.T) {
	mgr, _, cleanup := newJogManager(t)
	defer cleanup()
	s := &Session{ctx: context.Background(), mgr: mgr, targetPending: &pendingTarget{seq: 1, target: machine.AxisValues{"x": .01}},
		planned: machine.AxisValues{"x": .01}, events: make(chan Event, 4)}
	s.pausedJob.Store(true)
	if err := s.applyStatusPayload("<Pause|MPos:0,0,0|WPos:0,0,0>"); err != nil {
		t.Fatal(err)
	}
	if s.targetPending == nil || s.planned["x"] != .01 {
		t.Fatal("unmoved fine tap was treated as complete")
	}
	if err := s.applyStatusPayload("<Pause|MPos:0.01,0,0|WPos:0.01,0,0>"); err != nil {
		t.Fatal(err)
	}
	if s.targetPending != nil {
		t.Fatal("measured tap endpoint was not completed")
	}
}
