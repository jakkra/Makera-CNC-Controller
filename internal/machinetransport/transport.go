// Package machinetransport opens the proxy's machine-side byte stream.
//
// The Carvera framed protocol is the same over WiFi/TCP and the firmware's
// USB serial console. This package keeps the transport choice below the client,
// relay, and arbiter layers so controller-facing behavior stays unchanged.
package machinetransport

import (
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"
)

const (
	KindTCP = "tcp"
	KindUSB = "usb"

	DefaultTCPPort = 2222
	TCPPacketSize  = 8192
	USBPacketSize  = 128
)

// Conn is the minimal machine-side byte stream used by the protocol client and
// relay mux. A net.Conn satisfies it directly; the USB implementation adapts a
// serial.Port to the same shape.
type Conn interface {
	Read(p []byte) (int, error)
	Write(p []byte) (int, error)
	SetReadDeadline(t time.Time) error
	Close() error
}

// Config describes how to open a machine-side transport.
type Config struct {
	Kind string

	// TCPAddr resolves the machine host:port lazily. It is used only for TCP.
	TCPAddr func() (string, error)

	USBDevice      string
	USBBaud        int
	USBResetOnOpen bool

	DialTimeout time.Duration
}

// Opened is one live machine-side transport plus metadata callers need for
// logging and file-transfer packet sizing.
type Opened struct {
	Conn       Conn
	Label      string
	Kind       string
	PacketSize int
}

func NormalizeKind(kind string) string {
	if strings.TrimSpace(kind) == "" {
		return KindTCP
	}
	return strings.ToLower(strings.TrimSpace(kind))
}

func PacketSizeForKind(kind string) int {
	if NormalizeKind(kind) == KindUSB {
		return USBPacketSize
	}
	return TCPPacketSize
}

func ValidateKind(kind string) error {
	switch NormalizeKind(kind) {
	case KindTCP, KindUSB:
		return nil
	default:
		return fmt.Errorf("machine transport must be %q or %q", KindTCP, KindUSB)
	}
}

// NormalizeTCPAddress accepts either a host or host:port. Carvera's machine
// service uses TCP 2222, so a missing port is made explicit before the address
// is persisted, displayed, or passed to net.Dial.
func NormalizeTCPAddress(raw string) (string, error) {
	addr := strings.TrimSpace(raw)
	if addr == "" {
		return "", nil
	}
	if strings.Contains(addr, "://") {
		return "", fmt.Errorf("machine TCP address must be a host or host:port: %q", raw)
	}

	if host, port, err := net.SplitHostPort(addr); err == nil {
		return normalizeTCPHostPort(host, port)
	}

	// A bracketed IPv6 literal without a port is not accepted by
	// net.SplitHostPort, but it is otherwise unambiguous.
	if strings.HasPrefix(addr, "[") && strings.HasSuffix(addr, "]") {
		host := strings.TrimSuffix(strings.TrimPrefix(addr, "["), "]")
		if !isIPLiteral(host) {
			return "", fmt.Errorf("machine TCP address has an invalid IP literal: %q", raw)
		}
		return net.JoinHostPort(host, strconv.Itoa(DefaultTCPPort)), nil
	}

	// Unbracketed IPv6 literals contain colons but no port. Recognize them
	// before treating any remaining colon as a malformed host:port separator.
	if isIPLiteral(addr) {
		return net.JoinHostPort(addr, strconv.Itoa(DefaultTCPPort)), nil
	}
	if strings.Contains(addr, ":") {
		return "", fmt.Errorf("machine TCP address must be a host or host:port: %q", raw)
	}
	if strings.ContainsAny(addr, " /\\\t\r\n") {
		return "", fmt.Errorf("machine TCP address has an invalid host: %q", raw)
	}
	return net.JoinHostPort(addr, strconv.Itoa(DefaultTCPPort)), nil
}

func normalizeTCPHostPort(host, port string) (string, error) {
	host = strings.TrimSpace(host)
	if host == "" || strings.ContainsAny(host, " /\\\t\r\n") {
		return "", fmt.Errorf("machine TCP address requires a valid host")
	}
	p, err := strconv.Atoi(port)
	if err != nil || p <= 0 || p > 65535 {
		return "", fmt.Errorf("machine TCP port must be between 1 and 65535: %q", port)
	}
	return net.JoinHostPort(host, strconv.Itoa(p)), nil
}

func isIPLiteral(host string) bool {
	// net.ParseIP does not accept an IPv6 zone suffix, while net.Dial does.
	if zone := strings.LastIndex(host, "%"); zone >= 0 {
		host = host[:zone]
	}
	return net.ParseIP(host) != nil
}

// Open connects to the configured machine transport.
func Open(cfg Config) (*Opened, error) {
	switch NormalizeKind(cfg.Kind) {
	case KindTCP:
		return openTCP(cfg)
	case KindUSB:
		return openUSB(cfg)
	default:
		return nil, fmt.Errorf("machine transport must be %q or %q", KindTCP, KindUSB)
	}
}

func openTCP(cfg Config) (*Opened, error) {
	if cfg.TCPAddr == nil {
		return nil, errors.New("machine tcp transport requires an address resolver")
	}
	addr, err := cfg.TCPAddr()
	if err != nil {
		return nil, err
	}
	addr, err = NormalizeTCPAddress(addr)
	if err != nil {
		return nil, err
	}
	if addr == "" {
		return nil, errors.New("machine tcp transport requires a non-empty address")
	}
	timeout := cfg.DialTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	c, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return nil, err
	}
	// File transfers are a strict request/response sequence: the controller
	// requests each packet only after it receives the previous one. Avoid
	// Nagle/delayed-ACK stalls for those small request frames.
	if tcp, ok := c.(*net.TCPConn); ok {
		if err := tcp.SetNoDelay(true); err != nil {
			c.Close()
			return nil, fmt.Errorf("configure machine TCP connection: %w", err)
		}
	}
	return &Opened{
		Conn:       c,
		Label:      addr,
		Kind:       KindTCP,
		PacketSize: TCPPacketSize,
	}, nil
}
