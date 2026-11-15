package networkinfo

import (
	"context"
	"testing"
	"time"
)

func TestWiFiSSIDReadsOnlyTheActiveAssociationAndEscapes(t *testing.T) {
	now := time.Now()
	got := parseNMCLI("no:other:98:wlan0\nyes:Workshop\\: CNC\\\\Lab å:58:wlp1s0\n", now)
	if got.State != "connected" || got.SSID != "Workshop: CNC\\Lab å" || got.Interface != "wlp1s0" || got.SignalPercent == nil || *got.SignalPercent != 58 {
		t.Fatalf("association %+v", got)
	}
	if got.ObservedAt != now {
		t.Fatal("missing observation time")
	}
	for _, output := range []string{"", "no:saved:100:wlan0\n", "yes::50:wlan0", "bad"} {
		if got := parseNMCLI(output, now); got.State != "not_connected" || got.SSID != "" {
			t.Fatalf("invented association from %q: %+v", output, got)
		}
	}
}

func TestProviderNeverBlocksSnapshotsOnHostQueryAndStops(t *testing.T) {
	p := New()
	started := make(chan struct{})
	p.read = func(ctx context.Context) ([]byte, error) { close(started); <-ctx.Done(); return nil, ctx.Err() }
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); p.Run(ctx) }()
	<-started
	snapshot := make(chan Status, 1)
	go func() { snapshot <- p.Status() }()
	select {
	case st := <-snapshot:
		if st.Controller.State != "unavailable" || st.Machine.State != "not_reported" || st.Machine.SSID != "" {
			t.Fatalf("fabricated status %+v", st)
		}
	case <-time.After(100 * time.Millisecond):
		cancel()
		t.Fatal("API waited for host query")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("provider did not cancel")
	}
}

func TestProviderDoesNotReturnStaleAssociationAsCurrent(t *testing.T) {
	p := New()
	p.current = WiFi{State: "connected", SSID: "previous network", ObservedAt: time.Now().Add(-2 * time.Minute)}
	if got := p.Status(); got.Controller.SSID != "" || got.Controller.State != "unavailable" {
		t.Fatalf("stale Wi-Fi: %+v", got)
	}
}
