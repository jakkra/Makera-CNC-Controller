package attention

import (
	"testing"
	"time"

	"github.com/uwin/cnc-proxy/internal/machine"
)

func TestMonitorOpensOnceAndResolvesOnStateChange(t *testing.T) {
	m := New(10)
	start := time.Unix(1000, 0)
	changes, unsubscribe := m.Subscribe()
	defer unsubscribe()

	m.ObserveStatus(machine.Status{State: machine.Run, ObservedAt: start}, Context{JobPath: "/sd/gcodes/part.nc"})
	m.ObserveStatus(machine.Status{State: machine.Pause, ObservedAt: start.Add(time.Second)}, Context{JobPath: "/sd/gcodes/part.nc"})
	m.ObserveStatus(machine.Status{State: machine.Pause, ObservedAt: start.Add(2 * time.Second)}, Context{JobPath: "/sd/gcodes/part.nc"})

	opened := readChange(t, changes)
	if opened.Kind != ChangeOpened || opened.Event.Kind != KindPause || opened.Event.JobName != "part.nc" {
		t.Fatalf("opened change = %+v", opened)
	}
	assertNoChange(t, changes)

	m.ObserveStatus(machine.Status{State: machine.Run, ObservedAt: start.Add(3 * time.Second)}, Context{})
	resolved := readChange(t, changes)
	if resolved.Kind != ChangeResolved || resolved.Event.Active || resolved.Event.ResolvedAt == nil {
		t.Fatalf("resolved change = %+v", resolved)
	}

	snapshot := m.Snapshot()
	if snapshot.Active != nil || len(snapshot.Events) != 1 || snapshot.Events[0].Active {
		t.Fatalf("snapshot = %+v", snapshot)
	}
}

func TestMonitorClassifiesToolAndCopiesDetails(t *testing.T) {
	m := New(10)
	target := 4
	tool := &machine.ToolStatus{Active: 2, Offset: 1.25, Target: &target}
	m.ObserveStatus(machine.Status{State: machine.Tool, Tool: tool}, Context{})

	tool.Active = 99
	*tool.Target = 100
	snapshot := m.Snapshot()
	if snapshot.Active == nil || snapshot.Active.Kind != KindToolChange {
		t.Fatalf("active = %+v", snapshot.Active)
	}
	if snapshot.Active.Tool == nil || snapshot.Active.Tool.Active != 2 || snapshot.Active.Tool.Target == nil || *snapshot.Active.Tool.Target != 4 {
		t.Fatalf("copied tool = %+v", snapshot.Active.Tool)
	}
}

func TestMonitorUpdatesAlarmDetailsWithoutOpeningDuplicate(t *testing.T) {
	m := New(10)
	changes, unsubscribe := m.Subscribe()
	defer unsubscribe()
	m.ObserveStatus(machine.Status{State: machine.Alarm}, Context{})
	if got := readChange(t, changes); got.Kind != ChangeOpened {
		t.Fatalf("first change = %+v", got)
	}
	m.ObserveStatus(machine.Status{State: machine.Alarm, HaltReason: machine.ParseHaltReason("10")}, Context{})
	updated := readChange(t, changes)
	if updated.Kind != ChangeUpdated || updated.Event.HaltReason == nil || updated.Event.HaltReason.Code != 10 {
		t.Fatalf("updated change = %+v", updated)
	}
	if len(m.Snapshot().Events) != 1 {
		t.Fatalf("duplicate alarm events: %+v", m.Snapshot().Events)
	}
}

func TestMonitorBoundsHistory(t *testing.T) {
	m := New(2)
	for i, state := range []machine.State{machine.Pause, machine.Run, machine.Wait, machine.Run, machine.Hold} {
		m.ObserveStatus(machine.Status{State: state, ObservedAt: time.Unix(int64(i+1), 0)}, Context{})
	}
	snapshot := m.Snapshot()
	if len(snapshot.Events) != 2 || snapshot.Events[0].Kind != KindHold || snapshot.Events[1].Kind != KindWait {
		t.Fatalf("bounded events = %+v", snapshot.Events)
	}
}

func TestMonitorCoalescesFirmwareWaitThenPauseForRotaryMarker(t *testing.T) {
	m := New(10)
	changes, unsubscribe := m.Subscribe()
	defer unsubscribe()
	target := 90.0
	ctx := Context{Marker: &Marker{Type: "rotary_index", Axis: "A", Target: &target, Operation: "Side two"}}
	m.ObserveStatus(machine.Status{State: machine.Run}, Context{})
	m.ObserveStatus(machine.Status{State: machine.Wait}, ctx)
	opened := readChange(t, changes)
	if opened.Kind != ChangeOpened || opened.Event.Kind != KindRotaryIndex {
		t.Fatalf("opened = %+v", opened)
	}
	m.ObserveStatus(machine.Status{State: machine.Pause}, Context{})
	updated := readChange(t, changes)
	if updated.Kind != ChangeUpdated || updated.Event.ID != opened.Event.ID || updated.Event.State != machine.Pause {
		t.Fatalf("updated = %+v", updated)
	}
	snapshot := m.Snapshot()
	if len(snapshot.Events) != 1 || snapshot.Active == nil || snapshot.Active.Marker == nil || snapshot.Active.Marker.Target == nil || *snapshot.Active.Marker.Target != 90 {
		t.Fatalf("snapshot = %+v", snapshot)
	}
}

func readChange(t *testing.T, ch <-chan Change) Change {
	t.Helper()
	select {
	case change := <-ch:
		return change
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for attention change")
		return Change{}
	}
}

func assertNoChange(t *testing.T, ch <-chan Change) {
	t.Helper()
	select {
	case change := <-ch:
		t.Fatalf("unexpected change: %+v", change)
	case <-time.After(20 * time.Millisecond):
	}
}
