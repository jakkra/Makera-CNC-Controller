// Package camera owns the fixed, operator-configured camera upstreams used by
// the web API.  It deliberately has no request-time URL input: browser clients
// can only use the same-origin routes exposed by internal/api.
package camera

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var ErrNotConfigured = errors.New("camera source is not configured")

const (
	ExternalModeMJPEG    = "mjpeg"
	ExternalModeSnapshot = "snapshot"
)

// Config is process-start configuration. URLs are supplied by the operator,
// never by a browser request.
type Config struct {
	BuiltinWSURL   string
	BuiltinDerived bool
	ExternalURL    string
	// ExternalMode is intentionally explicit because a snapshot needs periodic
	// browser reloads while an MJPEG response must stay open. Empty defaults to
	// MJPEG for backwards-compatible streaming behavior.
	ExternalMode string
	// HTTPClient is primarily useful for tests. Nil selects a client that does
	// not use environment proxies or follow redirects to another endpoint.
	HTTPClient *http.Client
}

// SourceStatus intentionally reports configuration, not liveness. A camera
// connection is made only when its same-origin stream endpoint is opened, so
// calling a configured source "connected" here would be misleading.
type SourceStatus struct {
	Configured bool   `json:"configured"`
	State      string `json:"state"`
	Transport  string `json:"transport,omitempty"`
	Mode       string `json:"mode,omitempty"`
	Derived    bool   `json:"derived,omitempty"`
	StreamURL  string `json:"stream_url,omitempty"`
}

type Status struct {
	Builtin  SourceStatus `json:"builtin"`
	External SourceStatus `json:"external"`
}

// Manager holds validated fixed upstreams.
type Manager struct {
	builtin        *url.URL
	builtinDerived bool
	external       *url.URL
	externalMode   string
	httpClient     *http.Client
}

func New(cfg Config) (*Manager, error) {
	builtin, err := parseSourceURL(cfg.BuiltinWSURL, "builtin WebSocket", map[string]bool{"ws": true, "wss": true})
	if err != nil {
		return nil, err
	}
	external, err := parseSourceURL(cfg.ExternalURL, "external HTTP", map[string]bool{"http": true, "https": true})
	if err != nil {
		return nil, err
	}
	externalMode, err := normalizeExternalMode(cfg.ExternalMode)
	if err != nil {
		return nil, err
	}
	client := cfg.HTTPClient
	if client == nil {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.Proxy = nil
		transport.DialContext = (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext
		transport.TLSHandshakeTimeout = 5 * time.Second
		transport.ResponseHeaderTimeout = 10 * time.Second
		client = &http.Client{
			Transport: transport,
		}
	} else {
		// Do not let a test or future embedding caller accidentally turn this
		// fixed-source proxy into a redirect-following proxy.
		clone := *client
		client = &clone
	}
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &Manager{builtin: builtin, builtinDerived: builtin != nil && cfg.BuiltinDerived, external: external, externalMode: externalMode, httpClient: client}, nil
}

func normalizeExternalMode(raw string) (string, error) {
	mode := strings.ToLower(strings.TrimSpace(raw))
	if mode == "" {
		return ExternalModeMJPEG, nil
	}
	if mode != ExternalModeMJPEG && mode != ExternalModeSnapshot {
		return "", fmt.Errorf("external camera mode must be %q or %q", ExternalModeMJPEG, ExternalModeSnapshot)
	}
	return mode, nil
}

func parseSourceURL(raw, label string, schemes map[string]bool) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	if strings.Contains(raw, "#") {
		return nil, fmt.Errorf("%s URL must not contain a fragment", label)
	}
	u, err := url.ParseRequestURI(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, fmt.Errorf("%s URL must be an absolute URL", label)
	}
	if !schemes[strings.ToLower(u.Scheme)] {
		return nil, fmt.Errorf("%s URL has unsupported scheme %q", label, u.Scheme)
	}
	if u.User != nil || u.Fragment != "" {
		return nil, fmt.Errorf("%s URL must not contain credentials or a fragment", label)
	}
	return u, nil
}

// DeriveBuiltinWSURL maps a fixed TCP -machine host or host:port to the Z1
// built-in camera endpoint. It intentionally does not derive from UDP
// discovery: doing so would change an operator's configured camera source at
// runtime.
func DeriveBuiltinWSURL(machineAddr string) (string, error) {
	raw := strings.TrimSpace(machineAddr)
	if raw == "" {
		return "", errors.New("machine address is empty")
	}
	if strings.Contains(raw, "://") {
		return "", fmt.Errorf("invalid machine host %q", machineAddr)
	}
	host, _, err := net.SplitHostPort(raw)
	if err != nil {
		// -machine also accepts a bare hostname or IP. An unbracketed IPv6
		// literal is valid as a bare host, but paths and URL-like values are not.
		host = strings.Trim(raw, "[]")
	}
	if host == "" || strings.ContainsAny(host, "/?#@") {
		return "", fmt.Errorf("invalid machine host %q", machineAddr)
	}
	u := &url.URL{Scheme: "ws", Host: net.JoinHostPort(host, "82"), Path: "/ws_video"}
	return u.String(), nil
}

func (m *Manager) Status() Status {
	if m == nil {
		return DisabledStatus()
	}
	status := DisabledStatus()
	if m.builtin != nil {
		status.Builtin = SourceStatus{Configured: true, State: "configured", Transport: "websocket-jpeg", Derived: m.builtinDerived, StreamURL: "/api/camera/builtin/ws"}
	}
	if m.external != nil {
		status.External = SourceStatus{Configured: true, State: "configured", Transport: "http-" + m.externalMode, Mode: m.externalMode, StreamURL: "/api/camera/external"}
	}
	return status
}

func DisabledStatus() Status {
	return Status{
		Builtin:  SourceStatus{State: "not_configured"},
		External: SourceStatus{State: "not_configured"},
	}
}

func (m *Manager) BuiltinWSURL() string {
	if m == nil || m.builtin == nil {
		return ""
	}
	return m.builtin.String()
}

// ExternalResponse opens the configured source with no caller-controlled URL,
// headers, credentials, or redirect destination.
func (m *Manager) ExternalResponse(ctx context.Context) (*http.Response, error) {
	if m == nil || m.external == nil {
		return nil, ErrNotConfigured
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.external.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "multipart/x-mixed-replace, image/jpeg, image/png;q=0.9")
	return m.httpClient.Do(req)
}
