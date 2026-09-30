package attention

import (
	"github.com/uwin/cnc-proxy/internal/machine"
	"strconv"
	"testing"
	"time"
)

func TestOperatorIntentIsScopedAndExpires(t *testing.T) {
	m := New(20)
	now := time.Now()
	m.now = func() time.Time { return now }
	observe := func(state machine.State, code int) {
		m.ObserveStatus(machine.Status{State: state, ObservedAt: now, HaltReason: machine.ParseHaltReason(strconv.Itoa(code))}, Context{})
	}
	cancel := m.BeginOperatorAction([]machine.State{machine.Tool}, false)
	cancel()
	observe(machine.Tool, 0)
	if m.Snapshot().Active.OperatorInitiated {
		t.Fatal("cancelled intent silenced tool")
	}
	observe(machine.Idle, 0)
	m.BeginOperatorAction([]machine.State{machine.Tool}, false)
	observe(machine.Alarm, 10)
	if m.Snapshot().Active.OperatorInitiated {
		t.Fatal("tool intent silenced limit fault")
	}
	observe(machine.Tool, 0)
	if !m.Snapshot().Active.OperatorInitiated {
		t.Fatal("expected tool unmarked")
	}
	observe(machine.Idle, 0)
	observe(machine.Tool, 0)
	if m.Snapshot().Active.OperatorInitiated {
		t.Fatal("later program tool change silenced")
	}
	observe(machine.Idle, 0)
	m.BeginOperatorAction([]machine.State{machine.Pause}, false)
	now = now.Add(31 * time.Second)
	observe(machine.Pause, 0)
	if m.Snapshot().Active.OperatorInitiated {
		t.Fatal("expired intent silenced pause")
	}
}

func TestOperatorResumeSuppressesOnlyResolution(t *testing.T) {
	m := New(20)
	changes, cancel := m.Subscribe()
	defer cancel()
	m.ObserveStatus(machine.Status{State: machine.Tool}, Context{})
	opened := <-changes
	if opened.Event.OperatorInitiated {
		t.Fatal("program tool change suppressed")
	}
	m.BeginOperatorAction(nil, true)
	m.ObserveStatus(machine.Status{State: machine.Run}, Context{})
	resolved := <-changes
	if !resolved.SuppressNotification {
		t.Fatal("operator resume notified")
	}
	m.ObserveStatus(machine.Status{State: machine.Tool}, Context{})
	if later := <-changes; later.Event.OperatorInitiated || later.SuppressNotification {
		t.Fatal("later tool event suppressed")
	}
}

func TestUnobservedManualToolPromptDoesNotSilenceNewJob(t *testing.T) {
	m := New(20)
	m.ObserveStatus(machine.Status{State: machine.Idle}, Context{})
	m.BeginOperatorAction([]machine.State{machine.Tool}, false)
	m.ObserveStatus(machine.Status{State: machine.Run}, Context{})
	m.ObserveStatus(machine.Status{State: machine.Tool}, Context{})
	if m.Snapshot().Active.OperatorInitiated {
		t.Fatal("later job prompt suppressed")
	}
}
