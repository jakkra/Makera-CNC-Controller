// Package client speaks the Carvera framed protocol to a machine over the
// proxy-owned machine-side transport. It implements the management commands
// (ls/rm/mv/mkdir/md5sum), a status query, and the upload handshake.
//
// This is the execution path the sync engine uses; it is only ever active when
// no controller is connected, so there is a single in-flight operation at a time.
package client

import (
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/uwin/cnc-proxy/internal/machinetransport"
	"github.com/uwin/cnc-proxy/internal/protocol"
)

// WifiPacketSize is the upload chunk size used over WiFi, matching the
// controller (XMODEM.py wifiMode).
const WifiPacketSize = machinetransport.TCPPacketSize

// USBPacketSize is the upload chunk size used over the firmware's USB serial
// console, matching the controller (XMODEM.py USBMode) and staying below the
// SerialConsole frame-length limit.
const USBPacketSize = machinetransport.USBPacketSize

const defaultUploadStartDelay = 200 * time.Millisecond

// Option tunes a protocol connection.
type Option func(*Conn)

// WithFilePacketSize sets the FILE_VIEW packet size advertised during uploads.
// Values <= 0 keep the default WiFi/TCP size.
func WithFilePacketSize(n int) Option {
	return func(k *Conn) {
		if n > 0 {
			k.filePacketSize = n
		}
	}
}

// WithUploadStartDelay overrides the controller-compatible pause between the
// FILE_START upload command and the first FILE_MD5 handshake frame.
func WithUploadStartDelay(d time.Duration) Option {
	return func(k *Conn) {
		if d < 0 {
			d = 0
		}
		k.uploadStartDelay = d
	}
}

// Conn wraps a frame transport with frame-level read/write and a resync scanner.
type Conn struct {
	c                machinetransport.Conn
	filePacketSize   int
	uploadStartDelay time.Duration
	writeMu          sync.Mutex
	scan             protocol.Scanner
	// pending holds frames already parsed from a read that returned more than
	// one frame, so the next readFrame call drains them first.
	pending []protocol.Frame
	// onStatus, if set, is called with each STATUS_RES payload observed while
	// another command is active, so the caller's state tracker can stay current
	// when status frames are interleaved with command traffic.
	onStatus func(payload string)
}

// SetStatusObserver registers a callback invoked with each STATUS_RES payload
// seen while running a command.
func (k *Conn) SetStatusObserver(f func(payload string)) { k.onStatus = f }

// Dial connects to a machine at host:port over TCP.
func Dial(addr string, timeout time.Duration, opts ...Option) (*Conn, error) {
	c, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return nil, err
	}
	return New(c, opts...), nil
}

// New wraps an existing connection (useful for tests).
func New(c net.Conn, opts ...Option) *Conn { return newConn(c, opts...) }

// NewTransport wraps any frame transport, e.g. the relay injection mux.
func NewTransport(t machinetransport.Conn, opts ...Option) *Conn {
	return newConn(t, opts...)
}

func newConn(t machinetransport.Conn, opts ...Option) *Conn {
	k := &Conn{c: t, filePacketSize: WifiPacketSize, uploadStartDelay: defaultUploadStartDelay}
	for _, opt := range opts {
		if opt != nil {
			opt(k)
		}
	}
	if k.filePacketSize <= 0 {
		k.filePacketSize = WifiPacketSize
	}
	return k
}

// Close closes the underlying connection.
func (k *Conn) Close() error { return k.c.Close() }

// IsConnectionError reports whether err indicates that the underlying machine
// transport can no longer be trusted. Firmware/protocol semantic errors (for
// example, an rm command rejected by the machine) deliberately return false so
// callers do not reconnect or reset a healthy transport.
func IsConnectionError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, net.ErrClosed) {
		return true
	}
	var netErr net.Error
	return errors.As(err, &netErr)
}

func (k *Conn) writeFrame(b []byte) error {
	k.writeMu.Lock()
	defer k.writeMu.Unlock()
	for written := 0; written < len(b); {
		n, err := k.c.Write(b[written:])
		if n > 0 {
			written += n
		}
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrNoProgress
		}
	}
	return nil
}

// WriteGcodeLine writes a CTRL_MULTI gcode/console line and does not wait for a
// reply. It is for higher-level schedulers that own their own status/read loop.
func (k *Conn) WriteGcodeLine(line string) error {
	return k.WriteConsoleCommand(line)
}

// WriteConsoleCommand writes one OEM-compatible CTRL_MULTI console command.
// Makera Studio and Carvera Controller remove trailing CR/LF before framing;
// keeping it in the payload can make the Z1 Wi-Fi firmware include it in a
// filename and therefore calculate a different play-path CRC than the LPC.
func (k *Conn) WriteConsoleCommand(line string) error {
	line = strings.TrimRight(line, "\r\n")
	return k.writeFrame(protocol.Encode(protocol.CmdCtrlMulti, []byte(line)))
}

// readFrame returns the next protocol frame, blocking until one arrives or the
// deadline passes. Bytes that don't form a frame are buffered across calls.
func (k *Conn) readFrame(deadline time.Time) (protocol.Frame, error) {
	if len(k.pending) > 0 {
		f := k.pending[0]
		k.pending = k.pending[1:]
		return f, nil
	}
	buf := make([]byte, 16*1024)
	for {
		if err := k.c.SetReadDeadline(deadline); err != nil {
			return protocol.Frame{}, err
		}
		n, err := k.c.Read(buf)
		if n > 0 {
			frames := k.scan.Push(buf[:n])
			if len(frames) > 0 {
				k.pending = frames[1:]
				return frames[0], nil
			}
		}
		if err != nil {
			return protocol.Frame{}, err
		}
	}
}

// CommandResult is the outcome of a management command.
type CommandResult struct {
	Info    string // concatenated LOAD_INFO payloads (e.g. listing rows)
	Success bool   // LOAD_FINISH vs LOAD_ERROR
}

// runManaged sends a management command frame and collects response frames
// until LOAD_FINISH or LOAD_ERROR. Status reports (STATUS_RES) that arrive
// interleaved are ignored here; the caller's state tracker handles those via
// the relay/poll path.
func (k *Conn) runManaged(frame []byte, timeout time.Duration) (CommandResult, error) {
	if err := k.writeFrame(frame); err != nil {
		return CommandResult{}, err
	}
	deadline := time.Now().Add(timeout)
	var info []byte
	for {
		f, err := k.readFrame(deadline)
		if err != nil {
			return CommandResult{}, err
		}
		switch f.Cmd {
		case protocol.CmdLoadInfo:
			info = append(info, f.Data...)
		case protocol.CmdLoadFinish:
			return CommandResult{Info: string(info), Success: true}, nil
		case protocol.CmdLoadError:
			return CommandResult{Info: string(info), Success: false}, nil
		default:
			// Ignore status/diag/normal-info noise during a managed command.
		}
	}
}

// List runs `ls -e -s` and returns parsed directory entries.
func (k *Conn) List(dir string, timeout time.Duration) ([]protocol.DirEntry, error) {
	res, err := k.runManaged(protocol.LsCommand(dir), timeout)
	if err != nil {
		return nil, err
	}
	if !res.Success {
		return nil, fmt.Errorf("ls %q failed: %s", dir, res.Info)
	}
	return protocol.ParseListing(res.Info), nil
}

// Remove runs `rm <path> -e`.
func (k *Conn) Remove(path string, timeout time.Duration) error {
	res, err := k.runManaged(protocol.RmCommand(path), timeout)
	if err != nil {
		return err
	}
	if !res.Success {
		return fmt.Errorf("rm %q failed: %s", path, res.Info)
	}
	return nil
}

// Rename runs `mv <from> <to> -e`.
func (k *Conn) Rename(from, to string, timeout time.Duration) error {
	res, err := k.runManaged(protocol.MvCommand(from, to), timeout)
	if err != nil {
		return err
	}
	if !res.Success {
		return fmt.Errorf("mv %q->%q failed: %s", from, to, res.Info)
	}
	return nil
}

// Mkdir runs `mkdir <dir> -e`.
func (k *Conn) Mkdir(dir string, timeout time.Duration) error {
	res, err := k.runManaged(protocol.MkdirCommand(dir), timeout)
	if err != nil {
		return err
	}
	if !res.Success {
		return fmt.Errorf("mkdir %q failed: %s", dir, res.Info)
	}
	return nil
}

// Md5 runs `md5sum <path>` and returns the lowercase hex digest. The firmware
// replies with a single NORMAL_INFO line — "<hex> <path>" on success or
// "File not found: <path>" — rather than a packetized LOAD_* response, so this
// scans info lines rather than using the managed-command path.
func (k *Conn) Md5(path string, timeout time.Duration) (string, error) {
	if err := k.writeFrame(protocol.Md5Command(path)); err != nil {
		return "", err
	}
	deadline := time.Now().Add(timeout)
	for {
		f, err := k.readFrame(deadline)
		if err != nil {
			return "", err
		}
		switch f.Cmd {
		case protocol.CmdNormalInfo, protocol.CmdLoadInfo:
			text := string(f.Data)
			if digest, ok := protocol.ParseMd5Response(text); ok {
				return digest, nil
			}
			if strings.Contains(text, "not found") || strings.Contains(strings.ToLower(text), "error") {
				return "", fmt.Errorf("md5sum %q: %s", path, strings.TrimSpace(text))
			}
			// Other info noise (e.g. a trailing upload message): keep reading.
		case protocol.CmdLoadError:
			return "", fmt.Errorf("md5sum %q failed: %s", path, strings.TrimSpace(string(f.Data)))
		default:
			// Ignore STATUS_RES etc.
		}
	}
}

// Ftype sends `ftype` and returns the upload file type the firmware supports
// (e.g. "lz"). The reply arrives as an info line "ftype = <type>" rather than a
// LOAD_* frame, so we scan info-bearing frames for it.
func (k *Conn) Ftype(timeout time.Duration) (string, error) {
	if err := k.writeFrame(protocol.FtypeCommand()); err != nil {
		return "", err
	}
	deadline := time.Now().Add(timeout)
	for {
		f, err := k.readFrame(deadline)
		if err != nil {
			return "", err
		}
		switch f.Cmd {
		case protocol.CmdNormalInfo, protocol.CmdLoadInfo, protocol.CmdStatusRes:
			if t, ok := protocol.ParseFtype(string(f.Data)); ok {
				return t, nil
			}
		}
	}
}

// GcodeOpts tunes how SendGcodeLine waits for a command's response. Defaults
// (all zero) mean fire-and-forget with no reply read.
type GcodeOpts struct {
	// ExpectReply selects the response model. False (default): fire-and-forget —
	// write the frame and only briefly drain for an immediate error/alarm line.
	// True: read the prompt reply (an "ok"/"ok <payload>" line, or one-or-more
	// output lines with no "ok") until quiescence.
	ExpectReply bool
	// Settle is how long to wait for more output after the last line before
	// considering a no-"ok" reply complete (ExpectReply) or how long to drain
	// for a late error line (fire-and-forget). Defaults to defaultSettle.
	Settle time.Duration
	// FirstReplyTimeout optionally gives a reply-producing command longer to
	// produce its first frame than the normal post-reply quiescence window. Slow
	// physical probes use this; after the first [PRB:...] line, Settle remains
	// short so the command completes promptly.
	FirstReplyTimeout time.Duration
	// Cap bounds the whole call as a safety net. Because the firmware replies
	// promptly or never, this should never actually fire in normal operation;
	// it only guards against a misbehaving peer. Defaults to defaultCap.
	Cap time.Duration
}

const (
	// defaultSettle: the firmware emits a multi-line reply (e.g. M503, $#) as a
	// burst; this much silence after the last line means it's done. It also
	// bounds the fire-and-forget drain (catching a late "error:"/ALARM line).
	defaultSettle = 400 * time.Millisecond
	// defaultCap is the hard ceiling on a single SendGcodeLine call.
	defaultCap = 5 * time.Second
)

// SendGcodeLine sends a single command line (CTRL_MULTI) and, per opts, collects
// its response. It is the single send primitive for all injected gcode/console
// commands; protocol.ClassifyGcode decides which response model a given line
// needs (and the caller passes that via opts.ExpectReply).
//
// The design rests on a property verified against real hardware (firmware
// 1.0.5): the Carvera firmware replies PROMPTLY or NEVER over the WiFi protocol.
//   - Queries (M114, version, $G, M503, …) answer within milliseconds, either as
//     "ok"/"ok <payload>" or as output line(s) with NO terminating "ok".
//   - Motion (G0–G3), modal/state sets (G90/G91, M5/M9), blocking waits (M400,
//     G4 dwell) and unrecognized lines produce NO reply frame at all.
//
// Because nothing is "silent then late", a short settle window after the last
// observed line is a complete and non-hanging termination rule — no per-2s
// keepalive poll is needed or useful (the old design's keepalive only delayed a
// guaranteed timeout for the silent commands, which is exactly what caused a
// fire-and-forget command to block opMu until the command timeout).
//
// STATUS_RES frames that arrive interleaved are fed to the status observer (so
// the tracker stays fresh) and never count as the command's output. A NORMAL_INFO
// line containing "error"/"alarm" returns a non-nil error with whatever output
// preceded it. On a connection-level read error with no output yet, that error
// is surfaced so the arbiter can drop and reconnect.
func (k *Conn) SendGcodeLine(line string, opts GcodeOpts) (string, error) {
	return k.SendConsoleCommand(ensureLineEnding(line), opts)
}

// SendConsoleCommand sends a CTRL_MULTI console command and collects output
// according to opts. WriteConsoleCommand applies the OEM wire convention of
// stripping trailing CR/LF before framing.
func (k *Conn) SendConsoleCommand(line string, opts GcodeOpts) (string, error) {
	if opts.Settle <= 0 {
		opts.Settle = defaultSettle
	}
	if opts.Cap <= 0 {
		opts.Cap = defaultCap
	}
	if err := k.WriteConsoleCommand(line); err != nil {
		return "", err
	}

	hardDeadline := time.Now().Add(opts.Cap)
	var out []byte
	haveOutput := false
	observedReply := false
	appendOutput := func(s string) {
		if haveOutput {
			out = append(out, '\n')
		}
		out = append(out, s...)
		haveOutput = true
		observedReply = true
	}
	for {
		// Read deadline: the settle window (so a quiescent reply terminates),
		// capped by the overall hard deadline.
		wait := opts.Settle
		if opts.ExpectReply && !observedReply && opts.FirstReplyTimeout > 0 {
			wait = opts.FirstReplyTimeout
		}
		rd := time.Now().Add(wait)
		if rd.After(hardDeadline) {
			rd = hardDeadline
		}
		f, err := k.readFrame(rd)
		if err != nil {
			if isTimeout(err) {
				// Quiescence (or the hard cap): for a reply-expected command this
				// ends a no-"ok" multi-line reply; for fire-and-forget it is the
				// normal, expected outcome (nothing more is coming). Either way,
				// return what we have.
				if opts.ExpectReply && !observedReply {
					return "", fmt.Errorf("machine: no reply for %q", strings.TrimSpace(line))
				}
				return string(out), nil
			}
			// A real connection error (EOF/closed). If we already captured output
			// it just marks the end; otherwise surface it so the conn is dropped.
			if haveOutput {
				return string(out), nil
			}
			return "", err
		}
		switch f.Cmd {
		case protocol.CmdNormalInfo:
			observedReply = true
			trimmed := strings.TrimRight(string(f.Data), "\r\n")
			low := strings.ToLower(strings.TrimSpace(trimmed))
			switch {
			case low == "ok":
				return string(out), nil
			case strings.HasPrefix(low, "ok "):
				// "ok <payload>" — the firmware appended the result to the ok line
				// (e.g. M114 position). Capture the payload and finish.
				payload := strings.TrimSpace(trimmed[len("ok "):])
				if haveOutput {
					out = append(out, '\n')
				}
				out = append(out, payload...)
				return string(out), nil
			case strings.Contains(low, "error") || strings.Contains(low, "alarm"):
				return string(out), fmt.Errorf("machine: %s", trimmed)
			default:
				appendOutput(trimmed)
			}
		case protocol.CmdDiagRes:
			appendOutput(strings.TrimRight(string(f.Data), "\r\n"))
		case protocol.CmdStatusRes:
			// Interleaved status report (e.g. a concurrent poll's reply): feed the
			// observer so the tracker stays fresh, but it's not this command's
			// output.
			if k.onStatus != nil {
				k.onStatus(string(f.Data))
			}
		default:
			// Ignore other frames during a gcode command.
		}
	}
}

func ensureLineEnding(line string) string {
	if line == "" || line[len(line)-1] == '\n' {
		return line
	}
	return line + "\n"
}

// SendControl sends a single realtime control character (CTRL_SINGLE): '!'
// feed-hold, '~' resume, or 0x18 emergency halt. These are out-of-band: the
// firmware acts on them immediately from its receive path regardless of what
// the machine is doing, so this is fire-and-forget and never waits for a reply.
func (k *Conn) SendControl(c byte) error {
	return k.writeFrame(protocol.Encode(protocol.CmdCtrlSingle, []byte{c}))
}

// isTimeout reports whether err is a deadline/timeout (net.Error.Timeout),
// distinguishing a quiescence deadline from a real connection failure.
func isTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

// QueryState sends `?` and waits for the next STATUS_RES frame, returning its
// payload (e.g. "<Idle|...>"). The caller parses it via the machine package.
func (k *Conn) QueryState(timeout time.Duration) (string, error) {
	// A transport preserved after a prior poll timeout may receive that poll's
	// STATUS_RES late. The protocol has no sequence number, so discard frames
	// already waiting at a short quiet boundary before sending a new `?`;
	// otherwise the old state would be attributed to this query and timestamped
	// fresh. Do not discard an immediate firmware error from a preceding silent
	// motion command: it is the only direct explanation for a rejected jog.
	if err := k.drainAvailableFrames(2 * time.Millisecond); err != nil {
		return "", err
	}
	if err := k.writeFrame(protocol.QueryStatus()); err != nil {
		return "", err
	}
	deadline := time.Now().Add(timeout)
	for {
		f, err := k.readFrame(deadline)
		if err != nil {
			return "", err
		}
		switch f.Cmd {
		case protocol.CmdStatusRes:
			return string(f.Data), nil
		case protocol.CmdNormalInfo:
			if err := normalInfoError(f.Data); err != nil {
				return "", err
			}
		}
	}
}

// QueryActivePlayback asks the WiFi controller which SD-card file is currently
// executing. It is a read-only protocol transaction and does not depend on an
// official controller being connected. STATUS_RES traffic may interleave and
// is forwarded to the registered observer.
func (k *Conn) QueryActivePlayback(timeout time.Duration) (protocol.PlayStatus, error) {
	if err := k.writeFrame(protocol.Encode(protocol.CmdPlayStatus, nil)); err != nil {
		return protocol.PlayStatus{}, err
	}
	deadline := time.Now().Add(timeout)
	for {
		f, err := k.readFrame(deadline)
		if err != nil {
			return protocol.PlayStatus{}, err
		}
		switch f.Cmd {
		case protocol.CmdPlayStatus:
			return protocol.ParsePlayStatus(f.Data)
		case protocol.CmdStatusRes:
			if k.onStatus != nil {
				k.onStatus(string(f.Data))
			}
		case protocol.CmdNormalInfo:
			if err := normalInfoError(f.Data); err != nil {
				return protocol.PlayStatus{}, err
			}
		}
	}
}

func (k *Conn) drainAvailableFrames(quiet time.Duration) error {
	var diagnostic error
	for {
		f, err := k.readFrame(time.Now().Add(quiet))
		if err == nil {
			if f.Cmd == protocol.CmdNormalInfo {
				if err := normalInfoError(f.Data); err != nil {
					// Keep draining the immediately available burst. Interactive
					// motion can produce one diagnostic per rejected planner block;
					// returning on the first would make later retries rediscover old
					// errors one at a time and postpone fresh status unnecessarily.
					diagnostic = err
				}
			}
			continue
		}
		if isTimeout(err) {
			return diagnostic
		}
		return err
	}
}

func normalInfoError(data []byte) error {
	trimmed := strings.TrimRight(string(data), "\r\n")
	low := strings.ToLower(strings.TrimSpace(trimmed))
	if strings.Contains(low, "error") || strings.Contains(low, "alarm") {
		return fmt.Errorf("machine: %s", trimmed)
	}
	return nil
}

var ErrUploadCanceled = errors.New("upload canceled by machine")

// UploadCanceledError preserves the firmware's follow-up error text when it
// sends FILE_CANCEL and then a NORMAL_INFO diagnostic.
type UploadCanceledError struct {
	Reason string
}

func (e *UploadCanceledError) Error() string {
	if e != nil && e.Reason != "" {
		return ErrUploadCanceled.Error() + ": " + e.Reason
	}
	return ErrUploadCanceled.Error()
}

func (e *UploadCanceledError) Unwrap() error { return ErrUploadCanceled }

// Upload transfers a file to remotePath. md5hex is the MD5 of the file's
// contents (the firmware stores it in a sidecar and the controller compares it
// for sync confirmation). size is the file length. The handshake is firmware-
// driven: it requests MD5, then a file "view", then each data packet by
// sequence number; we react to each request. progress, if non-nil, is called
// with the number of packets sent so far.
//
// Note: this primitive uploads the bytes it is given. The sync engine may wrap
// it with QuickLZ compression by passing a .lz container and the uncompressed
// MD5, matching the controller's large-upload behavior.
func (k *Conn) Upload(remotePath string, r io.ReaderAt, size int64, md5hex string, timeout time.Duration, progress func(sent, total uint32)) error {
	if err := k.writeFrame(protocol.UploadCommand(remotePath)); err != nil {
		return err
	}
	if k.uploadStartDelay > 0 {
		time.Sleep(k.uploadStartDelay)
	}
	var lastCmd byte
	var lastData []byte
	send := func(cmd byte, data []byte) error {
		cp := append([]byte(nil), data...)
		if err := k.writeFrame(protocol.Encode(cmd, cp)); err != nil {
			return err
		}
		lastCmd = cmd
		lastData = cp
		return nil
	}
	resendLast := func() error {
		if lastCmd == 0 {
			return nil
		}
		return k.writeFrame(protocol.Encode(lastCmd, lastData))
	}

	// Proactively send MD5, as the controller does after giving the firmware
	// time to enter upload mode and reset its file-transfer frame parser.
	if err := send(protocol.CmdFileMD5, []byte(md5hex)); err != nil {
		return err
	}

	packetSize := int64(k.filePacketSize)
	totalPackets := uint32((size + packetSize - 1) / packetSize)
	if totalPackets == 0 {
		totalPackets = 1 // an empty file is still one (empty) packet to view
	}

	deadline := time.Now().Add(timeout)
	for {
		f, err := k.readFrame(deadline)
		if err != nil {
			return err
		}
		// Any progress resets the inactivity deadline.
		deadline = time.Now().Add(timeout)

		switch f.Cmd {
		case protocol.CmdFileCancel:
			return &UploadCanceledError{Reason: k.uploadCancelReason(f.Data, timeout)}
		case protocol.CmdFileRetry:
			if err := resendLast(); err != nil {
				return err
			}
		case protocol.CmdFileMD5:
			if err := send(protocol.CmdFileMD5, []byte(md5hex)); err != nil {
				return err
			}
		case protocol.CmdFileView:
			ps := k.filePacketSize
			view := []byte{
				byte(totalPackets >> 24), byte(totalPackets >> 16), byte(totalPackets >> 8), byte(totalPackets),
				byte(ps >> 8), byte(ps & 0xFF),
			}
			if err := send(protocol.CmdFileView, view); err != nil {
				return err
			}
		case protocol.CmdFileData:
			if len(f.Data) < 4 {
				continue
			}
			seq := uint32(f.Data[0])<<24 | uint32(f.Data[1])<<16 | uint32(f.Data[2])<<8 | uint32(f.Data[3])
			data, err := k.dataPacket(r, size, packetSize, seq)
			if err != nil {
				return err
			}
			if err := send(protocol.CmdFileData, data); err != nil {
				return err
			}
			if progress != nil {
				progress(seq, totalPackets)
			}
		case protocol.CmdFileEnd:
			if progress != nil {
				progress(totalPackets, totalPackets)
			}
			return nil
		default:
			// ignore
		}
	}
}

func (k *Conn) uploadCancelReason(data []byte, timeout time.Duration) string {
	if reason := cleanUploadCancelReason(string(data)); reason != "" {
		return reason
	}
	wait := 2 * time.Second
	if timeout > 0 && timeout < wait {
		wait = timeout
	}
	deadline := time.Now().Add(wait)
	for {
		f, err := k.readFrame(deadline)
		if err != nil {
			return ""
		}
		switch f.Cmd {
		case protocol.CmdNormalInfo, protocol.CmdLoadInfo, protocol.CmdDiagRes:
			if reason := cleanUploadCancelReason(string(f.Data)); reason != "" {
				return reason
			}
		case protocol.CmdFileCancel:
			if reason := cleanUploadCancelReason(string(f.Data)); reason != "" {
				return reason
			}
		}
	}
}

func cleanUploadCancelReason(s string) string {
	s = strings.Trim(strings.TrimSpace(s), "\x00")
	s = strings.TrimSpace(s)
	if s == "" || strings.EqualFold(s, "ok") {
		return ""
	}
	return s
}

func (k *Conn) dataPacket(r io.ReaderAt, size, packetSize int64, seq uint32) ([]byte, error) {
	offset := int64(seq-1) * packetSize
	n := packetSize
	if offset+n > size {
		n = size - offset
	}
	if n < 0 {
		n = 0
	}
	chunk := make([]byte, n)
	if n > 0 {
		if _, err := r.ReadAt(chunk, offset); err != nil && err != io.EOF {
			return nil, err
		}
	}
	data := make([]byte, 4+len(chunk))
	data[0] = byte(seq >> 24)
	data[1] = byte(seq >> 16)
	data[2] = byte(seq >> 8)
	data[3] = byte(seq)
	copy(data[4:], chunk)
	return data, nil
}

var ErrDownloadCanceled = errors.New("download canceled by machine")

// reqSeq sends a FILE_DATA frame whose payload is just the 4-byte sequence
// number, which is how the receiver asks the machine for that packet.
func (k *Conn) reqSeq(seq uint32) error {
	data := []byte{byte(seq >> 24), byte(seq >> 16), byte(seq >> 8), byte(seq)}
	return k.writeFrame(protocol.Encode(protocol.CmdFileData, data))
}

// Download fetches remotePath from the machine into w. Here the proxy is the
// receiver and driver: the machine sends MD5 first, then we request the file
// view, then we pull each packet by sequence number until the last one, and
// acknowledge with FILE_END. It returns the machine-reported MD5 (of the
// uncompressed content) and the number of bytes written.
//
// The bytes written are exactly what the machine sends. If a .lz sidecar exists
// the machine sends compressed bytes; callers that need the plaintext must
// detect and decompress (see protocol.IsQuickLZ). For .nc/.gcode files without
// a sidecar the machine sends them uncompressed.
func (k *Conn) Download(remotePath string, w io.Writer, timeout time.Duration, progress func(recv, total uint32)) (md5hex string, written int64, err error) {
	if err := k.writeFrame(protocol.DownloadCommand(remotePath)); err != nil {
		return "", 0, err
	}

	const (
		stWaitMD5 = iota
		stWaitView
		stReadData
	)
	state := stWaitMD5
	var totalPackets, nextSeq uint32

	deadline := time.Now().Add(timeout)
	for {
		f, err := k.readFrame(deadline)
		if err != nil {
			return "", written, err
		}
		deadline = time.Now().Add(timeout)

		if f.Cmd == protocol.CmdFileCancel {
			return "", written, ErrDownloadCanceled
		}

		switch state {
		case stWaitMD5:
			if f.Cmd == protocol.CmdFileMD5 {
				md5hex = string(f.Data)
				// Request the file view (total packets + packet size).
				if err := k.writeFrame(protocol.Encode(protocol.CmdFileView, nil)); err != nil {
					return md5hex, written, err
				}
				state = stWaitView
			}
		case stWaitView:
			if f.Cmd == protocol.CmdFileView {
				if len(f.Data) < 6 {
					return md5hex, written, fmt.Errorf("download %q: short FILE_VIEW (%d bytes)", remotePath, len(f.Data))
				}
				totalPackets = uint32(f.Data[0])<<24 | uint32(f.Data[1])<<16 | uint32(f.Data[2])<<8 | uint32(f.Data[3])
				if totalPackets == 0 {
					return md5hex, written, fmt.Errorf("download %q: FILE_VIEW reports zero packets", remotePath)
				}
				nextSeq = 1
				if err := k.reqSeq(nextSeq); err != nil {
					return md5hex, written, err
				}
				state = stReadData
			}
		case stReadData:
			if f.Cmd == protocol.CmdFileEnd {
				// The machine ended the transfer before the last expected packet.
				// Accept what we received rather than blocking until timeout.
				return md5hex, written, nil
			}
			if f.Cmd != protocol.CmdFileData || len(f.Data) < 4 {
				continue
			}
			seq := uint32(f.Data[0])<<24 | uint32(f.Data[1])<<16 | uint32(f.Data[2])<<8 | uint32(f.Data[3])
			if seq != nextSeq {
				// Re-request the packet we still expect.
				if err := k.reqSeq(nextSeq); err != nil {
					return md5hex, written, err
				}
				continue
			}
			n, werr := w.Write(f.Data[4:])
			written += int64(n)
			if werr != nil {
				return md5hex, written, werr
			}
			if progress != nil {
				progress(seq, totalPackets)
			}
			if seq >= totalPackets {
				if err := k.writeFrame(protocol.Encode(protocol.CmdFileEnd, nil)); err != nil {
					return md5hex, written, err
				}
				return md5hex, written, nil
			}
			nextSeq++
			if err := k.reqSeq(nextSeq); err != nil {
				return md5hex, written, err
			}
		}
	}
}
