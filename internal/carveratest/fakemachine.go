// Package carveratest provides a fake Carvera machine that speaks the framed
// wire protocol, for use in tests across packages. It emulates the firmware's
// management commands and the firmware-driven upload handshake closely enough
// to exercise the client, arbiter, and sync engine end to end.
package carveratest

import (
	"fmt"
	"math"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/uwin/cnc-proxy/internal/protocol"
)

// FakeMachine is a TCP server emulating a Carvera over the wire protocol.
type FakeMachine struct {
	ln net.Listener

	mu                  sync.Mutex
	files               map[string][]byte // remote path -> contents (from uploads)
	dirs                map[string]bool   // created directories
	status              string            // payload for "?" (e.g. "<Idle|...>")
	statusReplyDelay    time.Duration     // optional test hook: delay "?" replies
	statusQueries       int               // number of "?" polls received (test observation)
	probeReplyDelay     time.Duration     // optional test hook: delay G30/G38 replies
	dropStatusReplies   bool              // optional test hook: ignore "?" replies
	dropStatusN         int               // optional test hook: ignore the next N "?" replies
	dropMD5Replies      bool              // optional test hook: ignore md5sum replies
	failCmd             map[string]bool   // command prefixes to fail (for error-path tests)
	ftype               string            // advertised upload type ("lz" enables compression)
	compressDownloads   bool              // if set, downloads send a .lz container
	downloadPacketSize  int               // packet size reported/sent for downloads
	downloadPacketDelay time.Duration     // optional test hook: pace download FILE_DATA packets
	config              map[string]string // firmware config-get-all key/value surface
	modelName           string            // SimpleShell model name ("C1", "CA1")
	machineModel        int               // Kernel FACTORY_SET MachineModel
	funcSetting         int               // Kernel FACTORY_SET FuncSetting
	probeAddr           int               // model command probe address field
	probeModel          *fakeProbeModel   // optional machine-coordinate mesh for probe collision
	probeLaserActive    bool              // M841/M842 and M494.1/M494.2 probe laser state
	lastProbe           *fakeProbeResult  // last G30/G38 contact result
	insertedTool        *fakeInsertedTool // physical tool currently inserted in the fake spindle
	refToolMZ           float64           // calibration reference tool machine Z, matching ATC REFMZ
	curToolMZ           float64           // last calibrated current tool machine Z, matching ATC TOOLMZ
	gcodes              []string          // CTRL_MULTI gcode lines received (motion/MDI)
	controls            []byte            // CTRL_SINGLE control chars received (!, ~, 0x18)
	gcodeReplies        map[string]string // exact line -> textual reply payload
	rejectedGcodes      map[string]string // exact line -> immediate error without execution (test hook)
	uploadPacketSizes   []int             // packet sizes advertised by upload senders
	unlockDoesNotClear  bool              // test hook: $X replies but leaves status unchanged
	m999DoesNotClear    bool              // test hook: M999 replies but leaves status unchanged
	transferActive      bool              // firmware has one global upload/download conversation
	holdActive          bool              // feed hold freezes simulated motion/program time
	holdStarted         time.Time
	holdResumeState     string
	suspendActive       bool // player suspend freezes program time but permits manual motion
	suspendStarted      time.Time
	absolute            bool    // simulated modal distance mode for ordinary G0/G1 moves
	arcAbsolute         bool    // simulated modal arc-center mode, G90.1/G91.1
	plane               int     // simulated modal arc plane, G17/G18/G19
	unit                float64 // simulated modal unit scale, mm per gcode unit
	motionMode          int     // simulated modal motion mode for ordinary axis words
	motionCode          int     // simulated modal G motion code, including G2/G3 arcs
	feedMMMin           float64 // simulated modal G1 feed, in mm/min
	cycleStarted        bool
	cycleRetractInit    bool
	cycleInitialZ       float64
	cycleSticky         fakeCycleSticky
	motion              []fakeMotionSegment
	program             *fakeProgramRun
	activePlaybackPath  string // B7 PLAY_STATUS identity (may model an externally started job)
	activePlaybackMD5   string
	simEnabled          bool
	simShowVectors      bool
	simSpeedScale       float64
	simResolutionMM     float64
	simToolShape        string
	simToolAngleDeg     float64
	stock               *fakeStock
	stockSegments       []fakeStockSegment
}

// New starts a FakeMachine listening on a random loopback port. Call Close when
// done.
func New() (*FakeMachine, error) { return NewOn("127.0.0.1:0") }

// NewOn starts a FakeMachine listening on the given address (e.g. ":2222" for a
// fixed port in manual testing).
func NewOn(addr string) (*FakeMachine, error) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	m := &FakeMachine{
		ln:                 ln,
		files:              map[string][]byte{},
		dirs:               map[string]bool{},
		status:             "<Idle|MPos:0,0,0|WPos:0,0,0|C:2,4,0,1|T:0,0.000>",
		failCmd:            map[string]bool{},
		gcodeReplies:       map[string]string{},
		rejectedGcodes:     map[string]string{},
		downloadPacketSize: 8192,
		config:             defaultFakeMachineConfig(),
		modelName:          "CA1",
		machineModel:       2,
		funcSetting:        4,
		refToolMZ:          math.NaN(),
		curToolMZ:          math.NaN(),
		absolute:           true,
		plane:              fakePlaneXY,
		unit:               1,
		motionMode:         fakeMotionRapid,
		motionCode:         0,
		feedMMMin:          1000,
		cycleRetractInit:   true,
		simEnabled:         true,
		simShowVectors:     true,
		simSpeedScale:      1,
		simResolutionMM:    defaultStockResolutionMM,
		simToolShape:       fakeToolShapeFlat,
		simToolAngleDeg:    defaultFakeVBitAngleDeg,
	}
	go m.serve()
	return m, nil
}

// Addr returns the host:port the machine listens on.
func (m *FakeMachine) Addr() string { return m.ln.Addr().String() }

// Close stops the machine.
func (m *FakeMachine) Close() { m.ln.Close() }

// SetStatus sets the payload returned for "?" queries.
func (m *FakeMachine) SetStatus(s string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.status = s
	m.motion = nil
	m.program = nil
	m.stockSegments = nil
	m.cycleStarted = false
	m.cycleSticky = fakeCycleSticky{}
	m.motionMode = fakeMotionRapid
	m.motionCode = 0
	m.holdActive = false
	m.holdStarted = time.Time{}
	m.holdResumeState = ""
	m.suspendActive = false
	m.suspendStarted = time.Time{}
}

// SetStatusReplyDelay delays replies to `?` status polls. It is a test hook for
// exercising jog/status behavior when firmware replies are delayed by motion.
func (m *FakeMachine) SetStatusReplyDelay(d time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.statusReplyDelay = d
}

// StatusQueries reports how many `?` polls reached the fake machine.
func (m *FakeMachine) StatusQueries() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.statusQueries
}

// SetProbeReplyDelay delays G30/G38 contact replies. It keeps the fake from
// unrealistically answering a physical probe synchronously.
func (m *FakeMachine) SetProbeReplyDelay(d time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.probeReplyDelay = d
}

// SetDropStatusReplies makes the fake ignore `?` status polls. It is a test
// hook for exercising status timeout behavior.
func (m *FakeMachine) SetDropStatusReplies(v bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.dropStatusReplies = v
}

// DropNextStatusReplies makes the fake ignore the next n `?` status polls and
// answer normally afterward, emulating STATUS_RES replies lost on the WiFi
// bridge in the middle of an operation.
func (m *FakeMachine) DropNextStatusReplies(n int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.dropStatusN = n
}

// SetDropMD5Replies makes md5sum commands receive no response, modelling the
// production Z1 WiFi bridge behavior that motivated bounded reconcile probes.
func (m *FakeMachine) SetDropMD5Replies(v bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.dropMD5Replies = v
}

// SetFtype sets the upload type advertised via "ftype" ("lz" enables QuickLZ
// upload compression; "nc" or empty disables it).
func (m *FakeMachine) SetFtype(s string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ftype = s
}

// SetCompressDownloads makes downloads send a QuickLZ .lz container (as the
// firmware does when a .lz sidecar exists), while still reporting the
// uncompressed MD5. Used to exercise download-side decompression.
func (m *FakeMachine) SetCompressDownloads(v bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.compressDownloads = v
}

// SetDownloadPacketSize sets the FILE_VIEW packet size used when the fake
// machine sends downloads. Real firmware uses 8192 over WiFi and 128 over USB.
func (m *FakeMachine) SetDownloadPacketSize(n int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if n > 0 {
		m.downloadPacketSize = n
	}
}

// SetDownloadPacketDelay delays each download FILE_DATA packet by d, analogous
// to SetStatusReplyDelay. It is a test hook for exercising slow downloads —
// e.g. a concurrent local write landing while a fetch is still in flight.
func (m *FakeMachine) SetDownloadPacketDelay(d time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.downloadPacketDelay = d
}

// FailCommand makes management commands with the given prefix return LOAD_ERROR.
func (m *FakeMachine) FailCommand(prefix string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.failCmd[prefix] = true
}

// File returns the contents uploaded to a path.
func (m *FakeMachine) File(path string) ([]byte, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.files[path]
	return b, ok
}

// PutFile seeds a remote file in the fake machine's SD catalog. It is a test
// hook for scenarios where higher layers already consider a file synced.
func (m *FakeMachine) PutFile(path string, content []byte) {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := make([]byte, len(content))
	copy(cp, content)
	m.files[path] = cp
}

// SetActivePlayback configures the read-only B7 player identity. It is a test
// hook for a job started by an external controller before Sensei connects.
func (m *FakeMachine) SetActivePlayback(path string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.activePlaybackPath = path
	m.activePlaybackMD5 = ""
	if content, ok := m.files[path]; ok {
		m.activePlaybackMD5 = md5hex(content)
	}
}

// HasDir reports whether a directory was created.
func (m *FakeMachine) HasDir(path string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.dirs[path]
}

// Gcodes returns the CTRL_MULTI gcode/MDI lines the machine has received.
func (m *FakeMachine) Gcodes() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.gcodes...)
}

// Controls returns the realtime control characters (!, ~, 0x18) received.
func (m *FakeMachine) Controls() []byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]byte(nil), m.controls...)
}

// UploadPacketSizes returns packet sizes advertised by upload senders in
// FILE_VIEW frames.
func (m *FakeMachine) UploadPacketSizes() []int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]int(nil), m.uploadPacketSizes...)
}

// SetGcodeReply makes the machine answer an exact gcode line with the given
// reply (without trailing CRLF), e.g. "ok C: X:1.0" for an M114. Lines with no
// configured reply get a bare "ok".
func (m *FakeMachine) SetGcodeReply(line, reply string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.gcodeReplies[line] = reply
}

// RejectGcode makes an exact gcode line return an immediate diagnostic without
// executing it. Passing an empty reply clears the hook. It models transient
// firmware/planner refusal for interactive retry tests.
func (m *FakeMachine) RejectGcode(line, reply string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if reply == "" {
		delete(m.rejectedGcodes, line)
		return
	}
	m.rejectedGcodes[line] = reply
}

// SetUnlockDoesNotClear makes $X leave the current status unchanged while still
// replying like firmware. Tests use this to exercise M999 recovery fallback.
func (m *FakeMachine) SetUnlockDoesNotClear(v bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.unlockDoesNotClear = v
}

// SetM999DoesNotClear makes M999 leave the current status unchanged while still
// replying like firmware. Tests use this to exercise verified recovery failure.
func (m *FakeMachine) SetM999DoesNotClear(v bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.m999DoesNotClear = v
}

func (m *FakeMachine) serve() {
	for {
		c, err := m.ln.Accept()
		if err != nil {
			return
		}
		go m.handle(c)
	}
}

func (m *FakeMachine) send(c net.Conn, cmd byte, payload string) {
	c.Write(protocol.Encode(cmd, []byte(payload)))
}

func (m *FakeMachine) handle(c net.Conn) {
	var scan protocol.Scanner
	buf := make([]byte, 16*1024)

	const (
		modeIdle     = iota
		modeUpload   // controller -> machine (machine receives)
		modeDownload // machine -> controller (machine sends)
	)
	var (
		mode      int
		xferPath  string
		totalPkts uint32
		nextSeq   uint32
		received  []byte
		sendData  []byte // contents being sent during a download
	)
	pktSize := 8192
	transferStarted := false
	releaseTransfer := func() {
		if !transferStarted {
			return
		}
		m.mu.Lock()
		m.transferActive = false
		m.mu.Unlock()
		transferStarted = false
	}
	defer func() {
		releaseTransfer()
		c.Close()
	}()

	for {
		c.SetReadDeadline(time.Now().Add(5 * time.Second))
		n, err := c.Read(buf)
		if n > 0 {
			for _, f := range scan.Push(buf[:n]) {
				switch f.Cmd {
				case protocol.CmdPlayStatus:
					m.mu.Lock()
					path, digest := m.activePlaybackPath, m.activePlaybackMD5
					m.mu.Unlock()
					m.send(c, protocol.CmdPlayStatus, protocol.Escape(path)+"|"+digest)
				case protocol.CmdCtrlSingle:
					if len(f.Data) == 1 {
						switch f.Data[0] {
						case '?':
							m.mu.Lock()
							m.statusQueries++
							delay := m.statusReplyDelay
							drop := m.dropStatusReplies
							if !drop && m.dropStatusN > 0 {
								m.dropStatusN--
								drop = true
							}
							s := ""
							if !drop && delay <= 0 {
								s = m.statusAtLocked(time.Now())
							}
							m.mu.Unlock()
							if drop {
								break
							}
							if delay > 0 {
								go func() {
									time.Sleep(delay)
									m.mu.Lock()
									s := m.statusAtLocked(time.Now())
									m.mu.Unlock()
									m.send(c, protocol.CmdStatusRes, s)
								}()
								break
							}
							m.send(c, protocol.CmdStatusRes, s)
						case '!', '~', 0x18:
							// Realtime control: record it so tests can assert it
							// arrived. The firmware acts out-of-band; feed hold and
							// resume send no reply, while halt emits an immediate
							// alarm/info line on the WiFi path.
							m.mu.Lock()
							m.controls = append(m.controls, f.Data[0])
							reply := m.applyControlLocked(f.Data[0], time.Now())
							m.mu.Unlock()
							if reply != "" {
								m.send(c, protocol.CmdNormalInfo, reply)
							}
						}
					}
				case protocol.CmdCtrlMulti:
					m.handleManaged(c, string(f.Data))
				case protocol.CmdFileStart:
					line := strings.TrimSpace(string(f.Data))
					verb, arg := "", ""
					if fields := strings.SplitN(line, " ", 2); len(fields) == 2 {
						verb = fields[0]
						arg = protocol.Unescape(strings.TrimSpace(fields[1]))
					}
					xferPath = arg
					received = nil
					nextSeq = 0
					if verb == "download" {
						m.mu.Lock()
						if !m.beginDownloadTransferLocked(xferPath, time.Now()) {
							m.mu.Unlock()
							m.send(c, protocol.CmdFileCancel, "ok\r\n")
							m.send(c, protocol.CmdNormalInfo, "error: Machine is busy.\r\n")
							break
						}
						plain := append([]byte(nil), m.files[xferPath]...)
						_, exists := m.files[xferPath]
						compress := m.compressDownloads
						pktSize = m.downloadPacketSize
						m.mu.Unlock()
						if !exists {
							m.send(c, protocol.CmdFileCancel, "not found")
							m.mu.Lock()
							m.transferActive = false
							m.mu.Unlock()
							mode = modeIdle
							break
						}
						transferStarted = true
						mode = modeDownload
						// The reported MD5 is always of the uncompressed content.
						uncompressedMD5 := md5hex(plain)
						sendData = plain
						if compress {
							// Send a .lz container instead, as the firmware does
							// when a sidecar exists.
							sendData = compressLZ(plain)
						}
						m.send(c, protocol.CmdFileMD5, uncompressedMD5)
						totalPkts = uint32((len(sendData) + pktSize - 1) / pktSize)
						if totalPkts == 0 {
							totalPkts = 1
						}
					} else {
						m.mu.Lock()
						if !m.beginTransferLocked(time.Now()) {
							m.mu.Unlock()
							m.send(c, protocol.CmdFileCancel, "ok\r\n")
							m.send(c, protocol.CmdNormalInfo, "error: Machine is busy.\r\n")
							break
						}
						m.mu.Unlock()
						transferStarted = true
						mode = modeUpload
					}
				case protocol.CmdFileMD5:
					if mode == modeUpload {
						m.send(c, protocol.CmdFileView, "")
					}
				case protocol.CmdFileView:
					switch mode {
					case modeUpload:
						if len(f.Data) >= 6 {
							totalPkts = uint32(f.Data[0])<<24 | uint32(f.Data[1])<<16 | uint32(f.Data[2])<<8 | uint32(f.Data[3])
							ps := int(f.Data[4])<<8 | int(f.Data[5])
							m.mu.Lock()
							m.uploadPacketSizes = append(m.uploadPacketSizes, ps)
							m.mu.Unlock()
							nextSeq = 1
							m.requestSeq(c, nextSeq)
						}
					case modeDownload:
						// Controller requested the view; reply with totals.
						view := []byte{
							byte(totalPkts >> 24), byte(totalPkts >> 16), byte(totalPkts >> 8), byte(totalPkts),
							byte(pktSize >> 8), byte(pktSize & 0xFF),
						}
						m.send2(c, protocol.CmdFileView, view)
					}
				case protocol.CmdFileData:
					if mode == modeUpload && len(f.Data) >= 4 {
						seq := uint32(f.Data[0])<<24 | uint32(f.Data[1])<<16 | uint32(f.Data[2])<<8 | uint32(f.Data[3])
						if seq == nextSeq {
							received = append(received, f.Data[4:]...)
							if seq < totalPkts {
								nextSeq++
								m.requestSeq(c, nextSeq)
							} else {
								// Mirror the firmware: a .lz upload is decompressed and
								// stored under the stripped name.
								storePath := xferPath
								content := received
								if strings.HasSuffix(xferPath, ".lz") {
									storePath = strings.TrimSuffix(xferPath, ".lz")
									if dec, derr := decompressLZ(received); derr == nil {
										content = dec
									} else {
										m.send(c, protocol.CmdFileCancel, "decompress failed")
										releaseTransfer()
										mode = modeIdle
										continue
									}
								}
								m.mu.Lock()
								cp := make([]byte, len(content))
								copy(cp, content)
								m.files[storePath] = cp
								m.mu.Unlock()
								m.send(c, protocol.CmdFileEnd, "")
								releaseTransfer()
								mode = modeIdle
							}
						} else {
							m.requestSeq(c, nextSeq)
						}
					} else if mode == modeDownload && len(f.Data) >= 4 {
						// Controller is requesting packet `seq`; send it.
						seq := uint32(f.Data[0])<<24 | uint32(f.Data[1])<<16 | uint32(f.Data[2])<<8 | uint32(f.Data[3])
						m.mu.Lock()
						delay := m.downloadPacketDelay
						m.mu.Unlock()
						if delay > 0 {
							time.Sleep(delay)
						}
						m.sendDownloadPacket(c, sendData, pktSize, seq)
					}
				case protocol.CmdFileEnd:
					if mode == modeDownload {
						m.send(c, protocol.CmdFileEnd, "")
						releaseTransfer()
						mode = modeIdle
					}
				}
			}
		}
		if err != nil {
			return
		}
	}
}

func (m *FakeMachine) requestSeq(c net.Conn, seq uint32) {
	data := []byte{byte(seq >> 24), byte(seq >> 16), byte(seq >> 8), byte(seq)}
	c.Write(protocol.Encode(protocol.CmdFileData, data))
}

// send2 writes a frame with a raw byte payload.
func (m *FakeMachine) send2(c net.Conn, cmd byte, data []byte) {
	c.Write(protocol.Encode(cmd, data))
}

// sendDownloadPacket sends the 1-based packet `seq` of data as a FILE_DATA frame
// (seq prefix + chunk), mirroring the firmware's download sender.
func (m *FakeMachine) sendDownloadPacket(c net.Conn, data []byte, pktSize int, seq uint32) {
	off := int(seq-1) * pktSize
	if off < 0 || off > len(data) {
		return
	}
	end := off + pktSize
	if end > len(data) {
		end = len(data)
	}
	chunk := data[off:end]
	payload := make([]byte, 4+len(chunk))
	payload[0] = byte(seq >> 24)
	payload[1] = byte(seq >> 16)
	payload[2] = byte(seq >> 8)
	payload[3] = byte(seq)
	copy(payload[4:], chunk)
	c.Write(protocol.Encode(protocol.CmdFileData, payload))
}

func (m *FakeMachine) beginTransferLocked(now time.Time) bool {
	if m.transferActive {
		return false
	}
	if !m.fileOpsIdleLocked(now) {
		return false
	}
	m.transferActive = true
	return true
}

func (m *FakeMachine) beginDownloadTransferLocked(path string, now time.Time) bool {
	if m.transferActive {
		return false
	}
	if !m.fileOpsIdleLocked(now) && path != m.activePlaybackPath {
		return false
	}
	m.transferActive = true
	return true
}

func (m *FakeMachine) fileOpsIdleLocked(now time.Time) bool {
	status := m.statusAtLocked(now)
	_, state, _, ok := parseFakeStatus(status)
	return ok && state == "Idle"
}

func (m *FakeMachine) withIdleFileOp() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.fileOpsIdleLocked(time.Now())
}

func (m *FakeMachine) renamePathLocked(from, to string) {
	if b, ok := m.files[from]; ok {
		cp := append([]byte(nil), b...)
		delete(m.files, from)
		m.files[to] = cp
	}
	if m.dirs[from] {
		delete(m.dirs, from)
		m.dirs[to] = true
	}
	fromPrefix := strings.TrimRight(from, "/") + "/"
	toPrefix := strings.TrimRight(to, "/") + "/"
	for p, b := range m.files {
		if strings.HasPrefix(p, fromPrefix) {
			np := toPrefix + strings.TrimPrefix(p, fromPrefix)
			cp := append([]byte(nil), b...)
			delete(m.files, p)
			m.files[np] = cp
		}
	}
	for p := range m.dirs {
		if strings.HasPrefix(p, fromPrefix) {
			np := toPrefix + strings.TrimPrefix(p, fromPrefix)
			delete(m.dirs, p)
			m.dirs[np] = true
		}
	}
}

func (m *FakeMachine) applyControlLocked(ctrl byte, now time.Time) string {
	switch ctrl {
	case protocol.CtrlFeedHold:
		if m.holdActive {
			return ""
		}
		m.advanceMotionLocked(now)
		m.advanceProgramLocked(now)
		_, state, _, ok := parseFakeStatus(m.status)
		if ok {
			m.holdResumeState = state
		}
		m.holdActive = true
		m.holdStarted = now
		m.setStatusStateLocked("Hold")
	case protocol.CtrlResume:
		if !m.holdActive {
			return ""
		}
		heldFor := now.Sub(m.holdStarted)
		for i := range m.motion {
			if m.motion[i].end.After(m.holdStarted) {
				m.motion[i].start = m.motion[i].start.Add(heldFor)
				m.motion[i].end = m.motion[i].end.Add(heldFor)
			}
		}
		for i := range m.stockSegments {
			if m.stockSegments[i].end.After(m.holdStarted) {
				m.stockSegments[i].start = m.stockSegments[i].start.Add(heldFor)
				m.stockSegments[i].end = m.stockSegments[i].end.Add(heldFor)
			}
		}
		if m.program != nil && m.program.end.After(m.holdStarted) {
			m.program.start = m.program.start.Add(heldFor)
			m.program.end = m.program.end.Add(heldFor)
		}
		m.holdActive = false
		m.holdStarted = time.Time{}
		state := m.holdResumeState
		if len(m.motion) > 0 || m.program != nil {
			state = "Run"
		}
		if state == "" || state == "Hold" {
			state = "Idle"
		}
		m.holdResumeState = ""
		m.setStatusStateLocked(state)
	case protocol.CtrlHalt:
		m.advanceMotionLocked(now)
		m.motion = nil
		m.stockSegments = nil
		m.program = nil
		m.cycleStarted = false
		m.cycleSticky = fakeCycleSticky{}
		m.motionMode = fakeMotionRapid
		m.motionCode = 0
		m.holdActive = false
		m.holdStarted = time.Time{}
		m.holdResumeState = ""
		m.suspendActive = false
		m.suspendStarted = time.Time{}
		m.setStatusStateLocked("Alarm")
		m.upsertStatusFieldLocked("H", "1")
		return "ALARM: Abort during cycle\r\n"
	}
	return ""
}

func (m *FakeMachine) clearAlarmLocked() {
	m.motion = nil
	m.stockSegments = nil
	m.program = nil
	m.cycleStarted = false
	m.cycleSticky = fakeCycleSticky{}
	m.motionMode = fakeMotionRapid
	m.motionCode = 0
	m.holdActive = false
	m.holdStarted = time.Time{}
	m.holdResumeState = ""
	m.suspendActive = false
	m.suspendStarted = time.Time{}
	m.setStatusStateLocked("Idle")
	m.removeStatusFieldLocked("H")
}

func (m *FakeMachine) homeLocked(now time.Time) {
	m.advanceMotionLocked(now)
	m.motion = nil
	m.stockSegments = nil
	m.program = nil
	m.cycleStarted = false
	m.cycleSticky = fakeCycleSticky{}
	m.motionMode = fakeMotionRapid
	m.motionCode = 0
	m.suspendActive = false
	m.suspendStarted = time.Time{}
	bracketed, _, fields, ok := parseFakeStatus(m.status)
	if !ok {
		m.status = "<Idle|MPos:0.0000,0.0000,0.0000|WPos:0.0000,0.0000,0.0000|C:2,4,0,1|T:0,0.000>"
		return
	}
	zero := []float64{0, 0, 0}
	applyFakeAxesToFields(&fields, zero, zero)
	m.status = formatFakeStatus(bracketed, "Idle", fields)
}

func (m *FakeMachine) startProgramLocked(path string, content []byte, now time.Time) {
	m.advanceMotionLocked(now)
	m.suspendActive = false
	m.suspendStarted = time.Time{}
	m.program = nil
	startMotionCount := len(m.motion)
	lines := fakeExecutableProgramLines(string(content))
	for _, line := range lines {
		m.applySimulatedGcodeLocked(line)
	}
	end := now.Add(m.scaleDurationLocked(time.Duration(len(lines)) * 50 * time.Millisecond))
	if last := m.lastMotionSegmentLocked(); last != nil && last.end.After(end) {
		end = last.end
	}
	if !end.After(now) {
		end = now.Add(m.scaleDurationLocked(50 * time.Millisecond))
	}
	if len(lines) == 0 && len(m.motion) == startMotionCount {
		// Empty programs still briefly look like an active run to status
		// observers, matching the firmware's player state rather than an
		// instantaneous no-op.
		end = now.Add(50 * time.Millisecond)
	}
	m.program = &fakeProgramRun{path: path, start: now, end: end, lines: len(lines)}
	m.activePlaybackPath = path
	m.activePlaybackMD5 = md5hex(content)
	m.upsertStatusFieldLocked("P", "0,0,0")
	m.setStatusStateLocked("Run")
}

func (m *FakeMachine) defaultGcodeReplyLocked(line string, now time.Time) (string, bool) {
	line = strings.TrimSpace(protocol.Unescape(line))
	if line == "" {
		return "", false
	}
	norm := strings.ToLower(stripFakeGcodeComments(line))
	if strings.HasPrefix(norm, "n") && len(norm) > 1 && norm[1] >= '0' && norm[1] <= '9' {
		if i := strings.IndexAny(norm, " \t"); i >= 0 {
			norm = strings.TrimSpace(norm[i+1:])
		}
	}
	tok := norm
	if i := strings.IndexAny(tok, " \t"); i >= 0 {
		tok = tok[:i]
	}
	base := tok
	if i := strings.IndexByte(base, '.'); i >= 0 {
		base = base[:i]
	}

	switch {
	case base == "m114":
		status := m.statusAtLocked(now)
		_, _, fields, ok := parseFakeStatus(status)
		if !ok {
			return "ok C: X:0.0000 Y:0.0000 Z:0.0000", true
		}
		axes := []float64{0, 0, 0}
		if wi := findFakeStatusField(fields, "WPos"); wi >= 0 {
			if vals, ok := parseFakeAxisList(fields[wi].value); ok {
				axes = vals
			}
		} else if mi := findFakeStatusField(fields, "MPos"); mi >= 0 {
			if vals, ok := parseFakeAxisList(fields[mi].value); ok {
				axes = vals
			}
		}
		return "ok C: " + formatFakeM114Axes(axes), true
	case base == "m115":
		return "FIRMWARE_NAME:Smoothieware, FIRMWARE_VERSION:1.0.5, X-CNC:1, X-GRBL_MODE:1\nok", true
	case base == "m119":
		return "X_min:0 Y_min:0 Z_min:0 X_max:0 Y_max:0 Z_max:0\nok", true
	case base == "m105":
		return "ok T:0.0 /0.0 B:0.0 /0.0", true
	case tok == "version":
		return "version = 1.0.5", true
	case tok == "model":
		return m.modelReplyLocked(), true
	case tok == "time":
		return "Build time: 2026-01-01 12:00:00", true
	case tok == "echo":
		return "echo: on", true
	case tok == "mem":
		return "Unused Heap: 0", true
	case tok == "progress":
		if m.program == nil {
			return "Not playing", true
		}
		percent, elapsed := m.programProgressLocked(now)
		return "file: " + m.program.path + ", " + itoa(percent) + " % complete, elapsed time: " + fakeElapsed(elapsed), true
	case tok == "$" || tok == "$$":
		return "$0=10\n$1=25\nok", true
	case tok == "$#":
		return "[G54:0.000,0.000,0.000]\n[G92:0.000,0.000,0.000]\nok", true
	case tok == "$g":
		return "[GC:" + m.modalStateLocked() + "]\nok", true
	case tok == "$i":
		return "[VER:1.0.5:CarveraAir]\n[OPT:V,15,128]\nok", true
	case tok == "$n":
		return "$N0=\n$N1=\nok", true
	case base == "m220":
		return "Feed override: 100%", true
	case base == "m221":
		return "Flow override: 100%", true
	case base == "m211":
		return "Soft endstops: on", true
	case base == "m204":
		return "Acceleration: 1000", true
	case base == "m203":
		return "Maximum feedrates: X3000 Y3000 Z2000", true
	case base == "m206":
		return "Home offset: X0 Y0 Z0", true
	case base == "m301":
		return "PID: P0 I0 D0", true
	case base == "g30" || base == "g38":
		if m.lastProbe == nil {
			return "[PRB:0.0000,0.0000,0.0000:0]", true
		}
		status := "0"
		if m.lastProbe.Hit {
			status = "1"
		}
		return "[PRB:" + formatFakeProbePoint(m.lastProbe.Machine) + ":" + status + "]", true
	}
	return "", false
}

func (m *FakeMachine) modalStateLocked() string {
	motion := "G0"
	switch m.motionCode {
	case 2:
		motion = "G2"
	case 3:
		motion = "G3"
	case 81:
		motion = "G81"
	case 82:
		motion = "G82"
	case 83:
		motion = "G83"
	case 1:
		motion = "G1"
	}
	unit := "G21"
	if fakeNear(m.unit, 25.4) {
		unit = "G20"
	}
	distance := "G91"
	if m.absolute {
		distance = "G90"
	}
	return strings.Join([]string{motion, unit, distance}, " ")
}

func (m *FakeMachine) programProgressLocked(now time.Time) (int, time.Duration) {
	if m.program == nil {
		return 0, 0
	}
	total := m.program.end.Sub(m.program.start)
	elapsed := now.Sub(m.program.start)
	if elapsed < 0 {
		elapsed = 0
	}
	if total <= 0 || elapsed >= total {
		return 100, total
	}
	percent := int((elapsed.Seconds() / total.Seconds()) * 100)
	if percent < 0 {
		percent = 0
	}
	if percent > 99 {
		percent = 99
	}
	return percent, elapsed
}

func (m *FakeMachine) handleManaged(c net.Conn, line string) {
	line = strings.TrimSpace(line)
	m.mu.Lock()
	for prefix := range m.failCmd {
		if strings.HasPrefix(line, prefix) {
			m.mu.Unlock()
			m.send(c, protocol.CmdLoadError, "forced failure\r\n")
			return
		}
	}
	m.mu.Unlock()

	switch {
	case strings.HasPrefix(line, "ls"):
		if !m.withIdleFileOp() {
			m.send(c, protocol.CmdLoadError, "error: Machine is busy.\r\n")
			return
		}
		// Synthesize a listing of the requested directory's DIRECT children,
		// from stored files/dirs. The dir is the last token of "ls -e -s <dir>".
		dir := lsDir(line)
		m.mu.Lock()
		var sb strings.Builder
		for p := range m.dirs {
			if parentOf(p) == dir {
				sb.WriteString(lastSegment(p) + "/ 0 20260101120000\r\n")
			}
		}
		for p, b := range m.files {
			if parentOf(p) == dir {
				sb.WriteString(lastSegment(p) + " " + itoa(len(b)) + " 20260101120000\r\n")
			}
		}
		payload := sb.String()
		m.mu.Unlock()
		if payload != "" {
			m.send(c, protocol.CmdLoadInfo, payload)
		}
		m.send(c, protocol.CmdLoadFinish, "Load directory finished.\r\n")
	case strings.HasPrefix(line, "md5sum"):
		m.mu.Lock()
		dropReply := m.dropMD5Replies
		m.mu.Unlock()
		if dropReply {
			return
		}
		if !m.withIdleFileOp() {
			m.send(c, protocol.CmdNormalInfo, "error: Machine is busy.\n")
			return
		}
		// Mirror the firmware: md5sum does NOT parse flags and replies with a
		// single NORMAL_INFO line, not packetized LOAD_* frames.
		path := md5Target(line)
		m.mu.Lock()
		b, ok := m.files[path]
		m.mu.Unlock()
		if ok {
			m.send(c, protocol.CmdNormalInfo, md5hex(b)+" "+path+"\n")
		} else {
			m.send(c, protocol.CmdNormalInfo, "File not found: "+path+"\n")
		}
	case strings.HasPrefix(line, "ftype"):
		m.mu.Lock()
		ft := m.ftype
		m.mu.Unlock()
		if ft == "" {
			ft = "nc" // default: no compression
		}
		m.send(c, protocol.CmdNormalInfo, "ftype = "+ft+"\n")
	case strings.HasPrefix(line, "config-set"):
		args := configSetArgs(line)
		if len(args) < 3 {
			m.send(c, protocol.CmdNormalInfo, "Usage: config-set source setting value # where source is sd, setting is the key and value\r\n")
			return
		}
		source, key, value := args[0], args[1], args[2]
		if source != "sd" {
			m.send(c, protocol.CmdNormalInfo, source+" source does not exist\r\n")
			return
		}
		m.mu.Lock()
		m.gcodes = append(m.gcodes, line)
		m.config[key] = value
		m.mu.Unlock()
		m.send(c, protocol.CmdNormalInfo, source+": "+key+" has been set to "+value+"\r\n")
	case strings.HasPrefix(line, "config-get-all"):
		m.mu.Lock()
		m.gcodes = append(m.gcodes, line)
		reply, ok := m.gcodeReplies[line]
		if !ok {
			reply = m.configGetAllReplyLocked(strings.Contains(line, "-e"))
		}
		m.mu.Unlock()
		m.send(c, protocol.CmdNormalInfo, strings.TrimRight(reply, "\r\n")+"\n")
	case strings.EqualFold(line, "diagnose"):
		// Real firmware emits DIAG_RES for diagnose, not NORMAL_INFO. Keep the
		// fake strict so tests catch callers that only listen for NORMAL_INFO.
		m.mu.Lock()
		m.gcodes = append(m.gcodes, line)
		reply, ok := m.gcodeReplies[line]
		m.mu.Unlock()
		if !ok {
			reply = "{S:0,0|I:0}"
		}
		m.send(c, protocol.CmdDiagRes, strings.TrimRight(reply, "\r\n")+"\n")
	case strings.EqualFold(line, "reset"):
		// Firmware SimpleShell accepts "reset" as a console command and schedules
		// a reboot. Record it so alarm-recovery tests can assert it was sent.
		m.mu.Lock()
		m.gcodes = append(m.gcodes, line)
		m.mu.Unlock()
		m.send(c, protocol.CmdNormalInfo, "Rebooting machine in 3 seconds...\n")
	case strings.EqualFold(line, "suspend"):
		m.mu.Lock()
		m.gcodes = append(m.gcodes, line)
		now := time.Now()
		m.advanceMotionLocked(now)
		m.advanceProgramLocked(now)
		_, state, _, ok := parseFakeStatus(m.status)
		if !ok || state != "Run" {
			m.mu.Unlock()
			m.send(c, protocol.CmdNormalInfo, "error: There is no running file to suspend.\r\n")
			return
		}
		m.suspendActive = true
		m.suspendStarted = now
		m.setStatusStateLocked("Pause")
		m.mu.Unlock()
		m.send(c, protocol.CmdNormalInfo, "Suspended, resume to continue playing\r\n")
	case strings.EqualFold(line, "resume"):
		m.mu.Lock()
		m.gcodes = append(m.gcodes, line)
		if !m.suspendActive {
			m.mu.Unlock()
			m.send(c, protocol.CmdNormalInfo, "error: There is no suspended file to resume.\r\n")
			return
		}
		now := time.Now()
		pausedFor := now.Sub(m.suspendStarted)
		if m.program != nil {
			m.program.start = m.program.start.Add(pausedFor)
			m.program.end = m.program.end.Add(pausedFor)
		}
		m.suspendActive = false
		m.suspendStarted = time.Time{}
		m.setStatusStateLocked("Run")
		m.mu.Unlock()
		m.send(c, protocol.CmdNormalInfo, "Resuming playing\r\n")
	case strings.EqualFold(line, "M999"):
		m.mu.Lock()
		m.gcodes = append(m.gcodes, line)
		if !m.m999DoesNotClear {
			m.clearAlarmLocked()
		}
		m.mu.Unlock()
		m.send(c, protocol.CmdNormalInfo, "WARNING: After HALT you should HOME before resume\nok\n")
	case line == "$X":
		m.mu.Lock()
		m.gcodes = append(m.gcodes, line)
		if !m.unlockDoesNotClear {
			m.clearAlarmLocked()
		}
		m.mu.Unlock()
		m.send(c, protocol.CmdNormalInfo, "[Caution: Unlocked]\nok\n")
	case line == "$H":
		m.mu.Lock()
		m.gcodes = append(m.gcodes, line)
		m.homeLocked(time.Now())
		m.mu.Unlock()
		m.send(c, protocol.CmdNormalInfo, "ok\n")
	case strings.HasPrefix(strings.ToLower(line), "play "):
		m.mu.Lock()
		playLine := protocol.Unescape(line)
		m.gcodes = append(m.gcodes, playLine)
		path := strings.TrimSpace(line[len("play "):])
		path = protocol.Unescape(path)
		if !m.fileOpsIdleLocked(time.Now()) {
			m.mu.Unlock()
			m.send(c, protocol.CmdNormalInfo, "error: Machine is busy.\r\n")
			return
		}
		content, ok := m.files[path]
		if !ok {
			m.mu.Unlock()
			m.send(c, protocol.CmdNormalInfo, "error: failed to open file ["+path+"]!\r\n")
			return
		}
		m.startProgramLocked(path, content, time.Now())
		m.mu.Unlock()
	case strings.HasPrefix(line, "rm"):
		if !m.withIdleFileOp() {
			m.send(c, protocol.CmdLoadError, "error: Machine is busy.\r\n")
			return
		}
		path := secondField(line)
		m.mu.Lock()
		delete(m.files, path)
		delete(m.dirs, path)
		for p := range m.files {
			if strings.HasPrefix(p, strings.TrimRight(path, "/")+"/") {
				delete(m.files, p)
			}
		}
		for p := range m.dirs {
			if strings.HasPrefix(p, strings.TrimRight(path, "/")+"/") {
				delete(m.dirs, p)
			}
		}
		m.mu.Unlock()
		m.send(c, protocol.CmdLoadFinish, "ok\r\n")
	case strings.HasPrefix(line, "mv"):
		if !m.withIdleFileOp() {
			m.send(c, protocol.CmdLoadError, "error: Machine is busy.\r\n")
			return
		}
		args := commandArgs(line)
		if len(args) < 2 {
			m.send(c, protocol.CmdLoadError, "error: missing rename target\r\n")
			return
		}
		from, to := args[0], args[1]
		m.mu.Lock()
		m.renamePathLocked(from, to)
		m.mu.Unlock()
		m.send(c, protocol.CmdLoadFinish, "ok\r\n")
	case strings.HasPrefix(line, "mkdir"):
		if !m.withIdleFileOp() {
			m.send(c, protocol.CmdLoadError, "error: Machine is busy.\r\n")
			return
		}
		path := secondField(line)
		m.mu.Lock()
		m.dirs[path] = true
		m.mu.Unlock()
		m.send(c, protocol.CmdLoadFinish, "ok\r\n")
	case isGcodeLine(line):
		// Motion / MDI / console gcode. The firmware dispatches it and replies
		// with NORMAL_INFO, not LOAD framing. Record it so tests can assert what
		// reached the machine. Reply behavior mirrors hardware (verified on a
		// real Carvera):
		//   - read-only queries (M114, version, …) DO get a reply line, e.g.
		//     "ok C: X:..." for M114 or "version = 1.0.5";
		//   - motion / state-changing gcode (G0/G1, $H, …) gets NO reply at all —
		//     the move just executes. The proxy must NOT wait for an "ok" on
		//     these, so the fake stays silent unless a reply is explicitly set.
		m.mu.Lock()
		m.gcodes = append(m.gcodes, line)
		reply, rejected := m.rejectedGcodes[line]
		if !rejected {
			m.applySimulatedGcodeLocked(line)
		}
		configuredReply, ok := m.gcodeReplies[line]
		if !rejected && ok {
			reply = configuredReply
		}
		ok = rejected || ok
		if !ok {
			reply, ok = m.defaultGcodeReplyLocked(line, time.Now())
		}
		delay := time.Duration(0)
		if isFakeProbeCommand(line) {
			delay = m.probeReplyDelay
		}
		m.mu.Unlock()
		resp, _ := protocol.ClassifyGcode(line)
		if ok {
			if delay > 0 {
				time.Sleep(delay)
			}
			m.send(c, protocol.CmdNormalInfo, reply+"\r\n")
		} else if resp == protocol.ReplyExpected {
			// A reply-expected command with no explicitly-configured reply still
			// gets a bare ok, as the firmware answers these promptly.
			m.send(c, protocol.CmdNormalInfo, "ok\r\n")
		}
		// Otherwise (fire-and-forget: motion/modal/dwell): silent, like hardware.
	default:
		m.send(c, protocol.CmdLoadError, "unknown\r\n")
	}
}

func isFakeProbeCommand(line string) bool {
	norm := strings.ToLower(strings.TrimSpace(protocol.Unescape(line)))
	if strings.HasPrefix(norm, "n") && len(norm) > 1 && norm[1] >= '0' && norm[1] <= '9' {
		if i := strings.IndexAny(norm, " \t"); i >= 0 {
			norm = strings.TrimSpace(norm[i+1:])
		}
	}
	if i := strings.IndexAny(norm, " \t"); i >= 0 {
		norm = norm[:i]
	}
	if i := strings.IndexByte(norm, '.'); i >= 0 {
		norm = norm[:i]
	}
	return norm == "g30" || norm == "g38"
}

// isGcodeLine reports whether a console line is a gcode/MDI command (G/M/T/S
// codes, modal axis/feed words, a grbl '$' command, an N-numbered line, or a
// console-word query the firmware answers with NORMAL_INFO), as opposed to the
// filesystem/management commands handled explicitly above. It mirrors the real
// firmware closely enough that anything the proxy will send as CTRL_MULTI gets a
// NORMAL_INFO reply rather than a LOAD_ERROR (which the client ignores, hanging
// to timeout).
func isGcodeLine(line string) bool {
	if line == "" {
		return false
	}
	switch line[0] {
	case 'G', 'M', 'T', 'S', '$', 'N', 'X', 'Y', 'Z', 'A', 'B', 'C', 'F',
		'g', 'm', 't', 's', 'n', 'x', 'y', 'z', 'a', 'b', 'c', 'f':
		return true
	}
	// Console-word queries (version, model, ftype, time, echo, mem, diagnose).
	if protocol.IsStatusQuery(line) {
		return true
	}
	return false
}

type fakeGcodeWord struct {
	letter byte
	value  float64
}

type fakeStatusField struct {
	key   string
	value string
}

type fakeMotionSegment struct {
	start time.Time
	end   time.Time
	fromM []float64
	toM   []float64
	fromW []float64
	toW   []float64
}

type fakeProgramRun struct {
	path  string
	start time.Time
	end   time.Time
	lines int
}

type fakeCycleSticky struct {
	z float64
	r float64
	f float64
	q float64
	p float64
}

const (
	fakeFirmwareMaxXYMMMin = 3000.0
	fakeFirmwareMaxZMMMin  = 2000.0
)

func defaultFakeMachineConfig() map[string]string {
	return map[string]string{
		"coordinate.anchor1_x":         "-287.51",
		"coordinate.anchor1_y":         "-202.11",
		"coordinate.anchor2_offset_x":  "88.5",
		"coordinate.anchor2_offset_y":  "45.0",
		"coordinate.toolrack_offset_x": "126.0",
		"coordinate.toolrack_offset_y": "196.0",
		"coordinate.toolrack_z":        "-108",
		"coordinate.rotation_offset_x": "41.5",
		"coordinate.rotation_offset_y": "82.5",
		"coordinate.rotation_offset_z": "23.0",
		"coordinate.anchor_width":      "15.0",
		"coordinate.anchor_length":     "100.0",
		"coordinate.worksize_x":        "300.0",
		"coordinate.worksize_y":        "200.0",
		"coordinate.clearance_x":       "-5.0",
		"coordinate.clearance_y":       "-21.0",
		"coordinate.clearance_z":       "-3.0",
		"default_feed_rate":            "1000",
		"default_seek_rate":            "3000.0",
		"alpha_max_rate":               "3000.0",
		"beta_max_rate":                "3000.0",
		"gamma_max_rate":               "2000.0",
		"soft_endstop.enable":          "true",
		"soft_endstop.x_min":           "-302.0",
		"soft_endstop.y_min":           "-212.0",
		"soft_endstop.z_min":           "-121.0",
		"laser_module_offset_x":        "0",
		"laser_module_offset_y":        "0",
		"laser_module_offset_z":        "-7.0",
		"atc.probe.fast_rate_mm_m":     "300",
		"atc.probe.slow_rate_mm_m":     "60",
		"atc.probe.retract_mm":         "2",
		"atc.probe.probe_height_mm":    "0",
	}
}

func (m *FakeMachine) modelReplyLocked() string {
	name := m.modelName
	if name == "" {
		name = fakeMachineModelName(m.machineModel)
	}
	return "model = " + name + ", " + itoa(m.machineModel) + ", " + itoa(m.funcSetting) + ", " + itoa(m.probeAddr)
}

func fakeMachineModelName(id int) string {
	switch id {
	case 1:
		return "C1"
	case 2:
		return "CA1"
	default:
		return "C1"
	}
}

func (m *FakeMachine) configGetAllReplyLocked(sendEOF bool) string {
	keys := make([]string, 0, len(m.config))
	for key := range m.config {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, key := range keys {
		b.WriteString(key)
		b.WriteByte('=')
		b.WriteString(m.config[key])
		b.WriteByte('\n')
	}
	if sendEOF {
		b.WriteByte(0x04)
	}
	return b.String()
}

func configSetArgs(line string) []string {
	fields := strings.Fields(line)
	args := make([]string, 0, len(fields))
	for _, f := range fields[1:] {
		args = append(args, protocol.Unescape(f))
	}
	return args
}

const (
	fakeMotionRapid = iota
	fakeMotionFeed
)

const (
	fakePlaneXY = iota
	fakePlaneXZ
	fakePlaneYZ
)

var fakeAxisLetters = []byte{'X', 'Y', 'Z', 'A', 'B', 'C'}

var fakeAxisIndex = map[byte]int{
	'X': 0,
	'Y': 1,
	'Z': 2,
	'A': 3,
	'B': 4,
	'C': 5,
}

// applySimulatedGcodeLocked updates the fake's status position for the motion
// commands CNC Proxy generates during manual/jog testing. It intentionally does
// not emit replies; fire-and-forget motion stays silent like the firmware.
func (m *FakeMachine) applySimulatedGcodeLocked(line string) {
	line = strings.TrimSpace(protocol.Unescape(line))
	if line == "" {
		return
	}
	if m.applyToolGcodeLocked(line) {
		return
	}
	if strings.HasPrefix(strings.ToUpper(line), "$J") {
		words := parseFakeGcodeWords(line)
		values, has := fakeWordValues(words, 1)
		delta := fakeAxisValues(values, has)
		scale := values['F']
		if !has['F'] || scale <= 0 {
			scale = 1
		}
		m.applyRelativeMoveLocked(delta, scale*fakeSelectedMachineMax(delta))
		return
	}

	words := parseFakeGcodeWords(stripFakeGcodeComments(line))
	if len(words) == 0 {
		return
	}
	if m.applyFeedOverrideLocked(words) {
		return
	}
	hasG10 := false
	hasG92 := false
	hasG53 := false
	hasDwell := false
	hasProbe := false
	arcClockwise := false
	hasArc := false
	cycleCode := 0
	cancelCycle := false
	lineMotionMode := -1
	var lineAbsolute *bool
	var lineArcAbsolute *bool
	unit := m.unit
	if unit == 0 {
		unit = 1
	}
	for _, w := range words {
		if w.letter != 'G' {
			continue
		}
		code, subcode := splitFakeGCode(w.value)
		switch code {
		case 0:
			if subcode == 0 {
				lineMotionMode = fakeMotionRapid
			}
		case 1:
			if subcode == 0 {
				lineMotionMode = fakeMotionFeed
			}
		case 2:
			if subcode == 0 {
				lineMotionMode = fakeMotionFeed
				arcClockwise = true
				hasArc = true
			}
		case 3:
			if subcode == 0 {
				lineMotionMode = fakeMotionFeed
				arcClockwise = false
				hasArc = true
			}
		case 4:
			hasDwell = true
		case 10:
			hasG10 = true
		case 17:
			m.plane = fakePlaneXY
		case 18:
			m.plane = fakePlaneXZ
		case 19:
			m.plane = fakePlaneYZ
		case 20:
			unit = 25.4
		case 21:
			unit = 1
		case 30, 38:
			hasProbe = true
			lineMotionMode = fakeMotionFeed
		case 53:
			hasG53 = true
		case 80:
			cancelCycle = true
			lineMotionMode = -1
		case 81, 82, 83:
			cycleCode = code
			lineMotionMode = fakeMotionFeed
		case 90:
			if subcode == 1 {
				v := true
				lineArcAbsolute = &v
			} else if subcode == 0 {
				v := true
				lineAbsolute = &v
			}
		case 91:
			if subcode == 1 {
				v := false
				lineArcAbsolute = &v
			} else if subcode == 0 {
				v := false
				lineAbsolute = &v
			}
		case 92:
			if subcode == 0 {
				hasG92 = true
			}
		case 98:
			m.cycleRetractInit = true
			if !m.cycleStarted {
				m.cycleInitialZ = m.currentMPosZLocked()
			}
			m.cycleStarted = true
		case 99:
			m.cycleRetractInit = false
			if !m.cycleStarted {
				m.cycleInitialZ = m.currentMPosZLocked()
			}
			m.cycleStarted = true
		}
	}

	values, has := fakeWordValues(words, unit)
	m.unit = unit
	if lineAbsolute != nil {
		m.absolute = *lineAbsolute
	}
	if lineArcAbsolute != nil {
		m.arcAbsolute = *lineArcAbsolute
	}
	if lineMotionMode >= 0 {
		m.motionMode = lineMotionMode
	}
	if hasArc {
		if arcClockwise {
			m.motionCode = 2
		} else {
			m.motionCode = 3
		}
	} else if cycleCode != 0 {
		m.motionCode = cycleCode
		m.motionMode = fakeMotionFeed
	} else if lineMotionMode == fakeMotionRapid {
		m.motionCode = 0
	} else if lineMotionMode == fakeMotionFeed {
		m.motionCode = 1
	}
	if has['F'] && values['F'] > 0 {
		m.feedMMMin = values['F']
	}

	if hasDwell {
		m.appendDwellLocked(m.scaleDurationLocked(fakeDwellDuration(words)))
		return
	}
	if cancelCycle {
		m.cancelCycleLocked()
		return
	}
	if hasG10 && fakeNear(values['L'], 20) && fakeNear(values['P'], 0) {
		m.advanceMotionLocked(time.Now())
		if has['Z'] {
			m.setReferenceToolMZLocked()
		}
		m.applyWorkPositionLocked(fakeAxisValues(values, has))
		return
	}
	if hasG10 && fakeNear(values['L'], 2) && fakeNear(values['P'], 0) {
		m.advanceMotionLocked(time.Now())
		m.applyWorkOffsetLocked(fakeAxisValues(values, has))
		return
	}
	if hasG92 {
		m.advanceMotionLocked(time.Now())
		m.applyWorkPositionLocked(fakeAxisValues(values, has))
		return
	}
	if hasProbe {
		m.applyProbeMoveLocked(line, values, has, hasG53)
		return
	}
	axes := fakeAxisValues(values, has)
	hasArcCenter := has['I'] || has['J'] || has['K'] || has['R']
	if !hasArc && (m.motionCode == 2 || m.motionCode == 3) && (len(axes) > 0 || hasArcCenter) {
		hasArc = true
		arcClockwise = m.motionCode == 2
	}
	if cycleCode == 0 && (m.motionCode == 81 || m.motionCode == 82 || m.motionCode == 83) && len(axes) > 0 {
		cycleCode = m.motionCode
	}
	if cycleCode != 0 {
		m.applyCycleLocked(cycleCode, values, has)
		return
	}
	if len(axes) == 0 && !(hasArc && hasArcCenter) {
		return
	}
	feedMMMin := 0.0
	if m.motionMode == fakeMotionFeed || hasProbe {
		feedMMMin = m.feedMMMin
	}
	if hasArc {
		m.applyArcMoveLocked(axes, values, has, hasG53, arcClockwise, feedMMMin)
		return
	}
	if hasG53 || m.absolute {
		m.applyAbsoluteMoveLocked(axes, feedMMMin, hasG53)
		return
	}
	m.applyRelativeMoveLocked(axes, feedMMMin)
}

func (m *FakeMachine) applyFeedOverrideLocked(words []fakeGcodeWord) bool {
	isM220 := false
	percent := 0.0
	hasPercent := false
	for _, word := range words {
		switch word.letter {
		case 'M':
			code, subcode := splitFakeGCode(word.value)
			isM220 = code == 220 && subcode == 0
		case 'S':
			percent = word.value
			hasPercent = true
		}
	}
	if !isM220 || !hasPercent {
		return false
	}
	if percent < 10 {
		percent = 10
	} else if percent > 1000 {
		percent = 1000
	}
	current, target := "0", "0"
	if _, _, fields, ok := parseFakeStatus(m.status); ok {
		if index := findFakeStatusField(fields, "F"); index >= 0 {
			parts := strings.Split(fields[index].value, ",")
			if len(parts) >= 2 {
				current, target = parts[0], parts[1]
			}
		}
	}
	m.upsertStatusFieldLocked("F", fmt.Sprintf("%s,%s,%.0f", current, target, percent))
	return true
}

func (m *FakeMachine) applyToolGcodeLocked(line string) bool {
	words := parseFakeGcodeWords(stripFakeGcodeComments(line))
	if len(words) == 0 {
		return false
	}
	mcode, subcode, hasM := 0, 0, false
	toolID, hasTool := 0, false
	for _, w := range words {
		switch w.letter {
		case 'M':
			mcode, subcode = splitFakeGCode(w.value)
			hasM = true
		case 'T':
			toolID = int(math.Round(w.value))
			hasTool = true
		}
	}
	if !hasM {
		return false
	}
	switch {
	case mcode == 5:
		m.stopSpindleLocked()
		return true
	case mcode == 841 || (mcode == 494 && (subcode == 0 || subcode == 1)):
		m.probeLaserActive = true
		return true
	case mcode == 842 || (mcode == 494 && subcode == 2):
		m.probeLaserActive = false
		return true
	case mcode == 491:
		m.calibrateActiveToolLocked("M491")
		return true
	case mcode == 495 && subcode == 0:
		m.applyAutoZProbeLocked(words)
		return true
	case mcode == 493 && (subcode == 0 || subcode == 1):
		m.setToolOffsetFromProbeLocked()
		return true
	case mcode == 493 && subcode == 2 && hasTool:
		m.setActiveToolPreserveOffsetLocked(toolID)
		if toolID == 9999 {
			m.probeLaserActive = true
		} else if toolID != 8888 {
			m.probeLaserActive = false
		}
		return true
	case mcode == 490 && subcode == 1:
		m.enterToolChangeWaitLocked(toolID, hasTool)
		return true
	case mcode == 490 && subcode == 2:
		m.continueToolChangeLocked()
		return true
	case mcode == 6 && hasTool:
		m.beginToolChangeLocked(toolID)
		return true
	default:
		return false
	}
}

func (m *FakeMachine) stopSpindleLocked() {
	bracketed, state, fields, ok := parseFakeStatus(m.status)
	if !ok {
		return
	}
	if i := findFakeStatusField(fields, "S"); i >= 0 {
		parts := strings.Split(fields[i].value, ",")
		for len(parts) < 3 {
			parts = append(parts, "0")
		}
		parts[0], parts[1] = "0", "0"
		fields[i].value = strings.Join(parts, ",")
	}
	m.status = formatFakeStatus(bracketed, state, fields)
}

func (m *FakeMachine) applyRelativeMoveLocked(delta map[byte]float64, feedMMMin float64) {
	if len(delta) == 0 {
		return
	}
	now := time.Now()
	m.advanceMotionLocked(now)
	bracketed, state, fields, ok := parseFakeStatus(m.status)
	if !ok {
		return
	}
	mi := findFakeStatusField(fields, "MPos")
	if mi < 0 {
		return
	}
	mpos, ok := parseFakeAxisList(fields[mi].value)
	if !ok {
		return
	}
	wi := findFakeStatusField(fields, "WPos")
	wpos, haveWPos := []float64(nil), false
	if wi >= 0 {
		if vals, ok := parseFakeAxisList(fields[wi].value); ok {
			wpos, haveWPos = vals, true
		}
	}
	start := now
	if last := m.lastMotionSegmentLocked(); last != nil && last.end.After(now) {
		start = last.end
		mpos = append([]float64(nil), last.toM...)
		if haveWPos {
			wpos = append([]float64(nil), last.toW...)
		}
	}

	fromM := append([]float64(nil), mpos...)
	fromW := []float64(nil)
	if haveWPos {
		fromW = append([]float64(nil), wpos...)
	}
	for axis, d := range delta {
		idx, ok := fakeAxisIndex[axis]
		if !ok || !fakeFinite(d) {
			continue
		}
		mpos = ensureFakeAxisLen(mpos, idx+1)
		mpos[idx] += d
		if haveWPos {
			wpos = ensureFakeAxisLen(wpos, idx+1)
			wpos[idx] += d
		}
	}
	m.appendMotionLocked(bracketed, state, fields, start, fromM, mpos, fromW, wpos, m.fakeMoveDurationLocked(delta, feedMMMin), feedMMMin)
}

func (m *FakeMachine) applyAbsoluteMoveLocked(targets map[byte]float64, feedMMMin float64, machineCoords bool) {
	if len(targets) == 0 {
		return
	}
	now := time.Now()
	m.advanceMotionLocked(now)
	bracketed, state, fields, ok := parseFakeStatus(m.status)
	if !ok {
		return
	}
	mi := findFakeStatusField(fields, "MPos")
	if mi < 0 {
		return
	}
	mpos, ok := parseFakeAxisList(fields[mi].value)
	if !ok {
		return
	}
	wi := findFakeStatusField(fields, "WPos")
	wpos, haveWPos := []float64(nil), false
	if wi >= 0 {
		if vals, ok := parseFakeAxisList(fields[wi].value); ok {
			wpos, haveWPos = vals, true
		}
	}
	start := now
	if last := m.lastMotionSegmentLocked(); last != nil && last.end.After(now) {
		start = last.end
		mpos = append([]float64(nil), last.toM...)
		if haveWPos {
			wpos = append([]float64(nil), last.toW...)
		}
	}

	fromM := append([]float64(nil), mpos...)
	fromW := []float64(nil)
	if haveWPos {
		fromW = append([]float64(nil), wpos...)
	}
	delta := map[byte]float64{}
	for axis, target := range targets {
		idx, ok := fakeAxisIndex[axis]
		if !ok || !fakeFinite(target) {
			continue
		}
		mpos = ensureFakeAxisLen(mpos, idx+1)
		d := 0.0
		if machineCoords || !haveWPos {
			d = target - mpos[idx]
			mpos[idx] = target
		} else {
			wpos = ensureFakeAxisLen(wpos, idx+1)
			d = target - wpos[idx]
			wpos[idx] = target
			mpos[idx] += d
		}
		delta[axis] = d
		if haveWPos && machineCoords {
			wpos = ensureFakeAxisLen(wpos, idx+1)
			wpos[idx] += d
		}
	}
	m.appendMotionLocked(bracketed, state, fields, start, fromM, mpos, fromW, wpos, m.fakeMoveDurationLocked(delta, feedMMMin), feedMMMin)
}

func (m *FakeMachine) applyArcMoveLocked(targets map[byte]float64, values map[byte]float64, has map[byte]bool, hasG53 bool, clockwise bool, feedMMMin float64) {
	now := time.Now()
	m.advanceMotionLocked(now)
	bracketed, state, fields, ok := parseFakeStatus(m.status)
	if !ok {
		return
	}
	mi := findFakeStatusField(fields, "MPos")
	if mi < 0 {
		return
	}
	mpos, ok := parseFakeAxisList(fields[mi].value)
	if !ok {
		return
	}
	wi := findFakeStatusField(fields, "WPos")
	wpos, haveWPos := []float64(nil), false
	if wi >= 0 {
		if vals, ok := parseFakeAxisList(fields[wi].value); ok {
			wpos, haveWPos = vals, true
		}
	}
	start := now
	if last := m.lastMotionSegmentLocked(); last != nil && last.end.After(now) {
		start = last.end
		mpos = append([]float64(nil), last.toM...)
		if haveWPos {
			wpos = append([]float64(nil), last.toW...)
		}
	}
	fromM := append([]float64(nil), ensureFakeAxisLen(mpos, 3)...)
	fromW := []float64(nil)
	if haveWPos {
		fromW = append([]float64(nil), ensureFakeAxisLen(wpos, 3)...)
	}
	targetM := append([]float64(nil), fromM...)
	targetW := []float64(nil)
	if haveWPos {
		targetW = append([]float64(nil), fromW...)
	}
	for axis, target := range targets {
		idx, ok := fakeAxisIndex[axis]
		if !ok || idx >= 3 || !fakeFinite(target) {
			continue
		}
		targetM = ensureFakeAxisLen(targetM, idx+1)
		if hasG53 {
			d := target - targetM[idx]
			targetM[idx] = target
			if haveWPos {
				targetW = ensureFakeAxisLen(targetW, idx+1)
				targetW[idx] += d
			}
		} else if m.absolute {
			if haveWPos {
				targetW = ensureFakeAxisLen(targetW, idx+1)
				d := target - targetW[idx]
				targetW[idx] = target
				targetM[idx] += d
			} else {
				targetM[idx] = target
			}
		} else {
			targetM[idx] += target
			if haveWPos {
				targetW = ensureFakeAxisLen(targetW, idx+1)
				targetW[idx] += target
			}
		}
	}
	segments := m.arcInterpolatedTargetsLocked(fromM, targetM, values, has, clockwise)
	if len(segments) == 0 {
		return
	}
	prevM := fromM
	prevW := fromW
	cursorStart := start
	for i, nextM := range segments {
		nextW := []float64(nil)
		if haveWPos {
			nextW = append([]float64(nil), targetW...)
			if i < len(segments)-1 {
				nextW = interpolateFakeAxes(fromW, targetW, float64(i+1)/float64(len(segments)))
			}
		}
		delta := fakeDeltaForAxes(prevM, nextM)
		dur := m.fakeMoveDurationLocked(delta, feedMMMin)
		m.appendMotionLocked(bracketed, state, fields, cursorStart, prevM, nextM, prevW, nextW, dur, feedMMMin)
		cursorStart = cursorStart.Add(dur)
		prevM = nextM
		prevW = nextW
	}
}

func (m *FakeMachine) arcInterpolatedTargetsLocked(start, target []float64, values map[byte]float64, has map[byte]bool, clockwise bool) [][]float64 {
	u, v, w := m.arcPlaneAxesLocked()
	start = ensureFakeAxisLen(start, 3)
	target = ensureFakeAxisLen(target, 3)
	offset, ok := m.arcOffsetLocked(start, target, values, has, clockwise)
	if !ok {
		return [][]float64{append([]float64(nil), target...)}
	}
	radius := math.Hypot(offset[u], offset[v])
	if radius <= 0.000001 {
		return [][]float64{append([]float64(nil), target...)}
	}
	centerU := start[u] + offset[u]
	centerV := start[v] + offset[v]
	r0U := -offset[u]
	r0V := -offset[v]
	rtU := target[u] - centerU
	rtV := target[v] - centerV
	angularTravel := 0.0
	if fakeNear(start[u], target[u]) && fakeNear(start[v], target[v]) {
		if clockwise {
			angularTravel = -2 * math.Pi
		} else {
			angularTravel = 2 * math.Pi
		}
	} else {
		angularTravel = math.Atan2(r0U*rtV-r0V*rtU, r0U*rtU+r0V*rtV)
		effectiveClockwise := clockwise
		if w == 1 {
			effectiveClockwise = !effectiveClockwise
		}
		if effectiveClockwise {
			if angularTravel > 0 {
				angularTravel -= 2 * math.Pi
			}
		} else if angularTravel < 0 {
			angularTravel += 2 * math.Pi
		}
	}
	travel := math.Hypot(angularTravel*radius, math.Abs(target[w]-start[w]))
	if travel <= 0.000001 {
		return nil
	}
	segments := int(math.Ceil(travel / 0.5))
	if segments < 1 {
		segments = 1
	}
	if segments > 2000 {
		segments = 2000
	}
	startAngle := math.Atan2(start[v]-centerV, start[u]-centerU)
	out := make([][]float64, 0, segments)
	for i := 1; i <= segments; i++ {
		t := float64(i) / float64(segments)
		next := append([]float64(nil), start...)
		angle := startAngle + angularTravel*t
		next[u] = centerU + radius*math.Cos(angle)
		next[v] = centerV + radius*math.Sin(angle)
		next[w] = start[w] + (target[w]-start[w])*t
		if i == segments {
			next = append([]float64(nil), target...)
		}
		out = append(out, next)
	}
	return out
}

func (m *FakeMachine) arcOffsetLocked(start, target []float64, values map[byte]float64, has map[byte]bool, clockwise bool) ([3]float64, bool) {
	var offset [3]float64
	if has['R'] {
		return m.arcOffsetFromRadiusLocked(start, target, values['R'], clockwise)
	}
	seen := false
	for _, word := range []struct {
		letter byte
		axis   int
	}{
		{'I', 0},
		{'J', 1},
		{'K', 2},
	} {
		if !has[word.letter] {
			continue
		}
		seen = true
		if m.arcAbsolute {
			offset[word.axis] = values[word.letter] - start[word.axis]
		} else {
			offset[word.axis] = values[word.letter]
		}
	}
	return offset, seen
}

func (m *FakeMachine) arcOffsetFromRadiusLocked(start, target []float64, radiusWord float64, clockwise bool) ([3]float64, bool) {
	var offset [3]float64
	u, v, _ := m.arcPlaneAxesLocked()
	startU, startV := start[u], start[v]
	targetU, targetV := target[u], target[v]
	du := targetU - startU
	dv := targetV - startV
	chord := math.Hypot(du, dv)
	if chord <= 0.000001 {
		return offset, false
	}
	radius := math.Abs(radiusWord)
	if radius <= 0.000001 {
		return offset, false
	}
	halfChord := chord / 2
	if radius < halfChord {
		radius = halfChord
	}
	oc := math.Sqrt(math.Max(radius*radius-halfChord*halfChord, 0))
	if clockwise {
		oc = -oc
	}
	if radiusWord < 0 {
		oc = -oc
	}
	centerU := 0.5*(startU+targetU) - oc*dv/chord
	centerV := 0.5*(startV+targetV) + oc*du/chord
	offset[u] = centerU - startU
	offset[v] = centerV - startV
	return offset, true
}

func (m *FakeMachine) arcPlaneAxesLocked() (int, int, int) {
	switch m.plane {
	case fakePlaneXZ:
		return 0, 2, 1
	case fakePlaneYZ:
		return 1, 2, 0
	default:
		return 0, 1, 2
	}
}

func fakeDeltaForAxes(from, to []float64) map[byte]float64 {
	out := map[byte]float64{}
	n := len(from)
	if len(to) > n {
		n = len(to)
	}
	for i := 0; i < n && i < len(fakeAxisLetters); i++ {
		f, t := 0.0, 0.0
		if i < len(from) {
			f = from[i]
		}
		if i < len(to) {
			t = to[i]
		}
		if d := t - f; math.Abs(d) > 0.000001 {
			out[fakeAxisLetters[i]] = d
		}
	}
	return out
}

func (m *FakeMachine) applyCycleLocked(code int, values map[byte]float64, has map[byte]bool) {
	if !m.absolute {
		return
	}
	m.ensureCycleStartedLocked()
	m.updateCycleStickyLocked(values, has)
	current := m.currentMPosPointLocked()
	xy := map[byte]float64{
		'X': current.X,
		'Y': current.Y,
	}
	if has['X'] {
		xy['X'] = values['X']
	}
	if has['Y'] {
		xy['Y'] = values['Y']
	}
	m.applyAbsoluteMoveLocked(xy, 0, false)

	if fakeFinite(m.cycleSticky.r) {
		m.applyAbsoluteMoveLocked(map[byte]float64{'Z': m.cycleSticky.r}, 0, false)
	}
	switch code {
	case 83:
		m.applyPeckCycleLocked()
	default:
		m.applyAbsoluteMoveLocked(map[byte]float64{'Z': m.cycleSticky.z}, m.feedMMMin, false)
		if code == 82 && m.cycleSticky.p > 0 {
			m.appendDwellLocked(m.scaleDurationLocked(time.Duration(m.cycleSticky.p * float64(time.Second))))
		}
	}
	retractZ := m.cycleSticky.r
	if m.cycleRetractInit {
		retractZ = m.cycleInitialZ
	}
	m.applyAbsoluteMoveLocked(map[byte]float64{'Z': retractZ}, 0, false)
}

func (m *FakeMachine) ensureCycleStartedLocked() {
	if m.cycleStarted {
		return
	}
	m.cycleStarted = true
	m.cycleRetractInit = true
	m.cycleInitialZ = m.currentMPosZLocked()
	m.cycleSticky = fakeCycleSticky{
		z: m.currentMPosZLocked(),
		r: m.currentMPosZLocked(),
		f: m.feedMMMin,
	}
}

func (m *FakeMachine) updateCycleStickyLocked(values map[byte]float64, has map[byte]bool) {
	if has['Z'] {
		m.cycleSticky.z = values['Z']
	}
	if has['R'] {
		m.cycleSticky.r = values['R']
	}
	if has['F'] && values['F'] > 0 {
		m.cycleSticky.f = values['F']
		m.feedMMMin = values['F']
	}
	if has['Q'] {
		m.cycleSticky.q = values['Q']
	}
	if has['P'] {
		m.cycleSticky.p = values['P']
	}
	if m.cycleSticky.f > 0 {
		m.feedMMMin = m.cycleSticky.f
	}
}

func (m *FakeMachine) applyPeckCycleLocked() {
	q := m.cycleSticky.q
	if q <= 0 || !fakeFinite(q) {
		m.applyAbsoluteMoveLocked(map[byte]float64{'Z': m.cycleSticky.z}, m.feedMMMin, false)
		return
	}
	r := m.cycleSticky.r
	for z := r - q; z > m.cycleSticky.z; z -= q {
		m.applyAbsoluteMoveLocked(map[byte]float64{'Z': z}, m.feedMMMin, false)
		m.applyAbsoluteMoveLocked(map[byte]float64{'Z': r}, 0, false)
	}
	m.applyAbsoluteMoveLocked(map[byte]float64{'Z': m.cycleSticky.z}, m.feedMMMin, false)
}

func (m *FakeMachine) cancelCycleLocked() {
	m.cycleStarted = false
	m.cycleInitialZ = 0
	m.cycleSticky = fakeCycleSticky{}
	m.motionCode = 0
	m.motionMode = fakeMotionRapid
}

func (m *FakeMachine) applyWorkPositionLocked(targets map[byte]float64) {
	if len(targets) == 0 {
		return
	}
	if last := m.lastMotionSegmentLocked(); last != nil && last.end.After(time.Now()) {
		wpos := append([]float64(nil), last.toW...)
		if len(wpos) == 0 {
			wpos = append([]float64(nil), last.toM...)
		}
		for axis, target := range targets {
			idx, ok := fakeAxisIndex[axis]
			if !ok || !fakeFinite(target) {
				continue
			}
			wpos = ensureFakeAxisLen(wpos, idx+1)
			wpos[idx] = target
		}
		last.toW = wpos
		return
	}
	bracketed, state, fields, ok := parseFakeStatus(m.status)
	if !ok {
		return
	}
	wi := findFakeStatusField(fields, "WPos")
	wpos := []float64(nil)
	if wi >= 0 {
		vals, ok := parseFakeAxisList(fields[wi].value)
		if !ok {
			return
		}
		wpos = vals
	} else {
		mi := findFakeStatusField(fields, "MPos")
		if mi < 0 {
			return
		}
		vals, ok := parseFakeAxisList(fields[mi].value)
		if !ok {
			return
		}
		wpos = append([]float64(nil), vals...)
		fields = append(fields, fakeStatusField{key: "WPos"})
		wi = len(fields) - 1
	}

	for axis, target := range targets {
		idx, ok := fakeAxisIndex[axis]
		if !ok || !fakeFinite(target) {
			continue
		}
		wpos = ensureFakeAxisLen(wpos, idx+1)
		wpos[idx] = target
	}
	fields[wi].value = formatFakeAxisList(wpos)
	m.status = formatFakeStatus(bracketed, state, fields)
}

func (m *FakeMachine) applyWorkOffsetLocked(offsets map[byte]float64) {
	if len(offsets) == 0 {
		return
	}
	bracketed, state, fields, ok := parseFakeStatus(m.status)
	if !ok {
		return
	}
	mi := findFakeStatusField(fields, "MPos")
	if mi < 0 {
		return
	}
	mpos, ok := parseFakeAxisList(fields[mi].value)
	if !ok {
		return
	}
	wi := findFakeStatusField(fields, "WPos")
	wpos := append([]float64(nil), mpos...)
	if wi >= 0 {
		if current, ok := parseFakeAxisList(fields[wi].value); ok {
			wpos = current
		}
	} else {
		fields = append(fields, fakeStatusField{key: "WPos"})
		wi = len(fields) - 1
	}
	for axis, offset := range offsets {
		idx, ok := fakeAxisIndex[axis]
		if !ok || !fakeFinite(offset) {
			continue
		}
		mpos = ensureFakeAxisLen(mpos, idx+1)
		wpos = ensureFakeAxisLen(wpos, idx+1)
		wpos[idx] = mpos[idx] - offset
	}
	fields[wi].value = formatFakeAxisList(wpos)
	m.status = formatFakeStatus(bracketed, state, fields)
}

func (m *FakeMachine) statusAtLocked(now time.Time) string {
	if m.holdActive {
		m.setStatusStateLocked("Hold")
		return m.status
	}
	m.advanceMotionLocked(now)
	if m.suspendActive {
		m.setStatusStateLocked("Pause")
		return m.status
	}
	m.advanceProgramLocked(now)
	return m.status
}

func (m *FakeMachine) advanceMotionLocked(now time.Time) {
	m.advanceStockSimulationLocked(now)
	if len(m.motion) == 0 {
		return
	}
	bracketed, state, fields, ok := parseFakeStatus(m.status)
	if !ok {
		m.motion = nil
		return
	}
	for len(m.motion) > 0 && !now.Before(m.motion[0].end) {
		seg := m.motion[0]
		applyFakeAxesToFields(&fields, seg.toM, seg.toW)
		m.motion = m.motion[1:]
	}
	if len(m.motion) == 0 {
		if state == "Run" && m.program == nil {
			state = "Idle"
		}
		m.status = formatFakeStatus(bracketed, state, fields)
		return
	}
	seg := m.motion[0]
	mpos := append([]float64(nil), seg.fromM...)
	wpos := append([]float64(nil), seg.fromW...)
	if !now.Before(seg.start) && seg.end.After(seg.start) {
		t := now.Sub(seg.start).Seconds() / seg.end.Sub(seg.start).Seconds()
		mpos = interpolateFakeAxes(seg.fromM, seg.toM, t)
		if seg.toW != nil {
			wpos = interpolateFakeAxes(seg.fromW, seg.toW, t)
		}
	}
	applyFakeAxesToFields(&fields, mpos, wpos)
	state = "Run"
	m.status = formatFakeStatus(bracketed, state, fields)
}

func (m *FakeMachine) finishMotionLocked() {
	if len(m.motion) == 0 {
		return
	}
	last := m.motion[len(m.motion)-1]
	m.advanceStockSimulationLocked(last.end)
	bracketed, state, fields, ok := parseFakeStatus(m.status)
	if !ok {
		m.motion = nil
		return
	}
	applyFakeAxesToFields(&fields, last.toM, last.toW)
	m.motion = nil
	if state == "Run" && m.program == nil {
		state = "Idle"
	}
	m.status = formatFakeStatus(bracketed, state, fields)
}

func (m *FakeMachine) appendMotionLocked(bracketed bool, state string, fields []fakeStatusField, start time.Time, fromM, toM, fromW, toW []float64, dur time.Duration, feedMMMin float64) {
	if dur <= 0 {
		m.maybeQueueStockCutLocked(start, start, fromM, toM, feedMMMin)
		applyFakeAxesToFields(&fields, toM, toW)
		m.status = formatFakeStatus(bracketed, state, fields)
		return
	}
	end := start.Add(dur)
	m.motion = append(m.motion, fakeMotionSegment{
		start: start,
		end:   end,
		fromM: append([]float64(nil), fromM...),
		toM:   append([]float64(nil), toM...),
		fromW: append([]float64(nil), fromW...),
		toW:   append([]float64(nil), toW...),
	})
	m.maybeQueueStockCutLocked(start, end, fromM, toM, feedMMMin)
	state = "Run"
	m.status = formatFakeStatus(bracketed, state, fields)
}

func (m *FakeMachine) appendDwellLocked(dur time.Duration) {
	if dur <= 0 {
		return
	}
	now := time.Now()
	m.advanceMotionLocked(now)
	bracketed, state, fields, ok := parseFakeStatus(m.status)
	if !ok {
		return
	}
	mi := findFakeStatusField(fields, "MPos")
	if mi < 0 {
		return
	}
	mpos, ok := parseFakeAxisList(fields[mi].value)
	if !ok {
		return
	}
	wpos := []float64(nil)
	if wi := findFakeStatusField(fields, "WPos"); wi >= 0 {
		if vals, ok := parseFakeAxisList(fields[wi].value); ok {
			wpos = vals
		}
	}
	start := now
	if last := m.lastMotionSegmentLocked(); last != nil && last.end.After(now) {
		start = last.end
		mpos = append([]float64(nil), last.toM...)
		if last.toW != nil {
			wpos = append([]float64(nil), last.toW...)
		}
	}
	m.appendMotionLocked(bracketed, state, fields, start, mpos, mpos, wpos, wpos, dur, 0)
}

func (m *FakeMachine) advanceProgramLocked(now time.Time) {
	if m.program == nil {
		return
	}
	bracketed, state, fields, ok := parseFakeStatus(m.status)
	if !ok {
		m.program = nil
		m.activePlaybackPath = ""
		m.activePlaybackMD5 = ""
		return
	}
	if !now.Before(m.program.end) {
		m.removeStatusFieldFrom(&fields, "P")
		m.program = nil
		m.activePlaybackPath = ""
		m.activePlaybackMD5 = ""
		if len(m.motion) == 0 && state == "Run" {
			state = "Idle"
		}
		m.status = formatFakeStatus(bracketed, state, fields)
		return
	}
	percent, elapsed := m.programProgressLocked(now)
	played := 0
	if m.program.lines > 0 {
		played = int(float64(m.program.lines) * float64(percent) / 100)
	}
	m.upsertStatusFieldIn(&fields, "P", itoa(played)+","+itoa(percent)+","+itoa(int(elapsed.Seconds())))
	state = "Run"
	m.status = formatFakeStatus(bracketed, state, fields)
}

func (m *FakeMachine) lastMotionSegmentLocked() *fakeMotionSegment {
	if len(m.motion) == 0 {
		return nil
	}
	return &m.motion[len(m.motion)-1]
}

func applyFakeAxesToFields(fields *[]fakeStatusField, mpos, wpos []float64) {
	if len(mpos) > 0 {
		if mi := findFakeStatusField(*fields, "MPos"); mi >= 0 {
			(*fields)[mi].value = formatFakeAxisList(mpos)
		}
	}
	if len(wpos) > 0 {
		if wi := findFakeStatusField(*fields, "WPos"); wi >= 0 {
			(*fields)[wi].value = formatFakeAxisList(wpos)
		}
	}
}

func parseFakeStatus(raw string) (bool, string, []fakeStatusField, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return false, "", nil, false
	}
	bracketed := strings.HasPrefix(raw, "<") && strings.HasSuffix(raw, ">")
	body := strings.TrimPrefix(raw, "<")
	body = strings.TrimSuffix(body, ">")
	parts := strings.Split(body, "|")
	state := strings.TrimSpace(parts[0])
	if state == "" {
		return false, "", nil, false
	}
	fields := make([]fakeStatusField, 0, len(parts)-1)
	for _, part := range parts[1:] {
		key, value, ok := strings.Cut(strings.TrimSpace(part), ":")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		fields = append(fields, fakeStatusField{key: key, value: strings.TrimSpace(value)})
	}
	return bracketed, state, fields, true
}

func formatFakeStatus(bracketed bool, state string, fields []fakeStatusField) string {
	var b strings.Builder
	b.WriteString(state)
	for _, f := range fields {
		b.WriteByte('|')
		b.WriteString(f.key)
		b.WriteByte(':')
		b.WriteString(f.value)
	}
	if !bracketed {
		return b.String()
	}
	return "<" + b.String() + ">"
}

func (m *FakeMachine) setStatusStateLocked(state string) {
	bracketed, _, fields, ok := parseFakeStatus(m.status)
	if !ok {
		return
	}
	m.status = formatFakeStatus(bracketed, state, fields)
}

func (m *FakeMachine) upsertStatusFieldLocked(key, value string) {
	bracketed, state, fields, ok := parseFakeStatus(m.status)
	if !ok {
		return
	}
	m.upsertStatusFieldIn(&fields, key, value)
	m.status = formatFakeStatus(bracketed, state, fields)
}

func (m *FakeMachine) removeStatusFieldLocked(key string) {
	bracketed, state, fields, ok := parseFakeStatus(m.status)
	if !ok {
		return
	}
	m.removeStatusFieldFrom(&fields, key)
	m.status = formatFakeStatus(bracketed, state, fields)
}

func (m *FakeMachine) upsertStatusFieldIn(fields *[]fakeStatusField, key, value string) {
	if idx := findFakeStatusField(*fields, key); idx >= 0 {
		(*fields)[idx].value = value
		return
	}
	*fields = append(*fields, fakeStatusField{key: key, value: value})
}

func (m *FakeMachine) removeStatusFieldFrom(fields *[]fakeStatusField, key string) {
	out := (*fields)[:0]
	for _, f := range *fields {
		if strings.EqualFold(f.key, key) {
			continue
		}
		out = append(out, f)
	}
	*fields = out
}

func findFakeStatusField(fields []fakeStatusField, key string) int {
	for i, f := range fields {
		if strings.EqualFold(f.key, key) {
			return i
		}
	}
	return -1
}

func (m *FakeMachine) currentMPosZLocked() float64 {
	_, _, fields, ok := parseFakeStatus(m.status)
	if !ok {
		return 0
	}
	if mi := findFakeStatusField(fields, "MPos"); mi >= 0 {
		if vals, ok := parseFakeAxisList(fields[mi].value); ok && len(vals) >= 3 {
			return vals[2]
		}
	}
	return 0
}

func (m *FakeMachine) currentToolStatusLocked() (int, float64, bool) {
	_, _, fields, ok := parseFakeStatus(m.status)
	if !ok {
		return 0, 0, false
	}
	idx := findFakeStatusField(fields, "T")
	if idx < 0 {
		return 0, 0, false
	}
	vals, ok := parseFakeAxisList(fields[idx].value)
	if !ok || len(vals) < 2 {
		return 0, 0, false
	}
	return int(vals[0]), vals[1], true
}

func (m *FakeMachine) currentToolTargetStatusLocked() (int, float64, int, bool) {
	_, _, fields, ok := parseFakeStatus(m.status)
	if !ok {
		return 0, 0, 0, false
	}
	idx := findFakeStatusField(fields, "T")
	if idx < 0 {
		return 0, 0, 0, false
	}
	vals, ok := parseFakeAxisList(fields[idx].value)
	if !ok || len(vals) < 3 {
		return 0, 0, 0, false
	}
	return int(vals[0]), vals[1], int(vals[2]), true
}

func (m *FakeMachine) setToolStatusLocked(toolID int, offset float64) {
	if !fakeFinite(offset) {
		offset = 0
	}
	_, oldOffset, ok := m.currentToolStatusLocked()
	m.upsertStatusFieldLocked("T", formatFakeToolStatus(toolID, offset))
	if ok {
		m.applyToolOffsetDeltaLocked(offset - oldOffset)
	}
}

func (m *FakeMachine) setToolTargetStatusLocked(toolID int, offset float64, target int) {
	if !fakeFinite(offset) {
		offset = 0
	}
	m.upsertStatusFieldLocked("T", formatFakeToolTargetStatus(toolID, offset, target))
}

func (m *FakeMachine) applyToolOffsetDeltaLocked(delta float64) {
	if math.Abs(delta) < 0.0005 {
		return
	}
	bracketed, state, fields, ok := parseFakeStatus(m.status)
	if !ok {
		return
	}
	wi := findFakeStatusField(fields, "WPos")
	wpos := []float64(nil)
	if wi >= 0 {
		vals, ok := parseFakeAxisList(fields[wi].value)
		if !ok {
			return
		}
		wpos = vals
	} else {
		mi := findFakeStatusField(fields, "MPos")
		if mi < 0 {
			return
		}
		vals, ok := parseFakeAxisList(fields[mi].value)
		if !ok {
			return
		}
		wpos = append([]float64(nil), vals...)
		fields = append(fields, fakeStatusField{key: "WPos"})
		wi = len(fields) - 1
	}
	wpos = ensureFakeAxisLen(wpos, 3)
	wpos[2] -= delta
	fields[wi].value = formatFakeAxisList(wpos)
	m.status = formatFakeStatus(bracketed, state, fields)
}

func formatFakeToolStatus(toolID int, offset float64) string {
	if math.Abs(offset) < 0.0005 {
		offset = 0
	}
	return strconv.Itoa(toolID) + "," + strconv.FormatFloat(offset, 'f', 3, 64)
}

func formatFakeToolTargetStatus(toolID int, offset float64, target int) string {
	return formatFakeToolStatus(toolID, offset) + "," + strconv.Itoa(target)
}

func parseFakeAxisList(s string) ([]float64, bool) {
	parts := strings.Split(s, ",")
	out := make([]float64, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		v, err := strconv.ParseFloat(part, 64)
		if err != nil || !fakeFinite(v) {
			return nil, false
		}
		out = append(out, v)
	}
	return out, len(out) > 0
}

func formatFakeAxisList(vals []float64) string {
	parts := make([]string, len(vals))
	for i, v := range vals {
		if math.Abs(v) < 0.00005 {
			v = 0
		}
		parts[i] = strconv.FormatFloat(v, 'f', 4, 64)
	}
	return strings.Join(parts, ",")
}

func ensureFakeAxisLen(vals []float64, n int) []float64 {
	if len(vals) >= n {
		return vals
	}
	out := make([]float64, n)
	copy(out, vals)
	return out
}

func interpolateFakeAxes(from, to []float64, t float64) []float64 {
	if t < 0 {
		t = 0
	} else if t > 1 {
		t = 1
	}
	n := len(from)
	if len(to) > n {
		n = len(to)
	}
	out := ensureFakeAxisLen(append([]float64(nil), from...), n)
	for i, target := range to {
		out[i] = out[i] + (target-out[i])*t
	}
	return out
}

func stripFakeGcodeComments(line string) string {
	var b strings.Builder
	inParen := false
	for i := 0; i < len(line); i++ {
		c := line[i]
		if inParen {
			if c == ')' {
				inParen = false
			}
			continue
		}
		switch c {
		case '(':
			inParen = true
		case ';':
			return b.String()
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

func parseFakeGcodeWords(line string) []fakeGcodeWord {
	var out []fakeGcodeWord
	for i := 0; i < len(line); {
		c := line[i]
		if c >= 'a' && c <= 'z' {
			c -= 'a' - 'A'
		}
		if c < 'A' || c > 'Z' {
			i++
			continue
		}
		i++
		for i < len(line) && (line[i] == ' ' || line[i] == '\t') {
			i++
		}
		start := i
		if i < len(line) && (line[i] == '+' || line[i] == '-') {
			i++
		}
		digits := false
		exponent := false
		for i < len(line) {
			ch := line[i]
			if ch >= '0' && ch <= '9' {
				digits = true
				i++
				continue
			}
			if ch == '.' {
				i++
				continue
			}
			if (ch == 'e' || ch == 'E') && digits && !exponent {
				exponent = true
				i++
				if i < len(line) && (line[i] == '+' || line[i] == '-') {
					i++
				}
				continue
			}
			break
		}
		if !digits {
			continue
		}
		v, err := strconv.ParseFloat(line[start:i], 64)
		if err != nil || !fakeFinite(v) {
			continue
		}
		out = append(out, fakeGcodeWord{letter: c, value: v})
	}
	return out
}

func splitFakeGCode(v float64) (int, int) {
	code := int(math.Trunc(v))
	subcode := int(math.Round((v - float64(code)) * 10))
	return code, subcode
}

func fakeWordValues(words []fakeGcodeWord, unit float64) (map[byte]float64, map[byte]bool) {
	values := map[byte]float64{}
	has := map[byte]bool{}
	if unit == 0 {
		unit = 1
	}
	for _, w := range words {
		switch w.letter {
		case 'X', 'Y', 'Z', 'A', 'B', 'C':
			values[w.letter] = w.value * unit
			has[w.letter] = true
		case 'F':
			values[w.letter] = w.value * unit
			has[w.letter] = true
		case 'I', 'J', 'K', 'R', 'Q':
			values[w.letter] = w.value * unit
			has[w.letter] = true
		case 'L', 'P':
			values[w.letter] = w.value
			has[w.letter] = true
		}
	}
	return values, has
}

func fakeAxisValues(values map[byte]float64, has map[byte]bool) map[byte]float64 {
	out := map[byte]float64{}
	for _, axis := range fakeAxisLetters {
		if has[axis] && fakeFinite(values[axis]) {
			out[axis] = values[axis]
		}
	}
	return out
}

func fakeFinite(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0)
}

func fakeNear(v, target float64) bool {
	return math.Abs(v-target) < 0.000001
}

func fakeMoveDuration(delta map[byte]float64, feedMMMin float64) time.Duration {
	dist := fakeMoveDistance(delta)
	if dist == 0 {
		return 0
	}
	if feedMMMin <= 0 || !fakeFinite(feedMMMin) {
		feedMMMin = fakeSelectedMachineMax(delta)
	}
	if feedMMMin <= 0 {
		return 0
	}
	return time.Duration((dist / feedMMMin) * float64(time.Minute))
}

func fakeMoveDistance(delta map[byte]float64) float64 {
	sum := 0.0
	for _, d := range delta {
		sum += d * d
	}
	return math.Sqrt(sum)
}

func fakeSelectedMachineMax(delta map[byte]float64) float64 {
	maxRate := 0.0
	for axis, d := range delta {
		if d == 0 {
			continue
		}
		rate := fakeFirmwareMaxXYMMMin
		if axis == 'Z' {
			rate = fakeFirmwareMaxZMMMin
		}
		if maxRate == 0 || rate < maxRate {
			maxRate = rate
		}
	}
	return maxRate
}

func fakeExecutableProgramLines(program string) []string {
	raw := strings.Split(program, "\n")
	lines := make([]string, 0, len(raw))
	for _, line := range raw {
		line = strings.TrimSpace(stripFakeGcodeComments(line))
		if line == "" {
			continue
		}
		lines = append(lines, line)
	}
	return lines
}

func fakeDwellDuration(words []fakeGcodeWord) time.Duration {
	seconds := 0.0
	for _, w := range words {
		switch w.letter {
		case 'S':
			seconds = w.value
		case 'P':
			// Smoothieware's G4 P parameter is seconds; drilling cycles may
			// convert from milliseconds before generating G4.
			seconds = w.value
		}
	}
	if seconds <= 0 || !fakeFinite(seconds) {
		return 0
	}
	return time.Duration(seconds * float64(time.Second))
}

func formatFakeM114Axes(vals []float64) string {
	names := []byte{'X', 'Y', 'Z', 'A', 'B', 'C'}
	parts := make([]string, 0, len(vals))
	for i, v := range vals {
		if i >= len(names) {
			break
		}
		parts = append(parts, string(names[i])+":"+strconv.FormatFloat(v, 'f', 4, 64))
	}
	if len(parts) == 0 {
		return "X:0.0000 Y:0.0000 Z:0.0000"
	}
	return strings.Join(parts, " ")
}

func formatFakeProbePoint(p fakeVec3) string {
	return strings.Join([]string{
		strconv.FormatFloat(p.X, 'f', 4, 64),
		strconv.FormatFloat(p.Y, 'f', 4, 64),
		strconv.FormatFloat(p.Z, 'f', 4, 64),
	}, ",")
}

func fakeElapsed(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	total := int(d.Seconds())
	h := total / 3600
	m := (total % 3600) / 60
	s := total % 60
	return twoDigits(h) + ":" + twoDigits(m) + ":" + twoDigits(s)
}

func twoDigits(n int) string {
	if n < 10 {
		return "0" + itoa(n)
	}
	return itoa(n)
}
