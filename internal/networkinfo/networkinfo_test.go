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

func TestSignalDBMRequiresExplicitMeasuredUnits(t *testing.T) {
	for _, tc := range []struct {
		output string
		known  bool
		want   float64
	}{
		{"Connected to 11:22:33:44:55:66\n\tsignal: -63 dBm\n\ttx bitrate: 19.5 MBit/s", true, -63},
		{"Tx-Power=14 dBm\nLink Quality=47/70  Signal level=-63 dBm", true, -63},
		{"\tsignal: -61.5 dBm", true, -61.5},
		{"Tx-Power=14 dBm\nLink Quality=55/100", false, 0},
		{"Signal level=55/100", false, 0},
		{"Signal level=193", false, 0},
		{"Not connected.", false, 0},
		{"Signal level=-256 dBm", false, 0},
	} {
		got := parseSignalDBM(tc.output)
		if (got != nil) != tc.known || (got != nil && *got != tc.want) {
			t.Fatalf("signal from %q = %v, want known=%v value=%v", tc.output, got, tc.known, tc.want)
		}
	}
}

func TestProviderUsesDriverRSSIWithoutConvertingPercent(t *testing.T) {
	p := New()
	p.read = func(context.Context) ([]byte, error) { return []byte("yes:Workshop:55:wlp1s0\n"), nil }
	queried := make(chan string, 1)
	p.readSignal = func(_ context.Context, iface string) ([]byte, error) {
		queried <- iface
		return []byte("Signal level=-63 dBm"), nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); p.Run(ctx) }()
	defer func() { cancel(); <-done }()
	select {
	case iface := <-queried:
		if iface != "wlp1s0" {
			t.Fatal(iface)
		}
	case <-time.After(time.Second):
		t.Fatal("driver not queried")
	}
	deadline := time.Now().Add(time.Second)
	for {
		st := p.Status()
		if st.Controller.SignalDBM != nil {
			if *st.Controller.SignalDBM != -63 || st.Controller.SSID != "Workshop" {
				t.Fatalf("measured Wi-Fi %+v", st.Controller)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("no measured dBm in snapshot")
		}
		time.Sleep(time.Millisecond)
	}
}
