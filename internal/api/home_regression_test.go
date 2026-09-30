package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/uwin/cnc-proxy/internal/jog"
)

// Exercise the operator path: arm movement, Home over HTTP, and arm again.
// All machine traffic stays inside serverWithJog's protocol fake.
func TestHomeReleasesArmedMovementAndCanRepeat(t *testing.T) {
	srv, m, _ := serverWithJog(t, false)
	c := dialWS(t, srv.URL)
	defer c.Close(websocket.StatusNormalClosure, "")
	readWSEvent(t, c, "hello")
	for attempt := 1; attempt <= 2; attempt++ {
		writeWS(t, c, map[string]any{"type": "arm", "seq": attempt})
		readWSEvent(t, c, "ack")
		readWSStateWhere(t, c, func(ev jog.Event) bool { return ev.Armed != nil && *ev.Armed })
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		req, err := http.NewRequestWithContext(ctx, "POST", srv.URL+"/api/control", bytes.NewBufferString(`{"action":"home"}`))
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			cancel()
			t.Errorf("Home attempt %d stayed blocked by armed movement: %v", attempt, err)
			return
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		cancel()
		if resp.StatusCode != http.StatusAccepted {
			t.Fatalf("Home attempt %d: HTTP %d: %s", attempt, resp.StatusCode, body)
		}
		var result map[string]any
		if err := json.Unmarshal(body, &result); err != nil {
			t.Fatal(err)
		}
		readWSStateWhere(t, c, func(ev jog.Event) bool { return ev.Armed != nil && !*ev.Armed })
		got := m.Gcodes()
		if len(got) != attempt || got[attempt-1] != "$H" {
			t.Fatalf("Home commands = %v, want %d $H commands", got, attempt)
		}
	}
}
