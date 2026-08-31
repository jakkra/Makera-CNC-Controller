package notifications

import (
	"context"
	"errors"
	"testing"

	"github.com/uwin/cnc-proxy/internal/attention"
	"github.com/uwin/cnc-proxy/internal/machine"
)

type recordingSender struct {
	err      error
	messages []Message
}

func (s *recordingSender) Name() string { return "recording" }
func (s *recordingSender) Send(_ context.Context, msg Message) error {
	s.messages = append(s.messages, msg)
	return s.err
}

func TestDispatcherSendsOpenedButNotUpdatedOrResolvedByDefault(t *testing.T) {
	sender := &recordingSender{}
	d, err := New(Config{Sender: sender, MachineName: "Shop Z1", DashboardURL: "https://z1.tail.example/"})
	if err != nil {
		t.Fatal(err)
	}
	target := 4
	event := attention.Event{ID: 7, Kind: attention.KindToolChange, State: machine.Tool, JobName: "part.cnc", Tool: &machine.ToolStatus{Active: 2, Target: &target}}
	if err := d.Handle(context.Background(), attention.Change{Kind: attention.ChangeOpened, Event: event}); err != nil {
		t.Fatal(err)
	}
	_ = d.Handle(context.Background(), attention.Change{Kind: attention.ChangeUpdated, Event: event})
	_ = d.Handle(context.Background(), attention.Change{Kind: attention.ChangeResolved, Event: event})

	if len(sender.messages) != 1 {
		t.Fatalf("messages = %d, want 1", len(sender.messages))
	}
	msg := sender.messages[0]
	if msg.Title != "Shop Z1 needs a tool change" || msg.Body != "Change tool from T2 to T4. Job: part.cnc." || msg.ClickURL == "" || msg.SequenceID != "z1-attention-7" {
		t.Fatalf("message = %+v", msg)
	}
	snapshot := d.Snapshot()
	if !snapshot.Enabled || snapshot.Provider != "recording" || len(snapshot.Deliveries) != 1 || snapshot.Deliveries[0].State != DeliverySent {
		t.Fatalf("snapshot = %+v", snapshot)
	}
}

func TestDispatcherRecordsFailure(t *testing.T) {
	sender := &recordingSender{err: errors.New("offline")}
	d, _ := New(Config{Sender: sender})
	event := attention.Event{ID: 2, Kind: attention.KindAlarm, State: machine.Alarm, HaltReason: machine.ParseHaltReason("10")}
	err := d.Handle(context.Background(), attention.Change{Kind: attention.ChangeOpened, Event: event})
	if err == nil {
		t.Fatal("Handle succeeded, want failure")
	}
	delivery := d.Snapshot().Deliveries[0]
	if delivery.State != DeliveryFailed || delivery.Error != "offline" || delivery.CompletedAt == nil {
		t.Fatalf("delivery = %+v", delivery)
	}
	if sender.messages[0].Priority != "max" {
		t.Fatalf("alarm priority = %q, want max", sender.messages[0].Priority)
	}
}

func TestDispatcherCanSendResolved(t *testing.T) {
	sender := &recordingSender{}
	d, _ := New(Config{Sender: sender, SendResolved: true})
	event := attention.Event{ID: 3, Kind: attention.KindPause, State: machine.Pause}
	if err := d.Handle(context.Background(), attention.Change{Kind: attention.ChangeResolved, Event: event}); err != nil {
		t.Fatal(err)
	}
	if len(sender.messages) != 1 || sender.messages[0].Priority != "default" {
		t.Fatalf("resolved messages = %+v", sender.messages)
	}
}

func TestFormatMessageDescribesRotaryTarget(t *testing.T) {
	target := 90.0
	msg := FormatMessage("Shop Z1", "", attention.Change{
		Kind: attention.ChangeOpened,
		Event: attention.Event{
			ID: 8, Kind: attention.KindRotaryIndex, State: machine.Wait,
			Marker: &attention.Marker{Type: "rotary_index", Axis: "A", Target: &target},
		},
	})
	if msg.Title != "Shop Z1 is ready to index the A-axis" || msg.Body != "Inspect rotary clearance, then resume to rotate A to 90 degrees." {
		t.Fatalf("message = %+v", msg)
	}
}
