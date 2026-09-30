package notifications

import (
	"context"
	"github.com/uwin/cnc-proxy/internal/attention"
	"github.com/uwin/cnc-proxy/internal/machine"
	"testing"
)

func TestOperatorEventsDoNotNotifyButFaultsStillDo(t *testing.T) {
	sender := &recordingSender{}
	d, _ := New(Config{Sender: sender, SendResolved: true})
	for _, code := range []string{"1", "13", "10", "3"} {
		event := attention.Event{Kind: attention.KindAlarm, State: machine.Alarm, HaltReason: machine.ParseHaltReason(code)}
		for _, kind := range []attention.ChangeKind{attention.ChangeOpened, attention.ChangeResolved} {
			if err := d.Handle(context.Background(), attention.Change{Kind: kind, Event: event}); err != nil {
				t.Fatal(err)
			}
		}
	}
	event := attention.Event{Kind: attention.KindToolChange, State: machine.Tool, OperatorInitiated: true}
	d.Handle(context.Background(), attention.Change{Kind: attention.ChangeOpened, Event: event})
	d.Handle(context.Background(), attention.Change{Kind: attention.ChangeResolved, Event: event})
	event.OperatorInitiated = false
	d.Handle(context.Background(), attention.Change{Kind: attention.ChangeResolved, Event: event, SuppressNotification: true})
	if len(sender.messages) != 4 {
		t.Fatalf("messages=%+v", sender.messages)
	}
}
