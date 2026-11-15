package discovery

import (
	"testing"
	"time"
)

func TestParseRoundTrip(t *testing.T) {
	in := "CARVERA,192.168.1.42,2222,1"
	m, ok := parse(in)
	if !ok {
		t.Fatal("parse failed")
	}
	if m.Name != "CARVERA" || m.IP != "192.168.1.42" || m.Port != 2222 || !m.Busy {
		t.Errorf("parsed = %+v", m)
	}
	if m.format() != in {
		t.Errorf("format = %q, want %q", m.format(), in)
	}
}

func TestParseRejectsShort(t *testing.T) {
	for _, s := range []string{"", "CARVERA", "CARVERA,192.168.1.42", "a,b,notaport,0"} {
		if _, ok := parse(s); ok {
			t.Errorf("parse(%q) unexpectedly succeeded", s)
		}
	}
}

func TestAdvertiseRewritesAddress(t *testing.T) {
	idle := Machine{Name: "CARVERA", IP: "192.168.1.42", Port: 2222, Busy: false}
	adv := Machine{Name: idle.Name + " (proxy)", IP: "192.168.1.50", Port: 2222, Busy: idle.Busy}
	if adv.format() != "CARVERA (proxy),192.168.1.50,2222,0" {
		t.Errorf("advert = %q", adv.format())
	}
}

func TestAdvertisedName(t *testing.T) {
	suffix := &Advertiser{NameSuffix: " (proxy)"}
	if got := suffix.advertisedName("CARVERA"); got != "CARVERA (proxy)" {
		t.Errorf("suffix mode = %q", got)
	}
	override := &Advertiser{Name: "Workshop CNC", NameSuffix: " (proxy)"}
	if got := override.advertisedName("CARVERA"); got != "Workshop CNC" {
		t.Errorf("override mode = %q", got)
	}
}

func TestListenerIgnoresSelf(t *testing.T) {
	l := &Listener{}
	l.SetSelf(Machine{Name: "CARVERA (proxy)", IP: "192.168.1.50", Port: 2222})

	if !l.isSelf(Machine{Name: "CARVERA (proxy)", IP: "192.168.1.50", Port: 2222}) {
		t.Error("own advertisement not filtered")
	}
	// The real machine must never be filtered, even when the operator picks
	// the same advertised name as the real one.
	if l.isSelf(Machine{Name: "CARVERA (proxy)", IP: "192.168.1.42", Port: 2222}) {
		t.Error("real machine filtered because of a name collision")
	}
	if l.isSelf(Machine{Name: "CARVERA", IP: "192.168.1.42", Port: 2222}) {
		t.Error("real machine filtered")
	}
}

func TestNamedDiscoveryFollowsOnlySelectedMachine(t *testing.T) {
	l := &Listener{TargetName: "Makera_Z1_011855"}
	l.SetSelf(Machine{IP: "192.168.1.121", Port: 2222})
	l.observe("Makera_Z1_011855,192.168.1.39,2222,0,Idle")
	if m, ok := l.Latest(); !ok || m.IP != "192.168.1.39" {
		t.Fatalf("initial: %+v %v", m, ok)
	}
	l.observe("Makera_Z1_011855,192.168.1.40,2222,0,Run")
	for _, record := range []string{
		"other,192.168.1.50,2222,0", "Makera_Z1_011855,192.168.1.121,2222,0",
		"Makera_Z1_011855,bad,2222,0", "Makera_Z1_011855,192.168.1.40,0,0",
		"Makera_Z1_011855,192.168.1.40,65536,0",
	} {
		l.observe(record)
	}
	if m, ok := l.Latest(); !ok || m.IP != "192.168.1.40" {
		t.Fatalf("changed: %+v %v", m, ok)
	}
	l.mu.Lock()
	l.seen = time.Now().Add(-11 * time.Second)
	l.mu.Unlock()
	if _, ok := l.Latest(); ok {
		t.Fatal("expired address is still usable")
	}
	l.observe("other,192.168.1.50,2222,0")
	if _, ok := l.Latest(); ok {
		t.Fatal("other machine refreshed expired record")
	}
	l.observe("Makera_Z1_011855,192.168.1.41,2222,0")
	if m, ok := l.Latest(); !ok || m.IP != "192.168.1.41" {
		t.Fatalf("return: %+v %v", m, ok)
	}
}
