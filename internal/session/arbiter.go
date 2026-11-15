// Package session arbitrates the single machine connection between the official
// controller (relay mode) and the proxy's own sync engine (owner mode).
//
// The firmware is single-conversation, so at most one of {controller, sync
// engine} may talk to the machine at a time. The arbiter enforces this:
//
//   - When a controller connects, the relay takes over: the arbiter enters
//     relay mode, the sync engine is told to stand down, and machine state is
//     observed passively by sniffing STATUS_RES frames the controller solicits.
//   - When no controller is connected, the arbiter is in owner mode: it holds
//     its own connection to the machine, polls "?" to track state, and lets the
//     sync engine borrow the connection to run file operations while Idle.
package session

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"sync"
	"time"

	"github.com/uwin/cnc-proxy/internal/client"
	"github.com/uwin/cnc-proxy/internal/machine"
	"github.com/uwin/cnc-proxy/internal/relay"
)

// Arbiter implements relay.Observer so the relay can drive mode transitions and
// feed sniffed machine state into the tracker.
var _ relay.Observer = (*Arbiter)(nil)

// Mode is the arbiter's current ownership of the machine connection.
type Mode int

const (
	// ModeOwner: no controller connected; the proxy owns the connection and the
	// sync engine may run.
	ModeOwner Mode = iota
	// ModeRelay: a controller is connected; the proxy only observes.
	ModeRelay
)

const statusRefreshTimeout = 5 * time.Second

func (m Mode) String() string {
	if m == ModeRelay {
		return "relay"
	}
	return "owner"
}

// Injector borrows the controller's shared machine connection for one injected
// operation during relay mode. The relay Server implements it.
type Injector interface {
	AcquireMachine() (it InjectTransport, release func(), err error)
}

// InteractiveInjector borrows the controller's shared machine connection for a
// long-lived interactive operation. The abort channel closes when controller
// traffic needs the connection back.
type InteractiveInjector interface {
	AcquireInteractive() (it InjectTransport, abort <-chan struct{}, release func(), err error)
}

// ControlWriter writes a single realtime control character (feed-hold, resume,
// halt) straight to the machine, out-of-band — without taking the transaction
// lock. The relay Server implements it for relay mode; an injector that also
// satisfies this is used by SendControl. The active transport must serialize
// Write calls so the CTRL_SINGLE frame cannot byte-interleave with another
// frame. The firmware acts on it immediately from its receive path, so it must
// be emitted concurrently with an in-flight transaction to let an emergency
// halt preempt a blocking move it would otherwise queue behind.
type ControlWriter interface {
	SendControl(c byte) error
}

// InjectTransport is the byte channel an injected operation drives.
type InjectTransport interface {
	Write(p []byte) (int, error)
	Read(p []byte) (int, error)
	SetReadDeadline(t time.Time) error
	Close() error
}

// JogLease is a long-lived exclusive lease over normal machine I/O. Realtime
// controls still bypass it through SendControl.
type JogLease struct {
	Conn  *client.Conn
	Mode  Mode
	Abort <-chan struct{}

	once    sync.Once
	release func(error)
}

// Release returns the machine I/O lease. Passing a non-nil err lets owner mode
// drop the underlying connection before future operations reuse it.
func (l *JogLease) Release(err error) {
	if l == nil {
		return
	}
	l.once.Do(func() {
		if l.release != nil {
			l.release(err)
		}
	})
}

// Arbiter tracks mode and machine state, and gates access to the machine
// connection from the proxy's own operations (sync engine, API), whether the
// proxy owns the connection (owner mode) or is sharing it with a connected
// controller (relay mode, via the injector).
type Arbiter struct {
	tracker *machine.Tracker

	// dial opens a fresh owner-mode connection to the machine. Injectable for
	// tests; in production it dials the real machine address.
	dial func() (*client.Conn, error)

	// injector, if set, lets owner operations run during relay mode by borrowing
	// the controller's shared connection between its transactions.
	injector Injector

	// controlWriter, if set, emits out-of-band realtime control characters to
	// the machine during relay mode (the relay writes them straight to the
	// shared transport without taking the injection window).
	controlWriter ControlWriter

	mu                   sync.Mutex
	mode                 Mode
	ownerConn            *client.Conn
	pollFailed           bool
	connectionGeneration uint64

	// opMu serializes actual machine I/O for the full duration of a WithMachine
	// callback. The machine is single-conversation and a client.Conn is not safe
	// for concurrent use, so the status poll, sync engine, and gcode injection
	// must never run two operations on it at once. Held across fn, separate from
	// mu (which only guards the fields above and must not be held during I/O).
	opMu sync.Mutex

	// pollInterval controls how often owner mode queries "?" for state.
	pollInterval time.Duration
	// stateMaxAge bounds how old an observed state may be and still gate ops.
	stateMaxAge time.Duration
	// filePacketSize is used when relay-mode injections wrap the shared
	// machine transport in a client.Conn. Owner-mode conns receive this through
	// their Dial function.
	filePacketSize int

	// preserveConnOnPollTimeout keeps owner-mode polling timeouts from being
	// treated as connection-fatal. USB serial status replies can arrive late
	// enough that closing/reopening the port discards the eventual frame or
	// repeatedly resets the machine when reset-on-open is enabled.
	preserveConnOnPollTimeout bool
}

// Config configures an Arbiter.
type Config struct {
	Dial           func() (*client.Conn, error)
	Tracker        *machine.Tracker
	Injector       Injector
	PollInterval   time.Duration
	StateMaxAge    time.Duration
	FilePacketSize int

	// PreserveConnOnPollTimeout should be enabled for USB/serial owner-mode
	// polling. TCP keeps the historic behavior where a status timeout drops the
	// connection and lets the next poll redial.
	PreserveConnOnPollTimeout bool
}

// New creates an Arbiter in owner mode.
func New(cfg Config) *Arbiter {
	if cfg.PollInterval == 0 {
		cfg.PollInterval = 2 * time.Second
	}
	if cfg.StateMaxAge == 0 {
		cfg.StateMaxAge = 10 * time.Second
	}
	if cfg.Tracker == nil {
		cfg.Tracker = machine.NewTracker()
	}
	if cfg.FilePacketSize <= 0 {
		cfg.FilePacketSize = client.WifiPacketSize
	}
	return &Arbiter{
		tracker:                   cfg.Tracker,
		dial:                      cfg.Dial,
		injector:                  cfg.Injector,
		mode:                      ModeOwner,
		pollInterval:              cfg.PollInterval,
		stateMaxAge:               cfg.StateMaxAge,
		filePacketSize:            cfg.FilePacketSize,
		preserveConnOnPollTimeout: cfg.PreserveConnOnPollTimeout,
	}
}

// SetInjector wires the relay injector after construction (the relay and
// arbiter are mutually referential at startup).
func (a *Arbiter) SetInjector(inj Injector) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.injector = inj
}

// SetControlWriter wires the relay's out-of-band control writer after
// construction, used by SendControl in relay mode.
func (a *Arbiter) SetControlWriter(cw ControlWriter) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.controlWriter = cw
}

// Mode returns the current mode.
func (a *Arbiter) Mode() Mode {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.mode
}

// StateMaxAge returns the configured freshness bound for gating machine ops.
func (a *Arbiter) StateMaxAge() time.Duration { return a.stateMaxAge }

// Tracker exposes the shared machine-state tracker.
func (a *Arbiter) Tracker() *machine.Tracker { return a.tracker }

// ConnectionGeneration changes whenever the proxy starts a fresh machine-side
// conversation, allowing background observers to refresh connection-scoped
// read-only metadata exactly once per connection.
func (a *Arbiter) ConnectionGeneration() uint64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.connectionGeneration
}

// EnterRelay is called when a controller connects. The proxy drops its owner
// connection (if any) so the controller becomes the machine's sole conversation
// partner, and the sync engine is blocked from acquiring the connection.
func (a *Arbiter) EnterRelay() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.mode = ModeRelay
	a.connectionGeneration++
	if a.ownerConn != nil {
		a.ownerConn.Close()
		a.ownerConn = nil
	}
}

// ExitRelay is called when the controller disconnects, returning to owner mode.
func (a *Arbiter) ExitRelay() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.mode = ModeOwner
}

// ObserveStatusPayload feeds a status report (from either a sniffed relay frame
// or an owner-mode poll) into the tracker.
func (a *Arbiter) ObserveStatusPayload(payload string) bool {
	return a.tracker.ObserveStatusPayload(payload)
}

// WithMachine runs fn with a connection to the machine. In owner mode it uses
// the proxy's own persistent connection. In relay mode it borrows the
// controller's shared connection via the injector, running fn between the
// controller's transactions; if no injector is configured it returns
// ErrRelayActive. When requireIdle is set, fn runs only after the machine is
// known to be fresh Idle. A stale or non-Idle cached state is actively refreshed
// on this same serialized transaction path before fn is allowed to run; a
// refreshed non-Idle or unrefreshable status returns ErrNotIdle. Relay-mode
// injection additionally returns ErrBusy (from the injector) if the controller
// is mid file-transfer.
func (a *Arbiter) WithMachine(requireIdle bool, fn func(*client.Conn) error) error {
	// Serialize all machine I/O: only one operation may use the single
	// connection at a time. Held for the whole callback.
	a.opMu.Lock()
	defer a.opMu.Unlock()

	a.mu.Lock()
	mode := a.mode
	inj := a.injector
	needStatusRefresh := false
	if requireIdle {
		st, _ := a.tracker.Snapshot()
		if !a.tracker.Fresh(a.stateMaxAge) || !st.CanRunFileOps() {
			needStatusRefresh = true
		}
	}

	if mode != ModeOwner {
		a.mu.Unlock()
		if inj == nil {
			return ErrRelayActive
		}
		return a.withInjection(inj, requireIdle, needStatusRefresh, fn)
	}
	a.mu.Unlock()
	conn, err := a.acquireOwnerConn()
	if err != nil {
		return err
	}
	if requireIdle {
		drop, err := a.ensureFreshIdle(conn, needStatusRefresh)
		if err != nil {
			if drop {
				a.dropOwnerConn(conn)
			}
			return err
		}
	}
	if err := fn(conn); err != nil {
		if client.IsConnectionError(err) {
			a.dropOwnerConn(conn)
		}
		return err
	}
	return nil
}

// AcquireJog acquires a long-lived exclusive machine I/O lease for interactive
// jogging. It requires fresh Idle state before acquiring the machine path; the
// caller should still refresh status while the lease is active.
func (a *Arbiter) AcquireJog(ctx context.Context) (*JogLease, error) {
	if err := a.lockOp(ctx); err != nil {
		return nil, err
	}
	locked := true
	defer func() {
		if locked {
			a.opMu.Unlock()
		}
	}()

	a.mu.Lock()
	st, _ := a.tracker.Snapshot()
	if !a.tracker.Fresh(a.stateMaxAge) || !st.CanRunFileOps() {
		a.mu.Unlock()
		return nil, ErrNotIdle
	}
	mode := a.mode
	if mode != ModeOwner {
		inj, ok := a.injector.(InteractiveInjector)
		a.mu.Unlock()
		if !ok || inj == nil {
			return nil, ErrRelayActive
		}
		it, abort, release, err := inj.AcquireInteractive()
		if err != nil {
			switch {
			case errors.Is(err, relay.ErrBusy):
				return nil, ErrBusy
			case errors.Is(err, relay.ErrNoSession):
				return nil, ErrRelayActive
			default:
				return nil, err
			}
		}
		conn := client.NewTransport(it, client.WithFilePacketSize(a.filePacketSize))
		conn.SetStatusObserver(func(payload string) { a.tracker.ObserveStatusPayload(payload) })
		locked = false
		return &JogLease{
			Conn:  conn,
			Mode:  mode,
			Abort: abort,
			release: func(error) {
				release()
				a.opMu.Unlock()
			},
		}, nil
	}

	a.mu.Unlock()
	conn, err := a.acquireOwnerConn()
	if err != nil {
		return nil, err
	}
	locked = false
	return &JogLease{
		Conn: conn,
		Mode: mode,
		release: func(err error) {
			if client.IsConnectionError(err) {
				a.mu.Lock()
				if a.ownerConn == conn {
					a.ownerConn.Close()
					a.ownerConn = nil
				}
				a.mu.Unlock()
			}
			a.opMu.Unlock()
		},
	}, nil
}

func (a *Arbiter) lockOp(ctx context.Context) error {
	for {
		if a.opMu.TryLock() {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// withInjection borrows the controller's shared connection for one operation.
func (a *Arbiter) withInjection(inj Injector, requireIdle, needStatusRefresh bool, fn func(*client.Conn) error) error {
	it, release, err := inj.AcquireMachine()
	if err != nil {
		// Map the relay's "can't right now" errors to session semantics so the
		// sync engine treats them as retryable rather than failures.
		switch {
		case errors.Is(err, relay.ErrBusy):
			return ErrBusy
		case errors.Is(err, relay.ErrNoSession):
			return ErrRelayActive
		default:
			return err
		}
	}
	defer release()
	conn := client.NewTransport(it, client.WithFilePacketSize(a.filePacketSize))
	conn.SetStatusObserver(func(payload string) { a.tracker.ObserveStatusPayload(payload) })
	if requireIdle {
		if _, err := a.ensureFreshIdle(conn, needStatusRefresh); err != nil {
			return err
		}
	}
	return fn(conn)
}

func (a *Arbiter) ensureFreshIdle(conn *client.Conn, forceRefresh bool) (dropConn bool, err error) {
	st, _ := a.tracker.Snapshot()
	if !forceRefresh && a.tracker.Fresh(a.stateMaxAge) {
		if st.CanRunFileOps() {
			return false, nil
		}
		return false, ErrNotIdle
	}
	payload, err := conn.QueryState(statusRefreshTimeout)
	if err != nil {
		if timeoutErr(err) {
			return false, ErrNotIdle
		}
		return true, err
	}
	if !a.tracker.ObserveStatusPayload(payload) {
		return false, ErrNotIdle
	}
	st, _ = a.tracker.Snapshot()
	if !a.tracker.Fresh(a.stateMaxAge) || !st.CanRunFileOps() {
		return false, ErrNotIdle
	}
	return false, nil
}

func (a *Arbiter) dropOwnerConn(conn *client.Conn) {
	a.mu.Lock()
	if a.ownerConn == conn {
		a.ownerConn.Close()
		a.ownerConn = nil
	}
	a.mu.Unlock()
}

// SendControl emits a single realtime control character (feed-hold, resume,
// halt) out-of-band, WITHOUT taking opMu, so it preempts any in-flight
// transaction — an emergency halt must not queue behind the blocking move it is
// meant to abort. This is safe when the active machine transport serializes
// Write calls, so the CTRL_SINGLE frame cannot byte-interleave with another
// frame; the firmware acts on it from its receive path regardless of the gcode
// stream's state.
//
// In owner mode it writes to the live owner connection (if one is established).
// In relay mode it delegates to the relay's out-of-band control writer, which
// writes straight to the shared machine transport without acquiring the injection
// window. Returns ErrRelayActive if no path to the machine is available.
func (a *Arbiter) SendControl(c byte) error {
	a.mu.Lock()
	if a.mode != ModeOwner {
		a.mu.Unlock()
		return a.sendControlRelay(c)
	}
	conn := a.ownerConn
	a.mu.Unlock()
	if conn != nil {
		return conn.SendControl(c)
	}

	// No live owner connection yet (the poll loop hasn't dialed, or it was
	// dropped). Establish one so control still reaches the machine — dialing
	// outside the lock so a slow dial can't block mode transitions.
	nc, err := a.dial()
	if err != nil {
		return err
	}
	nc.SetStatusObserver(func(payload string) { a.tracker.ObserveStatusPayload(payload) })
	a.mu.Lock()
	switch {
	case a.mode != ModeOwner:
		// A controller connected while we were dialing; the machine is
		// single-conversation, so we must not keep a second owner socket.
		a.mu.Unlock()
		nc.Close()
		return a.sendControlRelay(c)
	case a.ownerConn != nil:
		// Lost a race with a concurrent op that established the connection;
		// reuse theirs and discard ours.
		conn = a.ownerConn
		a.mu.Unlock()
		nc.Close()
	default:
		a.ownerConn = nc
		conn = nc
		a.mu.Unlock()
	}
	return conn.SendControl(c)
}

// sendControlRelay delegates an out-of-band control character to the relay's
// control writer (relay mode). Returns ErrRelayActive if none is wired.
func (a *Arbiter) sendControlRelay(c byte) error {
	a.mu.Lock()
	cw := a.controlWriter
	a.mu.Unlock()
	if cw == nil {
		return ErrRelayActive
	}
	return cw.SendControl(c)
}

// acquireOwnerConn returns the cached owner connection, dialing if needed.
// Dialing occurs without a.mu so Mode, EnterRelay, and out-of-band controls
// remain responsive while the machine is unreachable.
func (a *Arbiter) acquireOwnerConn() (*client.Conn, error) {
	a.mu.Lock()
	if a.mode != ModeOwner {
		a.mu.Unlock()
		return nil, ErrRelayActive
	}
	if a.ownerConn != nil {
		conn := a.ownerConn
		a.mu.Unlock()
		return conn, nil
	}
	a.mu.Unlock()

	conn, err := a.dial()
	if err != nil {
		return nil, err
	}
	// Feed status reports observed mid-command into the tracker, so interleaved
	// STATUS_RES frames keep state fresh even while another command holds opMu
	// and starves the periodic poll loop.
	conn.SetStatusObserver(func(payload string) { a.tracker.ObserveStatusPayload(payload) })

	a.mu.Lock()
	switch {
	case a.mode != ModeOwner:
		a.mu.Unlock()
		conn.Close()
		return nil, ErrRelayActive
	case a.ownerConn != nil:
		existing := a.ownerConn
		a.mu.Unlock()
		conn.Close()
		return existing, nil
	default:
		a.ownerConn = conn
		a.connectionGeneration++
		a.mu.Unlock()
		return conn, nil
	}
}

// Poll runs the owner-mode state poll loop until ctx is canceled. It queries
// "?" immediately and then every pollInterval while in owner mode, feeding
// results to the tracker. In relay mode it does nothing (the relay observer
// feeds state instead).
func (a *Arbiter) Poll(ctx context.Context, queryTimeout time.Duration) {
	ticker := time.NewTicker(a.pollInterval)
	defer ticker.Stop()
	a.pollOnce(queryTimeout) // observe state right away, don't wait a full tick
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.pollOnce(queryTimeout)
		}
	}
}

// pollOnce queries machine state if in owner mode.
func (a *Arbiter) pollOnce(queryTimeout time.Duration) {
	if a.Mode() != ModeOwner {
		return
	}
	observed := false
	var statusErr error
	err := a.WithMachine(false, func(c *client.Conn) error {
		payload, err := c.QueryState(queryTimeout)
		if err == nil && !a.tracker.ObserveStatusPayload(payload) {
			err = fmt.Errorf("invalid machine status payload %q", payload)
		}
		if err != nil {
			// A failed TCP status transaction must not retain an unusable stream
			// merely because the error is not a net.Error (e.g. invalid status).
			// Serial timeouts intentionally preserve the port to avoid reset loops.
			if a.preserveConnOnPollTimeout && timeoutErr(err) {
				statusErr = err
				return nil
			}
			a.dropOwnerConn(c)
			return err
		}
		observed = true
		return nil
	})
	if err == nil {
		err = statusErr
	}
	if errors.Is(err, ErrRelayActive) {
		return
	}
	a.mu.Lock()
	failedBefore := a.pollFailed
	if err != nil {
		a.pollFailed = true
	} else if observed {
		a.pollFailed = false
	}
	a.mu.Unlock()
	if err != nil && !failedBefore {
		log.Printf("session: status poll failed: %v", err)
	}
	if observed && failedBefore {
		log.Printf("session: machine status reports resumed")
	}
}

func timeoutErr(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}
