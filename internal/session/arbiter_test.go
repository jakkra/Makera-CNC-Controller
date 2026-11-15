package session

import (
	"errors"
	"io"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/uwin/cnc-proxy/internal/carveratest"
	"github.com/uwin/cnc-proxy/internal/client"
	"github.com/uwin/cnc-proxy/internal/machine"
	"github.com/uwin/cnc-proxy/internal/protocol"
	"github.com/uwin/cnc-proxy/internal/relay"
)

// relayBusy returns the relay's busy error, which the arbiter maps to ErrBusy.
func relayBusy() error { return relay.ErrBusy }

// miniMachine answers "?" with a configurable status so the arbiter's idle
// gating can be exercised without the full fake machine.
func miniMachine(t *testing.T, status func() string) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				var scan protocol.Scanner
				buf := make([]byte, 4096)
				for {
					c.SetReadDeadline(time.Now().Add(2 * time.Second))
					n, err := c.Read(buf)
					for _, f := range scan.Push(buf[:n]) {
						if f.Cmd == protocol.CmdCtrlSingle && len(f.Data) == 1 && f.Data[0] == '?' {
							c.Write(protocol.Encode(protocol.CmdStatusRes, []byte(status())))
						}
					}
					if err != nil {
						return
					}
				}
			}(c)
		}
	}()
	return ln.Addr().String()
}

func newArbiter(t *testing.T, addr string, tr *machine.Tracker) *Arbiter {
	return New(Config{
		Tracker: tr,
		Dial:    func() (*client.Conn, error) { return client.Dial(addr, time.Second) },
	})
}

func statusOnDemandMachine(t *testing.T, replies *atomic.Bool, accepts *atomic.Int32) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			accepts.Add(1)
			go func(c net.Conn) {
				defer c.Close()
				var scan protocol.Scanner
				buf := make([]byte, 4096)
				for {
					c.SetReadDeadline(time.Now().Add(2 * time.Second))
					n, err := c.Read(buf)
					for _, f := range scan.Push(buf[:n]) {
						if f.Cmd == protocol.CmdCtrlSingle && len(f.Data) == 1 && f.Data[0] == '?' && replies.Load() {
							c.Write(protocol.Encode(protocol.CmdStatusRes, []byte("<Idle|MPos:0.000,0.000,0.000>")))
						}
					}
					if err != nil {
						return
					}
				}
			}(c)
		}
	}()
	return ln.Addr().String()
}

func TestWithMachineBlockedInRelay(t *testing.T) {
	addr := miniMachine(t, func() string { return "<Idle>" })
	a := newArbiter(t, addr, machine.NewTracker())
	a.EnterRelay()

	err := a.WithMachine(false, func(*client.Conn) error { return nil })
	if !errors.Is(err, ErrRelayActive) {
		t.Errorf("got %v, want ErrRelayActive", err)
	}

	a.ExitRelay()
	if err := a.WithMachine(false, func(*client.Conn) error { return nil }); err != nil {
		t.Errorf("owner mode should allow access: %v", err)
	}
}

// fakeInjector implements Injector with a TCP pipe to a mini machine, plus an
// optional forced error to exercise busy/no-session mapping.
type fakeInjector struct {
	addr     string
	forceErr error
	acquired int
}

func (f *fakeInjector) AcquireMachine() (InjectTransport, func(), error) {
	if f.forceErr != nil {
		return nil, nil, f.forceErr
	}
	f.acquired++
	c, err := net.Dial("tcp", f.addr)
	if err != nil {
		return nil, nil, err
	}
	return c, func() { c.Close() }, nil
}

func TestWithMachineInjectsDuringRelay(t *testing.T) {
	addr := miniMachine(t, func() string { return "<Idle>" })
	tr := machine.NewTracker()
	tr.Observe(machine.Idle)
	inj := &fakeInjector{addr: addr}
	a := New(Config{
		Tracker:  tr,
		Dial:     func() (*client.Conn, error) { return client.Dial(addr, time.Second) },
		Injector: inj,
	})
	a.EnterRelay()

	// In relay mode with an injector, WithMachine should route through it.
	ran := false
	err := a.WithMachine(false, func(c *client.Conn) error {
		ran = true
		// Exercise the borrowed connection: a status query round-trips.
		_, e := c.QueryState(time.Second)
		return e
	})
	if err != nil {
		t.Fatalf("WithMachine via injector: %v", err)
	}
	if !ran || inj.acquired != 1 {
		t.Errorf("injector not used: ran=%v acquired=%d", ran, inj.acquired)
	}
}

func TestWithMachineMapsBusyError(t *testing.T) {
	addr := miniMachine(t, func() string { return "<Idle>" })
	tr := machine.NewTracker()
	tr.Observe(machine.Idle)
	inj := &fakeInjector{addr: addr, forceErr: relayBusy()}
	a := New(Config{Tracker: tr, Injector: inj,
		Dial: func() (*client.Conn, error) { return client.Dial(addr, time.Second) }})
	a.EnterRelay()

	err := a.WithMachine(false, func(*client.Conn) error { return nil })
	if !errors.Is(err, ErrBusy) {
		t.Errorf("got %v, want ErrBusy", err)
	}
	if !Retryable(err) {
		t.Error("ErrBusy should be Retryable")
	}
}

func TestWithMachineIdleGatingRefreshesStaleStatus(t *testing.T) {
	tr := machine.NewTracker()
	var status atomic.Value
	status.Store("<Idle|MPos:0.000,0.000,0.000>")
	addr := miniMachine(t, func() string { return status.Load().(string) })
	a := newArbiter(t, addr, tr)

	ran := false
	if err := a.WithMachine(true, func(*client.Conn) error { ran = true; return nil }); err != nil {
		t.Fatalf("stale state should be refreshed before idle-gated access: %v", err)
	}
	if !ran {
		t.Fatal("fn did not run after stale status refresh")
	}
	if !tr.Fresh(time.Second) {
		t.Fatal("tracker should be fresh after idle-gated refresh")
	}

	tr.Observe(machine.Run)
	status.Store("<Run|MPos:0.000,0.000,0.000>")
	if err := a.WithMachine(true, func(*client.Conn) error { return nil }); !errors.Is(err, ErrNotIdle) {
		t.Errorf("Run state: got %v, want ErrNotIdle", err)
	}

	tr.Observe(machine.Idle)
	status.Store("<Idle|MPos:0.000,0.000,0.000>")
	ran = false
	if err := a.WithMachine(true, func(*client.Conn) error { ran = true; return nil }); err != nil {
		t.Errorf("Idle state should allow: %v", err)
	}
	if !ran {
		t.Error("fn did not run under Idle")
	}
}

func TestWithMachineIdleGatingBlocksAfterFreshRunRefresh(t *testing.T) {
	tr := machine.NewTracker()
	addr := miniMachine(t, func() string { return "<Run|MPos:0.000,0.000,0.000>" })
	a := newArbiter(t, addr, tr)

	ran := false
	err := a.WithMachine(true, func(*client.Conn) error { ran = true; return nil })
	if !errors.Is(err, ErrNotIdle) {
		t.Fatalf("got %v, want ErrNotIdle", err)
	}
	if ran {
		t.Fatal("fn ran even though refreshed status was Run")
	}
	if !tr.Fresh(time.Second) {
		t.Fatal("tracker should be fresh after Run status refresh")
	}
	if st, _ := tr.Snapshot(); st != machine.Run {
		t.Fatalf("state = %q, want Run", st)
	}
}

func TestWithMachineRelayInjectionRefreshesStaleStatus(t *testing.T) {
	addr := miniMachine(t, func() string { return "<Idle|MPos:0.000,0.000,0.000>" })
	tr := machine.NewTracker()
	inj := &fakeInjector{addr: addr}
	a := New(Config{
		Tracker:  tr,
		Dial:     func() (*client.Conn, error) { return client.Dial(addr, time.Second) },
		Injector: inj,
	})
	a.EnterRelay()

	ran := false
	err := a.WithMachine(true, func(*client.Conn) error { ran = true; return nil })
	if err != nil {
		t.Fatalf("WithMachine via relay stale refresh: %v", err)
	}
	if !ran {
		t.Fatal("fn did not run after relay stale status refresh")
	}
	if inj.acquired != 1 {
		t.Fatalf("injector acquired = %d, want 1", inj.acquired)
	}
	if !tr.Fresh(time.Second) {
		t.Fatal("tracker should be fresh after relay stale status refresh")
	}
}

func TestEnterRelayObservesStatus(t *testing.T) {
	tr := machine.NewTracker()
	addr := miniMachine(t, func() string { return "<Idle>" })
	a := newArbiter(t, addr, tr)

	// A sniffed status frame (relay mode) should update the tracker.
	a.EnterRelay()
	if !a.ObserveStatusPayload("<Run|MPos:1,2,3>") {
		t.Fatal("expected valid status payload")
	}
	if st, _ := tr.Snapshot(); st != machine.Run {
		t.Errorf("observed state = %q, want Run", st)
	}
}

func TestConnReusedAcrossCalls(t *testing.T) {
	addr := miniMachine(t, func() string { return "<Idle>" })
	a := newArbiter(t, addr, machine.NewTracker())

	var c1, c2 *client.Conn
	a.WithMachine(false, func(c *client.Conn) error { c1 = c; return nil })
	a.WithMachine(false, func(c *client.Conn) error { c2 = c; return nil })
	if c1 == nil || c1 != c2 {
		t.Error("expected the owner connection to be reused across calls")
	}
}

func TestSemanticErrorKeepsConnectionAndConnectionErrorDropsIt(t *testing.T) {
	addr := miniMachine(t, func() string { return "<Idle>" })
	a := newArbiter(t, addr, machine.NewTracker())

	var c1 *client.Conn
	a.WithMachine(false, func(c *client.Conn) error { c1 = c; return nil })
	// A semantic failure came from a responsive machine and must not cause a
	// reconnect (or a physical USB reset).
	a.WithMachine(false, func(c *client.Conn) error { return errors.New("machine rejected operation") })
	var c2 *client.Conn
	a.WithMachine(false, func(c *client.Conn) error { c2 = c; return nil })
	if c1 != c2 {
		t.Error("semantic error unexpectedly dropped the connection")
	}

	// A real transport error still invalidates the connection.
	a.WithMachine(false, func(c *client.Conn) error { return io.EOF })
	var c3 *client.Conn
	a.WithMachine(false, func(c *client.Conn) error { c3 = c; return nil })
	if c2 == c3 {
		t.Error("connection error did not force a fresh connection")
	}
}

func TestModeNotBlockedBySlowDial(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	a := New(Config{
		Dial: func() (*client.Conn, error) {
			close(started)
			<-release
			return nil, io.EOF
		},
	})
	done := make(chan error, 1)
	go func() {
		done <- a.WithMachine(false, func(*client.Conn) error { return nil })
	}()
	<-started

	modeDone := make(chan Mode, 1)
	go func() { modeDone <- a.Mode() }()
	select {
	case mode := <-modeDone:
		if mode != ModeOwner {
			t.Fatalf("mode = %q, want owner", mode)
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("Mode blocked behind slow dial")
	}

	relayDone := make(chan struct{})
	go func() {
		a.EnterRelay()
		close(relayDone)
	}()
	select {
	case <-relayDone:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("EnterRelay blocked behind slow dial")
	}

	close(release)
	if err := <-done; !errors.Is(err, io.EOF) {
		t.Fatalf("WithMachine = %v, want dial EOF", err)
	}
}

func TestPollTimeoutPreservesOwnerConnectionWhenConfigured(t *testing.T) {
	var replies atomic.Bool
	var accepts atomic.Int32
	addr := statusOnDemandMachine(t, &replies, &accepts)
	tr := machine.NewTracker()
	a := New(Config{
		Tracker:                   tr,
		Dial:                      func() (*client.Conn, error) { return client.Dial(addr, time.Second) },
		PreserveConnOnPollTimeout: true,
	})

	a.pollOnce(20 * time.Millisecond)
	if tr.Fresh(time.Second) {
		t.Fatal("tracker should remain stale after an unanswered poll")
	}

	replies.Store(true)
	a.pollOnce(time.Second)

	if got := accepts.Load(); got != 1 {
		t.Fatalf("accepted connections = %d, want 1", got)
	}
	if !tr.Fresh(time.Second) {
		t.Fatal("tracker should become fresh after the next status reply")
	}
	if st, _ := tr.Snapshot(); st != machine.Idle {
		t.Fatalf("state = %q, want Idle", st)
	}
}

func TestPollTimeoutDoesNotMisattributeStaleStatus(t *testing.T) {
	m, err := carveratest.New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	m.SetStatus("<Idle|MPos:0,0,0>")
	m.SetStatusReplyDelay(100 * time.Millisecond)
	tr := machine.NewTracker()
	a := New(Config{
		Tracker:                   tr,
		Dial:                      func() (*client.Conn, error) { return client.Dial(m.Addr(), time.Second) },
		PreserveConnOnPollTimeout: true,
	})

	a.pollOnce(20 * time.Millisecond)
	time.Sleep(150 * time.Millisecond) // let the stale Idle reply reach the socket
	m.SetStatusReplyDelay(0)
	m.SetStatus("<Alarm|MPos:0,0,0|H:1>")
	a.pollOnce(time.Second)

	st, _ := tr.Current()
	if st.State != machine.Alarm {
		t.Fatalf("state = %q raw=%q, want current Alarm rather than stale Idle", st.State, st.Raw)
	}
}

// TestSendControlPreemptsBlockingOp is the safety test for the fix: a realtime
// control character must reach the machine WITHOUT waiting on opMu, so an
// emergency halt is not queued behind an in-flight blocking gcode that holds
// the transaction lock for its whole (potentially minutes-long) duration.
func TestSendControlPreemptsBlockingOp(t *testing.T) {
	addr := miniMachine(t, func() string { return "<Idle>" })
	tr := machine.NewTracker()
	tr.Observe(machine.Idle)
	a := newArbiter(t, addr, tr)

	// Occupy opMu with a long-running WithMachine callback, as a blocking move
	// would. It must NOT block SendControl.
	started := make(chan struct{})
	releaseOp := make(chan struct{})
	go func() {
		a.WithMachine(false, func(*client.Conn) error {
			close(started)
			<-releaseOp
			return nil
		})
	}()
	<-started

	done := make(chan error, 1)
	go func() { done <- a.SendControl(protocol.CtrlHalt) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("SendControl while op holds opMu: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("SendControl blocked behind the in-flight op — emergency halt cannot preempt")
	}
	close(releaseOp)
}

// TestSendControlRelayUsesControlWriter confirms relay-mode control delegates to
// the out-of-band control writer rather than the injector (which would block on
// a controller transaction).
func TestSendControlRelayUsesControlWriter(t *testing.T) {
	addr := miniMachine(t, func() string { return "<Idle>" })
	tr := machine.NewTracker()
	tr.Observe(machine.Idle)
	cw := &fakeControlWriter{}
	a := New(Config{Tracker: tr, Dial: func() (*client.Conn, error) { return client.Dial(addr, time.Second) }})
	a.SetControlWriter(cw)
	a.EnterRelay()

	if err := a.SendControl(protocol.CtrlFeedHold); err != nil {
		t.Fatalf("relay SendControl: %v", err)
	}
	if len(cw.got) != 1 || cw.got[0] != protocol.CtrlFeedHold {
		t.Errorf("control writer got %v, want [!]", cw.got)
	}
}

type fakeControlWriter struct{ got []byte }

func (f *fakeControlWriter) SendControl(c byte) error { f.got = append(f.got, c); return nil }

func TestPollRejectsMalformedStatusAndReconnects(t *testing.T) {
	m, err := carveratest.New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	var dials atomic.Int32
	a := New(Config{Dial: func() (*client.Conn, error) { dials.Add(1); return client.Dial(m.Addr(), time.Second) }})
	defer a.EnterRelay()
	m.SetStatus("not a machine status")
	a.pollOnce(time.Second)
	if a.Tracker().Fresh(time.Second) {
		t.Fatal("malformed status became fresh")
	}
	m.SetStatus("<Run|MPos:1,2,3>")
	a.pollOnce(time.Second)
	st, _ := a.Tracker().Current()
	if st.State != machine.Run || !a.Tracker().Fresh(time.Second) {
		t.Fatalf("did not recover: %+v", st)
	}
	if dials.Load() != 2 {
		t.Fatalf("dials = %d, want reconnect", dials.Load())
	}
}

// Emulate a half-open connection after a machine reboot: it remains open but
// never reads another frame. No address change or proxy restart is involved.
type stalledWriteConn struct{ net.Conn }

func (c stalledWriteConn) SetWriteDeadline(deadline time.Time) error {
	if !deadline.IsZero() {
		deadline = time.Now().Add(20 * time.Millisecond)
	}
	return c.Conn.SetWriteDeadline(deadline)
}
func TestPollReconnectsAfterBlockedMachineWrite(t *testing.T) {
	local, remote := net.Pipe()
	defer local.Close()
	defer remote.Close()
	fm, err := carveratest.New()
	if err != nil {
		t.Fatal(err)
	}
	defer fm.Close()
	fm.SetStatus("<Idle|MPos:1,2,3>")
	var dials atomic.Int32
	a := New(Config{Dial: func() (*client.Conn, error) {
		if dials.Add(1) == 1 {
			return client.New(stalledWriteConn{local}), nil
		}
		return client.Dial(fm.Addr(), time.Second)
	}})
	defer a.EnterRelay()
	done := make(chan struct{})
	go func() { defer close(done); a.pollOnce(50 * time.Millisecond); a.pollOnce(time.Second) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		local.Close()
		<-done
		t.Fatal("blocked write prevented owner reconnect")
	}
	if dials.Load() != 2 || !a.Tracker().Fresh(time.Second) {
		t.Fatalf("dials=%d fresh=%v", dials.Load(), a.Tracker().Fresh(time.Second))
	}
	st, _ := a.Tracker().Current()
	if st.MPos["x"] != 1 {
		t.Fatalf("fresh position not observed: %+v", st)
	}
	if len(fm.Gcodes()) != 0 {
		t.Fatalf("reconnect replayed machine commands: %v", fm.Gcodes())
	}
}
