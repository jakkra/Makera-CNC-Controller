// Package webguard implements the browser same-origin guard shared by the
// proxy API server (internal/api) and the tray manager server
// (internal/traymgr), so the two guards cannot drift.
//
// The guard rejects cross-site mutating requests using fetch metadata
// (Sec-Fetch-Site) and Origin/Referer comparison, and can optionally validate
// the request Host so DNS-rebinding (a hostile page pointing its own DNS name
// at a local listener) is rejected.
package webguard

import (
	"net"
	"net/http"
	"net/url"
	"strings"
)

// Options configures Handler.
type Options struct {
	// RequiresSameOrigin reports whether a request must pass the guard.
	// Requests for which it returns false are forwarded unchecked.
	RequiresSameOrigin func(*http.Request) bool
	// AllowHost, when non-nil, validates the request's Host header for
	// guarded requests. Returning false rejects the request (DNS-rebinding
	// defense).
	AllowHost func(host string) bool
	// Reject writes the 403 response. When nil, a plain-text http.Error is
	// used.
	Reject func(w http.ResponseWriter, message string)
}

// Handler wraps next with the same-origin guard described by opts.
func Handler(next http.Handler, opts Options) http.Handler {
	reject := opts.Reject
	if reject == nil {
		reject = func(w http.ResponseWriter, message string) {
			http.Error(w, message, http.StatusForbidden)
		}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if opts.RequiresSameOrigin != nil && !opts.RequiresSameOrigin(r) {
			next.ServeHTTP(w, r)
			return
		}
		if opts.AllowHost != nil && !opts.AllowHost(requestHost(r)) {
			reject(w, "request host rejected")
			return
		}
		if site := strings.ToLower(r.Header.Get("Sec-Fetch-Site")); site == "cross-site" {
			reject(w, "cross-site request rejected")
			return
		}
		if !SameOrigin(r, r.Header.Get("Origin")) {
			reject(w, "cross-origin request rejected")
			return
		}
		if r.Header.Get("Origin") == "" && !SameOrigin(r, r.Header.Get("Referer")) {
			reject(w, "cross-origin request rejected")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// SameOrigin reports whether raw (an Origin or Referer URL, empty allowed)
// matches the request's own scheme and host.
func SameOrigin(r *http.Request, raw string) bool {
	if raw == "" {
		return true
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return false
	}
	return strings.EqualFold(NormalizeHost(u.Host), NormalizeHost(requestHost(r))) &&
		strings.EqualFold(u.Scheme, RequestScheme(r))
}

// AllowIPLiteralOrLocalhost is an AllowHost policy that accepts a Host whose
// host part is an IP literal or "localhost". A DNS name (which a hostile page
// could rebind at a local listener) is rejected; IP literals cannot be
// rebound, and non-loopback IP binds (which require an admin token) keep
// working.
func AllowIPLiteralOrLocalhost(host string) bool {
	h, _, err := net.SplitHostPort(host)
	if err != nil {
		h = host
	}
	h = strings.Trim(h, "[]")
	if strings.EqualFold(h, "localhost") {
		return true
	}
	return net.ParseIP(h) != nil
}

// AllowIPLiteralLocalhostOr returns a host policy that retains the DNS-
// rebinding-safe defaults while admitting an explicit set of reverse-proxy
// host names. The configured names are exact matches after default-port and
// case normalization; suffix and wildcard matching are intentionally absent.
func AllowIPLiteralLocalhostOr(hosts ...string) func(string) bool {
	allowed := make(map[string]struct{}, len(hosts))
	for _, host := range hosts {
		host = strings.TrimSpace(host)
		if host != "" {
			allowed[NormalizeHost(host)] = struct{}{}
		}
	}
	return func(host string) bool {
		if AllowIPLiteralOrLocalhost(host) {
			return true
		}
		_, ok := allowed[NormalizeHost(host)]
		return ok
	}
}

// RequestScheme returns the effective scheme of the request, honoring
// X-Forwarded-Proto.
func RequestScheme(r *http.Request) string {
	if xf := r.Header.Get("X-Forwarded-Proto"); xf != "" {
		if i := strings.IndexByte(xf, ','); i >= 0 {
			xf = xf[:i]
		}
		return strings.ToLower(strings.TrimSpace(xf))
	}
	if r.TLS != nil {
		return "https"
	}
	return "http"
}

// NormalizeHost lowercases a host and strips default ports (80/443) so
// origin comparisons are stable.
func NormalizeHost(host string) string {
	h, p, err := net.SplitHostPort(host)
	if err != nil {
		return strings.ToLower(host)
	}
	if (p == "80" || p == "443") && h != "" {
		return strings.ToLower(h)
	}
	return strings.ToLower(net.JoinHostPort(h, p))
}

func requestHost(r *http.Request) string {
	if r.Host != "" {
		return r.Host
	}
	return r.URL.Host
}
