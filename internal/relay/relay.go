// Package relay implements a byte-transparent TCP proxy between the Carvera
// controller and the machine-side transport.
//
// The firmware is effectively single-session (it sends responses to "the latest
// connected remote" and uploads take a global lock), so the relay admits only
// one controller at a time. Additional connections are refused until the active
// one closes, mirroring how the machine itself behaves.
//
// Controller-facing TCP bytes are forwarded verbatim in both directions; frames
// are only sniffed for logging and never altered, so CRCs the controller
// validates stay intact.
package relay

import (
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/uwin/cnc-proxy/internal/gcodelog"
	"github.com/uwin/cnc-proxy/internal/machinetransport"
	"github.com/uwin/cnc-proxy/internal/protocol"
)

// DownloadCache is an optional local source for controller FILE_START download
// requests. A cache hit lets the relay satisfy a controller preview/select
// download without requiring the machine to already have those bytes.
type DownloadCache interface {
	OpenDownloadCache(remotePath string) (io.ReaderAt, io.Closer, int64, string, error)
}

// Observer is notified of relay session lifecycle and of machine state observed
// by sniffing STATUS_RES frames. The session arbiter implements this so the
// proxy enters relay mode while a controller is connected and keeps the shared
// machine-state tracker current. It is optional; a nil Observer disables hooks.
type Observer interface {
	// EnterRelay is called when a controller session begins.
	EnterRelay()
	// ExitRelay is called when the controller session ends.
	ExitRelay()
	// ObserveStatusPayload is called with the payload of each STATUS_RES frame
	// seen flowing from the machine to the controller.
	ObserveStatusPayload(payload string) bool
}

// Server relays one controller<->machine session at a time.
type Server struct {
	// MachineAddr is resolved lazily per-connection via Dial so the proxy can
	// start before the machine is discovered.
	Dial func() (string, error)

	// MachineDial opens the machine-side transport. When set, it supersedes
	// Dial and may return either TCP or USB/serial. The controller-facing side
	// of the relay remains TCP.
	MachineDial func() (*machinetransport.Opened, error)

	// Observer, if set, receives session lifecycle and state-observation hooks.
	Observer Observer

	// GcodeLog, if set, records the controller's command lines and the machine's
	// textual output as they pass through the relay (sniffed, never altered).
	GcodeLog *gcodelog.Log

	// DownloadCache, if set, may satisfy controller `download <path>` file
	// transfers from the proxy's local cache. Cache misses fall back to normal
	// transparent forwarding.
	DownloadCache DownloadCache

	active atomic.Bool

	// mu guards curMux, the active session's injection multiplexer.
	mu     sync.Mutex
	curMux *mux
}

// Injector is the relay's interface for the rest of the system to inject an
// operation onto the shared machine connection during a controller session.
type Injector interface {
	// AcquireMachine borrows the machine connection for one injected operation,
	// returning a client transport and a release func. It fails with ErrBusy if
	// the controller is mid file-transfer, or ErrNoSession if no controller is
	// connected (in which case the caller should use the owner-mode path).
	AcquireMachine() (it InjectTransport, release func(), err error)
}

// InjectTransport is the byte channel an injected operation drives. It matches
// the client package's transport shape.
type InjectTransport interface {
	Write(p []byte) (int, error)
	Read(p []byte) (int, error)
	SetReadDeadline(t time.Time) error
	Close() error
}

// AcquireMachine implements Injector.
func (s *Server) AcquireMachine() (InjectTransport, func(), error) {
	s.mu.Lock()
	m := s.curMux
	s.mu.Unlock()
	if m == nil {
		return nil, nil, ErrNoSession
	}
	it, release, err := m.AcquireInjection()
	if err != nil {
		return nil, nil, err
	}
	return it, release, nil
}

// AcquireInteractive borrows the shared machine connection for a long-lived
// interactive operation such as jogging. The returned abort channel is closed
// if the controller sends non-status traffic and the lease must release.
func (s *Server) AcquireInteractive() (InjectTransport, <-chan struct{}, func(), error) {
	s.mu.Lock()
	m := s.curMux
	s.mu.Unlock()
	if m == nil {
		return nil, nil, nil, ErrNoSession
	}
	it, abortCh, release, err := m.AcquireInteractive()
	if err != nil {
		return nil, nil, nil, err
	}
	return it, abortCh, release, nil
}

// SendControl writes a single realtime control character (CTRL_SINGLE) straight
// to the shared machine transport, out-of-band — without taking the injection
// window. The firmware acts on '!'/'~'/0x18 immediately from its receive path
// regardless of any in-flight transaction, including controller file transfers,
// so this lets an emergency halt preempt even a controller program. Returns
// ErrNoSession if no controller (and thus no machine connection) is currently
// active. The injected control byte is the proxy's own; the controller's
// responses are unaffected (the firmware sends no reply to these, save an ALARM
// line on halt which flows to the controller as normal and correctly reflects
// the new machine state).
func (s *Server) SendControl(c byte) error {
	s.mu.Lock()
	m := s.curMux
	s.mu.Unlock()
	if m == nil {
		return ErrNoSession
	}
	return m.writeControl(c)
}

// Serve accepts connections on ln and relays each to the machine. It returns
// when ln is closed.
func (s *Server) Serve(ln net.Listener) error {
	for {
		conn, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		go s.handle(conn)
	}
}

func (s *Server) handle(client net.Conn) {
	defer client.Close()
	peer := client.RemoteAddr()

	if !s.active.CompareAndSwap(false, true) {
		log.Printf("relay: refusing %s, a session is already active", peer)
		return
	}
	defer s.active.Store(false)

	// Enter relay mode FIRST so the proxy's owner-mode connection (used for
	// status polling) is dropped before we open the controller's connection.
	// The machine is single-conversation: two proxy sockets at once would make
	// the firmware route responses to the wrong one and the session collapses.
	if s.Observer != nil {
		s.Observer.EnterRelay()
		defer s.Observer.ExitRelay()
	}

	opened, err := s.openMachine()
	if err != nil {
		log.Printf("relay: no machine to dial for %s: %v", peer, err)
		return
	}
	machine := opened.Conn
	defer machine.Close()
	log.Printf("relay: session up %s <-> machine %s", peer, opened.Label)

	m := newMux(machine)
	s.mu.Lock()
	s.curMux = m
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.curMux = nil
		s.mu.Unlock()
	}()

	var wg sync.WaitGroup
	wg.Add(2)
	closeBoth := func() { client.Close(); machine.Close() }
	errs := make(chan error, 2)
	go func() {
		defer wg.Done()
		errs <- s.pumpControllerToMachine(client, machine, m)
		closeBoth()
	}()
	go func() {
		defer wg.Done()
		errs <- s.pumpMachineToController(machine, client, m)
		closeBoth()
	}()
	wg.Wait()
	first, second := <-errs, <-errs
	if isCloseError(first) && !isCloseError(second) {
		first = second
	}
	log.Printf("relay: session closed %s: %v", peer, first)
}

func (s *Server) openMachine() (*machinetransport.Opened, error) {
	if s.MachineDial != nil {
		opened, err := s.MachineDial()
		if err != nil {
			return nil, err
		}
		if opened == nil || opened.Conn == nil {
			return nil, errors.New("machine dialer returned nil connection")
		}
		if opened.Label == "" {
			opened.Label = opened.Kind
		}
		if opened.PacketSize <= 0 {
			opened.PacketSize = machinetransport.PacketSizeForKind(opened.Kind)
		}
		return opened, nil
	}
	if s.Dial == nil {
		return nil, errors.New("no machine dialer configured")
	}
	addr, err := s.Dial()
	if err != nil {
		return nil, err
	}
	machine, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		return nil, fmt.Errorf("dial machine %s: %w", addr, err)
	}
	return &machinetransport.Opened{
		Conn:       machine,
		Label:      addr,
		Kind:       machinetransport.KindTCP,
		PacketSize: machinetransport.TCPPacketSize,
	}, nil
}

// pumpControllerToMachine forwards controller frames to the machine, except
// while an injection holds the mux, when most frames are buffered for replay and
// status polls are answered locally from the cached status.
func (s *Server) pumpControllerToMachine(client net.Conn, machine machinetransport.Conn, m *mux) error {
	var sc protocol.Scanner
	buf := make([]byte, 32*1024)
	var cached *controllerDownload
	defer func() {
		if cached != nil {
			cached.Close()
			m.finishLocalControllerTransfer()
		}
	}()
	for {
		n, rerr := client.Read(buf)
		if n > 0 {
			for _, f := range sc.Push(buf[:n]) {
				logFrame("C->M", f)
				s.logControllerCommand(f)
				if cached != nil {
					done, handled := cached.Handle(client, f)
					if done {
						cached.Close()
						cached = nil
						m.finishLocalControllerTransfer()
					}
					if handled || done {
						continue
					}
				}
				if dl, ok := s.tryStartCachedDownload(client, m, f); ok {
					cached = dl
					continue
				}
				if m.noteControllerFrame(f, f.Raw) {
					if _, werr := machine.Write(f.Raw); werr != nil {
						return fmt.Errorf("write controller frame to machine: %w", werr)
					}
				} else if isStatusPoll(f) {
					// Answer the poll from cache so the controller's heartbeat
					// stays alive during injection.
					if frame := m.cachedStatusFrame(); frame != nil {
						if _, werr := client.Write(frame); werr != nil {
							return fmt.Errorf("write cached status to controller: %w", werr)
						}
					}
				}
			}
		}
		if rerr != nil {
			return fmt.Errorf("read controller: %w", rerr)
		}
	}
}

func (s *Server) tryStartCachedDownload(client net.Conn, m *mux, f protocol.Frame) (*controllerDownload, bool) {
	if s.DownloadCache == nil || f.Cmd != protocol.CmdFileStart {
		return nil, false
	}
	remote, ok := downloadPath(f)
	if !ok {
		return nil, false
	}
	reader, closer, size, md5hex, err := s.DownloadCache.OpenDownloadCache(remote)
	if err != nil {
		return nil, false
	}
	dl := newControllerDownload(reader, closer, size, md5hex)
	if !m.beginLocalControllerTransfer() {
		dl.Close()
		return nil, false
	}
	if err := dl.Start(client); err != nil {
		dl.Close()
		m.finishLocalControllerTransfer()
		return nil, false
	}
	return dl, true
}

func downloadPath(f protocol.Frame) (string, bool) {
	line := strings.TrimSpace(string(f.Data))
	verb, arg, ok := strings.Cut(line, " ")
	if !ok || strings.ToLower(strings.TrimSpace(verb)) != "download" {
		return "", false
	}
	arg = strings.TrimSpace(arg)
	if arg == "" {
		return "", false
	}
	return protocol.Unescape(arg), true
}

// pumpMachineToController forwards machine frames to the controller, diverting
// to the active injector during an injection window. Status reports are always
// forwarded to the controller (and observed) so its state and heartbeat stay
// current.
func (s *Server) pumpMachineToController(machine machinetransport.Conn, client net.Conn, m *mux) error {
	var sc protocol.Scanner
	buf := make([]byte, 32*1024)
	for {
		n, rerr := machine.Read(buf)
		if n > 0 {
			for _, f := range sc.Push(buf[:n]) {
				logFrame("M->C", f)
				if s.Observer != nil && f.Cmd == protocol.CmdStatusRes {
					s.Observer.ObserveStatusPayload(string(f.Data))
				}
				if m.routeMachineFrame(f) {
					// Log only frames actually forwarded to the controller:
					// diverted frames belong to an injected operation, which
					// records its own I/O under the "api" source.
					s.logMachineOutput(f)
					if _, werr := client.Write(f.Raw); werr != nil {
						return fmt.Errorf("write machine frame to controller: %w", werr)
					}
				}
			}
		}
		if rerr != nil {
			return fmt.Errorf("read machine: %w", rerr)
		}
	}
}

func isCloseError(err error) bool {
	return errors.Is(err, net.ErrClosed)
}

// logControllerCommand records a controller frame's command text into the
// gcode log. Status polls (`?`, sent every second as the controller's
// heartbeat) are skipped — they are transport noise, not commands.
func (s *Server) logControllerCommand(f protocol.Frame) {
	if s.GcodeLog == nil {
		return
	}
	switch f.Cmd {
	case protocol.CmdCtrlMulti:
		s.GcodeLog.Append(gcodelog.DirSend, gcodelog.SourceController, protocol.Unescape(string(f.Data)))
	case protocol.CmdCtrlSingle:
		if len(f.Data) != 1 {
			return
		}
		// '?' status polls are deliberately not logged; other control chars are.
		if label, ok := protocol.ControlLabel(f.Data[0]); ok {
			s.GcodeLog.Append(gcodelog.DirSend, gcodelog.SourceController, label)
		}
	}
}

// logMachineOutput records the machine's textual command output into the gcode
// log. Only NORMAL_INFO carries gcode/console output ("ok", error lines,
// command results); status reports and file-transfer frames are protocol
// machinery and stay out of the log.
func (s *Server) logMachineOutput(f protocol.Frame) {
	if s.GcodeLog == nil {
		return
	}
	if f.Cmd == protocol.CmdNormalInfo {
		s.GcodeLog.Append(gcodelog.DirRecv, gcodelog.SourceController, string(f.Data))
	}
}

func logFrame(dir string, f protocol.Frame) {
	switch f.Cmd {
	case protocol.CmdCtrlMulti, protocol.CmdFileStart, protocol.CmdLoadInfo,
		protocol.CmdLoadError, protocol.CmdNormalInfo, protocol.CmdPlayStatus:
		log.Printf("relay %s %s: %q", dir, protocol.CmdName(f.Cmd), preview(f.Data))
	case protocol.CmdFileData:
		log.Printf("relay %s FILE_DATA: %d bytes", dir, len(f.Data))
	default:
		log.Printf("relay %s %s (%d bytes)", dir, protocol.CmdName(f.Cmd), len(f.Data))
	}
}

func preview(b []byte) string {
	const max = 80
	if len(b) > max {
		b = b[:max]
	}
	out := make([]rune, 0, len(b))
	for _, c := range b {
		if c >= 0x20 && c < 0x7f {
			out = append(out, rune(c))
		} else {
			out = append(out, '.')
		}
	}
	return string(out)
}
