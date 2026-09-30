package service

import (
	"github.com/uwin/cnc-proxy/internal/machine"
	"testing"
	"time"
)

func TestFeedOverrideWaitsForDelayedStatusWithoutResending(t *testing.T) {
	svc, m, tr := serviceWithMachine(t)
	old := "<Run|MPos:0,0,-5|WPos:0,0,-5|F:800,1000,100>"
	m.SetStatus(old)
	tr.ObserveStatusPayload(old)
	m.SetStatusReplies(old, old)
	result, err := svc.SetFeedOverride(150)
	if err != nil || !result.Verified {
		t.Fatalf("result=%+v error=%v", result, err)
	}
	if got := m.Gcodes(); len(got) != 1 || got[0] != "M220 S150" {
		t.Fatalf("commands=%v", got)
	}
}

func TestFeedOverrideLostConfirmationIsNotCommandFailure(t *testing.T) {
	svc, m, tr := serviceWithMachine(t)
	old := "<Run|F:800,1000,100>"
	m.SetStatus(old)
	tr.ObserveStatusPayload(old)
	m.SetDropStatusReplies(true)
	result, err := svc.SetFeedOverride(150)
	if err != nil || result.Verified {
		t.Fatalf("result=%+v error=%v", result, err)
	}
	if got := m.Gcodes(); len(got) != 1 {
		t.Fatalf("commands=%v", got)
	}
}

func TestOperatorCommandNotificationAttribution(t *testing.T) {
	for _, line := range []string{"M6T2", "T2 M6", "N10 M06 T2", "M0", "suspend"} {
		t.Run(line, func(t *testing.T) {
			svc, _, _ := serviceWithMachine(t)
			state := machine.Tool
			if line == "M0" || line == "suspend" {
				state = machine.Pause
			}
			svc.operatorCommandIntent(line)
			svc.attention.ObserveStatus(machine.Status{State: state, ObservedAt: time.Now()}, svc.attentionContext(machine.Status{}))
			active := svc.Attention().Active
			if active == nil || !active.OperatorInitiated {
				t.Fatalf("active=%+v", active)
			}
		})
	}
}

func TestExplicitToolChangeMarksObservedAttention(t *testing.T) {
	svc, m, tr := serviceWithMachine(t)
	status := "<Idle|MPos:0,0,0|WPos:0,0,0|C:2,4,0,1|T:0,0.000>"
	m.SetStatus(status)
	tr.ObserveStatusPayload(status)
	if _, err := svc.ChangeTool(2); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if active := svc.Attention().Active; active != nil && active.State == machine.Tool {
			if !active.OperatorInitiated {
				t.Fatalf("active=%+v", active)
			}
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("tool attention never observed")
}

func TestFeedOverrideKeepsRealCommandRejection(t *testing.T) {
	svc, m, tr := serviceWithMachine(t)
	status := "<Run|F:800,1000,100>"
	m.SetStatus(status)
	tr.ObserveStatusPayload(status)
	m.RejectGcode("M220 S150", "error: rejected")
	if result, err := svc.SetFeedOverride(150); err == nil || result.Verified {
		t.Fatalf("result=%+v error=%v", result, err)
	}
}

func TestRejectedOperatorToolActionDoesNotSilenceLaterEvent(t *testing.T) {
	svc, m, tr := serviceWithMachine(t)
	status := "<Idle|T:0,0>"
	m.SetStatus(status)
	tr.ObserveStatusPayload(status)
	m.RejectGcode("M6T2", "error: rejected")
	if _, err := svc.SendGcode("M6T2"); err == nil {
		t.Fatal("expected rejection")
	}
	tr.ObserveStatusPayload("<Tool|T:0,0,2>")
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if active := svc.Attention().Active; active != nil {
			if active.OperatorInitiated {
				t.Fatal("failed command silenced later event")
			}
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("later event not observed")
}
