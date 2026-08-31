// Package protocol implements just enough of the Carvera wire protocol to
// observe (not alter) traffic flowing through the transparent proxy.
//
// Frame layout (firmware "new" protocol):
//
//	HEADER(0x8668) | LEN(2,BE) | CMD(1) | DATA(N) | CRC16-CCITT(2,BE) | FOOTER(0x55AA)
//
// LEN counts CMD(1) + DATA(N) + CRC(2). The firmware does not verify the CRC on
// receive, but the controller does verify it on responses, so the proxy must
// never mutate frames it forwards.
package protocol

import "encoding/binary"

const (
	Header = 0x8668
	Footer = 0x55AA
)

// Command type bytes. Names mirror PublicData.h / Controller.py.
const (
	CmdCtrlSingle = 0xA1
	CmdCtrlMulti  = 0xA2
	CmdFileStart  = 0xB0
	CmdFileMD5    = 0xB1
	CmdFileView   = 0xB2
	CmdFileData   = 0xB3
	CmdFileEnd    = 0xB4
	CmdFileCancel = 0xB5
	CmdFileRetry  = 0xB6
	// CmdPlayStatus asks the WiFi controller which SD-card file its player is
	// currently executing. The reply uses the same command byte and carries
	// "<path>|<md5>" (or "|" when no file is active).
	CmdPlayStatus = 0xB7

	CmdStatusRes  = 0x81
	CmdDiagRes    = 0x82
	CmdLoadInfo   = 0x83
	CmdLoadFinish = 0x84
	CmdLoadError  = 0x85
	CmdNormalInfo = 0x90
)

// CmdName returns a human-readable label for a command byte, for logging.
func CmdName(cmd byte) string {
	switch cmd {
	case CmdCtrlSingle:
		return "CTRL_SINGLE"
	case CmdCtrlMulti:
		return "CTRL_MULTI"
	case CmdFileStart:
		return "FILE_START"
	case CmdFileMD5:
		return "FILE_MD5"
	case CmdFileView:
		return "FILE_VIEW"
	case CmdFileData:
		return "FILE_DATA"
	case CmdFileEnd:
		return "FILE_END"
	case CmdFileCancel:
		return "FILE_CANCEL"
	case CmdFileRetry:
		return "FILE_RETRY"
	case CmdPlayStatus:
		return "PLAY_STATUS"
	case CmdStatusRes:
		return "STATUS_RES"
	case CmdDiagRes:
		return "DIAG_RES"
	case CmdLoadInfo:
		return "LOAD_INFO"
	case CmdLoadFinish:
		return "LOAD_FINISH"
	case CmdLoadError:
		return "LOAD_ERROR"
	case CmdNormalInfo:
		return "NORMAL_INFO"
	default:
		return "UNKNOWN"
	}
}

// Frame is one decoded packet. Data and Raw are slices into the source buffer;
// copy them if they must outlive the buffer. Raw is the exact wire bytes of the
// whole frame (header..footer), so callers can forward it verbatim without
// re-encoding (preserving the original CRC).
type Frame struct {
	Cmd  byte
	Data []byte
	Raw  []byte
}

// Encode builds a complete wire frame for a command and payload:
//
//	HEADER | LEN(2) | CMD(1) | DATA | CRC16(2) | FOOTER
//
// LEN counts CMD + DATA + CRC. The CRC covers LEN + CMD + DATA, matching the
// controller and firmware. This is byte-for-byte what the official controller
// would have sent for the same command.
func Encode(cmd byte, data []byte) []byte {
	dataLen := 1 + len(data) + 2 // CMD + DATA + CRC
	out := make([]byte, 0, 4+dataLen+2)
	out = append(out, 0x86, 0x68)
	out = append(out, byte(dataLen>>8), byte(dataLen))
	out = append(out, cmd)
	out = append(out, data...)
	crc := CRC16(out[2:]) // over LEN + CMD + DATA
	out = append(out, byte(crc>>8), byte(crc))
	out = append(out, byte(Footer>>8), byte(Footer&0xFF))
	return out
}

// Scanner extracts whole frames from a stream of bytes that may arrive in
// arbitrary chunks. It resynchronizes on the header marker, so junk or
// mid-frame splits never wedge it. It is purely an observer: callers still
// forward the original bytes untouched.
type Scanner struct {
	buf []byte
}

// Push appends freshly read bytes and returns every complete frame now
// available. Bytes that don't yet form a full frame are retained for next call.
func (s *Scanner) Push(p []byte) []Frame {
	s.buf = append(s.buf, p...)
	var frames []Frame
	for {
		f, consumed, ok := s.parseOne()
		if consumed > 0 {
			s.buf = s.buf[consumed:]
		}
		if ok {
			// Copy out of the reusable buffer so Raw/Data stay valid after the
			// buffer is resliced or grown on later Push calls. Data always begins
			// at offset 5 (header 2 + len 2 + cmd 1) within the frame.
			dataLen := len(f.Data)
			raw := append([]byte(nil), f.Raw...)
			f.Raw = raw
			f.Data = raw[5 : 5+dataLen]
			frames = append(frames, f)
			continue
		}
		// No frame produced. If we discarded bytes (garbage/resync), retry;
		// otherwise we're waiting for more input.
		if consumed == 0 {
			break
		}
	}
	// Cap retained garbage so a peer spewing non-protocol bytes can't grow buf
	// without bound while we hunt for a header.
	if len(s.buf) > 1<<16 {
		s.buf = s.buf[len(s.buf)-2:]
	}
	return frames
}

// parseOne tries to read a single frame from the front of the buffer. It
// returns the number of bytes that can be discarded (whether or not a frame was
// produced) so the caller can advance past consumed input and resync garbage.
func (s *Scanner) parseOne() (Frame, int, bool) {
	b := s.buf
	// Resync: if the buffer doesn't start on a header, discard up to the next
	// candidate header byte. Keep a trailing lone 0x86 in case it's a split.
	if len(b) >= 2 && !(b[0] == 0x86 && b[1] == 0x68) {
		for i := 1; i < len(b); i++ {
			if b[i] == 0x86 {
				return Frame{}, i, false
			}
		}
		return Frame{}, len(b), false // no header byte anywhere: drop all
	}
	if len(b) < 2 {
		if len(b) == 1 && b[0] != 0x86 {
			return Frame{}, 1, false
		}
		return Frame{}, 0, false
	}
	if len(b) < 5 {
		return Frame{}, 0, false // need LEN + CMD
	}
	dataLen := int(binary.BigEndian.Uint16(b[2:4])) // = CMD(1)+DATA(N)+CRC(2)
	total := 4 + dataLen + 2                        // header + body + footer
	if dataLen < 3 || total > 1<<17 {
		return Frame{}, 2, false // implausible length: skip this header, resync
	}
	if len(b) < total {
		return Frame{}, 0, false // wait for the rest
	}
	if binary.BigEndian.Uint16(b[total-2:total]) != Footer {
		return Frame{}, 2, false // bad footer: skip header, resync
	}
	cmd := b[4]
	data := b[5 : 5+dataLen-3]
	return Frame{Cmd: cmd, Data: data, Raw: b[:total]}, total, true
}
