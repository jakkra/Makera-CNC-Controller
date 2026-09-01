package api

import (
	"bufio"
	"bytes"
	"context"
	"crypto/md5"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/uwin/cnc-proxy/internal/attention"
	"github.com/uwin/cnc-proxy/internal/carveratest"
	"github.com/uwin/cnc-proxy/internal/client"
	"github.com/uwin/cnc-proxy/internal/httpauth"
	"github.com/uwin/cnc-proxy/internal/jog"
	"github.com/uwin/cnc-proxy/internal/machine"
	"github.com/uwin/cnc-proxy/internal/notifications"
	"github.com/uwin/cnc-proxy/internal/service"
	"github.com/uwin/cnc-proxy/internal/session"
	"github.com/uwin/cnc-proxy/internal/store"
)

// do performs a request and fails the test on transport error, returning the
// response for status/body assertions. Keeps the error-checking in one place.
func do(t *testing.T, req *http.Request) *http.Response {
	t.Helper()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", req.Method, req.URL, err)
	}
	return resp
}

func get(t *testing.T, url string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest("GET", url, nil)
	return do(t, req)
}

func md5Hex(content []byte) string {
	sum := md5.Sum(content)
	return hex.EncodeToString(sum[:])
}

type apiNotificationSender struct {
	messages []notifications.Message
}

func (s *apiNotificationSender) Name() string { return "test" }
func (s *apiNotificationSender) Send(_ context.Context, msg notifications.Message) error {
	s.messages = append(s.messages, msg)
	return nil
}

func apiSeedMachineFile(t *testing.T, addr, remote string, content []byte) {
	t.Helper()
	conn, err := client.Dial(addr, 2*time.Second, client.WithUploadStartDelay(0))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.Upload(remote, bytes.NewReader(content), int64(len(content)), md5Hex(content), 2*time.Second, nil); err != nil {
		t.Fatalf("seed machine file %s: %v", remote, err)
	}
}

func newTestServer(t *testing.T) (*httptest.Server, *service.Service) {
	t.Helper()
	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	arb := session.New(session.Config{Dial: func() (*client.Conn, error) { return nil, io.EOF }})
	svc, err := service.New(st, arb)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(New(svc).Handler())
	t.Cleanup(srv.Close)
	return srv, svc
}

func TestPostFileRawBody(t *testing.T) {
	srv, _ := newTestServer(t)
	req, _ := http.NewRequest("POST", srv.URL+"/api/files?path=part.nc", strings.NewReader("G0 X0\n"))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d: %s", resp.StatusCode, b)
	}
	var entry store.Entry
	json.NewDecoder(resp.Body).Decode(&entry)
	if entry.Path != "/sd/gcodes/part.nc" || entry.Sync != store.PendingUpload {
		t.Errorf("entry = %+v", entry)
	}
}

func TestReadOnlyObserverModeRejectsMutationsAndKeepsStatusAvailable(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	arb := session.New(session.Config{Dial: func() (*client.Conn, error) { return nil, io.EOF }})
	svc, err := service.New(st, arb)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(NewWithOptions(svc, Options{ReadOnly: true}).Handler())
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/capabilities")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("capabilities status = %d", resp.StatusCode)
	}
	var caps struct {
		ReadOnly bool `json:"read_only"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&caps); err != nil || !caps.ReadOnly {
		t.Fatalf("capabilities = %+v err=%v, want read_only", caps, err)
	}

	mutating, err := http.Post(srv.URL+"/api/control", "application/json", strings.NewReader(`{"action":"halt"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer mutating.Body.Close()
	if mutating.StatusCode != http.StatusForbidden {
		t.Fatalf("mutation status = %d, want %d", mutating.StatusCode, http.StatusForbidden)
	}

	status, err := http.Get(srv.URL + "/api/machine")
	if err != nil {
		t.Fatal(err)
	}
	defer status.Body.Close()
	if status.StatusCode != http.StatusOK {
		t.Fatalf("machine status = %d, want %d", status.StatusCode, http.StatusOK)
	}
}

func TestPostFileRejectsJunkFilename(t *testing.T) {
	srv, svc := newTestServer(t)
	req, _ := http.NewRequest("POST", srv.URL+"/api/files?path=._part.nc", strings.NewReader("junk"))
	resp := do(t, req)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	if files := svc.Files(); len(files) != 0 {
		t.Fatalf("junk leaked into catalog: %+v", files)
	}
}

func TestInternalUploadFailureReturns500(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	arb := session.New(session.Config{Dial: func() (*client.Conn, error) { return nil, io.EOF }})
	svc, err := service.New(st, arb)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(st.CacheDir()); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(st.CacheDir(), []byte("blocks cache directory recreation"), 0o644); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(New(svc).Handler())
	defer srv.Close()

	req, _ := http.NewRequest("POST", srv.URL+"/api/files?path=part.nc", strings.NewReader("G0 X0\n"))
	resp := do(t, req)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusInternalServerError {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d, want 500: %s", resp.StatusCode, body)
	}
}

func TestInvalidMachineActionsReturn400(t *testing.T) {
	srv, _ := newTestServer(t)
	for _, tc := range []struct {
		path string
		body any
	}{
		{path: "/api/probe/z", body: map[string]any{"probe_depth_mm": 0, "probe_feed_mm_min": 50}},
		{path: "/api/outline/trace", body: map[string]any{"machine_points": []any{}}},
		{path: "/api/tool/current", body: map[string]any{"tool_id": 1000}},
		{path: "/api/tool/change", body: map[string]any{"tool_id": -1}},
	} {
		resp := postJSON(t, srv.URL+tc.path, tc.body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("POST %s status=%d, want 400", tc.path, resp.StatusCode)
		}
	}
}

func TestUISettingsStoreFailureReturns500WithoutLeakingPath(t *testing.T) {
	dir := t.TempDir()
	statePath := filepath.Join(dir, "state.json")
	st, err := store.Open(statePath)
	if err != nil {
		t.Fatal(err)
	}
	arb := session.New(session.Config{Dial: func() (*client.Conn, error) { return nil, io.EOF }})
	svc, err := service.New(st, arb)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(statePath, 0o755); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(New(svc).Handler())
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodPut, srv.URL+"/api/ui/settings", strings.NewReader(`{"log":{"filter":"all"}}`))
	req.Header.Set("Content-Type", "application/json")
	resp := do(t, req)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusInternalServerError {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status=%d, want 500: %s", resp.StatusCode, body)
	}
	body, _ := io.ReadAll(resp.Body)
	if strings.Contains(string(body), statePath) {
		t.Fatalf("internal path leaked in response: %s", body)
	}
}

func TestMutatingAPIRejectsCrossOriginBrowserRequests(t *testing.T) {
	srv, _ := newTestServer(t)
	req, _ := http.NewRequest("POST", srv.URL+"/api/gcode", strings.NewReader(`{"line":"M114"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://evil.example")
	resp := do(t, req)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-origin status = %d, want 403", resp.StatusCode)
	}

	req, _ = http.NewRequest("POST", srv.URL+"/api/gcode", strings.NewReader(`{"line":"M114"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", srv.URL)
	resp = do(t, req)
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusForbidden {
		t.Fatalf("same-origin request was rejected")
	}
}

func TestAPIRejectsForeignHostForReadsAndMutations(t *testing.T) {
	srv, _ := newTestServer(t)

	readReq, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/files", nil)
	readReq.Host = "evil.example:8420"
	readReq.Header.Set("Origin", "http://evil.example:8420")
	readResp := do(t, readReq)
	readResp.Body.Close()
	if readResp.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign-host read status=%d, want 403", readResp.StatusCode)
	}

	writeReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/control", strings.NewReader(`{"action":"halt"}`))
	writeReq.Host = "evil.example:8420"
	writeReq.Header.Set("Origin", "http://evil.example:8420")
	writeReq.Header.Set("Content-Type", "application/json")
	writeResp := do(t, writeReq)
	writeResp.Body.Close()
	if writeResp.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign-host mutation status=%d, want 403", writeResp.StatusCode)
	}

}

func TestBackupExportRejectsCrossOriginBrowserRequests(t *testing.T) {
	srv, _ := newTestServer(t)
	req, _ := http.NewRequest("GET", srv.URL+"/api/backup", nil)
	req.Header.Set("Origin", "http://evil.example")
	resp := do(t, req)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-origin backup status = %d, want 403", resp.StatusCode)
	}
}

func TestPostFileUploadLimit(t *testing.T) {
	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	arb := session.New(session.Config{Dial: func() (*client.Conn, error) { return nil, io.EOF }})
	svc, err := service.New(st, arb)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(NewWithOptions(svc, Options{MaxUploadBytes: 4}).Handler())
	defer srv.Close()

	req, _ := http.NewRequest("POST", srv.URL+"/api/files?path=too-big.nc", strings.NewReader("12345"))
	resp := do(t, req)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("upload status = %d, want 413", resp.StatusCode)
	}
}

func TestAuthenticatedAPIRequests(t *testing.T) {
	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	arb := session.New(session.Config{Dial: func() (*client.Conn, error) { return nil, io.EOF }})
	svc, err := service.New(st, arb)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(httpauth.Middleware(httpauth.Config{User: "operator", Token: "secret"}, New(svc).Handler()))
	defer srv.Close()

	req, _ := http.NewRequest("GET", srv.URL+"/api/files", nil)
	resp := do(t, req)
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want 401", resp.StatusCode)
	}

	req, _ = http.NewRequest("GET", srv.URL+"/api/files", nil)
	req.SetBasicAuth("operator", "secret")
	resp = do(t, req)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("authenticated status = %d, want 200", resp.StatusCode)
	}

	req, _ = http.NewRequest("GET", srv.URL+"/api/events", nil)
	req.SetBasicAuth("operator", "secret")
	resp = do(t, req)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("authenticated SSE status=%d content-type=%q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}

	req, _ = http.NewRequest("GET", srv.URL+"/healthz", nil)
	resp = do(t, req)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || string(body) != "ok\n" {
		t.Fatalf("healthz status=%d body=%q", resp.StatusCode, body)
	}
}

func TestPostFileMultipart(t *testing.T) {
	srv, _ := newTestServer(t)
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "drawing.nc")
	fw.Write([]byte("G1 X5 Y5\n"))
	mw.Close()

	resp, err := http.Post(srv.URL+"/api/files", mw.FormDataContentType(), &buf)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d: %s", resp.StatusCode, b)
	}
	var entry store.Entry
	json.NewDecoder(resp.Body).Decode(&entry)
	if entry.Path != "/sd/gcodes/drawing.nc" {
		t.Errorf("path = %q", entry.Path)
	}
}

func TestPostFileMultipartPreservesExactBytes(t *testing.T) {
	srv, _ := newTestServer(t)
	content := []byte{'G', '0', ' ', 'X', '0', '\r', '\n', 0, 'G', '1', ' ', 'X', '5', '\n'}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "exact.nc")
	if _, err := fw.Write(content); err != nil {
		t.Fatal(err)
	}
	mw.Close()

	resp, err := http.Post(srv.URL+"/api/files", mw.FormDataContentType(), &buf)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d: %s", resp.StatusCode, b)
	}
	var entry store.Entry
	if err := json.NewDecoder(resp.Body).Decode(&entry); err != nil {
		t.Fatal(err)
	}
	if entry.Size != int64(len(content)) {
		t.Fatalf("multipart entry size = %d, want %d", entry.Size, len(content))
	}

	gotResp := get(t, srv.URL+"/api/files/exact.nc")
	defer gotResp.Body.Close()
	got, err := io.ReadAll(gotResp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, content) {
		t.Fatalf("multipart content = %v, want %v", got, content)
	}
}

func TestGetFilesAndContent(t *testing.T) {
	srv, _ := newTestServer(t)
	http.Post(srv.URL+"/api/files?path=a.nc", "application/octet-stream", strings.NewReader("hello"))

	resp := get(t, srv.URL+"/api/files")
	var files []store.Entry
	json.NewDecoder(resp.Body).Decode(&files)
	resp.Body.Close()
	if len(files) != 1 || files[0].Path != "/sd/gcodes/a.nc" {
		t.Fatalf("files = %+v", files)
	}

	// Content endpoint serves from cache.
	resp2 := get(t, srv.URL+"/api/files/a.nc")
	body, _ := io.ReadAll(resp2.Body)
	resp2.Body.Close()
	if string(body) != "hello" {
		t.Errorf("content = %q", body)
	}
}

func TestGetValidationPendingContentReturns503(t *testing.T) {
	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	dialed := false
	arb := session.New(session.Config{Dial: func() (*client.Conn, error) {
		dialed = true
		return nil, io.EOF
	}})
	svc, err := service.New(st, arb)
	if err != nil {
		t.Fatal(err)
	}
	content := []byte("G0 X0\n")
	cachePath := filepath.Join(st.CacheDir(), "validating-cache")
	if err := os.WriteFile(cachePath, content, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := st.PutEntry(store.Entry{
		Path:       "/sd/gcodes/validating.nc",
		Size:       int64(len(content)),
		MD5:        md5Hex(content),
		CachePath:  cachePath,
		CacheState: store.CacheValidating,
		Sync:       store.Synced,
	}); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(New(svc).Handler())
	t.Cleanup(srv.Close)

	resp := get(t, srv.URL+"/api/files/validating.nc")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.StatusCode)
	}
	if dialed {
		t.Fatal("validation-pending API read dialed the machine")
	}
}

func TestAPIGetRemoteOnlyFetchesOnceThenServesCache(t *testing.T) {
	m, err := carveratest.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)

	content := []byte("G0 X10\nM30\n")
	apiSeedMachineFile(t, m.Addr(), "/sd/gcodes/remote.nc", content)

	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	tr := machine.NewTracker()
	tr.Observe(machine.Idle)
	dials := 0
	arb := session.New(session.Config{
		Tracker: tr,
		Dial: func() (*client.Conn, error) {
			dials++
			return client.Dial(m.Addr(), 2*time.Second, client.WithUploadStartDelay(0))
		},
	})
	svc, err := service.New(st, arb)
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.PutRemoteOnly("remote.nc", int64(len(content)), time.Unix(0, 0), ""); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(New(svc).Handler())
	t.Cleanup(srv.Close)

	resp := get(t, srv.URL+"/api/files/remote.nc")
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !bytes.Equal(body, content) {
		t.Fatalf("first GET status=%d body=%q, want cached remote content", resp.StatusCode, string(body))
	}
	if dials != 1 {
		t.Fatalf("machine dials after first GET = %d, want 1", dials)
	}

	resp = get(t, srv.URL+"/api/files/remote.nc")
	body, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !bytes.Equal(body, content) {
		t.Fatalf("second GET status=%d body=%q, want cached content", resp.StatusCode, string(body))
	}
	if dials != 1 {
		t.Fatalf("machine dials after second GET = %d, want still 1", dials)
	}
	entry, _ := svc.Lookup("remote.nc")
	if entry.CacheState != store.CacheReady || entry.CachePath == "" {
		t.Fatalf("entry after API fetch = %+v, want ready cache", entry)
	}
}

func TestJobsEndpointIncludesDiagnostics(t *testing.T) {
	srv, _ := newTestServer(t)
	http.Post(srv.URL+"/api/files?path=a.nc", "application/octet-stream", strings.NewReader("hello"))

	resp := get(t, srv.URL+"/api/jobs")
	defer resp.Body.Close()
	var jobs []store.Job
	if err := json.NewDecoder(resp.Body).Decode(&jobs); err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 || jobs[0].BlockedReason != "stale_status" || jobs[0].BlockedMessage == "" {
		t.Fatalf("jobs = %+v", jobs)
	}
}

func TestBackupEndpoints(t *testing.T) {
	srv, _ := newTestServer(t)
	http.Post(srv.URL+"/api/files?path=a.nc", "application/octet-stream", strings.NewReader("hello"))

	resp := get(t, srv.URL+"/api/backup")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.Contains(resp.Header.Get("Content-Disposition"), "cnc-proxy-backup.json") {
		t.Fatalf("backup export status=%d disposition=%q", resp.StatusCode, resp.Header.Get("Content-Disposition"))
	}
	var backup service.Backup
	if err := json.NewDecoder(resp.Body).Decode(&backup); err != nil {
		t.Fatal(err)
	}
	if backup.Version != 1 || len(backup.State.Entries) != 1 {
		t.Fatalf("backup = %+v", backup)
	}

	body, _ := json.Marshal(backup)
	req, _ := http.NewRequest("POST", srv.URL+"/api/backup/import", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	imp := do(t, req)
	defer imp.Body.Close()
	if imp.StatusCode != http.StatusAccepted {
		b, _ := io.ReadAll(imp.Body)
		t.Fatalf("backup import status=%d body=%s", imp.StatusCode, b)
	}

	backup.Version = 0
	body, _ = json.Marshal(backup)
	req, _ = http.NewRequest("POST", srv.URL+"/api/backup/import", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	bad := do(t, req)
	defer bad.Body.Close()
	if bad.StatusCode != http.StatusBadRequest {
		t.Fatalf("unsupported backup version status=%d, want 400", bad.StatusCode)
	}
}

// TestSpacedFilenameRoundTrip ensures a filename with a space (which the web UI
// percent-encodes) can be uploaded, read back, and deleted through the API.
func TestSpacedFilenameRoundTrip(t *testing.T) {
	srv, _ := newTestServer(t)
	http.Post(srv.URL+"/api/files?path=my%20part.nc", "application/octet-stream", strings.NewReader("data"))

	// Read it back via a percent-encoded path.
	resp := get(t, srv.URL+"/api/files/my%20part.nc")
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || string(body) != "data" {
		t.Fatalf("get spaced: status=%d body=%q", resp.StatusCode, body)
	}

	// Delete it via a percent-encoded path.
	req, _ := http.NewRequest("DELETE", srv.URL+"/api/files/my%20part.nc", nil)
	dresp := do(t, req)
	defer dresp.Body.Close()
	if dresp.StatusCode != http.StatusAccepted {
		t.Errorf("delete spaced: status=%d", dresp.StatusCode)
	}
}

func TestDeleteEndpoint(t *testing.T) {
	srv, _ := newTestServer(t)
	http.Post(srv.URL+"/api/files?path=a.nc", "application/octet-stream", strings.NewReader("x"))

	req, _ := http.NewRequest("DELETE", srv.URL+"/api/files/a.nc", nil)
	resp := do(t, req)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		t.Errorf("status = %d, want 202", resp.StatusCode)
	}

	// Deleting a non-existent file 404s.
	req2, _ := http.NewRequest("DELETE", srv.URL+"/api/files/missing.nc", nil)
	resp2 := do(t, req2)
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusNotFound {
		t.Errorf("missing delete status = %d, want 404", resp2.StatusCode)
	}
}

func TestFileRetryAndDiscardEndpoints(t *testing.T) {
	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	arb := session.New(session.Config{Dial: func() (*client.Conn, error) { return nil, io.EOF }})
	svc, err := service.New(st, arb)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(New(svc).Handler())
	defer srv.Close()

	respUpload := postRaw(t, srv.URL+"/api/files?path=bad.nc", "x")
	respUpload.Body.Close()
	if respUpload.StatusCode != http.StatusCreated {
		t.Fatalf("upload status = %d", respUpload.StatusCode)
	}
	if err := st.UpdateJob(1, func(j *store.Job) {
		j.State = store.Failed
		j.Attempts = 8
		j.LastError = "upload failed"
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SetEntrySync("/sd/gcodes/bad.nc", store.Error, "upload failed"); err != nil {
		t.Fatal(err)
	}

	retry := postJSON(t, srv.URL+"/api/files/retry", map[string]int64{"job_id": 1})
	retry.Body.Close()
	if retry.StatusCode != http.StatusAccepted {
		t.Fatalf("retry status = %d", retry.StatusCode)
	}
	if got := st.ListJobs()[0]; got.State != store.Queued || got.Attempts != 0 || got.LastError != "" {
		t.Fatalf("job after retry = %+v", got)
	}
	if got, _ := st.GetEntry("/sd/gcodes/bad.nc"); got.Sync != store.PendingUpload || got.Error != "" {
		t.Fatalf("entry after retry = %+v", got)
	}

	if err := st.UpdateJob(1, func(j *store.Job) {
		j.State = store.Failed
		j.Attempts = 8
		j.LastError = "upload failed again"
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SetEntrySync("/sd/gcodes/bad.nc", store.Error, "upload failed again"); err != nil {
		t.Fatal(err)
	}
	discard := postJSON(t, srv.URL+"/api/files/discard", map[string]string{"path": "bad.nc"})
	discard.Body.Close()
	if discard.StatusCode != http.StatusAccepted {
		t.Fatalf("discard status = %d", discard.StatusCode)
	}
	if _, ok := st.GetEntry("/sd/gcodes/bad.nc"); ok {
		t.Fatal("entry should be discarded")
	}
}

func TestRenameEndpoint(t *testing.T) {
	srv, _ := newTestServer(t)
	http.Post(srv.URL+"/api/files?path=a.nc", "application/octet-stream", strings.NewReader("x"))

	body, _ := json.Marshal(map[string]string{"from": "a.nc", "to": "b.nc"})
	req, _ := http.NewRequest("POST", srv.URL+"/api/files/rename", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp := do(t, req)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		t.Errorf("status = %d, want 202", resp.StatusCode)
	}
}

func TestMachineEndpoint(t *testing.T) {
	srv, _ := newTestServer(t)
	reqUpload, _ := http.NewRequest("POST", srv.URL+"/api/files?path=queued.nc", strings.NewReader("x"))
	reqUpload.Header.Set("Content-Type", "application/octet-stream")
	respUpload := do(t, reqUpload)
	respUpload.Body.Close()
	if respUpload.StatusCode != http.StatusCreated {
		t.Fatalf("upload status = %d", respUpload.StatusCode)
	}
	resp := get(t, srv.URL+"/api/machine")
	defer resp.Body.Close()
	var st service.MachineStatus
	json.NewDecoder(resp.Body).Decode(&st)
	if st.Mode != "owner" {
		t.Errorf("mode = %q, want owner", st.Mode)
	}
	if st.PendingJobs != 1 {
		t.Errorf("pending_jobs = %d, want 1", st.PendingJobs)
	}
}

func TestMachineStatusEndpointRichFields(t *testing.T) {
	srv, _, tr := serverWithMachine(t)
	tr.ObserveStatusPayload("<Run|MPos:1.25,-2.5,3.75,4|WPos:6,7,8,9|F:10,20,150|S:1000,12000,80,1,31.5,42.0,0,0,1|T:2,12.345,3|W:3.72|L:1,1,0,42.5,80|A:5|O:0.125|H:10|P:100,45,12|C:2,7,0,1>")
	resp := get(t, srv.URL+"/api/machine/status")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
	var st service.MachineStatus
	if err := json.NewDecoder(resp.Body).Decode(&st); err != nil {
		t.Fatal(err)
	}
	if st.State != machine.Run || !st.Connected || st.Stale || st.ObservedAt.IsZero() {
		t.Fatalf("connection status = %+v", st)
	}
	if st.MPos["x"] != 1.25 || st.MPos["y"] != -2.5 || st.MPos["z"] != 3.75 || st.WPos["x"] != 6 || st.WPos["y"] != 7 || st.WPos["z"] != 8 {
		t.Fatalf("positions = mpos:%+v wpos:%+v", st.MPos, st.WPos)
	}
	if st.Feed == nil || st.Feed.Current != 10 || st.Feed.Target != 20 || st.Feed.Override != 150 {
		t.Fatalf("feed = %+v", st.Feed)
	}
	if st.Spindle == nil || st.Spindle.CurrentRPM != 1000 || st.Spindle.TargetRPM != 12000 || st.Spindle.SpindleTempC == nil || *st.Spindle.SpindleTempC != 31.5 || st.Spindle.PowerTempC == nil || *st.Spindle.PowerTempC != 42 {
		t.Fatalf("spindle = %+v", st.Spindle)
	}
	if st.Tool == nil || st.Tool.Active != 2 || st.Tool.Offset != 12.345 || st.Tool.Target == nil || *st.Tool.Target != 3 {
		t.Fatalf("tool = %+v", st.Tool)
	}
	if st.ProbeV == nil || *st.ProbeV != 3.72 || st.Laser == nil || !st.Laser.Mode || !st.Laser.State || st.Laser.Power != 42.5 || st.ATCState == nil || *st.ATCState != 5 || st.LevelDelta == nil || *st.LevelDelta != 0.125 {
		t.Fatalf("optional telemetry = probe:%v laser:%+v atc:%v leveling:%v", st.ProbeV, st.Laser, st.ATCState, st.LevelDelta)
	}
	if st.Controller == nil || st.Controller.Model != 2 || st.Controller.Functions != 7 || st.Controller.InchMode || !st.Controller.AbsoluteMode {
		t.Fatalf("controller status = %+v", st.Controller)
	}
	if st.HaltReason == nil || st.HaltReason.Code != 10 || len(st.Progress) != 3 || len(st.Machine) != 4 {
		t.Fatalf("extended status = halt:%+v progress:%+v machine:%+v", st.HaltReason, st.Progress, st.Machine)
	}
	if st.ActiveJob == nil || st.ActiveJob.PlayedLines != 100 || st.ActiveJob.Percent != 45 || st.ActiveJob.ElapsedMs != 12000 || st.ActiveJob.RemainingMs == nil || *st.ActiveJob.RemainingMs != 14000 {
		t.Fatalf("active job = %+v", st.ActiveJob)
	}
}

func TestRunsEndpointDerivesObservedRun(t *testing.T) {
	srv, m, tr := serverWithMachine(t)
	tr.Observe(machine.Idle)
	m.PutFile("/sd/gcodes/a.nc", []byte("G1 X1\n"))
	resp := postJSON(t, srv.URL+"/api/gcode", map[string]string{"line": "play /sd/gcodes/a.nc"})
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("play command status = %d", resp.StatusCode)
	}
	tr.ObserveStatusPayload("<Run|MPos:0,0,0|F:100,200,100|S:5000,12000,80|P:1,10,1>")
	tr.ObserveStatusPayload("<Idle|MPos:0,0,0>")

	var runs []struct {
		File string `json:"file"`
	}
	found := false
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		r := get(t, srv.URL+"/api/runs")
		json.NewDecoder(r.Body).Decode(&runs)
		r.Body.Close()
		if len(runs) == 1 && runs[0].File == "/sd/gcodes/a.nc" {
			found = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !found {
		t.Fatalf("runs = %+v, want observed file", runs)
	}

	req, _ := http.NewRequest("DELETE", srv.URL+"/api/runs", nil)
	clearResp := do(t, req)
	clearResp.Body.Close()
	if clearResp.StatusCode != http.StatusOK {
		t.Fatalf("clear runs status = %d", clearResp.StatusCode)
	}
	r := get(t, srv.URL+"/api/runs")
	defer r.Body.Close()
	runs = nil
	if err := json.NewDecoder(r.Body).Decode(&runs); err != nil {
		t.Fatal(err)
	}
	if len(runs) != 0 {
		t.Fatalf("runs after clear = %+v, want empty", runs)
	}
}

func TestAttentionEndpointDeduplicatesAndResolvesPause(t *testing.T) {
	srv, _, tr := serverWithMachine(t)
	tr.ObserveStatusPayload("<Run|MPos:0,0,0>")
	tr.ObserveStatusPayload("<Pause|MPos:0,0,0>")
	tr.ObserveStatusPayload("<Pause|MPos:0,0,0>")

	var snapshot attention.Snapshot
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		resp := get(t, srv.URL+"/api/attention")
		if got := resp.Header.Get("Cache-Control"); got != "no-store" {
			resp.Body.Close()
			t.Fatalf("Cache-Control = %q, want no-store", got)
		}
		if err := json.NewDecoder(resp.Body).Decode(&snapshot); err != nil {
			resp.Body.Close()
			t.Fatal(err)
		}
		resp.Body.Close()
		if snapshot.Active != nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if snapshot.Active == nil || snapshot.Active.Kind != attention.KindPause || len(snapshot.Events) != 1 {
		t.Fatalf("pause snapshot = %+v", snapshot)
	}

	tr.ObserveStatusPayload("<Run|MPos:0,0,0>")
	deadline = time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		resp := get(t, srv.URL+"/api/attention")
		if err := json.NewDecoder(resp.Body).Decode(&snapshot); err != nil {
			resp.Body.Close()
			t.Fatal(err)
		}
		resp.Body.Close()
		if snapshot.Active == nil && len(snapshot.Events) == 1 && !snapshot.Events[0].Active {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("resolved snapshot = %+v", snapshot)
}

func TestNotificationEndpointsDisabledAndConfigured(t *testing.T) {
	disabled, _ := newTestServer(t)
	resp := get(t, disabled.URL+"/api/notifications")
	var disabledSnapshot notifications.Snapshot
	if err := json.NewDecoder(resp.Body).Decode(&disabledSnapshot); err != nil {
		resp.Body.Close()
		t.Fatal(err)
	}
	resp.Body.Close()
	if disabledSnapshot.Enabled {
		t.Fatalf("disabled snapshot = %+v", disabledSnapshot)
	}
	resp, err := http.Post(disabled.URL+"/api/notifications/test", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("disabled test status = %d, want 409", resp.StatusCode)
	}

	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	arb := session.New(session.Config{Dial: func() (*client.Conn, error) { return nil, io.EOF }})
	svc, err := service.New(st, arb)
	if err != nil {
		t.Fatal(err)
	}
	sender := &apiNotificationSender{}
	dispatcher, err := notifications.New(notifications.Config{Sender: sender, MachineName: "Shop Z1"})
	if err != nil {
		t.Fatal(err)
	}
	configured := httptest.NewServer(NewWithOptions(svc, Options{Notifications: dispatcher}).Handler())
	defer configured.Close()
	resp, err = http.Post(configured.URL+"/api/notifications/test", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || len(sender.messages) != 1 {
		t.Fatalf("configured test status=%d messages=%d", resp.StatusCode, len(sender.messages))
	}
	resp = get(t, configured.URL+"/api/notifications")
	var snapshot notifications.Snapshot
	if err := json.NewDecoder(resp.Body).Decode(&snapshot); err != nil {
		resp.Body.Close()
		t.Fatal(err)
	}
	resp.Body.Close()
	if !snapshot.Enabled || snapshot.Provider != "test" || len(snapshot.Deliveries) != 1 || snapshot.Deliveries[0].State != notifications.DeliverySent {
		t.Fatalf("configured snapshot = %+v", snapshot)
	}
}

func TestWebUIServed(t *testing.T) {
	srv, _ := newTestServer(t)
	for _, route := range []string{"/dashboard", "/active-job", "/jog", "/control", "/files"} {
		routed := get(t, srv.URL+route)
		routedBody, _ := io.ReadAll(routed.Body)
		routed.Body.Close()
		if routed.StatusCode != http.StatusOK || !bytes.Contains(routedBody, []byte("<!DOCTYPE html>")) {
			t.Errorf("tab route %s status=%d body-start=%.30q", route, routed.StatusCode, routedBody)
		}
	}
	missing := get(t, srv.URL+"/not-a-tab")
	missing.Body.Close()
	if missing.StatusCode != http.StatusNotFound {
		t.Errorf("unknown UI route status=%d, want 404", missing.StatusCode)
	}

	resp := get(t, srv.URL+"/")
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	bodyText := string(body)
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(body), "<!DOCTYPE html>") {
		t.Errorf("index status=%d body-start=%.30q", resp.StatusCode, body)
	}
	if !strings.Contains(string(body), `id="tab-dashboard"`) || !strings.Contains(string(body), `id="tab-active-job"`) || !strings.Contains(string(body), `id="tab-control"`) || !strings.Contains(string(body), `id="tab-files"`) || !strings.Contains(string(body), `id="dashboard-view"`) || !strings.Contains(string(body), `id="control-view"`) {
		t.Errorf("index missing lazy tab markup")
	}
	if !strings.Contains(string(body), `id="workarea-plot"`) || !strings.Contains(string(body), `id="status-connection"`) {
		t.Errorf("index missing work area visualization or connection status")
	}
	for _, want := range []string{`id="workarea-actions-toggle" aria-expanded="false" aria-controls="workarea-actions-panel"`, `id="workarea-actions-panel"`, `class="workarea-actions-close"`, `#workarea-actions-panel.is-open { display: grid; }`, `#workarea-actions-panel .workarea-controls, #workarea-actions-panel .outline-preview-controls { position: static;`} {
		if !strings.Contains(bodyText, want) {
			t.Errorf("index missing mobile work area actions marker %s", want)
		}
	}
	for _, want := range []string{
		`<canvas id="dashboard-preview" role="img" aria-label="Active job 3D preview"></canvas>`,
		`#dashboard-preview-empty { z-index: 1; display: grid; place-items: center;`,
		`id="dashboard-controls-toggle" aria-expanded="false" aria-controls="dashboard-toolbar"`,
		`id="dashboard-toolbar" class="dashboard-toolbar" aria-label="Dashboard layouts" hidden`,
		`body[data-active-tab="dashboard"] #view-navigation { grid-template-columns: minmax(0, 1fr) 38px max-content; }`,
		`body[data-active-tab="dashboard"] .dashboard-controls { position: absolute; top: calc(100% + 8px); right: 10px; }`,
		`#dashboard-view { grid-template-rows: minmax(0, 1fr); gap: 0; overflow: hidden; }`,
		`.dashboard-metrics { min-height: 0; display: grid; grid-template-columns: repeat(15, minmax(0, 1fr)); grid-template-rows: repeat(2, minmax(0, 1fr));`,
		`.dashboard-position-metric { grid-column: 1 / -1; container-type: inline-size; }`,
		`.dashboard-position-metric > strong, .dashboard-position-metric > b { overflow: visible; text-overflow: clip; white-space: nowrap;`,
		`@media (max-height: 680px) and (min-width: 1041px)`,
		`id="dashboard-profile"`,
		`id="dashboard-copy-obs"`,
		`id="dashboard-settings-modal"`,
		`data-dashboard-panel="telemetry"`,
		`data-dashboard-panel="gcode"`,
		`body.dashboard-embed header`,
	} {
		if !strings.Contains(bodyText, want) {
			t.Errorf("index missing dashboard 3D preview marker %s", want)
		}
	}
	for _, gone := range []string{`id="dashboard-preview-path"`, `id="dashboard-preview-complete"`, `id="dashboard-preview-marker"`, `aria-label="Active job top view"`} {
		if strings.Contains(bodyText, gone) {
			t.Errorf("index still contains obsolete dashboard 2D preview marker %s", gone)
		}
	}
	for _, want := range []string{`[hidden] { display: none !important; }`, `id="status-bar"`, `.status-item`, `#status-bar { position: fixed;`, `background: transparent; border: 0; box-shadow: none; pointer-events: none;`, `.status-item.entering`, `.status-item.leaving`, `.status-dismiss`, `.jobs-head`, `.job-recovery`, `id="machine-status-toolbar"`, `id="machine-status-popout"`, `class="connection-status"`, `id="header-toggle"`, `aria-label="Hide top bars"`, `body.header-collapsed #command-toolbar, body.header-collapsed .tabs { display: none; }`, `id="alarm-panel"`, `id="alarm-recover"`, `data-control-action="recover"`, `id="ctl-home-main"`, `data-control-action="home"`, `id="dashboard-view"`, `id="dashboard-state"`, `class="dashboard-metric dashboard-position-metric"><span>Work position</span><strong id="dashboard-wpos"`, `id="dashboard-spindle-temp"`, `id="dashboard-power-temp"`, `id="dashboard-preview"`, `id="dashboard-progress-bar"`, `id="dashboard-remaining"`, `id="active-job-view"`, `id="active-gcode-left"`, `id="active-job-left-tab-source"`, `id="active-job-left-tab-console"`, `id="active-gcode-console"`, `id="active-gcode-splitter"`, `role="separator"`, `aria-orientation="vertical"`, `id="gcode-form"`, `id="gcode-input"`, `id="log-filter"`, `id="file-summary"`, `id="tool-panel"`, `id="tool-set"`, `id="tool-change-select"`, `id="tool-continue"`, `Tool Status`, `id="active-gcode-panel"`, `class="active-gcode-head"`, `id="active-gcode-progress"`, `id="active-gcode-elapsed"`, `id="active-gcode-remaining"`, `id="active-gcode-pause"`, `id="active-gcode-resume"`, `id="feed-override-controls"`, `id="feed-override-decrease"`, `id="feed-override-increase"`, `id="feed-override-reset"`, `id="paused-job-raise"`, `id="paused-job-stop-spindle"`, `id="active-gcode-source"`, `id="active-gcode-source-scroll"`, `id="active-gcode-source-position"`, `id="gcode-preview"`, `id="gcode-timeline"`, `id="gcode-projection-persp" aria-pressed="false"`, `id="gcode-projection-ortho" aria-pressed="true"`, `id="jog-settings-section"`, `id="move-to-work-section"`, `id="work-zero-section"`, `id="gamepad-section"`, `id="workarea-mobile-jog"`, `.mobile-jog-base`, `.mobile-jog-knob`, `class="command-panel-close" aria-label="Close Macros menu"`, `class="command-panel-close" aria-label="Close Tool menu"`, `type="module"`, `/app.js?v=dashboard-controls-2`} {
		if !strings.Contains(bodyText, want) {
			t.Errorf("index missing %s", want)
		}
	}
	for _, gone := range []string{`id="notice-clear"`, `body.has-status-message main`, `background: rgba(16,19,22,.96); border-top:`} {
		if strings.Contains(bodyText, gone) {
			t.Errorf("index still contains layout-affecting status bar marker %s", gone)
		}
	}
	for _, want := range []string{`id="tool-wait-row"`, `id="tool-wait-status"`, `id="tool-calibrate-row"`, `tool-single-action`, `tool-task-group`, `tool-state-row`} {
		if !strings.Contains(bodyText, want) {
			t.Errorf("index missing tool lifecycle grouping marker %s", want)
		}
	}
	if strings.Contains(bodyText, "tool-two-actions") {
		t.Errorf("tool Continue must not be grouped as a two-action peer with Calibrate")
	}
	continueIdx := strings.Index(bodyText, `id="tool-continue"`)
	setIdx := strings.Index(bodyText, `id="tool-set-row"`)
	calibrateRowIdx := strings.Index(bodyText, `id="tool-calibrate-row"`)
	calibrateIdx := strings.Index(bodyText, `id="tool-calibrate"`)
	if continueIdx < 0 || setIdx < 0 || calibrateRowIdx < 0 || calibrateIdx < 0 || !(continueIdx < setIdx && setIdx < calibrateRowIdx && calibrateRowIdx < calibrateIdx) {
		t.Errorf("tool Calibrate must be the bottom action after Set")
	}
	if got := resp.Header.Get("Cache-Control"); got != "no-store" {
		t.Errorf("index Cache-Control = %q, want no-store", got)
	}
	for _, want := range []string{`id="file-browser"`, `id="folder-tree"`, `id="breadcrumbs"`, `id="folder-up"`, `id="folder-new"`, `id="current-folder"`} {
		if !strings.Contains(string(body), want) {
			t.Errorf("index missing %s", want)
		}
	}
	for _, want := range []string{
		`class="files-toolbar"`,
		`grid-template-columns: minmax(260px, 1fr) max-content minmax(220px, 320px)`,
		`<button type="button" id="drop">Upload files or drop them here</button>`,
		`#files-view { --files-control-h: 38px; align-content: start; }`,
		`#drop, #filter { width: 100%; min-width: 0; height: var(--files-control-h); min-height: var(--files-control-h); }`,
		`#file-summary .summary-pill:first-child { display: none; }`,
		`#folder-sidebar { position: sticky; top: 0; }`,
	} {
		if !strings.Contains(bodyText, want) {
			t.Errorf("index missing desktop Files control marker %s", want)
		}
	}
	for _, want := range []string{
		`id="file-table"`,
		`#file-table .file-col-modified, #file-table thead th:nth-child(4), #file-table .file-modified-cell`,
		`#files tr { display: grid; grid-template-columns: max-content max-content minmax(0, 1fr) max-content; grid-template-areas: "name name name status" "type size modified modified" "actions actions actions actions";`,
		`#file-table .file-type-cell { display: block; grid-area: type; }`,
		`#file-table .file-size-cell { display: block; grid-area: size; }`,
		`#file-table .file-modified-cell { display: block; grid-area: modified;`,
		`#current-folder { display: none; }`,
		`#folder-bar { grid-template-columns: minmax(0, 1fr); gap: 8px; justify-content: stretch; }`,
		`#folder-actions { width: 100%; grid-template-columns: repeat(2, minmax(0, 1fr));`,
	} {
		if !strings.Contains(bodyText, want) {
			t.Errorf("index missing mobile file listing marker %s", want)
		}
	}
	for _, gone := range []string{
		`.file-col-modified, th:nth-child(4), td:nth-child(4)`,
		`.file-col-type, th:nth-child(2), td:nth-child(2)`,
		`    th:nth-child(3), td:nth-child(3)`,
	} {
		if strings.Contains(bodyText, gone) {
			t.Errorf("index still contains unscoped responsive table selector %s", gone)
		}
	}
	for _, want := range []string{
		`grid-template-columns: repeat(5, minmax(112px, 1fr))`,
		`main > *, .view > .page-section { width: 100%; min-width: 0; }`,
		`role="tablist"`,
		`role="tab" aria-selected="true" aria-controls="active-job-view"`,
		`role="tabpanel" aria-labelledby="tab-active-job"`,
		`#active-job-view { grid-template-rows: max-content; align-content: start; }`,
		`#active-gcode-panel { align-content: start; padding: 8px; gap: 0; }`,
		`.active-gcode-body { min-width: 0; display: grid; grid-template-rows: auto auto; align-content: start; gap: 4px; }`,
		`#active-job-view { grid-template-rows: minmax(0, 1fr); align-content: stretch; overflow: hidden; }`,
		`#active-gcode-panel { min-height: 0; height: 100%; grid-template-rows: minmax(0, 1fr); align-content: stretch; }`,
		`.active-gcode-body { min-height: 0; height: 100%; grid-template-rows: auto minmax(0, 1fr); align-content: stretch; }`,
		`.active-gcode-workspace { min-height: 0; height: 100%; }`,
		`.active-gcode-workspace.is-empty #active-gcode-splitter, .active-gcode-workspace.is-empty #gcode-preview-wrap { display: none; }`,
		`align-items: start; min-height: 0; margin-top: 4px;`,
	} {
		if !strings.Contains(string(body), want) {
			t.Errorf("index missing full-width responsive tab marker %s", want)
		}
	}
	for _, gone := range []string{`max-width: 1440px`, `body[data-active-tab="gcode-console"] main`, `id="tab-gcode-console"`, `id="gcode-console-view"`} {
		if strings.Contains(string(body), gone) {
			t.Errorf("index still contains tab-specific width constraint %s", gone)
		}
	}
	toolbarIdx := strings.Index(bodyText, `id="command-toolbar"`)
	tabsIdx := strings.Index(bodyText, `<nav class="tabs"`)
	headerEndIdx := strings.Index(bodyText, `</header>`)
	mainIdx := strings.Index(bodyText, `<main>`)
	if toolbarIdx < 0 || tabsIdx < toolbarIdx || headerEndIdx < tabsIdx || mainIdx < headerEndIdx {
		t.Error("view tabs must remain attached to the header below the command toolbar")
	}
	actionsIdx := strings.Index(bodyText, `id="command-actions"`)
	statusIdx := strings.Index(bodyText, `id="machine-status-toolbar"`)
	haltIdx := strings.Index(bodyText, `id="ctl-halt"`)
	if actionsIdx < 0 || statusIdx < actionsIdx || haltIdx < actionsIdx || haltIdx > statusIdx {
		t.Error("command actions, Halt, and machine status must share the desktop command toolbar")
	}
	for _, want := range []string{`id="macro-toolbar"`, `id="macro-panel"`, `id="macro-manager"`, `id="macro-save"`} {
		if !strings.Contains(string(body), want) {
			t.Errorf("index missing %s", want)
		}
	}
	for _, want := range []string{`id="probe-confirm-modal"`, `id="probe-confirm-message"`, `id="probe-confirm-warning"`, `id="probe-confirm-accept"`, `id="probe-confirm-cancel"`} {
		if !strings.Contains(string(body), want) {
			t.Errorf("index missing %s", want)
		}
	}
	for _, want := range []string{`grid-template-rows: 20px 36px 32px`, `grid-template-areas: "title title title title" "actions actions exports exports" "settings settings summary summary"`, `grid-template-columns: max-content 72px`, `grid-template-areas: "title title" "actions actions" "exports exports" "settings settings" "summary summary"`} {
		if !strings.Contains(string(body), want) {
			t.Errorf("index missing compact Outline Probe layout %s", want)
		}
	}
	for _, want := range []string{`Arm Movement`, `class="command-movement-arm"`, `Jog Settings`, `id="tap-feed-mm-min"`, `data-feed-step="-500"`, `data-feed-step="500"`, `id="tap-safe-z-enabled"`, `Move To Work`, `id="work-move-x"`, `id="work-move-y"`, `id="work-move-z"`, `data-work-move-reset="x"`, `data-work-move-reset="y"`, `data-work-move-reset="z"`, `id="work-move-send"`, `Work Zero`, `data-origin-zero="x"`, `data-origin-zero="y"`, `data-origin-zero="z"`, `Set XYZ`, `id="origin-set-xyz-open"`, `id="origin-xyz-modal"`, `id="origin-xyz-x"`, `id="origin-xyz-y"`, `id="origin-xyz-z"`, `id="origin-xyz-apply"`, `Set Origin`, `id="origin-set-open"`, `id="origin-set-modal"`, `id="origin-set-source"`, `id="origin-set-x"`, `id="origin-set-y"`, `id="origin-set-apply"`, `Origin Presets`, `id="origin-presets-open"`, `id="origin-presets-modal"`, `id="saved-origin-select"`, `id="saved-origin-recall"`, `id="saved-origin-delete"`, `id="saved-origin-label"`, `id="saved-origin-save"`, `id="origin-probe-z"`, `Probe Z`, `id="origin-probe-3d"`, `id="probe-3d-modal"`, `id="probe-3d-kind"`, `id="probe-3d-run"`, `3D Probe`, `id="workarea-hover-position"`, `id="workarea-zoom-out"`, `id="workarea-zoom-reset"`, `id="workarea-zoom-in"`, `id="workarea-viewport"`, `id="workarea-boundary"`, `aria-label="Machine XY travel area"`, `id="workarea-origin"`, `id="workarea-origin-xp"`, `id="workarea-origin-xm"`, `id="workarea-origin-yp"`, `id="workarea-origin-ym"`, `id="workarea-spindle"`, `id="workarea-target"`, `id="workarea-outline"`, `id="workarea-field-probe-preview"`, `id="outline-preview-controls"`, `id="outline-start"`, `Capture outline`, `id="outline-active-controls"`, `id="outline-end"`, `id="outline-add-point"`, `id="outline-trace"`, `Trace outline`, `id="outline-undo"`, `id="outline-redo"`, `id="outline-curve-fit"`, `Outline Probe`, `id="outline-probe-floor"`, `Probe Floor`, `id="outline-close"`, `id="outline-load"`, `id="outline-save"`, `id="outline-file"`, `id="outline-export"`, `id="outline-field-spacing"`, `Spot Gap`, `id="outline-field-probe"`, `Probe Field Z`, `id="outline-field-move"`, `Move to point`, `id="outline-field-reset"`, `Reset value`, `id="outline-export-obj"`, `id="outline-export-height"`, `id="z-step-distance"`, `data-z-step-dir="1"`, `data-z-step-dir="-1"`, `id="machine-settings-open"`, `id="machine-settings-modal"`, `id="machine-settings-close"`, `Travel X Min`, `Travel X Max`, `Travel Y Min`, `Travel Y Max`, `id="machine-x-min"`, `id="machine-feed-min"`, `id="machine-feed-max"`, `id="machine-safe-z"`, `id="machine-learn"`, `Learn from machine`, `id="machine-learned-summary"`, `<summary>Gamepad</summary>`, `id="gamepad-panel"`, `id="gamepad-settings"`, `id="gamepad-axis-x"`, `id="gamepad-speed-z"`, `id="gamepad-outline-button"`, `gamepad-outline-button-help`, `id="gamepad-macro-bindings"`, `id="gamepad-add-macro"`} {
		if !strings.Contains(string(body), want) {
			t.Errorf("index missing %s", want)
		}
	}
	indexText := string(body)
	armIndex := strings.Index(indexText, `id="jog-arm"`)
	jogSettingsIndex := strings.Index(indexText, `<summary>Jog Settings</summary>`)
	if armIndex < 0 || jogSettingsIndex < 0 || armIndex > jogSettingsIndex {
		t.Errorf("Arm Movement must be the first command-drawer row")
	}
	probeFloorIndex := strings.Index(indexText, `id="outline-probe-floor"`)
	probeFieldIndex := strings.Index(indexText, `id="outline-field-probe"`)
	probeExportIndex := strings.Index(indexText, `id="outline-export-controls"`)
	probeSettingsIndex := strings.Index(indexText, `class="outline-probe-settings"`)
	if probeFloorIndex < 0 || probeFieldIndex < probeFloorIndex || probeExportIndex < probeFieldIndex || probeSettingsIndex < probeExportIndex {
		t.Errorf("Outline Probe controls are not ordered as title, button row, then settings")
	}
	outlineLoadIdx := strings.Index(bodyText, `id="outline-load"`)
	outlineSaveIdx := strings.Index(bodyText, `id="outline-save"`)
	outlineExportIdx := strings.Index(bodyText, `id="outline-export"`)
	if outlineLoadIdx < 0 || outlineSaveIdx < outlineLoadIdx || outlineExportIdx < outlineSaveIdx {
		t.Error("outline load and save controls must appear above Export DXF")
	}
	if !strings.Contains(bodyText, `id="outline-export">Export DXF</button>`) || strings.Contains(bodyText, `Export SVG`) {
		t.Error("outline CAD export must be labeled DXF, not SVG")
	}
	for _, gone := range []string{`id="origin-z-probe"`, `id="origin-z-probe-status"`, "origin-row-probe", `id="machine-settings"`, `id="origin-action"`, `id="origin-apply"`, `anchor-origin-`, `Zero XY`, `Reset XY to Machine`, `id="outline-field-safe-z"`} {
		if strings.Contains(string(body), gone) {
			t.Errorf("index still contains removed Probe Z row marker %s", gone)
		}
	}
	for _, want := range []string{`class="machine-status-item machine-status-position"`, `class="position-line"`, `class="tap-move-toolbar"`, `class="tap-primary-controls"`, `class="tap-feed-stepper"`, `class="tap-safe-z-field"`, `class="tap-safe-z-toggle"`, `class="tap-coordinate-panel"`, `class="tap-coordinate-row"`, `grid-template-columns: repeat(3, 112px) 64px`, `class="work-move-label"`, `class="work-move-field is-live"`, `class="work-move-reset"`, `class="icon-reset"`, `class="tap-origin-panel"`, `class="origin-action-grid"`, `class="origin-modal"`, `class="origin-modal-fields"`, `class="origin-modal-source"`, `id="origin-set-change"`, `class="origin-set-change"`, `class="origin-row origin-row-preset"`, `class="origin-row origin-row-save"`, `class="saved-origin-label-field"`, `class="tap-move-body"`, `class="workarea-frame"`, `class="workarea-controls"`, `class="outline-preview-controls"`, `width: min(178px, calc(100% - 86px))`, `.tap-move-toolbar button, .tap-safe-z-toggle`, `#jog-arm { width: 100%; min-width: 0;`, `white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`, `#workarea-plot { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }`, `class="outline-active-controls"`, `class="outline-capture" hidden`, `class="outline-probe-actions"`, `class="machine-settings-actions"`, `class="machine-settings-modal-body"`, `class="machine-settings-section"`, `class="machine-settings-fields machine-settings-travel-fields"`, `class="machine-settings-fields machine-settings-origin-fields"`, `class="machine-settings-fields machine-settings-motion-fields"`, `class="machine-settings-field"`, `class="machine-learned-summary"`, `class="z-step-controls"`, `class="table-scroll"`, `id="probe-3d-preflight" class="probe-3d-preflight" aria-hidden="true"`} {
		if !strings.Contains(string(body), want) {
			t.Errorf("index missing layout marker %s", want)
		}
	}
	for _, want := range []string{
		`#machine-settings-modal { width: min(680px, calc(100vw - 24px)); --machine-settings-control-h: 36px; --machine-settings-label-h: 14px; }`,
		`#machine-settings-modal .machine-settings-modal-body { gap: 0; }`,
		`.machine-settings-travel-fields { grid-template-columns: repeat(4, minmax(0, 1fr)); }`,
		`.machine-settings-origin-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }`,
		`.machine-settings-motion-fields { grid-template-columns: repeat(3, minmax(0, 1fr)); }`,
		`.machine-settings-field > input { width: 100%; min-width: 0; height: var(--machine-settings-control-h); min-height: var(--machine-settings-control-h); }`,
		`.machine-settings-travel-fields, .machine-settings-motion-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }`,
		`@media (max-width: 440px)`,
		`.machine-settings-travel-fields, .machine-settings-origin-fields, .machine-settings-motion-fields { grid-template-columns: 1fr; }`,
		`:root { --control-h: 44px; }`,
		`header { gap: 8px; padding: 8px 10px; backdrop-filter: none; }`,
		`.badge { display: inline-flex; align-items: center; justify-content: center;`,
		`#command-toolbar { grid-template-columns: max-content minmax(0, 1fr); grid-template-areas: "actions actions" "machine status"; gap: 8px; align-items: center; }`,
		`#command-menu { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; overflow: visible; }`,
		`#machine-status-toolbar .machine-status-item:not(.machine-status-position) { display: none; }`,
		`.dashboard-job.is-empty .dashboard-progress, .dashboard-job.is-empty .dashboard-preview-frame { display: none; }`,
		`.command-panel { border-radius: 10px; overscroll-behavior: contain; scrollbar-gutter: stable; }`,
		`.command-panel-close { position: sticky; top: 0; z-index: 2; display: inline-flex; width: 100%; min-height: 44px;`,
		`.active-gcode-progress { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }`,
		`#active-gcode-left.is-console-active { height: clamp(480px, 68dvh, 620px); min-height: 480px; }`,
		`#files .actions { display: grid; grid-area: actions; grid-template-columns: repeat(2, minmax(0, 1fr));`,
		`dialog { width: calc(100vw - 16px); max-width: none; max-height: calc(100dvh - 16px); margin: 8px; }`,
	} {
		if !strings.Contains(bodyText, want) {
			t.Errorf("index missing stable Machine settings layout marker %s", want)
		}
	}
	if strings.Contains(bodyText, `.command-panel { top: auto !important; right: 10px; bottom:`) {
		t.Error("mobile command panels must remain anchored to their toolbar triggers")
	}
	machineSettingsIdx := strings.Index(bodyText, `id="machine-settings-modal"`)
	machineTravelIdx := strings.Index(bodyText, `id="machine-settings-travel-title"`)
	machineOriginIdx := strings.Index(bodyText, `id="machine-settings-origin-title"`)
	machineMotionIdx := strings.Index(bodyText, `id="machine-settings-motion-title"`)
	machineControllerIdx := strings.Index(bodyText, `id="machine-settings-controller-title"`)
	machineLearnIdx := strings.Index(bodyText, `id="machine-learn"`)
	machineLearnSummaryIdx := strings.Index(bodyText, `id="machine-learned-summary"`)
	if machineSettingsIdx < 0 || machineTravelIdx < machineSettingsIdx || machineOriginIdx < machineTravelIdx || machineMotionIdx < machineOriginIdx || machineControllerIdx < machineMotionIdx || machineLearnIdx < machineControllerIdx || machineLearnSummaryIdx < machineLearnIdx {
		t.Error("Machine settings must remain grouped as travel, display origin, motion limits, then Learn with its persistent summary below it")
	}
	if strings.Contains(bodyText, `class="machine-settings-grid"`) || strings.Contains(bodyText, `.machine-settings-grid`) {
		t.Error("Machine settings must not use the old auto-fit grid or Jog-scoped sizing contract")
	}
	for _, gone := range []string{`id="status-detail"`, `id="status-fields"`, `id="status-raw"`, `<summary>Gcode</summary>`, `id="quick-commands"`, `id="gcode-history"`, `data-gcode=`, `<h2>Gamepad Jog</h2>`, `<h2>Jog</h2>`, `<summary><h2>Gamepad</h2></summary>`, `class="tap-control-title">Jog Settings</div>`, `class="tap-control-title">Move To Work</div>`, `class="origin-group-title">Work Zero</div>`, `<span>Saved Zero</span><select id="saved-origin-select"`, `id="run-history-panel"`, `id="run-history-clear"`, `id="run-history"`, `Run History`, `id="jog-step-distance"`, `data-jog-step-axis=`, `id="jog-step-feedback"`, `id="jog-plot"`, `id="jog-axes"`, `id="jog-mpos"`, `id="jog-wpos"`, `id="jog-target-pos"`, `id="tap-mpos-x"`, `id="tap-mpos-y"`, `id="tap-wpos-x"`, `id="tap-wpos-y"`, `id="workarea-axis-overlay"`, `class="tap-position-readout"`, `class="outline-toolbar"`, `id="outline-probe-point"`, `probe_each_point`, `Arm Tap Move`, `class="tap-arm-panel"`, `id="alarm-feedback"`, `id="tool-feedback"`, `id="tool-action-status"`, `id="active-gcode-feedback"`, `id="tap-move-feedback"`, `id="outline-feedback"`, `id="outline-action-status"`, `id="machine-learn-status"`, `id="jog-error"`, `id="backup-status"`, `class="action-feedback"`, `class="tool-action-status"`, `class="outline-action-status"`, `class="origin-action-status"`, `data-origin-feedback`, `button:not(#jog-arm)`, `min-height: 64px`, `>X</button>`} {
		if strings.Contains(string(body), gone) {
			t.Errorf("index still contains removed status details marker %s", gone)
		}
	}
	if strings.Count(bodyText, `role="status"`) != 1 || strings.Count(bodyText, `aria-live="polite"`) != 1 || !strings.Contains(bodyText, `<div id="status-bar" role="status" aria-live="polite" hidden>`) {
		t.Error("the bottom status bar must be the production UI's sole status live region")
	}
	for _, want := range []string{`body { height: 100dvh;`, `overflow: hidden;`, `.view { display: grid; gap: var(--gap-xl); min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable;`} {
		if !strings.Contains(string(body), want) {
			t.Errorf("index missing tab-local scrolling marker %s", want)
		}
	}
	for _, want := range []string{`#control-view { grid-template-rows: minmax(0, 1fr); overflow: hidden; }`, `#control-view #jog, #control-view .control-page-layout { min-height: 0; height: 100%; }`, `#control-view .control-command-drawer { position: static; top: auto; align-self: stretch; min-height: 0; max-height: none; overflow-y: auto; }`, `#control-view .control-workspace { min-height: 0; height: 100%; grid-template-rows: minmax(0, 1fr) auto; align-items: stretch; }`, `#control-view .tap-move-body, #control-view .workarea-frame { min-height: 0; height: 100%; }`} {
		if !strings.Contains(string(body), want) {
			t.Errorf("index missing full-height Control layout marker %s", want)
		}
	}
	for _, gone := range []string{`<h2>Active job</h2>`, `<h2>Gcode console</h2>`, `<h2>Control</h2>`, `<h2>Files</h2>`} {
		if strings.Contains(string(body), gone) {
			t.Errorf("index still contains redundant tab title %s", gone)
		}
	}

	js := get(t, srv.URL+"/app.js")
	jsBody, _ := io.ReadAll(js.Body)
	js.Body.Close()
	if js.StatusCode != http.StatusOK || !strings.Contains(string(jsBody), "EventSource") {
		t.Errorf("app.js status=%d", js.StatusCode)
	}
	for _, want := range []string{`setText("dashboard-wpos", fmtPos(machine.wpos`, `setText("dashboard-mpos", "Machine " + fmtPos(machine.mpos`} {
		if !strings.Contains(string(jsBody), want) {
			t.Errorf("app.js missing dashboard position hierarchy marker %s", want)
		}
	}
	if !strings.Contains(string(jsBody), "/api/events?scope=control") || !strings.Contains(string(jsBody), "/api/events?scope=files") {
		t.Errorf("app.js missing scoped event streams")
	}
	for _, want := range []string{`setAttribute("aria-selected", String(active))`, `if (e.key === "ArrowRight")`, `else if (e.key === "Home")`, `window.addEventListener("popstate"`, `showTab(viewTabFromURL(), "replace")`} {
		if !strings.Contains(string(jsBody), want) {
			t.Errorf("app.js missing accessible tab behavior %s", want)
		}
	}
	if !strings.Contains(string(jsBody), `clearNotice("control-sse")`) || !strings.Contains(string(jsBody), `clearNotice("files-sse")`) {
		t.Errorf("app.js missing stream reconnect notice clearing")
	}
	if !strings.Contains(string(jsBody), `setNotice("Machine status unavailable: " + e.message, "error", "machine-status")`) || !strings.Contains(string(jsBody), `clearNotice("machine-status")`) {
		t.Errorf("app.js missing machine status notice lifecycle")
	}
	if !strings.Contains(string(jsBody), "function setStatusMessage") || !strings.Contains(string(jsBody), "function clearVisibleNotices") || !strings.Contains(string(jsBody), "NOTICE_REPEAT_SUPPRESS_MS") || !strings.Contains(string(jsBody), `consumeJogAlertFeedback("tap-move"`) || !strings.Contains(string(jsBody), `setStatusMessage("jog-availability"`) {
		t.Errorf("app.js missing shared transient status message routing")
	}
	if strings.Contains(string(jsBody), `return { text: "Jog input active.", kind: "ok" }`) || strings.Contains(string(jsBody), `return { text: "Armed.", kind: "ok" }`) {
		t.Errorf("app.js still exposes routine jog state as a success alert")
	}
	for _, want := range []string{"function dismissNotice", "function noticeItemRects", "function animateNoticeReflow", `for (const notice of notices)`, `dismiss.onclick = () => clearNotice(row.dataset.noticeKey)`} {
		if !strings.Contains(string(jsBody), want) {
			t.Errorf("app.js missing overlay notification stack behavior %s", want)
		}
	}
	for _, want := range []string{"function mobileWorkAreaJogEnabled", "function mobileWorkAreaJogAxes", "function startMobileWorkAreaJog", "function updateMobileWorkAreaJog", "function stopMobileWorkAreaJog", `if (state.workarea?.mobileJogActive)`, `sendJog({ type: "input", deadman: false`} {
		if !strings.Contains(string(jsBody), want) {
			t.Errorf("app.js missing mobile work-area jog behavior %s", want)
		}
	}
	for _, gone := range []string{`document.body.classList.toggle("has-status-message"`, `notices.slice(0, 1)`, `clearVisibleNotices();\n  const notice =`} {
		if strings.Contains(string(jsBody), gone) {
			t.Errorf("app.js still contains single-notice or layout-affecting behavior %s", gone)
		}
	}
	if !strings.Contains(string(jsBody), "function setWorkAreaActionsOpen") || !strings.Contains(string(jsBody), "function initWorkAreaActionsMenu") || !strings.Contains(string(jsBody), `event.key !== "Escape"`) {
		t.Errorf("app.js missing accessible mobile work area actions behavior")
	}
	if !strings.Contains(string(jsBody), `availability.available && isTransientJogBlock(state.jog.errorCode || state.jog.error)`) {
		t.Errorf("app.js does not retain stale jog recovery feedback until fresh machine status is observed")
	}
	for _, want := range []string{`function drawDashboardGcodePreview`, `function ensureDashboardGcodeViewer`, `function populateGcodePathScene`, `function rebuildGcodeContextOverlayForGroup`, `function activeGcodeDisplaySegments`, `overview_segments`, `function renderDashboardGcodeStream`, `function renderDashboardTelemetry`} {
		if !strings.Contains(string(jsBody), want) {
			t.Errorf("app.js missing dashboard 3D preview behavior %s", want)
		}
	}
	for _, want := range []string{`function requestMovementDisarm`, `function disarmMovementOnControlExit`, `disarmMovementOnControlExit(name);`, `disarmAfterPendingArm`} {
		if !strings.Contains(string(jsBody), want) {
			t.Errorf("app.js missing automatic Movement disarm behavior %s", want)
		}
	}
	if !strings.Contains(string(jsBody), "refreshJobs") || !strings.Contains(string(jsBody), "/api/jobs") {
		t.Errorf("app.js missing active job diagnostic refresh")
	}
	if !strings.Contains(string(jsBody), "renderWorkArea") || !strings.Contains(string(jsBody), "SPINDLE_DIAMETER_MM") || !strings.Contains(string(jsBody), "OUTLINE_POINT_DIAMETER_MM") || !strings.Contains(string(jsBody), "jogPanelMessage") || !strings.Contains(string(jsBody), "sendTapMove") || !strings.Contains(string(jsBody), "sendWorkCoordinateMove") || !strings.Contains(string(jsBody), "workMoveTargetsFromInputs") || !strings.Contains(string(jsBody), "resetWorkMoveInput") || !strings.Contains(string(jsBody), "workMoveInputIsLive") || !strings.Contains(string(jsBody), "renderWorkMoveFieldState") || !strings.Contains(string(jsBody), "stepTapFeed") || !strings.Contains(string(jsBody), "feedBoundsFor") || !strings.Contains(string(jsBody), "stepZ") || !strings.Contains(string(jsBody), "setOriginAxis") || !strings.Contains(string(jsBody), "applyXYZOrigin") || !strings.Contains(string(jsBody), "applyOriginSource") || !strings.Contains(string(jsBody), "originTargetsFromOriginSource") || !strings.Contains(string(jsBody), "originTargetsFromXYZ") || !strings.Contains(string(jsBody), "machineAnchorPoints") || !strings.Contains(string(jsBody), "runAutoZProbe") || !strings.Contains(string(jsBody), "recallSelectedOrigin") || !strings.Contains(string(jsBody), "saveCurrentOrigin") || !strings.Contains(string(jsBody), "deleteSelectedOrigin") || !strings.Contains(string(jsBody), "saved_origins") || !strings.Contains(string(jsBody), `type: "target"`) || !strings.Contains(string(jsBody), `type: "step"`) || !strings.Contains(string(jsBody), `type: "origin"`) || !strings.Contains(string(jsBody), "G10L20P0") || !strings.Contains(string(jsBody), "/api/probe/auto-z") || !strings.Contains(string(jsBody), "/api/machine/status") || !strings.Contains(string(jsBody), "motion_estimated") {
		t.Errorf("app.js missing work area, tap move, jog status messaging, or cache-only status polling")
	}
	for _, want := range []string{"defaultOutlineState", "startOutlineCapture", "endOutlineCapture", "addOutlinePoint", "undoOutline", "redoOutline", "closeOutline", "toggleOutlineCurveFit", "traceOutline", "traceOutlineMachinePoints", "/api/outline/trace", "probeFloor", "rebaseOutlineToFloor", "/api/probe/floor", "floor_machine_z", "runFieldProbe", "probeZAtWorkPoint", "currentOutlineCapturePosition", "retractZMM: startZMM", "/api/probe/z", "PROBE_SPOT_DIAMETER_MM", "OUTLINE_CURVE_TOLERANCE_MM", "MAX_EFFECTIVE_OUTLINE_POINTS", "effectiveOutlineGeometry", "outlineEffectiveExportPoints", "buildBoundaryProbePoints", "buildRelaxedProbePoints", "relaxProbeDistribution", "probeSpotFitsPolygon", "renderWorkAreaOutline", "renderWorkAreaFieldProbePreview", "outlinePathD", "outlineCubicSegments", "buildOutlineDXF", "outlineJSONDocument", "saveOutlineJSON", "loadOutlineFile", "outlineStateFromJSON", "application/json", "application/dxf", "$INSUNITS", "AC1009", "POLYLINE", "VERTEX", "SEQEND", "buildHeightMeshVertices", "exportHeightOBJ", "exportHeightImage", "safe_z_enabled", "safe_z_disabled"} {
		if !strings.Contains(string(jsBody), want) {
			t.Errorf("app.js missing outline capture behavior %s", want)
		}
	}
	for _, want := range []string{"confirmProbeAction", "floor_probe", "field_reference_machine_z", "fieldProbeHeightReference", "exportWorkOrigin", "requireHeightExportOutline", "buildHeightOBJ", "buildHeightPGM", "constrainedOutlineTriangles", "improveConstrainedDelaunay"} {
		if !strings.Contains(string(jsBody), want) {
			t.Errorf("app.js missing probe confirmation, persistence, or mesh behavior %s", want)
		}
	}
	for _, gone := range []string{"fieldProbeSafeZ", "field_safe_z_mm", "retractAboveMM: travelZMM"} {
		if strings.Contains(string(jsBody), gone) {
			t.Errorf("app.js still contains removed field probe safe Z behavior %s", gone)
		}
	}
	for _, gone := range []string{"buildOutlineSVG", "svgExportPoint", "visible_svg", "field-probe-layer", "table-layer"} {
		if strings.Contains(string(jsBody), gone) {
			t.Errorf("app.js still contains removed SVG export marker %s", gone)
		}
	}
	if got := js.Header.Get("Cache-Control"); got != "no-store" {
		t.Errorf("app.js Cache-Control = %q, want no-store", got)
	}
	three := get(t, srv.URL+"/three.module.min.js")
	threeBody, _ := io.ReadAll(three.Body)
	three.Body.Close()
	if three.StatusCode != http.StatusOK || !strings.Contains(string(threeBody[:min(len(threeBody), 200)]), "Three.js Authors") {
		t.Errorf("three.module.min.js status=%d", three.StatusCode)
	}
	if got := three.Header.Get("Cache-Control"); got != "no-store" {
		t.Errorf("three.module.min.js Cache-Control = %q, want no-store", got)
	}
	for _, want := range []string{"rememberCommand", "navigateCommandHistory", "renderAlarmPanel", "HALT_REASON", "controlPendingText", "controlSuccessText", "confirmControl", "bindDataControlButtons", "data-control-action", "renderFileSummary", "lineMatchesFilter", "setHeaderCollapsed", "selectActiveGcode", "runActiveGcode", "renderDashboard", `classList.toggle("is-empty", !active.path)`, `document.querySelector(".active-gcode-workspace")?.classList.toggle("is-empty", !active.path);`, "drawDashboardGcodePreview", "ensureDashboardGcodeViewer", "populateGcodePathScene", "drawGcodePreview", "activeJobPreviewState", "gcodeCursorForPlayedLine", "syncActiveGcodeFromMachine", "clearMissingActiveGcode", "ensureActiveGcodeGeometry", "ensureActiveGcodeSource", "fetchActiveGcodeSourcePage", "renderActiveGcodeSource", "gcodeSourceLineForCursor", "gcodeSourceWindow", "syncActiveGcodeSourceLine", "showActiveJobLeftTab", "activeJobLeftTabs", "activeJobSplitBounds", "setActiveJobSplitPercent", "bindActiveJobSplitter", "initializeResponsiveControlSections", "activeJobOverlayOriginFrom", "activeJobContextOverlayData", "interpolateOutlinePathZ", "activeJobFieldProbeComplete", "field_probe_complete", "syncGcodeContextOverlay", "rebuildGcodeContextOverlay", "combineGcodeBounds", "gcodeRenderPixelRatio", "viewCubeTargetComponents", "gcodeOrbitAnglesForDirection", `projection: "orthographic"`, `gcodeOrbitAnglesForDirection({ x: 1, y: 1, z: 1 })`, "onGcodeViewCubePointerMove", "rotateGcodeOrbitByDrag", "gcodeCubeDragStep", "THREE.WebGLRenderer", "gcodeWorldCoordinates", "gcodeWorldPoint", "panGcodeCamera", "/api/gcode/active/segments", "/api/gcode/active/source", "/api/files/", "/api/tool/current", "/api/tool/change", "/api/tool/continue", "/api/tool/calibrate", "/api/probe/3d", "runProbe3D", "is3DProbeToolActive"} {
		if !strings.Contains(string(jsBody), want) {
			t.Errorf("app.js missing %s", want)
		}
	}
	for _, want := range []string{`function renderToolActions`, `const waitingForTool = m.state === "Tool"`, `const continueAvailable = waitingForTool`, `tool-wait-row`, `tool-wait-status`, `set.disabled = setPending || waitingForTool`, `change.disabled = changePending || waitingForTool`, `cont.disabled = continuePending`, `setSoftDisabled(cont, !continuePending && !continueAvailable)`, `cal.disabled = calibratePending || waitingForTool`, `function refreshMachineAfterToolAction`, `isProbeToolActive()`} {
		if !strings.Contains(string(jsBody), want) {
			t.Errorf("app.js missing tool wait-state UI policy %s", want)
		}
	}
	if strings.Contains(string(jsBody), "toolChangeAwaitingContinue") {
		t.Error("tool Continue availability must follow the observed machine Tool state, not a stale local latch")
	}
	for _, old := range []string{`cal.disabled = pending || waitingForTool`, `change.disabled = pending || waitingForTool`, `set.disabled = pending || waitingForTool`, `cont.disabled = pending || !waitingForTool`, `await pollMachine();
    setTimeout(pollMachine, 1200);`} {
		if strings.Contains(string(jsBody), old) {
			t.Errorf("app.js still contains popup-wide tool action lock %s", old)
		}
	}
	if strings.Contains(string(jsBody), "function setToolContinueAvailability") || strings.Contains(string(jsBody), "function setToolButtonsPending") {
		t.Errorf("app.js still has split tool action state ownership")
	}
	if strings.Contains(string(jsBody), "renderStatusFields") {
		t.Errorf("app.js still contains removed status details renderer")
	}
	if strings.Contains(string(jsBody), "renderCommandHistory") || strings.Contains(string(jsBody), "[data-gcode]") {
		t.Errorf("app.js still contains removed command button/list handling")
	}
	if strings.Contains(string(jsBody), "Emergency halt the machine?") {
		t.Errorf("app.js must not confirm emergency halt")
	}
	for _, want := range []string{"directoryRows", "renderFolderTree", "renderFolderChrome", "openDir", "doMkdir", "joinRelPath", "retryJob", "discardFile", "/api/files/retry", "/api/files/discard"} {
		if !strings.Contains(string(jsBody), want) {
			t.Errorf("app.js missing %s", want)
		}
	}
	for _, want := range []string{"loadUISettings", "saveUISettings", "renderMacroButtons", "runMacro", "/api/ui/settings"} {
		if !strings.Contains(string(jsBody), want) {
			t.Errorf("app.js missing %s", want)
		}
	}
	for _, want := range []string{"defaultGamepadSettings", "renderGamepadSettings", "mappedAxis", "handleGamepadMacroButtons", "addGamepadMacroBinding", "gamepadLabel", "Xbox-compatible gamepad", "standard gamepad", "defaultMachineSettings", "normalizeMachineLearned", "renderMachineSettings", "machineLearnedSummaryLines", "learnMachineParameters", "renderOriginSetChange", "learned_profiles", "openMachineSettings", "closeMachineSettings", "showModal", "connection-status", "Machine connection outage", "/api/machine/learn", "updateWorkAreaHoverPosition", "handleWorkAreaTap", "bindWorkAreaInteractions", "zoomWorkArea"} {
		if !strings.Contains(string(jsBody), want) {
			t.Errorf("app.js missing %s", want)
		}
	}
	for _, want := range []string{"scheduleJogReconnect", "clearJogReconnect", "preferredPadIndex", "visibilitychange", "armQueuedAction", "flushQueuedTapMoveArm", "tapMoveArmFailureText", "setSoftDisabled", "aria-disabled"} {
		if !strings.Contains(string(jsBody), want) {
			t.Errorf("app.js missing jog reconnect behavior %s", want)
		}
	}
	for _, want := range []string{"jogEstimateActive", "estimatedUntil", "shouldPreserveJogPrediction", "reconcileObservedMachineStatus", "mergeMachineStatusForDisplay"} {
		if !strings.Contains(string(jsBody), want) {
			t.Errorf("app.js missing jog estimate display behavior %s", want)
		}
	}
}

func TestUISettingsAPI(t *testing.T) {
	srv, _ := newTestServer(t)

	resp := get(t, srv.URL+"/api/ui/settings")
	var initial store.UISettings
	json.NewDecoder(resp.Body).Decode(&initial)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || initial.Log.Filter != "all" || !initial.Log.Autoscroll {
		t.Fatalf("initial settings status=%d value=%+v", resp.StatusCode, initial)
	}
	if initial.Macros == nil || initial.MacroButtons == nil || initial.Machine.SavedOrigins == nil || initial.Gamepad.SlowButtons == nil || initial.Gamepad.MacroButtons == nil {
		t.Fatalf("initial settings should use empty arrays, got %+v", initial)
	}
	if initial.Dashboard.DefaultProfileID != "overview" || len(initial.Dashboard.Profiles) != 1 || initial.Dashboard.Profiles[0].GcodeLines != 9 {
		t.Fatalf("initial dashboard defaults = %+v", initial.Dashboard)
	}
	if initial.Gamepad.Axes.Y.Axis != 1 || !initial.Gamepad.Axes.Y.Invert || initial.Gamepad.Axes.Z.Axis != 3 {
		t.Fatalf("initial gamepad defaults = %+v", initial.Gamepad)
	}
	if initial.Machine.WorkArea.XMin != -302 || initial.Machine.WorkArea.XMax != -1 || initial.Machine.WorkArea.YMin != -212 || initial.Machine.WorkArea.YMax != -1 || initial.Machine.FeedMinMMMin != 1 || initial.Machine.FeedMaxMMMin != 3000 || initial.Machine.TapFeedMMMin != 600 {
		t.Fatalf("initial machine defaults = %+v", initial.Machine)
	}

	body := `{
		"macros":[{"id":"m1","name":"Probe","lines":["G38.2 Z-5 F50","G10 L20 P1 Z0"],"color":"#44c27b"}],
		"macro_buttons":[{"id":"b1","macro_id":"m1","region":"toolbar","order":2}],
		"log":{"filter":"jog","autoscroll":false},
		"dashboard":{"profiles":[{"id":"recording","name":"Recording","layout":"grid","density":"compact","background":"transparent","panels":["job","gcode","telemetry"],"gcode_lines":17}],"default_profile_id":"recording"},
		"machine":{"work_area":{"x_min":-300,"x_max":5,"y_min":-210,"y_max":10},"origin":{"x":1,"y":2},"saved_origins":[{"id":"fixture","label":"Fixture","origin":{"x":-12.5,"y":-20}}],"feed_min_mm_min":100,"feed_max_mm_min":1800,"tap_feed_mm_min":700},
		"gamepad":{
			"axes":{
				"x":{"axis":2,"invert":false,"scale":0.5},
				"y":{"axis":1,"invert":false,"scale":0.75},
				"z":{"axis":3,"invert":true,"scale":0.25}
			},
			"deadman_button":7,
			"slow_buttons":[6],
			"macro_buttons":[{"id":"gp1","button":1,"macro_id":"m1"}]
		}
	}`
	req, _ := http.NewRequest("PUT", srv.URL+"/api/ui/settings", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp = do(t, req)
	var saved store.UISettings
	json.NewDecoder(resp.Body).Decode(&saved)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || len(saved.Macros) != 1 || len(saved.MacroButtons) != 1 {
		t.Fatalf("saved settings status=%d value=%+v", resp.StatusCode, saved)
	}
	if saved.Log.Filter != "jog" || saved.Log.Autoscroll {
		t.Fatalf("saved log settings = %+v", saved.Log)
	}
	if saved.Dashboard.DefaultProfileID != "recording" || len(saved.Dashboard.Profiles) != 1 || saved.Dashboard.Profiles[0].Background != "transparent" || saved.Dashboard.Profiles[0].GcodeLines != 17 {
		t.Fatalf("saved dashboard settings = %+v", saved.Dashboard)
	}
	if saved.Gamepad.Axes.X.Axis != 2 || saved.Gamepad.Axes.X.Scale != 0.5 || saved.Gamepad.DeadmanButton != 7 {
		t.Fatalf("saved gamepad settings = %+v", saved.Gamepad)
	}
	if saved.Machine.WorkArea.XMin != -300 || saved.Machine.WorkArea.YMax != 10 || saved.Machine.Origin.X != 1 || saved.Machine.FeedMinMMMin != 100 || saved.Machine.FeedMaxMMMin != 1800 || saved.Machine.TapFeedMMMin != 700 || len(saved.Machine.SavedOrigins) != 1 {
		t.Fatalf("saved machine settings = %+v", saved.Machine)
	}
	if len(saved.Gamepad.MacroButtons) != 1 || saved.Gamepad.MacroButtons[0].Button != 1 {
		t.Fatalf("saved gamepad macro buttons = %+v", saved.Gamepad.MacroButtons)
	}

	resp = get(t, srv.URL+"/api/ui/settings")
	var got store.UISettings
	json.NewDecoder(resp.Body).Decode(&got)
	resp.Body.Close()
	if len(got.Macros) != 1 || got.Macros[0].Name != "Probe" || got.MacroButtons[0].Region != "toolbar" {
		t.Fatalf("round trip settings = %+v", got)
	}
	if got.Gamepad.Axes.Z.Scale != 0.25 || len(got.Gamepad.SlowButtons) != 1 || got.Gamepad.SlowButtons[0] != 6 {
		t.Fatalf("round trip gamepad settings = %+v", got.Gamepad)
	}
	if got.Machine.WorkArea.XMax != 5 || got.Machine.Origin.Y != 2 || got.Machine.FeedMinMMMin != 100 || got.Machine.FeedMaxMMMin != 1800 || got.Machine.TapFeedMMMin != 700 || len(got.Machine.SavedOrigins) != 1 || got.Machine.SavedOrigins[0].Label != "Fixture" {
		t.Fatalf("round trip machine settings = %+v", got.Machine)
	}
	if got.Dashboard.DefaultProfileID != "recording" || got.Dashboard.Profiles[0].Panels[1] != "gcode" {
		t.Fatalf("round trip dashboard settings = %+v", got.Dashboard)
	}
}

func TestUISettingsAPIRejectsInvalidDashboard(t *testing.T) {
	srv, _ := newTestServer(t)
	for _, body := range []string{
		`{"dashboard":{"profiles":[{"id":"Bad ID","name":"Recording","layout":"grid","density":"compact","background":"solid","panels":["job"],"gcode_lines":9}],"default_profile_id":"Bad ID"}}`,
		`{"dashboard":{"profiles":[{"id":"recording","name":"Recording","layout":"floating","density":"compact","background":"solid","panels":["job"],"gcode_lines":9}],"default_profile_id":"recording"}}`,
		`{"dashboard":{"profiles":[{"id":"recording","name":"Recording","layout":"grid","density":"compact","background":"solid","panels":["job","job"],"gcode_lines":9}],"default_profile_id":"recording"}}`,
		`{"dashboard":{"profiles":[{"id":"recording","name":"Recording","layout":"grid","density":"compact","background":"solid","panels":["job"],"gcode_lines":31}],"default_profile_id":"recording"}}`,
	} {
		req, _ := http.NewRequest(http.MethodPut, srv.URL+"/api/ui/settings", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp := do(t, req)
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400 for %s", resp.StatusCode, body)
		}
	}
}

func TestLearnMachineParametersAPI(t *testing.T) {
	srv, m, _, _, st := serverWithMachineState(t)
	m.SetFtype("lz")
	m.SetGcodeReply("model", "model = CarveraAir")
	m.SetGcodeReply("version", "version = 1.2.3")
	m.PutFile("/sd/config.txt", []byte(strings.Join([]string{
		"soft_endstop.x_min=-371.0",
		"soft_endstop.y_min=-250.0",
		"soft_endstop.z_min=-135.0",
		"alpha_max=0",
		"beta_max=0",
		"gamma_max=0",
		"alpha_max_rate=3000.0",
		"beta_max_rate=3000.0",
		"default_seek_rate=3000",
		"coordinate.anchor1_x=-287.51",
		"coordinate.anchor1_y=-202.11",
		"coordinate.anchor2_offset_x=88.5",
		"coordinate.anchor2_offset_y=45.0",
	}, "\n")))

	resp := postJSON(t, srv.URL+"/api/machine/learn", map[string]any{})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d body=%s", resp.StatusCode, body)
	}
	var out service.MachineLearnResult
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Learned.Identity.Model != "CarveraAir" || out.Learned.Identity.Version != "1.2.3" {
		t.Fatalf("learned identity = %+v", out.Learned.Identity)
	}
	if out.UI.Machine.WorkArea != (store.WorkArea{XMin: -371, XMax: -1, YMin: -250, YMax: -1}) {
		t.Fatalf("api learned work area = %+v", out.UI.Machine.WorkArea)
	}
	if !out.Learned.Anchors.Available || out.Learned.Anchors.Anchor1 != (store.XYPoint{X: -287.51, Y: -202.11}) || out.Learned.Anchors.Anchor2 != (store.XYPoint{X: -199.01, Y: -157.11}) {
		t.Fatalf("api learned anchors = %+v", out.Learned.Anchors)
	}
	got := st.UISettings()
	if got.Machine.Learned.Config["soft_endstop.x_min"] != "-371.0" || got.Machine.WorkArea != (store.WorkArea{XMin: -371, XMax: -1, YMin: -250, YMax: -1}) || !got.Machine.Learned.Anchors.Available {
		t.Fatalf("persisted UI settings = %+v", got.Machine)
	}
}

func TestSetMachineOriginReferenceAPIUsesPersistedAnchorProfile(t *testing.T) {
	srv, m, tr, svc, _ := serverWithMachineState(t)
	status := "<Idle|MPos:-100,-80,-3|WPos:0,0,0>"
	m.SetStatus(status)
	if !tr.ObserveStatusPayload(status) {
		t.Fatal("failed to seed tracker status")
	}
	ui := svc.UISettings()
	ui.Machine.Learned = store.MachineLearned{
		LearnedAt: time.Now(),
		Anchors: store.MachineAnchorProfile{
			Available: true,
			Anchor1:   store.XYPoint{X: -287.51, Y: -202.11},
			Anchor2:   store.XYPoint{X: -199.01, Y: -157.11},
		},
	}
	if _, err := svc.SetUISettings(ui); err != nil {
		t.Fatal(err)
	}

	resp := postJSON(t, srv.URL+"/api/origin/reference", map[string]any{
		"reference": "anchor1",
		"x":         10,
		"y":         -3,
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d body=%s", resp.StatusCode, body)
	}
	var result service.MachineOriginResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.Command != "G10L2P0X-277.5100Y-205.1100" {
		t.Fatalf("origin result = %+v", result)
	}
	if math.Abs(result.Target["x"]-177.51) > 1e-9 || math.Abs(result.Target["y"]-125.11) > 1e-9 {
		t.Fatalf("verification target = %+v", result.Target)
	}
	if got := m.Gcodes(); len(got) != 1 || got[0] != result.Command {
		t.Fatalf("gcodes = %v, want [%s]", got, result.Command)
	}
}

func TestUISettingsAPIRejectsInvalidMacro(t *testing.T) {
	srv, _ := newTestServer(t)
	req, _ := http.NewRequest("PUT", srv.URL+"/api/ui/settings", strings.NewReader(`{"macros":[{"id":"bad","name":"Bad","lines":["   "]}]}`))
	req.Header.Set("Content-Type", "application/json")
	resp := do(t, req)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

func TestUISettingsAPIRejectsInvalidGamepad(t *testing.T) {
	srv, _ := newTestServer(t)
	body := `{
		"macros":[{"id":"m1","name":"Position","lines":["M114"]}],
		"gamepad":{"axes":{"x":{"axis":99,"scale":1}}}
	}`
	req, _ := http.NewRequest("PUT", srv.URL+"/api/ui/settings", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp := do(t, req)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

func TestUISettingsAPIRejectsInvalidMachine(t *testing.T) {
	srv, _ := newTestServer(t)
	for _, body := range []string{
		`{"machine":{"work_area":{"x_min":10,"x_max":0,"y_min":-200,"y_max":0},"tap_feed_mm_min":600}}`,
		`{"machine":{"feed_min_mm_min":2000,"feed_max_mm_min":1000,"tap_feed_mm_min":600}}`,
	} {
		req, _ := http.NewRequest("PUT", srv.URL+"/api/ui/settings", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp := do(t, req)
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400 for %s", resp.StatusCode, body)
		}
	}
}

// serverWithMachine wires the API to a real fake machine + tracker so gcode and
// control endpoints can be exercised end to end with controllable state.
func serverWithMachine(t *testing.T) (*httptest.Server, *carveratest.FakeMachine, *machine.Tracker) {
	t.Helper()
	srv, m, tr, _, _ := serverWithMachineState(t)
	return srv, m, tr
}

func serverWithMachineState(t *testing.T) (*httptest.Server, *carveratest.FakeMachine, *machine.Tracker, *service.Service, *store.Store) {
	t.Helper()
	m, err := carveratest.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	tr := machine.NewTracker()
	arb := session.New(session.Config{
		Tracker: tr,
		Dial: func() (*client.Conn, error) {
			return client.Dial(m.Addr(), 2*time.Second, client.WithUploadStartDelay(0))
		},
	})
	svc, err := service.New(st, arb)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(New(svc).Handler())
	t.Cleanup(srv.Close)
	return srv, m, tr, svc, st
}

func serverWithJog(t *testing.T, auth bool) (*httptest.Server, *carveratest.FakeMachine, *machine.Tracker) {
	t.Helper()
	srv, m, tr, _ := serverWithJogState(t, auth)
	return srv, m, tr
}

func serverWithJogState(t *testing.T, auth bool) (*httptest.Server, *carveratest.FakeMachine, *machine.Tracker, *service.Service) {
	t.Helper()
	m, err := carveratest.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	status := "<Idle|MPos:0,0,0|WPos:0,0,0|F:0,0,100|S:0,0,100>"
	m.SetStatus(status)
	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	tr := machine.NewTracker()
	if !tr.ObserveStatusPayload(status) {
		t.Fatal("status precondition failed")
	}
	arb := session.New(session.Config{
		Tracker:     tr,
		StateMaxAge: time.Second,
		Dial: func() (*client.Conn, error) {
			return client.Dial(m.Addr(), 2*time.Second, client.WithUploadStartDelay(0))
		},
	})
	svc, err := service.New(st, arb)
	if err != nil {
		t.Fatal(err)
	}
	cfg := jog.DefaultConfig()
	cfg.Tick = 20 * time.Millisecond
	cfg.StatusInterval = 40 * time.Millisecond
	cfg.DeadmanTimeout = 120 * time.Millisecond
	h := NewWithOptions(svc, Options{Jog: jog.New(arb, cfg)}).Handler()
	if auth {
		h = httpauth.Middleware(httpauth.Config{User: "operator", Token: "secret", SuppressAPIChallenge: true}, h)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv, m, tr, svc
}

func TestJogCapabilities(t *testing.T) {
	srv, _, _ := serverWithJog(t, false)
	resp := get(t, srv.URL+"/api/jog/capabilities")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	var caps jog.Capabilities
	if err := json.NewDecoder(resp.Body).Decode(&caps); err != nil {
		t.Fatal(err)
	}
	if !caps.Enabled || caps.Axes[0] != "x" || !caps.Availability.Available {
		t.Fatalf("capabilities = %+v", caps)
	}
}

func TestJogWebSocketAuth(t *testing.T) {
	srv, _, _ := serverWithJog(t, true)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, resp, err := websocket.Dial(ctx, wsURL(srv.URL), nil)
	if err == nil || resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated dial err=%v resp=%v", err, resp)
	}
	if challenge := resp.Header.Get("WWW-Authenticate"); challenge != "" {
		t.Fatalf("unauthenticated background dial challenge = %q, want none", challenge)
	}

	loginReq, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/machine/status", nil)
	loginReq.SetBasicAuth("operator", "secret")
	loginResp := do(t, loginReq)
	loginResp.Body.Close()
	cookies := loginResp.Cookies()
	if loginResp.StatusCode != http.StatusOK || len(cookies) != 1 {
		t.Fatalf("login status=%d cookies=%d, want 200/1", loginResp.StatusCode, len(cookies))
	}
	cookieHeader := make(http.Header)
	cookieHeader.Set("Cookie", cookies[0].String())

	c, _, err := websocket.Dial(ctx, wsURL(srv.URL), &websocket.DialOptions{
		HTTPHeader: cookieHeader,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(websocket.StatusNormalClosure, "")
	if ev := readWSEvent(t, c, "hello"); ev.Type != "hello" || ev.Capabilities == nil || !ev.Capabilities.Availability.Available {
		t.Fatalf("event = %+v", ev)
	}
}

func TestJogWebSocketBadAxis(t *testing.T) {
	srv, _, _ := serverWithJog(t, false)
	c := dialWS(t, srv.URL)
	defer c.Close(websocket.StatusNormalClosure, "")
	readWSEvent(t, c, "hello")
	writeWS(t, c, map[string]any{"type": "input", "seq": 1, "deadman": true, "axes": map[string]float64{"a": 1}})
	ev := readWSEvent(t, c, "error")
	if ev.Code != jog.CodeBadInput {
		t.Fatalf("error = %+v", ev)
	}
}

func TestJogWebSocketMovementOwnershipHandoff(t *testing.T) {
	srv, _, _ := serverWithJog(t, false)
	first := dialWS(t, srv.URL)
	defer first.Close(websocket.StatusNormalClosure, "")
	readWSEvent(t, first, "hello")

	second := dialWS(t, srv.URL)
	defer second.Close(websocket.StatusNormalClosure, "")
	readWSEvent(t, second, "hello")

	writeWS(t, first, map[string]any{"type": "arm", "seq": 1})
	readWSEvent(t, first, "ack")
	firstArmed := readWSStateWhere(t, first, func(ev jog.Event) bool { return ev.Armed != nil && *ev.Armed })
	if firstArmed.Availability == nil || !firstArmed.Availability.Available {
		t.Fatalf("first armed state = %+v", firstArmed)
	}
	secondBusy := readWSStateWhere(t, second, func(ev jog.Event) bool {
		return ev.Armed != nil && !*ev.Armed && ev.Availability != nil && ev.Availability.Reason == jog.CodeBusy
	})
	if secondBusy.Availability == nil || secondBusy.Availability.Reason != jog.CodeBusy {
		t.Fatalf("second observer state = %+v, want busy", secondBusy)
	}
	writeWS(t, second, map[string]any{"type": "disarm", "seq": 2})
	readWSEvent(t, second, "ack")
	firstDisarmed := readWSStateWhere(t, first, func(ev jog.Event) bool {
		return ev.Armed != nil && !*ev.Armed && ev.Availability != nil && ev.Availability.Available
	})
	if firstDisarmed.Armed == nil || *firstDisarmed.Armed {
		t.Fatalf("first state after remote disarm = %+v", firstDisarmed)
	}
	readWSStateWhere(t, second, func(ev jog.Event) bool {
		return ev.Armed != nil && !*ev.Armed && ev.Availability != nil && ev.Availability.Available
	})

	writeWS(t, second, map[string]any{"type": "arm", "seq": 3})
	readWSEvent(t, second, "ack")
	secondArmed := readWSStateWhere(t, second, func(ev jog.Event) bool { return ev.Armed != nil && *ev.Armed })
	if secondArmed.Availability == nil || !secondArmed.Availability.Available {
		t.Fatalf("second armed state = %+v", secondArmed)
	}
	firstBusy := readWSStateWhere(t, first, func(ev jog.Event) bool {
		return ev.Armed != nil && !*ev.Armed && ev.Availability != nil && ev.Availability.Reason == jog.CodeBusy
	})
	if firstBusy.Availability == nil || firstBusy.Availability.Reason != jog.CodeBusy {
		t.Fatalf("first observer after takeover = %+v, want busy", firstBusy)
	}
}

func TestJogWebSocketObserversReceiveOwnerMotion(t *testing.T) {
	srv, _, _ := serverWithJog(t, false)
	owner := dialWS(t, srv.URL)
	defer owner.Close(websocket.StatusNormalClosure, "")
	readWSEvent(t, owner, "hello")

	observer := dialWS(t, srv.URL)
	defer observer.Close(websocket.StatusNormalClosure, "")
	readWSEvent(t, observer, "hello")

	writeWS(t, owner, map[string]any{"type": "arm", "seq": 1})
	readWSEvent(t, owner, "ack")
	readWSStateWhere(t, observer, func(ev jog.Event) bool {
		return ev.Availability != nil && ev.Availability.Reason == jog.CodeBusy
	})
	writeWS(t, owner, map[string]any{"type": "step", "seq": 2, "axis": "z", "distance": 1})
	readWSEvent(t, owner, "ack")
	observerMotion := readWSEvent(t, observer, "motion")
	if observerMotion.Motion == nil || observerMotion.Motion.Target["z"] != 1 || observerMotion.Motion.Revision == 0 {
		t.Fatalf("observer motion = %+v, want shared Z target", observerMotion)
	}
}

func TestJogWebSocketArmAndInput(t *testing.T) {
	srv, m, _ := serverWithJog(t, false)
	c := dialWS(t, srv.URL)
	defer c.Close(websocket.StatusNormalClosure, "")
	readWSEvent(t, c, "hello")
	writeWS(t, c, map[string]any{"type": "arm", "seq": 1})
	readWSEvent(t, c, "ack")
	writeWS(t, c, map[string]any{"type": "input", "seq": 2, "deadman": true, "axes": map[string]float64{"x": 1}})

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		for _, line := range m.Gcodes() {
			if strings.HasPrefix(line, "$J X") {
				writeWS(t, c, map[string]any{"type": "input", "seq": 3, "deadman": false, "axes": map[string]float64{"x": 0}})
				time.Sleep(40 * time.Millisecond)
				stopped := len(m.Gcodes())
				time.Sleep(400 * time.Millisecond)
				if got := len(m.Gcodes()); got != stopped {
					t.Fatalf("WebSocket release admitted later jog frames: stopped=%d got=%d gcodes=%v", stopped, got, m.Gcodes())
				}
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no jog command observed: %v", m.Gcodes())
}

func TestJogWebSocketCapturesReleasedQueueEndpoint(t *testing.T) {
	srv, m, _ := serverWithJog(t, false)
	c := dialWS(t, srv.URL)
	defer c.Close(websocket.StatusNormalClosure, "")
	readWSEvent(t, c, "hello")
	writeWS(t, c, map[string]any{"type": "arm", "seq": 1})
	readWSEvent(t, c, "ack")
	writeWS(t, c, map[string]any{"type": "input", "seq": 2, "deadman": true, "axes": map[string]float64{"x": 1}})

	deadline := time.Now().Add(time.Second)
	for len(m.Gcodes()) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if len(m.Gcodes()) == 0 {
		t.Fatal("no jog command reached the fake machine before capture")
	}

	// WebSocket message order is the capture contract: release first, then
	// freeze the endpoint that the already-admitted queue will reach.
	writeWS(t, c, map[string]any{"type": "input", "seq": 3, "deadman": false, "axes": map[string]float64{"x": 0}})
	writeWS(t, c, map[string]any{"type": "capture_position", "seq": 4})
	ev := readWSEvent(t, c, "position_capture")
	if ev.Seq != 4 || ev.Position == nil {
		t.Fatalf("capture event = %+v, want seq 4 position", ev)
	}
	if ev.Position.MPos["x"] <= 0 || ev.Position.WPos["x"] != ev.Position.MPos["x"] {
		t.Fatalf("capture position = %+v, want released positive-X endpoint with zero work offset", ev.Position)
	}
	if ev.Position.MotionRevision == 0 {
		t.Fatalf("capture position = %+v, want the admitted motion revision", ev.Position)
	}
}

func TestJogWebSocketStep(t *testing.T) {
	srv, m, _ := serverWithJog(t, false)
	c := dialWS(t, srv.URL)
	defer c.Close(websocket.StatusNormalClosure, "")
	readWSEvent(t, c, "hello")
	writeWS(t, c, map[string]any{"type": "arm", "seq": 1})
	readWSEvent(t, c, "ack")

	writeWS(t, c, map[string]any{"type": "step", "seq": 2, "axis": "x", "distance": 1})
	ack := readWSEvent(t, c, "ack")
	if ack.Seq != 2 {
		t.Fatalf("step ack = %+v, want seq 2", ack)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		for _, line := range m.Gcodes() {
			if strings.HasPrefix(line, "$J X1.0000") {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no step jog command observed: %v", m.Gcodes())
}

func TestJogWebSocketSetsServerResolvedAnchorOrigin(t *testing.T) {
	srv, m, _, svc := serverWithJogState(t, false)
	ui := svc.UISettings()
	ui.Machine.Learned = store.MachineLearned{
		LearnedAt: time.Now(),
		Anchors: store.MachineAnchorProfile{
			Available: true,
			Anchor1:   store.XYPoint{X: -287.51, Y: -202.11},
			Anchor2:   store.XYPoint{X: -199.01, Y: -157.11},
		},
	}
	if _, err := svc.SetUISettings(ui); err != nil {
		t.Fatal(err)
	}
	c := dialWS(t, srv.URL)
	defer c.Close(websocket.StatusNormalClosure, "")
	readWSEvent(t, c, "hello")
	writeWS(t, c, map[string]any{"type": "arm", "seq": 1})
	readWSEvent(t, c, "ack")

	writeWS(t, c, map[string]any{
		"type":      "origin_reference",
		"seq":       2,
		"reference": "anchor1",
		"x":         10,
		"y":         -3,
	})
	ack := readWSEvent(t, c, "ack")
	if ack.Seq != 2 || math.Abs(ack.Target["x"]-277.51) > 1e-9 || math.Abs(ack.Target["y"]-205.11) > 1e-9 {
		t.Fatalf("origin ack = %+v", ack)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		for _, line := range m.Gcodes() {
			if line == "G10L2P0X-277.5100Y-205.1100" {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no server-resolved origin command observed: %v", m.Gcodes())
}

func TestJogWebSocketTarget(t *testing.T) {
	srv, m, _ := serverWithJog(t, false)
	c := dialWS(t, srv.URL)
	defer c.Close(websocket.StatusNormalClosure, "")
	readWSEvent(t, c, "hello")
	writeWS(t, c, map[string]any{"type": "arm", "seq": 1})
	readWSEvent(t, c, "ack")

	writeWS(t, c, map[string]any{"type": "target", "seq": 2, "target": map[string]float64{"x": 10, "y": -5}, "feed_mm_min": 600})
	ack := readWSEvent(t, c, "ack")
	if ack.Seq != 2 {
		t.Fatalf("target ack = %+v, want seq 2", ack)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		for _, line := range m.Gcodes() {
			if strings.Contains(line, "X10.0000") && strings.Contains(line, "Y-5.0000") {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no target jog command observed: %v", m.Gcodes())
}

func TestJogWebSocketTargetZ(t *testing.T) {
	srv, m, _ := serverWithJog(t, false)
	c := dialWS(t, srv.URL)
	defer c.Close(websocket.StatusNormalClosure, "")
	readWSEvent(t, c, "hello")
	writeWS(t, c, map[string]any{"type": "arm", "seq": 1})
	readWSEvent(t, c, "ack")

	writeWS(t, c, map[string]any{"type": "target", "seq": 2, "target": map[string]float64{"z": 3}, "feed_mm_min": 600})
	ack := readWSEvent(t, c, "ack")
	if ack.Seq != 2 {
		t.Fatalf("target ack = %+v, want seq 2", ack)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		for _, line := range m.Gcodes() {
			if strings.Contains(line, "Z3.0000") {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no Z target jog command observed: %v", m.Gcodes())
}

func TestJogWebSocketTargetSafeZ(t *testing.T) {
	srv, m, tr := serverWithJog(t, false)
	status := "<Idle|MPos:0,0,-4|WPos:0,0,-4|F:0,0,100|S:0,0,100>"
	m.SetStatus(status)
	if !tr.ObserveStatusPayload(status) {
		t.Fatal("failed to seed tracker status")
	}
	c := dialWS(t, srv.URL)
	defer c.Close(websocket.StatusNormalClosure, "")
	readWSEvent(t, c, "hello")
	writeWS(t, c, map[string]any{"type": "arm", "seq": 1})
	readWSEvent(t, c, "ack")

	writeWS(t, c, map[string]any{"type": "target", "seq": 2, "target": map[string]float64{"x": 10, "y": -5}, "feed_mm_min": 600, "safe_z_enabled": true, "safe_z_mm": 0})
	ack := readWSEvent(t, c, "ack")
	if ack.Seq != 2 {
		t.Fatalf("target ack = %+v, want seq 2", ack)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		gcodes := m.Gcodes()
		if len(gcodes) >= 2 {
			if !strings.Contains(gcodes[0], "Z1.0000") || !strings.Contains(gcodes[1], "X10.0000") || !strings.Contains(gcodes[1], "Y-5.0000") {
				t.Fatalf("safe target gcodes = %v", gcodes)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no safe target jog commands observed: %v", m.Gcodes())
}

func TestJogWebSocketStatusTimeoutDoesNotCloseSession(t *testing.T) {
	srv, m, _ := serverWithJog(t, false)
	c := dialWS(t, srv.URL)
	defer c.Close(websocket.StatusNormalClosure, "")
	readWSEvent(t, c, "hello")
	writeWS(t, c, map[string]any{"type": "arm", "seq": 1})
	readWSEvent(t, c, "ack")

	m.SetStatus("<Run|MPos:0,0,0|WPos:0,0,0>")
	m.SetStatusReplyDelay(500 * time.Millisecond)
	writeWS(t, c, map[string]any{"type": "input", "seq": 2, "deadman": true, "axes": map[string]float64{"x": 1}})
	ev := readWSEvent(t, c, "error")
	if ev.Code != jog.CodeStatusWaiting {
		t.Fatalf("error = %+v, want status_waiting", ev)
	}

	writeWS(t, c, map[string]any{"type": "disarm", "seq": 3})
	ack := readWSEvent(t, c, "ack")
	if ack.Seq != 3 {
		t.Fatalf("ack = %+v, want disarm ack", ack)
	}
}

func wsURL(httpURL string) string {
	return "ws" + strings.TrimPrefix(httpURL, "http") + "/api/jog/ws"
}

func basicAuthHeader(user, pass string) http.Header {
	h := http.Header{}
	token := base64.StdEncoding.EncodeToString([]byte(user + ":" + pass))
	h.Set("Authorization", "Basic "+token)
	return h
}

func dialWS(t *testing.T, serverURL string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, wsURL(serverURL), nil)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func writeWS(t *testing.T, c *websocket.Conn, v any) {
	t.Helper()
	b, _ := json.Marshal(v)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := c.Write(ctx, websocket.MessageText, b); err != nil {
		t.Fatal(err)
	}
}

func readWSEvent(t *testing.T, c *websocket.Conn, typ string) jog.Event {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithDeadline(context.Background(), deadline)
		_, b, err := c.Read(ctx)
		cancel()
		if err != nil {
			t.Fatalf("read websocket event %q: %v", typ, err)
		}
		var ev jog.Event
		if err := json.Unmarshal(b, &ev); err != nil {
			t.Fatalf("decode event %q: %v", string(b), err)
		}
		if ev.Type == typ {
			return ev
		}
	}
	t.Fatalf("timeout waiting for websocket event %q", typ)
	return jog.Event{}
}

func readWSStateWhere(t *testing.T, c *websocket.Conn, match func(jog.Event) bool) jog.Event {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithDeadline(context.Background(), deadline)
		_, b, err := c.Read(ctx)
		cancel()
		if err != nil {
			t.Fatalf("read matching websocket state: %v", err)
		}
		var ev jog.Event
		if err := json.Unmarshal(b, &ev); err != nil {
			t.Fatalf("decode event %q: %v", string(b), err)
		}
		if ev.Type == "error" {
			t.Fatalf("unexpected websocket error waiting for state: %+v", ev)
		}
		if ev.Type == "state" && match(ev) {
			return ev
		}
	}
	t.Fatal("timeout waiting for matching websocket state")
	return jog.Event{}
}

func postJSON(t *testing.T, url string, body any) *http.Response {
	t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", url, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	return do(t, req)
}

func postRaw(t *testing.T, url, body string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest("POST", url, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/octet-stream")
	return do(t, req)
}

func TestPostGcodeMotionGatedByState(t *testing.T) {
	srv, m, tr := serverWithMachine(t)

	// Running: a motion command is rejected with 503 and never reaches the machine.
	m.SetStatus("<Run|MPos:0,0,0|WPos:0,0,0>")
	tr.Observe(machine.Run)
	resp := postJSON(t, srv.URL+"/api/gcode", map[string]string{"line": "G91 G0 X-10"})
	resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("motion during Run: status = %d, want 503", resp.StatusCode)
	}
	if g := m.Gcodes(); len(g) != 0 {
		t.Fatalf("motion leaked to machine: %v", g)
	}

	// Idle: accepted.
	m.SetStatus("<Idle|MPos:0,0,0|WPos:0,0,0>")
	tr.Observe(machine.Idle)
	resp2 := postJSON(t, srv.URL+"/api/gcode", map[string]string{"line": "G91 G0 X-10"})
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("motion during Idle: status = %d, want 200", resp2.StatusCode)
	}
}

func TestPostGcodeQueryNotGated(t *testing.T) {
	srv, m, tr := serverWithMachine(t)
	m.SetGcodeReply("M114", "ok C: X:1.0")
	tr.Observe(machine.Run) // still running

	resp := postJSON(t, srv.URL+"/api/gcode", map[string]string{"line": "M114"})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("query during Run: status = %d, want 200", resp.StatusCode)
	}
	var out map[string]string
	json.NewDecoder(resp.Body).Decode(&out)
	if out["output"] != "C: X:1.0" {
		t.Errorf("output = %q", out["output"])
	}
}

func TestProbeZEndpointSerializesSafeMoveProbeAndLift(t *testing.T) {
	srv, m, tr := serverWithMachine(t)
	status := "<Idle|MPos:0,0,0|WPos:0,0,0|T:0,0>"
	m.SetStatus(status)
	if !tr.ObserveStatusPayload(status) {
		t.Fatal("failed to seed tracker status")
	}
	m.SetGcodeReply("G38.2 Z-5.0000 F50.0000", "[PRB:10.0000,-5.0000,-1.2500:1]")
	m.SetProbeReplyDelay(800 * time.Millisecond)

	started := time.Now()
	resp := postJSON(t, srv.URL+"/api/probe/z", map[string]any{
		"machine_x":         10,
		"machine_y":         -5,
		"move_xy":           true,
		"safe_z_mm":         0,
		"probe_depth_mm":    5,
		"probe_feed_mm_min": 50,
	})
	if elapsed := time.Since(started); elapsed < 700*time.Millisecond {
		t.Fatalf("probe endpoint returned after %v, before delayed contact", elapsed)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("probe status = %d: %s", resp.StatusCode, body)
	}
	var result service.ProbeZResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.Machine["x"] != 10 || result.Machine["y"] != -5 || result.Machine["z"] != -1.25 {
		t.Fatalf("probe result = %+v", result)
	}
	want := []string{
		"G53 G0 Z-3.0000",
		"G53 G0 X10.0000 Y-5.0000",
		"G38.2 Z-5.0000 F50.0000",
		"G53 G0 Z-3.0000",
	}
	got := m.Gcodes()
	if len(got) != len(want) {
		t.Fatalf("probe gcodes = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("probe gcodes = %v, want %v", got, want)
		}
	}
}

func TestAutoZProbeEndpointStartsAtCurrentMachineZ(t *testing.T) {
	srv, m, tr := serverWithMachine(t)
	status := "<Idle|MPos:20,30,-5|WPos:12.5,-3.25,1|T:0,0>"
	m.SetStatus(status)
	if !tr.ObserveStatusPayload(status) {
		t.Fatal("failed to seed tracker status")
	}
	m.SetGcodeReply("G38.2 Z-20.0000 F50.0000", "[PRB:20.0000,30.0000,-12.0000:1]")

	resp := postJSON(t, srv.URL+"/api/probe/auto-z", map[string]any{})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("auto z probe status = %d: %s", resp.StatusCode, body)
	}
	var result service.MachineActionResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.Action != "auto_z_probe" || result.Command != "G38.2 Z-20.0000 F50.0000 → G10 L20 P0 Z0" || !result.Verified {
		t.Fatalf("auto z probe result = %+v", result)
	}
	if result.Machine["x"] != 20 || result.Machine["y"] != 30 || result.Machine["z"] != -12 {
		t.Fatalf("auto z probe contact = %+v, want X20 Y30 Z-12", result.Machine)
	}
	want := []string{"G53 G0 Z-5.0000", "G38.2 Z-20.0000 F50.0000", "G10 L20 P0 Z0", "G53 G0 Z-5.0000"}
	if got := m.Gcodes(); !reflect.DeepEqual(got, want) {
		t.Fatalf("auto z probe gcodes = %v, want %v", got, want)
	}
}

func TestFloorZProbeEndpointRetractsToSafeZ(t *testing.T) {
	srv, m, tr := serverWithMachine(t)
	status := "<Idle|MPos:20,30,-5|WPos:12.5,-3.25,1|T:0,0>"
	m.SetStatus(status)
	if !tr.ObserveStatusPayload(status) {
		t.Fatal("failed to seed tracker status")
	}
	m.SetGcodeReply("G38.2 Z-20.0000 F50.0000", "[PRB:20.0000,30.0000,-12.0000:1]")

	resp := postJSON(t, srv.URL+"/api/probe/floor", map[string]any{})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("floor z probe status = %d: %s", resp.StatusCode, body)
	}
	var result service.MachineActionResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.Action != "probe_floor" || !result.Verified || result.Machine["z"] != -12 {
		t.Fatalf("floor z probe result = %+v", result)
	}
	want := []string{"G53 G0 Z-5.0000", "G38.2 Z-20.0000 F50.0000", "G10 L20 P0 Z0", "G53 G0 Z-3.0000"}
	if got := m.Gcodes(); !reflect.DeepEqual(got, want) {
		t.Fatalf("floor z probe gcodes = %v, want %v", got, want)
	}
}

func TestProbe3DEndpointUsesDedicatedToolAndVendorWorkflow(t *testing.T) {
	srv, m, tr := serverWithMachine(t)
	status := "<Idle|MPos:20,30,-5|WPos:12.5,-3.25,1|T:9999,0>"
	m.SetStatus(status)
	if !tr.ObserveStatusPayload(status) {
		t.Fatal("failed to seed tracker status")
	}

	resp := postJSON(t, srv.URL+"/api/probe/3d", map[string]any{
		"kind":        "bore_pocket_x",
		"x_offset_mm": 20,
		"y_offset_mm": 21,
		"z_offset_mm": 2,
		"diameter_mm": 2,
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("3D probe status = %d: %s", resp.StatusCode, body)
	}
	var result service.MachineActionResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.Action != "probe_3d" || result.Verified || result.Command != "M480.9 X20 Y0 Z2 D2" {
		t.Fatalf("3D probe result = %+v", result)
	}
	if got := m.Gcodes(); !reflect.DeepEqual(got, []string{"M480.9 X20 Y0 Z2 D2"}) {
		t.Fatalf("3D probe gcodes = %v", got)
	}
}

func TestProbe3DEndpointRejectsPredictableSoftLimitMove(t *testing.T) {
	srv, m, tr, svc, _ := serverWithMachineState(t)
	status := "<Idle|MPos:-252.725,-164.814,-90.467|WPos:0,0,0|T:9999,0>"
	m.SetStatus(status)
	if !tr.ObserveStatusPayload(status) {
		t.Fatal("failed to seed tracker status")
	}
	ui := svc.UISettings()
	ui.Machine.Learned = store.MachineLearned{
		LearnedAt: time.Now(),
		SoftEndstop: store.MachineSoftEndstopProfile{
			Enabled: true,
			XMin:    -302,
			XMax:    -1,
			YMin:    -212,
			YMax:    -1,
		},
	}
	if _, err := svc.SetUISettings(ui); err != nil {
		t.Fatal(err)
	}

	resp := postJSON(t, srv.URL+"/api/probe/3d", map[string]any{
		"kind":        "boss_block",
		"x_offset_mm": 50,
		"y_offset_mm": 50,
		"z_offset_mm": 2,
		"diameter_mm": 2,
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("3D probe status = %d: %s", resp.StatusCode, body)
	}
	body, _ := io.ReadAll(resp.Body)
	if !bytes.Contains(body, []byte("X positioning target -302.725 mm")) {
		t.Fatalf("3D probe error = %s", body)
	}
	if got := m.Gcodes(); len(got) != 0 {
		t.Fatalf("unsafe 3D probe leaked through API: %v", got)
	}
}

func TestTraceOutlineEndpointSerializesProbeLaserTrace(t *testing.T) {
	srv, m, tr := serverWithMachine(t)
	status := "<Idle|MPos:0,0,0|WPos:0,0,0|T:0,0>"
	m.SetStatus(status)
	if !tr.ObserveStatusPayload(status) {
		t.Fatal("failed to seed tracker status")
	}

	resp := postJSON(t, srv.URL+"/api/outline/trace", map[string]any{
		"machine_points": []map[string]float64{{"x": 0, "y": 0}, {"x": 10, "y": 0}},
		"safe_z_mm":      5,
		"feed_mm_min":    10000,
		"closed":         false,
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("trace status = %d: %s", resp.StatusCode, body)
	}
	var result service.TraceOutlineResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if !result.Verified || result.Points != 2 || result.CommandCount != 4 {
		t.Fatalf("trace result = %+v", result)
	}
	want := []string{
		"M494.0",
		"G53 G0 Z-3.0000",
		"G90 G0 X0.0000 Y0.0000",
		"G90 G1 X10.0000 Y0.0000 F10000.0000",
	}
	got := m.Gcodes()
	if len(got) != len(want) {
		t.Fatalf("trace gcodes = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("trace gcodes = %v, want %v", got, want)
		}
	}
	if !m.Snapshot().ProbeLaserActive {
		t.Fatal("trace endpoint turned the probe laser off")
	}
}

func TestActiveGcodeEndpoints(t *testing.T) {
	srv, m, tr, _, st := serverWithMachineState(t)
	tr.Observe(machine.Idle)

	emptySegments := get(t, srv.URL+"/api/gcode/active/segments?start=0&limit=1")
	emptySegments.Body.Close()
	if emptySegments.StatusCode != http.StatusNoContent {
		t.Fatalf("empty segment window status=%d, want 204", emptySegments.StatusCode)
	}
	emptySource := get(t, srv.URL+"/api/gcode/active/source?start_line=1&limit=1")
	emptySource.Body.Close()
	if emptySource.StatusCode != http.StatusNoContent {
		t.Fatalf("empty source window status=%d, want 204", emptySource.StatusCode)
	}

	up := postRaw(t, srv.URL+"/api/files?path=my%20part.nc", "G90\nG0 X0 Y0\nG1 X5 Y5\n")
	up.Body.Close()
	if up.StatusCode != http.StatusCreated {
		t.Fatalf("upload status = %d", up.StatusCode)
	}
	if err := st.SetEntrySync("/sd/gcodes/my part.nc", store.Synced, ""); err != nil {
		t.Fatal(err)
	}

	selectResp := postJSON(t, srv.URL+"/api/gcode/active", map[string]string{"path": "my part.nc"})
	defer selectResp.Body.Close()
	if selectResp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(selectResp.Body)
		t.Fatalf("select status=%d body=%s", selectResp.StatusCode, b)
	}
	var active service.ActiveGcode
	if err := json.NewDecoder(selectResp.Body).Decode(&active); err != nil {
		t.Fatal(err)
	}
	if active.Path != "/sd/gcodes/my part.nc" || !active.Runnable || active.Preview == nil || active.Preview.MoveCount != 1 {
		t.Fatalf("active = %+v", active)
	}
	if len(active.Preview.Segments) != 0 || len(active.Preview.OverviewSegments) != 1 {
		t.Fatalf("active geometry = full:%d overview:%d", len(active.Preview.Segments), len(active.Preview.OverviewSegments))
	}

	segmentsResp := get(t, srv.URL+"/api/gcode/active/segments?start=0&limit=1")
	var segmentWindow service.GcodeSegmentWindow
	if err := json.NewDecoder(segmentsResp.Body).Decode(&segmentWindow); err != nil {
		segmentsResp.Body.Close()
		t.Fatal(err)
	}
	segmentsResp.Body.Close()
	if segmentsResp.StatusCode != http.StatusOK || segmentWindow.Total != 1 || len(segmentWindow.Segments) != 1 {
		t.Fatalf("segment window status=%d value=%+v", segmentsResp.StatusCode, segmentWindow)
	}

	sourceResp := get(t, srv.URL+"/api/gcode/active/source?start_line=2&limit=2")
	var sourceWindow service.GcodeSourceWindow
	if err := json.NewDecoder(sourceResp.Body).Decode(&sourceWindow); err != nil {
		sourceResp.Body.Close()
		t.Fatal(err)
	}
	sourceResp.Body.Close()
	if sourceResp.StatusCode != http.StatusOK || sourceWindow.TotalLines != 3 || !reflect.DeepEqual(sourceWindow.Lines, []string{"G0 X0 Y0", "G1 X5 Y5"}) {
		t.Fatalf("source window status=%d value=%+v", sourceResp.StatusCode, sourceWindow)
	}
	m.PutFile("/sd/gcodes/my part.nc", []byte("G1 X1\n"))

	req, _ := http.NewRequest("POST", srv.URL+"/api/gcode/active/run", nil)
	runResp := do(t, req)
	defer runResp.Body.Close()
	if runResp.StatusCode != http.StatusAccepted {
		b, _ := io.ReadAll(runResp.Body)
		t.Fatalf("run status=%d body=%s", runResp.StatusCode, b)
	}
	var runResult service.MachineActionResult
	if err := json.NewDecoder(runResp.Body).Decode(&runResult); err != nil {
		t.Fatal(err)
	}
	if runResult.Verified || !strings.Contains(runResult.Message, "machine confirmation was not available") {
		t.Fatalf("run result = %+v, want unverified neutral message", runResult)
	}
	if g := m.Gcodes(); len(g) != 1 || g[0] != "play /sd/gcodes/my part.nc" {
		t.Fatalf("machine gcodes = %v, want play command", g)
	}
}

func TestToolActionEndpoints(t *testing.T) {
	srv, m, tr := serverWithMachine(t)
	tr.Observe(machine.Idle)

	setResp := postJSON(t, srv.URL+"/api/tool/current", map[string]int{"tool_id": 4})
	if setResp.StatusCode != http.StatusAccepted {
		t.Fatalf("set tool status = %d", setResp.StatusCode)
	}
	var setResult service.MachineActionResult
	if err := json.NewDecoder(setResp.Body).Decode(&setResult); err != nil {
		t.Fatal(err)
	}
	setResp.Body.Close()
	if setResult.Verified || !strings.Contains(setResult.Message, "machine confirmation was not available") {
		t.Fatalf("set tool result = %+v, want unverified neutral message", setResult)
	}
	st, _ := tr.Current()
	if st.Tool == nil || st.Tool.Active != 4 {
		t.Fatalf("tracker after set current tool = %+v, want active tool 4", st.Tool)
	}
	setProbeResp := postJSON(t, srv.URL+"/api/tool/current", map[string]int{"tool_id": 0})
	setProbeResp.Body.Close()
	if setProbeResp.StatusCode != http.StatusAccepted {
		t.Fatalf("set probe status = %d", setProbeResp.StatusCode)
	}
	statusResp := get(t, srv.URL+"/api/machine/status")
	var status service.MachineStatus
	if err := json.NewDecoder(statusResp.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	statusResp.Body.Close()
	if status.Tool == nil || status.Tool.Active != 0 {
		t.Fatalf("machine status after set probe = %+v, want active probe", status.Tool)
	}
	setLaserResp := postJSON(t, srv.URL+"/api/tool/current", map[string]int{"tool_id": 8888})
	setLaserResp.Body.Close()
	if setLaserResp.StatusCode != http.StatusAccepted {
		t.Fatalf("set laser status = %d", setLaserResp.StatusCode)
	}
	changeResp := postJSON(t, srv.URL+"/api/tool/change", map[string]int{"tool_id": 2})
	changeResp.Body.Close()
	if changeResp.StatusCode != http.StatusAccepted {
		t.Fatalf("change tool status = %d", changeResp.StatusCode)
	}
	if _, err := m.InsertTool("tool_6"); err != nil {
		t.Fatal(err)
	}
	if snap := m.Snapshot(); snap.Status.State != machine.Tool || snap.Status.Tool == nil || snap.Status.Tool.Target == nil || *snap.Status.Tool.Target != 2 {
		t.Fatalf("fake status after insert = %+v, want pending target 2", snap.Status.Tool)
	}
	reqContinue, _ := http.NewRequest("POST", srv.URL+"/api/tool/continue", nil)
	continueResp := do(t, reqContinue)
	continueResp.Body.Close()
	if continueResp.StatusCode != http.StatusAccepted {
		t.Fatalf("continue tool status = %d", continueResp.StatusCode)
	}
	st, _ = tr.Current()
	if st.State != machine.Idle || st.Tool == nil || st.Tool.Active != 2 || st.Tool.Target != nil || math.Abs(st.Tool.Offset) < 0.001 {
		t.Fatalf("tracker after continue = %+v, want Idle active tool 2 with non-zero TLO", st)
	}
	req, _ := http.NewRequest("POST", srv.URL+"/api/tool/calibrate", nil)
	calResp := do(t, req)
	calResp.Body.Close()
	if calResp.StatusCode != http.StatusAccepted {
		t.Fatalf("calibrate status = %d", calResp.StatusCode)
	}
	if g := m.Gcodes(); len(g) != 6 ||
		g[0] != "M493.2T4" ||
		g[1] != "M493.2T0" ||
		g[2] != "M493.2T8888" ||
		g[3] != "M6T2" ||
		g[4] != "M490.2" ||
		g[5] != "M491" {
		t.Fatalf("machine gcodes = %v, want tool commands", g)
	}
}

func TestToolCalibrationEndpointReportsObservedTLO(t *testing.T) {
	srv, m, tr := serverWithMachine(t)
	if _, err := m.InsertTool("tool_6"); err != nil {
		t.Fatal(err)
	}
	tr.ObserveStatusPayload(m.Snapshot().Status.Raw)

	req, _ := http.NewRequest("POST", srv.URL+"/api/tool/calibrate", nil)
	resp := do(t, req)
	resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("calibrate status = %d", resp.StatusCode)
	}
	snap := m.Snapshot()
	if snap.Status.Tool == nil || snap.Status.Tool.Offset == 0 {
		t.Fatalf("fake status after calibration = %+v", snap.Status.Tool)
	}
	if !tr.ObserveStatusPayload(snap.Status.Raw) {
		t.Fatalf("tracker rejected fake status %q", snap.Status.Raw)
	}

	machineResp := get(t, srv.URL+"/api/machine")
	defer machineResp.Body.Close()
	if machineResp.StatusCode != http.StatusOK {
		t.Fatalf("machine status = %d", machineResp.StatusCode)
	}
	var status service.MachineStatus
	if err := json.NewDecoder(machineResp.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	if status.Tool == nil || status.Tool.Active != 2 || status.Tool.Offset == 0 {
		t.Fatalf("api machine tool = %+v, want calibrated tool 2 with non-zero TLO", status.Tool)
	}
}

func TestPostControl(t *testing.T) {
	srv, m, tr := serverWithMachine(t)
	tr.Observe(machine.Run) // control works even while running

	for _, action := range []string{"hold", "resume", "halt"} {
		resp := postJSON(t, srv.URL+"/api/control", map[string]string{"action": action})
		if resp.StatusCode != http.StatusAccepted {
			resp.Body.Close()
			t.Fatalf("control %q: status = %d, want 202", action, resp.StatusCode)
		}
		var result struct {
			Action   string `json:"action"`
			Accepted bool   `json:"accepted"`
			Message  string `json:"message"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			resp.Body.Close()
			t.Fatalf("control %q response: %v", action, err)
		}
		resp.Body.Close()
		if result.Action != action || !result.Accepted || result.Message == "" {
			t.Fatalf("control %q response = %+v", action, result)
		}
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && len(m.Controls()) < 3 {
		time.Sleep(10 * time.Millisecond)
	}
	if got := m.Controls(); len(got) != 3 || got[0] != '!' || got[1] != '~' || got[2] != 0x18 {
		t.Errorf("controls = %v, want [! ~ 0x18]", got)
	}

	// Unknown action → 400.
	resp := postJSON(t, srv.URL+"/api/control", map[string]string{"action": "wiggle"})
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("unknown action: status = %d, want 400", resp.StatusCode)
	}
}

func TestPostFeedOverrideWhileRunning(t *testing.T) {
	srv, m, tr := serverWithMachine(t)
	status := "<Run|MPos:0,0,-5|WPos:0,0,-5|F:800,1000,100>"
	m.SetStatus(status)
	if !tr.ObserveStatusPayload(status) {
		t.Fatal("running status should parse")
	}

	resp := postJSON(t, srv.URL+"/api/feed-override", map[string]int{"percent": 140})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d body=%s", resp.StatusCode, body)
	}
	var result service.FeedOverrideResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if !result.Verified || result.Percent != 140 || result.State != machine.Run {
		t.Fatalf("result = %+v", result)
	}

	invalid := postJSON(t, srv.URL+"/api/feed-override", map[string]int{"percent": 250})
	invalid.Body.Close()
	if invalid.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid status = %d, want 400", invalid.StatusCode)
	}
}

func TestPostControlJobPauseAndResume(t *testing.T) {
	srv, m, tr := serverWithMachine(t)
	m.SetStatus("<Run|MPos:0,0,-10|WPos:0,0,-10|S:12000,12000,100|P:1,10,1>")
	tr.Observe(machine.Run)

	resp := postJSON(t, srv.URL+"/api/control", map[string]string{"action": "pause_job"})
	if resp.StatusCode != http.StatusAccepted {
		resp.Body.Close()
		t.Fatalf("pause status = %d, want 202", resp.StatusCode)
	}
	var paused service.JobControlResult
	if err := json.NewDecoder(resp.Body).Decode(&paused); err != nil {
		resp.Body.Close()
		t.Fatal(err)
	}
	resp.Body.Close()
	if !paused.Verified || paused.State != machine.Pause {
		t.Fatalf("pause result = %+v", paused)
	}

	resp = postJSON(t, srv.URL+"/api/gcode/active/paused-command", service.PausedJobCommandRequest{Action: "stop_spindle"})
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		t.Fatalf("stop spindle status = %d, want 200", resp.StatusCode)
	}
	var stopped service.PausedJobCommandResult
	if err := json.NewDecoder(resp.Body).Decode(&stopped); err != nil {
		resp.Body.Close()
		t.Fatal(err)
	}
	resp.Body.Close()
	if !stopped.Verified {
		t.Fatalf("stop spindle result = %+v", stopped)
	}

	resp = postJSON(t, srv.URL+"/api/control", map[string]string{"action": "resume_job"})
	if resp.StatusCode != http.StatusAccepted {
		resp.Body.Close()
		t.Fatalf("resume status = %d, want 202", resp.StatusCode)
	}
	var resumed service.JobControlResult
	if err := json.NewDecoder(resp.Body).Decode(&resumed); err != nil {
		resp.Body.Close()
		t.Fatal(err)
	}
	resp.Body.Close()
	if !resumed.Verified || resumed.State != machine.Run {
		t.Fatalf("resume result = %+v", resumed)
	}
}

func TestPostControlAlarmRecovery(t *testing.T) {
	srv, m, tr := serverWithMachine(t)
	tr.ObserveStatusPayload("<Alarm|MPos:0,0,0|H:10>")

	resp := postJSON(t, srv.URL+"/api/control", map[string]string{"action": "recover"})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("recover status = %d, want 202", resp.StatusCode)
	}
	var result service.RecoveryResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if !result.Recovered || result.State != machine.Idle || !result.NeedsHome {
		t.Fatalf("recover result = %+v, want recovered Idle with needs_home", result)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		for _, line := range m.Gcodes() {
			if line == "$X" {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("unlock did not reach machine: %v", m.Gcodes())
}

func TestPostControlAlarmRecoveryRejectsWrongAction(t *testing.T) {
	srv, m, tr := serverWithMachine(t)
	tr.ObserveStatusPayload("<Alarm|MPos:0,0,0|H:21>")

	resp := postJSON(t, srv.URL+"/api/control", map[string]string{"action": "unlock"})
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("unlock hard fault status = %d, want 409", resp.StatusCode)
	}
	if g := m.Gcodes(); len(g) != 0 {
		t.Fatalf("wrong recovery action reached machine: %v", g)
	}

	resp = postJSON(t, srv.URL+"/api/control", map[string]string{"action": "reset"})
	resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("reset status = %d, want 202", resp.StatusCode)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		for _, line := range m.Gcodes() {
			if line == "reset" {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("reset did not reach machine: %v", m.Gcodes())
}

func TestPostControlHomeAllowedDuringUnlockableAlarm(t *testing.T) {
	srv, m, tr := serverWithMachine(t)
	tr.ObserveStatusPayload("<Alarm|MPos:0,0,0|H:10>")

	resp := postJSON(t, srv.URL+"/api/control", map[string]string{"action": "home"})
	resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("home status = %d, want 202", resp.StatusCode)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		for _, line := range m.Gcodes() {
			if line == "$H" {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("home did not reach machine: %v", m.Gcodes())
}

func TestPostControlHomeRejectsHardFaultAlarm(t *testing.T) {
	srv, m, tr := serverWithMachine(t)
	tr.ObserveStatusPayload("<Alarm|MPos:0,0,0|H:21>")

	resp := postJSON(t, srv.URL+"/api/control", map[string]string{"action": "home"})
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("home hard fault status = %d, want 409", resp.StatusCode)
	}
	if g := m.Gcodes(); len(g) != 0 {
		t.Fatalf("home reached machine despite hard fault: %v", g)
	}
}

func TestMachineStatusIncludesHaltReason(t *testing.T) {
	srv, _, tr := serverWithMachine(t)
	tr.ObserveStatusPayload("<Alarm|MPos:0,0,0|H:10>")

	resp := get(t, srv.URL+"/api/machine/status")
	defer resp.Body.Close()
	var st service.MachineStatus
	if err := json.NewDecoder(resp.Body).Decode(&st); err != nil {
		t.Fatal(err)
	}
	if st.State != machine.Alarm || st.HaltReason == nil || st.HaltReason.Code != 10 || st.HaltReason.Recovery != "unlock" {
		t.Fatalf("machine status = %+v", st)
	}
}

func TestGcodeLogEndpointAndStream(t *testing.T) {
	srv, svc := newTestServer(t)

	// Open the SSE stream first so the live event (not just the snapshot)
	// carries the line.
	req, _ := http.NewRequest("GET", srv.URL+"/api/events", nil)
	resp := do(t, req)
	defer resp.Body.Close()
	// Consume the snapshot event.
	buf := make([]byte, 8192)
	n, _ := resp.Body.Read(buf)
	if !strings.Contains(string(buf[:n]), "event: snapshot") {
		t.Fatalf("expected snapshot first, got %q", buf[:n])
	}

	// Submitting gcode fails (no machine in this harness), but the attempt and
	// the error must still land in the shared log and stream to clients.
	body, _ := json.Marshal(map[string]string{"line": "M114"})
	greq, _ := http.NewRequest("POST", srv.URL+"/api/gcode", bytes.NewReader(body))
	greq.Header.Set("Content-Type", "application/json")
	gresp := do(t, greq)
	gresp.Body.Close()

	// The REST log endpoint has both lines.
	lresp := get(t, srv.URL+"/api/gcode/log")
	var lines []struct {
		Dir    string `json:"dir"`
		Source string `json:"source"`
		Text   string `json:"text"`
	}
	json.NewDecoder(lresp.Body).Decode(&lines)
	lresp.Body.Close()
	if len(lines) < 2 || lines[0].Dir != "send" || lines[0].Text != "M114" || lines[0].Source != "api" {
		t.Fatalf("log lines = %+v", lines)
	}
	if lines[1].Dir != "recv" || !strings.Contains(lines[1].Text, "error") {
		t.Errorf("expected error output line, got %+v", lines[1])
	}

	// The SSE stream carries the same lines as gcode events.
	var got string
	for !strings.Contains(got, "M114") {
		n, err := resp.Body.Read(buf)
		got += string(buf[:n])
		if err != nil {
			t.Fatalf("stream ended before gcode event: %q (%v)", got, err)
		}
	}
	if !strings.Contains(got, "event: gcode") {
		t.Errorf("expected gcode event, got %q", got)
	}

	// Lines appended directly (as the relay does for controller traffic) also
	// reach the same stream.
	svc.GcodeLog().Append("recv", "controller", "ok")
	got = ""
	for !strings.Contains(got, `"controller"`) {
		n, err := resp.Body.Read(buf)
		got += string(buf[:n])
		if err != nil {
			t.Fatalf("stream ended before controller line: %q (%v)", got, err)
		}
	}
}

func TestEventsSnapshot(t *testing.T) {
	srv, _ := newTestServer(t)
	http.Post(srv.URL+"/api/files?path=a.nc", "application/octet-stream", strings.NewReader("x"))

	req, _ := http.NewRequest("GET", srv.URL+"/api/events", nil)
	resp := do(t, req)
	defer resp.Body.Close()

	// Read the initial snapshot event.
	buf := make([]byte, 4096)
	n, _ := resp.Body.Read(buf)
	got := string(buf[:n])
	if !strings.Contains(got, "event: snapshot") || !strings.Contains(got, "/sd/gcodes/a.nc") {
		t.Errorf("snapshot event missing expected content: %q", got)
	}
}

func TestEventsControlScopeOmitsCatalog(t *testing.T) {
	srv, _ := newTestServer(t)
	http.Post(srv.URL+"/api/files?path=a.nc", "application/octet-stream", strings.NewReader("x"))

	req, _ := http.NewRequest("GET", srv.URL+"/api/events?scope=control", nil)
	resp := do(t, req)
	defer resp.Body.Close()

	buf := make([]byte, 4096)
	n, _ := resp.Body.Read(buf)
	got := string(buf[:n])
	if !strings.Contains(got, "event: snapshot") || !strings.Contains(got, `"machine"`) {
		t.Fatalf("control snapshot missing expected machine content: %q", got)
	}
	if strings.Contains(got, "/sd/gcodes/a.nc") || strings.Contains(got, `"files"`) || strings.Contains(got, `"jobs"`) {
		t.Errorf("control snapshot unexpectedly included catalog data: %q", got)
	}
	if !strings.Contains(got, `"gcode"`) {
		t.Errorf("control snapshot should include gcode history: %q", got)
	}
}

func TestEventsControlScopeStreamsLiveMachineStatus(t *testing.T) {
	srv, _, tr := serverWithMachine(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/events?scope=control", nil)
	resp := do(t, req)
	defer resp.Body.Close()
	scanner := bufio.NewScanner(resp.Body)
	readEvent := func() (string, string) {
		t.Helper()
		var event, data string
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" && event != "" {
				return event, data
			}
			if strings.HasPrefix(line, "event: ") {
				event = strings.TrimPrefix(line, "event: ")
			} else if strings.HasPrefix(line, "data: ") {
				data = strings.TrimPrefix(line, "data: ")
			}
		}
		t.Fatalf("event stream ended: %v", scanner.Err())
		return "", ""
	}
	if event, _ := readEvent(); event != "snapshot" {
		t.Fatalf("first event = %q, want snapshot", event)
	}
	tr.ObserveStatusPayload("<Run|MPos:1,2,3|WPos:4,5,6|W:3.71|A:2|O:0.250>")
	event, data := readEvent()
	if event != "machine" {
		t.Fatalf("next event = %q, want machine: %s", event, data)
	}
	var status service.MachineStatus
	if err := json.Unmarshal([]byte(data), &status); err != nil {
		t.Fatal(err)
	}
	if status.State != machine.Run || status.WPos["x"] != 4 || status.ProbeV == nil || *status.ProbeV != 3.71 || status.ATCState == nil || *status.ATCState != 2 || status.LevelDelta == nil || *status.LevelDelta != 0.25 {
		t.Fatalf("streamed machine status = %+v", status)
	}
}

func TestEventsControlScopeStreamsAttentionChange(t *testing.T) {
	srv, _, tr := serverWithMachine(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/events?scope=control", nil)
	resp := do(t, req)
	defer resp.Body.Close()
	scanner := bufio.NewScanner(resp.Body)
	readEvent := func() (string, string) {
		t.Helper()
		var event, data string
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" && event != "" {
				return event, data
			}
			if strings.HasPrefix(line, "event: ") {
				event = strings.TrimPrefix(line, "event: ")
			} else if strings.HasPrefix(line, "data: ") {
				data = strings.TrimPrefix(line, "data: ")
			}
		}
		t.Fatalf("event stream ended: %v", scanner.Err())
		return "", ""
	}
	if event, data := readEvent(); event != "snapshot" || !strings.Contains(data, `"attention"`) {
		t.Fatalf("first event = %q data=%s, want snapshot with attention", event, data)
	}

	tr.ObserveStatusPayload("<Run|MPos:0,0,0>")
	tr.ObserveStatusPayload("<Tool|MPos:0,0,0|T:2,1.25,4>")
	for {
		event, data := readEvent()
		if event != "attention" {
			continue
		}
		var change attention.Change
		if err := json.Unmarshal([]byte(data), &change); err != nil {
			t.Fatal(err)
		}
		if change.Kind != attention.ChangeOpened || change.Event.Kind != attention.KindToolChange || change.Event.Tool == nil || change.Event.Tool.Target == nil || *change.Event.Tool.Target != 4 {
			t.Fatalf("attention change = %+v", change)
		}
		return
	}
}

func TestEventsFilesScopeOmitsGcode(t *testing.T) {
	srv, svc := newTestServer(t)
	http.Post(srv.URL+"/api/files?path=a.nc", "application/octet-stream", strings.NewReader("x"))
	svc.GcodeLog().Append("send", "api", "M114")

	req, _ := http.NewRequest("GET", srv.URL+"/api/events?scope=files", nil)
	resp := do(t, req)
	defer resp.Body.Close()

	buf := make([]byte, 4096)
	n, _ := resp.Body.Read(buf)
	got := string(buf[:n])
	if !strings.Contains(got, "/sd/gcodes/a.nc") || !strings.Contains(got, `"files"`) || !strings.Contains(got, `"jobs"`) {
		t.Fatalf("files snapshot missing expected catalog data: %q", got)
	}
	if strings.Contains(got, `"gcode"`) || strings.Contains(got, "M114") {
		t.Errorf("files snapshot unexpectedly included gcode data: %q", got)
	}
}
