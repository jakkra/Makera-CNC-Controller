// Package networkinfo reads host Wi-Fi metadata without scanning or changing
// connections. It never talks to the CNC or reads network credentials.
package networkinfo

import (
	"context"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type WiFi struct {
	State         string    `json:"state"`
	SSID          string    `json:"ssid,omitempty"`
	Interface     string    `json:"interface,omitempty"`
	SignalPercent *int      `json:"signal_percent,omitempty"`
	SignalDBM     *float64  `json:"signal_dbm,omitempty"`
	ObservedAt    time.Time `json:"observed_at"`
}

type Status struct {
	Controller WiFi `json:"controller"`
	Machine    WiFi `json:"machine"`
}

type Provider struct {
	mu         sync.RWMutex
	current    WiFi
	read       func(context.Context) ([]byte, error)
	readSignal func(context.Context, string) ([]byte, error)
}

func New() *Provider {
	return &Provider{current: WiFi{State: "unavailable"}, readSignal: readDriverSignal, read: func(ctx context.Context) ([]byte, error) {
		cmd := exec.CommandContext(ctx, "nmcli", "-t", "--escape", "yes", "-f", "ACTIVE,SSID,SIGNAL,DEVICE", "device", "wifi", "list", "--rescan", "no")
		cmd.Env = append(os.Environ(), "LC_ALL=C")
		return cmd.Output()
	}}
}

// Run refreshes in the background so API and SSE snapshots only read memory.
func (p *Provider) Run(ctx context.Context) {
	tick := time.NewTicker(30 * time.Second)
	defer tick.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		readCtx, cancel := context.WithTimeout(ctx, time.Second)
		output, err := p.read(readCtx)
		wifi := WiFi{State: "unavailable", ObservedAt: time.Now()}
		if err == nil {
			wifi = parseNMCLI(string(output), wifi.ObservedAt)
			if wifi.State == "connected" && p.readSignal != nil {
				if signalOutput, err := p.readSignal(readCtx, wifi.Interface); err == nil {
					wifi.SignalDBM = parseSignalDBM(string(signalOutput))
				}
			}
		}
		cancel()
		p.mu.Lock()
		p.current = wifi
		p.mu.Unlock()
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

func (p *Provider) Status() Status {
	p.mu.RLock()
	defer p.mu.RUnlock()
	wifi := p.current
	// Never keep a disconnected or stalled provider looking current forever.
	if !wifi.ObservedAt.IsZero() && time.Since(wifi.ObservedAt) > time.Minute {
		wifi = WiFi{State: "unavailable"}
	}
	return Status{Controller: wifi, Machine: WiFi{State: "not_reported"}}
}

func parseNMCLI(output string, now time.Time) WiFi {
	result := WiFi{State: "not_connected", ObservedAt: now}
	for _, line := range strings.Split(output, "\n") {
		fields := escapedFields(strings.TrimSuffix(line, "\r"))
		if len(fields) != 4 || fields[0] != "yes" {
			continue
		}
		if fields[1] == "" {
			continue
		}
		result.State = "connected"
		result.SSID = fields[1]
		result.Interface = fields[3]
		if signal, err := strconv.Atoi(fields[2]); err == nil && signal >= 0 && signal <= 100 {
			result.SignalPercent = &signal
		}
		return result
	}
	return result
}

func escapedFields(line string) []string {
	var fields []string
	var field strings.Builder
	escaped := false
	for _, ch := range line {
		if escaped {
			field.WriteRune(ch)
			escaped = false
			continue
		}
		if ch == '\\' {
			escaped = true
			continue
		}
		if ch == ':' {
			fields = append(fields, field.String())
			field.Reset()
			continue
		}
		field.WriteRune(ch)
	}
	if escaped {
		field.WriteRune('\\')
	}
	return append(fields, field.String())
}

// Only accept a driver measurement explicitly labelled dBm. The normalized
// NetworkManager percentage is deliberately never converted to dBm.
var signalDBMPattern = regexp.MustCompile(`(?m)(?:^\s*signal:|Signal level[=:])\s*(-?\d+(?:\.\d+)?)\s*dBm\b`)

func parseSignalDBM(output string) *float64 {
	match := signalDBMPattern.FindStringSubmatch(output)
	if len(match) != 2 {
		return nil
	}
	value, err := strconv.ParseFloat(match[1], 64)
	if err != nil || value > 0 || value < -150 {
		return nil
	}
	return &value
}

func readDriverSignal(ctx context.Context, iface string) ([]byte, error) {
	// iw reports nl80211 measurements. Older installations may only expose
	// wireless-tools/iwconfig; both are read-only and require no scan.
	var lastErr error
	for _, args := range [][]string{{"iw", "dev", iface, "link"}, {"iwconfig", iface}} {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		cmd := exec.CommandContext(ctx, args[0], args[1:]...)
		cmd.Env = append(os.Environ(), "LC_ALL=C")
		output, err := cmd.Output()
		if err == nil {
			return output, nil
		}
		lastErr = err
	}
	return nil, lastErr
}
