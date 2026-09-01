package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/uwin/cnc-proxy/internal/camera"
	"github.com/uwin/cnc-proxy/internal/client"
	"github.com/uwin/cnc-proxy/internal/service"
	"github.com/uwin/cnc-proxy/internal/session"
	"github.com/uwin/cnc-proxy/internal/store"
)

func newCameraTestServer(t *testing.T, manager *camera.Manager) *httptest.Server {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	arb := session.New(session.Config{Dial: func() (*client.Conn, error) { return nil, io.EOF }})
	svc, err := service.New(st, arb)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(NewWithOptions(svc, Options{Camera: manager}).Handler())
	t.Cleanup(srv.Close)
	return srv
}

func TestCameraStatusUsesSameOriginStreamURLs(t *testing.T) {
	manager, err := camera.New(camera.Config{
		BuiltinWSURL: "ws://z1.example:82/ws_video",
		ExternalURL:  "http://camera.example/mjpeg",
		ExternalMode: camera.ExternalModeSnapshot,
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := newCameraTestServer(t, manager)
	resp := get(t, srv.URL+"/api/cameras")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	var status camera.Status
	if err := json.NewDecoder(resp.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	if !status.Builtin.Configured || status.Builtin.StreamURL != "/api/camera/builtin/ws" {
		t.Fatalf("builtin = %+v", status.Builtin)
	}
	if !status.External.Configured || status.External.Mode != camera.ExternalModeSnapshot || status.External.StreamURL != "/api/camera/external" {
		t.Fatalf("external = %+v", status.External)
	}
}

func TestExternalCameraProxiesOnlyConfiguredSource(t *testing.T) {
	var gotPath, gotQuery string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotQuery = r.URL.Path, r.URL.RawQuery
		w.Header().Set("Content-Type", "image/jpeg")
		_, _ = w.Write([]byte("jpeg-data"))
	}))
	defer upstream.Close()
	manager, err := camera.New(camera.Config{ExternalURL: upstream.URL + "/fixed.jpg?token=server-config"})
	if err != nil {
		t.Fatal(err)
	}
	srv := newCameraTestServer(t, manager)
	resp := get(t, srv.URL+"/api/camera/external?url=http://not-used.invalid/stream")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d: %s", resp.StatusCode, body)
	}
	if gotPath != "/fixed.jpg" || gotQuery != "token=server-config" {
		t.Fatalf("upstream request = %s?%s, want configured URL", gotPath, gotQuery)
	}
	if got := resp.Header.Get("Content-Type"); !strings.HasPrefix(got, "image/jpeg") {
		t.Fatalf("content type = %q", got)
	}
	if body, _ := io.ReadAll(resp.Body); !bytes.Equal(body, []byte("jpeg-data")) {
		t.Fatalf("body = %q", body)
	}
}

func TestExternalCameraRejectsUnexpectedContentType(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("not a camera"))
	}))
	defer upstream.Close()
	manager, err := camera.New(camera.Config{ExternalURL: upstream.URL})
	if err != nil {
		t.Fatal(err)
	}
	srv := newCameraTestServer(t, manager)
	resp := get(t, srv.URL+"/api/camera/external")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusBadGateway)
	}
}

func TestExternalCameraDoesNotFollowRedirects(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://not-used.invalid/stream", http.StatusFound)
	}))
	defer upstream.Close()
	manager, err := camera.New(camera.Config{ExternalURL: upstream.URL})
	if err != nil {
		t.Fatal(err)
	}
	srv := newCameraTestServer(t, manager)
	resp := get(t, srv.URL+"/api/camera/external")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusBadGateway)
	}
}

func TestBuiltinCameraBridgeStartsForwardsAndStops(t *testing.T) {
	commands := make(chan string, 2)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
		if err != nil {
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		ctx := r.Context()
		_, start, err := conn.Read(ctx)
		if err != nil {
			return
		}
		commands <- string(start)
		if err := conn.Write(ctx, websocket.MessageBinary, []byte{0xff, 0xd8, 0xff, 0xd9}); err != nil {
			return
		}
		_, stop, err := conn.Read(ctx)
		if err == nil {
			commands <- string(stop)
		}
	}))
	defer upstream.Close()
	upstreamWS := "ws" + strings.TrimPrefix(upstream.URL, "http")
	manager, err := camera.New(camera.Config{BuiltinWSURL: upstreamWS + "/ws_video"})
	if err != nil {
		t.Fatal(err)
	}
	srv := newCameraTestServer(t, manager)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	downstream, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/api/camera/builtin/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	if start := waitCameraCommand(t, commands); start != "start_stream" {
		t.Fatalf("start command = %q", start)
	}
	typ, frame, err := downstream.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if typ != websocket.MessageBinary || !bytes.Equal(frame, []byte{0xff, 0xd8, 0xff, 0xd9}) {
		t.Fatalf("frame typ=%v data=%x", typ, frame)
	}
	if err := downstream.Close(websocket.StatusNormalClosure, "test complete"); err != nil {
		t.Fatal(err)
	}
	if stop := waitCameraCommand(t, commands); stop != "stop_stream" {
		t.Fatalf("stop command = %q", stop)
	}
}

func waitCameraCommand(t *testing.T, commands <-chan string) string {
	t.Helper()
	select {
	case command := <-commands:
		return command
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for camera command")
		return ""
	}
}
