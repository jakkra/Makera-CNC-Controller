package webguard

import "testing"

func TestAllowIPLiteralLocalhostOrUsesExactNormalizedHosts(t *testing.T) {
	allow := AllowIPLiteralLocalhostOr(" Z1.Example.TS.NET:443 ")
	for _, host := range []string{"127.0.0.1:8420", "[::1]:8420", "localhost:8420", "z1.example.ts.net", "Z1.EXAMPLE.TS.NET:443"} {
		if !allow(host) {
			t.Errorf("host %q was rejected", host)
		}
	}
	for _, host := range []string{"evil.example", "sub.z1.example.ts.net", "z1.example.ts.net.evil"} {
		if allow(host) {
			t.Errorf("host %q was unexpectedly allowed", host)
		}
	}
}
