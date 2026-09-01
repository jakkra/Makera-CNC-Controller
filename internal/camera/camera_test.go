package camera

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDeriveBuiltinWSURL(t *testing.T) {
	for _, tc := range []struct {
		machine string
		want    string
		wantErr bool
	}{
		{machine: "192.168.1.42", want: "ws://192.168.1.42:82/ws_video"},
		{machine: "z1.local:2222", want: "ws://z1.local:82/ws_video"},
		{machine: "[fd00::42]:2222", want: "ws://[fd00::42]:82/ws_video"},
		{machine: "", wantErr: true},
		{machine: "http://bad.example", wantErr: true},
	} {
		t.Run(tc.machine, func(t *testing.T) {
			got, err := DeriveBuiltinWSURL(tc.machine)
			if (err != nil) != tc.wantErr || got != tc.want {
				t.Fatalf("DeriveBuiltinWSURL(%q) = %q, %v; want %q, err=%v", tc.machine, got, err, tc.want, tc.wantErr)
			}
		})
	}
}

func TestConfiguredStatusDoesNotClaimLiveness(t *testing.T) {
	m, err := New(Config{BuiltinWSURL: "ws://z1.example:82/ws_video", BuiltinDerived: true, ExternalURL: "http://camera.example/mjpeg", ExternalMode: ExternalModeSnapshot})
	if err != nil {
		t.Fatal(err)
	}
	got := m.Status()
	if !got.Builtin.Configured || got.Builtin.State != "configured" || !got.Builtin.Derived || got.Builtin.StreamURL != "/api/camera/builtin/ws" {
		t.Fatalf("builtin status = %+v", got.Builtin)
	}
	if !got.External.Configured || got.External.State != "configured" || got.External.Mode != ExternalModeSnapshot || got.External.StreamURL != "/api/camera/external" {
		t.Fatalf("external status = %+v", got.External)
	}
}

func TestExternalModeDefaultsToMJPEGAndRejectsUnknownValue(t *testing.T) {
	m, err := New(Config{ExternalURL: "http://camera.example/mjpeg"})
	if err != nil {
		t.Fatal(err)
	}
	if got := m.Status().External.Mode; got != ExternalModeMJPEG {
		t.Fatalf("default external mode = %q, want %q", got, ExternalModeMJPEG)
	}
	if _, err := New(Config{ExternalMode: "auto"}); err == nil {
		t.Fatal("New accepted unknown external camera mode")
	}
}

func TestNewRejectsUnsupportedOrCredentialedURLs(t *testing.T) {
	for _, raw := range []string{"ftp://camera.example/video", "ws://user:pass@z1.example/ws", "http://camera.example/#fragment"} {
		if _, err := New(Config{ExternalURL: raw}); err == nil {
			t.Fatalf("New accepted %q", raw)
		}
	}
}

func TestExternalResponseUsesOnlyConfiguredURL(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/fixed.jpg" || r.URL.RawQuery != "token=fixed" {
			t.Fatalf("upstream request = %s", r.URL)
		}
		w.Header().Set("Content-Type", "image/jpeg")
		w.Write([]byte("jpeg"))
	}))
	defer upstream.Close()
	m, err := New(Config{ExternalURL: upstream.URL + "/fixed.jpg?token=fixed"})
	if err != nil {
		t.Fatal(err)
	}
	resp, err := m.ExternalResponse(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if !strings.HasPrefix(resp.Header.Get("Content-Type"), "image/jpeg") {
		t.Fatalf("content type = %q", resp.Header.Get("Content-Type"))
	}
}
