package jog

import (
	"context"
	"github.com/uwin/cnc-proxy/internal/client"
	"testing"
	"time"
)

func TestArmWaitsForBackgroundTransaction(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()
	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	entered := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- mgr.arb.WithMachine(false, func(c *client.Conn) error {
			close(entered)
			time.Sleep(2300 * time.Millisecond)
			// Background transactions can publish status before releasing the path.
			payload, err := c.QueryState(time.Second)
			if err == nil {
				mgr.arb.Tracker().ObserveStatusPayload(payload)
			}
			return err
		})
	}()
	<-entered
	s.Arm(1)
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for {
		select {
		case ev := <-s.Events():
			if ev.Type == "error" {
				<-done
				t.Fatalf("arm failed behind background transaction: %+v", ev)
			}
			if ev.Type == "ack" && ev.Seq == 1 {
				if err := <-done; err != nil {
					t.Fatal(err)
				}
				if got := fm.Gcodes(); len(got) != 0 {
					t.Fatalf("arming sent movement: %v", got)
				}
				return
			}
		case <-deadline.C:
			t.Fatal("arm did not finish after background transaction")
		}
	}
}

func TestArmAllowsSlowInitialStatusWithoutMoving(t *testing.T) {
	mgr, fm, cleanup := newJogManager(t)
	defer cleanup()
	fm.SetStatusReplyDelay(450 * time.Millisecond)
	s, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drainUntil(t, s, "hello")
	s.Arm(1)
	drainUntil(t, s, "ack")
	if got := fm.Gcodes(); len(got) != 0 {
		t.Fatalf("arming sent movement: %v", got)
	}
	if mgr.cfg.DeadmanTimeout != minDeadmanTimeout {
		t.Fatal("deadman timing changed")
	}
}
