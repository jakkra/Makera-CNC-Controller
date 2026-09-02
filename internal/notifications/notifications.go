// Package notifications delivers operator-attention events to optional mobile
// notification providers. It never sends commands to the CNC.
package notifications

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/uwin/cnc-proxy/internal/attention"
)

// Message is the provider-neutral notification payload.
type Message struct {
	Title      string
	Body       string
	Priority   string
	Tags       []string
	ClickURL   string
	SequenceID string
}

// Sender delivers one provider-neutral message.
type Sender interface {
	Name() string
	Send(context.Context, Message) error
}

// Config controls event formatting and delivery behavior.
type Config struct {
	Sender       Sender
	MachineName  string
	DashboardURL string
	SendResolved bool
	HistorySize  int
}

// DeliveryState is the retained outcome of one delivery attempt.
type DeliveryState string

const (
	DeliverySending DeliveryState = "sending"
	DeliverySent    DeliveryState = "sent"
	DeliveryFailed  DeliveryState = "failed"
)

// Delivery records one provider call. Tokens and provider secrets are never
// retained here.
type Delivery struct {
	ID               int64                `json:"id"`
	AttentionEventID int64                `json:"attention_event_id,omitempty"`
	AttentionChange  attention.ChangeKind `json:"attention_change,omitempty"`
	Provider         string               `json:"provider"`
	Title            string               `json:"title"`
	Body             string               `json:"body"`
	State            DeliveryState        `json:"state"`
	Error            string               `json:"error,omitempty"`
	CreatedAt        time.Time            `json:"created_at"`
	CompletedAt      *time.Time           `json:"completed_at,omitempty"`
}

// Snapshot is the notification read model exposed by the API.
type Snapshot struct {
	Enabled    bool       `json:"enabled"`
	Provider   string     `json:"provider,omitempty"`
	Deliveries []Delivery `json:"deliveries"`
}

// Dispatcher formats attention changes, invokes the configured sender, and
// keeps a bounded delivery history.
type Dispatcher struct {
	mu           sync.Mutex
	sender       Sender
	machineName  string
	dashboardURL string
	sendResolved bool
	historySize  int
	now          func() time.Time
	nextID       int64
	deliveries   []Delivery
	seen         map[string]struct{}
}

// New creates an enabled dispatcher. Sender is required.
func New(cfg Config) (*Dispatcher, error) {
	if cfg.Sender == nil {
		return nil, fmt.Errorf("notifications: sender is required")
	}
	machineName := strings.TrimSpace(cfg.MachineName)
	if machineName == "" {
		machineName = "Makera Z1"
	}
	historySize := cfg.HistorySize
	if historySize <= 0 {
		historySize = 100
	}
	return &Dispatcher{
		sender:       cfg.Sender,
		machineName:  machineName,
		dashboardURL: strings.TrimSpace(cfg.DashboardURL),
		sendResolved: cfg.SendResolved,
		historySize:  historySize,
		now:          time.Now,
		nextID:       1,
		seen:         map[string]struct{}{},
	}, nil
}

// Run consumes attention changes until the context is canceled or the source
// closes. Delivery failures are retained in history and do not stop the loop.
func (d *Dispatcher) Run(ctx context.Context, changes <-chan attention.Change) {
	for {
		select {
		case <-ctx.Done():
			return
		case change, ok := <-changes:
			if !ok {
				return
			}
			_ = d.Handle(ctx, change)
		}
	}
}

// Handle synchronously delivers one relevant attention change. Updated events
// are deliberately ignored so richer status detail cannot create a duplicate
// phone notification for the same waiting period.
func (d *Dispatcher) Handle(ctx context.Context, change attention.Change) error {
	if change.Kind == attention.ChangeUpdated {
		return nil
	}
	if suppressToolUnload(change.Event) {
		return nil
	}
	if change.Kind == attention.ChangeResolved && !d.sendResolved {
		return nil
	}
	if change.Kind != attention.ChangeOpened && change.Kind != attention.ChangeResolved {
		return nil
	}
	if change.Event.ID > 0 && d.markSeen(change) {
		return nil
	}

	msg := FormatMessage(d.machineName, d.dashboardURL, change)
	deliveryID := d.beginDelivery(change, msg)
	err := d.sender.Send(ctx, msg)
	d.finishDelivery(deliveryID, err)
	return err
}

// suppressToolUnload removes the firmware's intermediate "change to T0"
// episode. A real requested tool follows as a separate event, so notifying on
// both stages creates two phone alerts for one operator task.
func suppressToolUnload(event attention.Event) bool {
	return event.Kind == attention.KindToolChange && event.Tool != nil && event.Tool.Target != nil && *event.Tool.Target == 0
}

// markSeen records a change identity and reports whether it was already seen.
// This closes the startup race between subscribing and replaying an active
// event without relying on provider-specific replacement behavior.
func (d *Dispatcher) markSeen(change attention.Change) bool {
	key := string(change.Kind) + ":" + strconv.FormatInt(change.Event.ID, 10)
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.seen[key]; ok {
		return true
	}
	d.seen[key] = struct{}{}
	return false
}

// SendTest verifies provider configuration without requiring a machine event.
func (d *Dispatcher) SendTest(ctx context.Context) error {
	msg := Message{
		Title:      d.machineName + " notification test",
		Body:       "CNC notification delivery is configured.",
		Priority:   "default",
		Tags:       []string{"white_check_mark"},
		ClickURL:   d.dashboardURL,
		SequenceID: "z1-notification-test",
	}
	deliveryID := d.beginDelivery(attention.Change{}, msg)
	err := d.sender.Send(ctx, msg)
	d.finishDelivery(deliveryID, err)
	return err
}

// Snapshot returns newest deliveries first.
func (d *Dispatcher) Snapshot() Snapshot {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := Snapshot{Enabled: true, Provider: d.sender.Name(), Deliveries: make([]Delivery, 0, len(d.deliveries))}
	for i := len(d.deliveries) - 1; i >= 0; i-- {
		out.Deliveries = append(out.Deliveries, copyDelivery(d.deliveries[i]))
	}
	return out
}

// DisabledSnapshot describes a proxy without a configured provider.
func DisabledSnapshot() Snapshot { return Snapshot{Enabled: false, Deliveries: []Delivery{}} }

// FormatMessage converts a machine event into an operator-facing notification.
func FormatMessage(machineName, dashboardURL string, change attention.Change) Message {
	event := change.Event
	resolved := change.Kind == attention.ChangeResolved
	title := machineName + " needs attention"
	body := "The CNC is waiting for operator input."
	priority := "default"
	tags := []string{"warning"}

	if resolved {
		title = machineName + " attention cleared"
		body = "The CNC is no longer in " + string(event.State) + "."
		priority = "default"
		tags = []string{"white_check_mark"}
	} else {
		switch event.Kind {
		case attention.KindToolChange:
			title = machineName + " needs a tool change"
			body = toolChangeBody(event)
			tags = []string{"wrench"}
		case attention.KindRotaryIndex:
			title = machineName + " is ready to index the A-axis"
			body = rotaryIndexBody(event)
			tags = []string{"arrows_counterclockwise"}
		case attention.KindPause:
			title = machineName + " is paused"
			body = "The CNC is paused and needs operator input."
			tags = []string{"pause_button"}
		case attention.KindWait:
			title = machineName + " is waiting"
			body = "The CNC is waiting for operator input."
			tags = []string{"hourglass"}
		case attention.KindHold:
			title = machineName + " is on hold"
			body = "The CNC entered Hold and needs attention."
			tags = []string{"pause_button"}
		case attention.KindAlarm:
			title = machineName + " alarm"
			body = alarmBody(event)
			priority = "max"
			tags = []string{"rotating_light"}
		}
	}
	if event.JobName != "" {
		body += " Job: " + event.JobName + "."
	}
	return Message{
		Title:      title,
		Body:       body,
		Priority:   priority,
		Tags:       tags,
		ClickURL:   dashboardURL,
		SequenceID: "z1-attention-" + strconv.FormatInt(event.ID, 10),
	}
}

func rotaryIndexBody(event attention.Event) string {
	if event.Marker == nil {
		return "Inspect rotary clearance at the machine, then resume when safe."
	}
	if event.Marker.Instruction != "" {
		return event.Marker.Instruction
	}
	if event.Marker.Target != nil {
		return fmt.Sprintf("Inspect rotary clearance, then resume to rotate A to %g degrees.", *event.Marker.Target)
	}
	return "Inspect rotary clearance at the machine, then resume when safe."
}

func toolChangeBody(event attention.Event) string {
	if event.Tool == nil {
		return "The CNC is waiting for a tool change."
	}
	if event.Tool.Target != nil {
		return fmt.Sprintf("Change tool from T%d to T%d.", event.Tool.Active, *event.Tool.Target)
	}
	return fmt.Sprintf("The CNC is waiting for a tool change; current tool is T%d.", event.Tool.Active)
}

func alarmBody(event attention.Event) string {
	if event.HaltReason == nil {
		return "The CNC reported an alarm. Inspect the machine before recovery."
	}
	return fmt.Sprintf("Alarm %d: %s. Required recovery: %s.", event.HaltReason.Code, event.HaltReason.Message, event.HaltReason.Recovery)
}

func (d *Dispatcher) beginDelivery(change attention.Change, msg Message) int64 {
	d.mu.Lock()
	defer d.mu.Unlock()
	id := d.nextID
	d.nextID++
	d.deliveries = append(d.deliveries, Delivery{
		ID:               id,
		AttentionEventID: change.Event.ID,
		AttentionChange:  change.Kind,
		Provider:         d.sender.Name(),
		Title:            msg.Title,
		Body:             msg.Body,
		State:            DeliverySending,
		CreatedAt:        d.now(),
	})
	if len(d.deliveries) > d.historySize {
		d.deliveries = append([]Delivery(nil), d.deliveries[len(d.deliveries)-d.historySize:]...)
	}
	return id
}

func (d *Dispatcher) finishDelivery(id int64, err error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for i := range d.deliveries {
		if d.deliveries[i].ID != id {
			continue
		}
		completed := d.now()
		d.deliveries[i].CompletedAt = &completed
		if err != nil {
			d.deliveries[i].State = DeliveryFailed
			d.deliveries[i].Error = err.Error()
		} else {
			d.deliveries[i].State = DeliverySent
		}
		return
	}
}

func copyDelivery(in Delivery) Delivery {
	out := in
	if in.CompletedAt != nil {
		v := *in.CompletedAt
		out.CompletedAt = &v
	}
	return out
}
