package protocol

import (
	"encoding/hex"
	"errors"
	"strings"
)

const maxPlayStatusPayload = 4096

var ErrInvalidPlayStatus = errors.New("protocol: invalid play status payload")

// PlayStatus is the read-only SD player identity reported by CmdPlayStatus.
// MD5 is optional because older bridges may return only a path.
type PlayStatus struct {
	Path string
	MD5  string
}

// ParsePlayStatus parses the B7 response observed from the Z1 WiFi bridge.
// The path uses the protocol's 0x01 space escaping. A bare "|" means that no
// SD-card player job is active.
func ParsePlayStatus(payload []byte) (PlayStatus, error) {
	if len(payload) > maxPlayStatusPayload {
		return PlayStatus{}, ErrInvalidPlayStatus
	}
	text := strings.Trim(strings.TrimSpace(string(payload)), "\x00")
	pathPart, md5Part, found := strings.Cut(text, "|")
	if !found {
		return PlayStatus{}, ErrInvalidPlayStatus
	}
	path := strings.TrimSpace(Unescape(pathPart))
	md5sum := strings.ToLower(strings.TrimSpace(md5Part))
	if strings.Contains(md5sum, "|") {
		return PlayStatus{}, ErrInvalidPlayStatus
	}
	if md5sum != "" {
		if len(md5sum) != 32 {
			return PlayStatus{}, ErrInvalidPlayStatus
		}
		if _, err := hex.DecodeString(md5sum); err != nil {
			return PlayStatus{}, ErrInvalidPlayStatus
		}
	}
	return PlayStatus{Path: path, MD5: md5sum}, nil
}
