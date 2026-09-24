package traymgr

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

type recordingNotifier struct {
	got []Notification
}

func (r *recordingNotifier) Notify(n Notification) error {
	r.got = append(r.got, n)
	return nil
}

func TestServerNotifyRequiresTokenAndRecordsNotification(t *testing.T) {
	cfg := DefaultConfig()
	cfg.AdminListen = "127.0.0.1:8430"
	cfg.AdminToken = "secret"
	configPath := filepath.Join(t.TempDir(), "tray.json")
	sup := NewSupervisor(cfg, "")
	rec := &recordingNotifier{}
	srv := NewServer(configPath, sup, rec)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	body, _ := json.Marshal(Notification{Title: "CNC", Message: "Done", Level: "info"})
	resp, err := http.Post(ts.URL+"/api/notify", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want 401", resp.StatusCode)
	}

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/notify", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CNC-Tray-Token", "secret")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("authenticated status = %d", resp.StatusCode)
	}
	if len(rec.got) != 1 || rec.got[0].Message != "Done" {
		t.Fatalf("notifier got %+v", rec.got)
	}
	if got := srv.recentNotifications(); len(got) != 1 || got[0].Title != "CNC" {
		t.Fatalf("recent notifications = %+v", got)
	}
}

func TestManagerRejectsCrossSiteMutation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses a POSIX shell script as the supervised proxy")
	}
	dir := t.TempDir()
	proxy := filepath.Join(dir, "proxy.sh")
	if err := os.WriteFile(proxy, []byte("#!/bin/sh\ntrap 'exit 0' TERM INT\nwhile true; do sleep 1 & wait $!; done\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := DefaultConfig()
	cfg.ProxyBinary = proxy
	sup := NewSupervisor(cfg, "")
	if err := sup.Start(); err != nil {
		t.Fatalf("start proxy script: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = sup.Stop(ctx)
	})
	srv := NewServer(filepath.Join(dir, "tray.json"), sup, nil)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// Cross-site fetch metadata must be rejected and must not stop the proxy.
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/proxy/stop", nil)
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-site stop status = %d, want 403", resp.StatusCode)
	}
	if !sup.State().Running {
		t.Fatal("cross-site request stopped the supervised proxy")
	}

	// A foreign Origin must be rejected and must not stop the proxy.
	req, _ = http.NewRequest(http.MethodPost, ts.URL+"/api/proxy/stop", nil)
	req.Header.Set("Origin", "http://evil.example")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-origin stop status = %d, want 403", resp.StatusCode)
	}
	if !sup.State().Running {
		t.Fatal("cross-origin request stopped the supervised proxy")
	}

	// A same-origin request (matching Origin) still works.
	req, _ = http.NewRequest(http.MethodPost, ts.URL+"/api/proxy/stop", nil)
	req.Header.Set("Origin", ts.URL)
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("same-origin stop status = %d, want 200", resp.StatusCode)
	}
	if sup.State().Running {
		t.Fatal("same-origin stop request left the proxy running")
	}
}

func TestManagerRejectsForeignHost(t *testing.T) {
	cfg := DefaultConfig()
	configPath := filepath.Join(t.TempDir(), "tray.json")
	sup := NewSupervisor(cfg, "")
	srv := NewServer(configPath, sup, nil)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/proxy/stop", nil)
	req.Host = "evil.example:8430"
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign-host stop status = %d, want 403", resp.StatusCode)
	}

	// The loopback host used by httptest still works.
	resp, err = http.Post(ts.URL+"/api/proxy/stop", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("loopback-host stop status = %d, want 200", resp.StatusCode)
	}
}

func TestManagerLogFileBounded(t *testing.T) {
	cfg := DefaultConfig()
	configPath := filepath.Join(t.TempDir(), "tray.json")
	srv := NewServer(configPath, NewSupervisor(cfg, ""), nil)
	for i := 0; i < 275; i++ {
		srv.addManagerLog("info", "test", fmt.Sprintf("entry %d", i))
	}

	logPath := DefaultManagerLogPath(configPath)
	f, err := os.Open(logPath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var onDisk []ManagerLogEntry
	dec := json.NewDecoder(f)
	for {
		var entry ManagerLogEntry
		if err := dec.Decode(&entry); err != nil {
			if err == io.EOF {
				break
			}
			t.Fatalf("decode manager log: %v", err)
		}
		onDisk = append(onDisk, entry)
	}
	if len(onDisk) > 200 {
		t.Fatalf("on-disk manager log holds %d entries, want at most 200", len(onDisk))
	}
	if len(onDisk) == 0 || onDisk[len(onDisk)-1].Message != "entry 274" {
		t.Fatalf("on-disk manager log tail = %+v, want most recent entry retained", onDisk[len(onDisk)-1:])
	}

	reloaded := NewServer(configPath, NewSupervisor(cfg, ""), nil)
	got := reloaded.recentManagerLog()
	if len(got) == 0 || len(got) > 200 || got[len(got)-1].Message != "entry 274" {
		t.Fatalf("reloaded manager log len=%d tail=%+v", len(got), got[len(got)-1:])
	}
}

func TestManagerLogPersistsAndIsReturnedByStatus(t *testing.T) {
	cfg := DefaultConfig()
	configPath := filepath.Join(t.TempDir(), "tray.json")
	srv := NewServer(configPath, NewSupervisor(cfg, ""), nil)
	srv.addManagerLog("info", "webdav", "mount requested target=url=http://127.0.0.1:8430/webdav/ drive=*")

	reloaded := NewServer(configPath, NewSupervisor(cfg, ""), nil)
	got := reloaded.recentManagerLog()
	if len(got) != 1 {
		t.Fatalf("loaded manager log = %+v, want one entry", got)
	}
	if got[0].Source != "webdav" || got[0].Message != "mount requested target=url=http://127.0.0.1:8430/webdav/ drive=*" {
		t.Fatalf("loaded manager log entry = %+v", got[0])
	}

	ts := httptest.NewServer(reloaded.Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/api/status")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/status status = %d", resp.StatusCode)
	}
	var body struct {
		ManagerLog []ManagerLogEntry `json:"manager_log"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.ManagerLog) != 1 || body.ManagerLog[0].Source != "webdav" {
		t.Fatalf("status manager_log = %+v", body.ManagerLog)
	}
}

func TestManagerLogCanBeCleared(t *testing.T) {
	cfg := DefaultConfig()
	configPath := filepath.Join(t.TempDir(), "tray.json")
	srv := NewServer(configPath, NewSupervisor(cfg, ""), nil)
	srv.addManagerLog("error", "webdav", "mount failed")

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	req, err := http.NewRequest(http.MethodDelete, ts.URL+"/api/manager/log", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("DELETE /api/manager/log status = %d", resp.StatusCode)
	}
	if got := srv.recentManagerLog(); len(got) != 0 {
		t.Fatalf("recent manager log = %+v, want empty", got)
	}
	reloaded := NewServer(configPath, NewSupervisor(cfg, ""), nil)
	if got := reloaded.recentManagerLog(); len(got) != 0 {
		t.Fatalf("reloaded manager log = %+v, want empty", got)
	}
}

func TestServerWebDAVRemountEndpointUsesFreshMount(t *testing.T) {
	if !WebDAVMountSupported() {
		t.Skip("native WebDAV remount is not supported on this platform")
	}
	path := filepath.Join(t.TempDir(), "tray.json")
	cfg := DefaultConfig()
	cfg.WebDAVMount.Enabled = true
	writeRawConfig(t, path, cfg)

	app, err := NewApp(path, nil)
	if err != nil {
		t.Fatalf("NewApp: %v", err)
	}
	var mounts, unmounts int
	var fresh []bool
	restore := replaceWebDAVMountFuncs(func(ctx context.Context, req webDAVMountRequest) error {
		mounts++
		fresh = append(fresh, req.Fresh)
		return nil
	}, func(ctx context.Context, req webDAVMountRequest) error {
		unmounts++
		return nil
	}, func(ctx context.Context, req webDAVMountRequest) (bool, error) {
		return true, nil
	})
	defer restore()

	ts := httptest.NewServer(app.Server.Handler())
	defer ts.Close()
	resp, err := http.Post(ts.URL+"/api/webdav/remount", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST /api/webdav/remount status = %d", resp.StatusCode)
	}
	if mounts != 1 || unmounts != 1 {
		t.Fatalf("mounts=%d unmounts=%d, want 1/1", mounts, unmounts)
	}
	if got, want := fmt.Sprint(fresh), "[true]"; got != want {
		t.Fatalf("fresh mount flags = %s, want %s", got, want)
	}
	var body struct {
		Mount WebDAVMountStatus `json:"mount"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if !body.Mount.Desired || !body.Mount.Mounted {
		t.Fatalf("mount status = %+v, want desired and mounted", body.Mount)
	}
}

func TestServerWebDAVMountEndpointDisablesFailedDesiredMount(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tray.json")
	cfg := DefaultConfig()
	cfg.WebDAVMount.Enabled = true
	writeRawConfig(t, path, cfg)

	app, err := NewApp(path, nil)
	if err != nil {
		t.Fatalf("NewApp: %v", err)
	}
	var unmounts int
	restore := replaceWebDAVMountFuncs(func(ctx context.Context, req webDAVMountRequest) error {
		t.Fatal("disable should not mount")
		return nil
	}, func(ctx context.Context, req webDAVMountRequest) error {
		unmounts++
		return nil
	}, func(ctx context.Context, req webDAVMountRequest) (bool, error) {
		return false, nil
	})
	defer restore()

	ts := httptest.NewServer(app.Server.Handler())
	defer ts.Close()
	req, err := http.NewRequest(http.MethodPut, ts.URL+"/api/webdav/mount", strings.NewReader(`{"enabled":false}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("PUT /api/webdav/mount status = %d: %s", resp.StatusCode, body)
	}
	if unmounts != 1 {
		t.Fatalf("unmounts = %d, want 1", unmounts)
	}
	var body struct {
		Mount WebDAVMountStatus `json:"mount"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Mount.Desired || body.Mount.Mounted {
		t.Fatalf("mount status = %+v, want disabled and unmounted", body.Mount)
	}
}

func TestManagerWebUsesOneBottomStatusRegionAndOffersMountToggle(t *testing.T) {
	if got := strings.Count(indexHTML, `role="status"`); got != 1 {
		t.Fatalf("role=status count = %d, want one", got)
	}
	for _, want := range []string{`id="actionStatus"`, `id="toggleWebDAV"`, `PUT`, `/api/webdav/mount`} {
		if !strings.Contains(indexHTML, want) {
			t.Fatalf("manager UI missing %q", want)
		}
	}
	for _, forbidden := range []string{`id="processMsg"`, `id="webdavMsg"`, `id="managerMsg"`, `id="proxyMsg"`, `id="logMsg"`} {
		if strings.Contains(indexHTML, forbidden) {
			t.Fatalf("manager UI still contains inline transient surface %q", forbidden)
		}
	}
}

func TestServerPutConfigPersistsAndUpdatesSupervisor(t *testing.T) {
	cfg := DefaultConfig()
	configPath := filepath.Join(t.TempDir(), "tray.json")
	sup := NewSupervisor(cfg, "")
	srv := NewServer(configPath, sup, nil)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	cfg.Flags["name"] = "Shop CNC"
	body, _ := json.Marshal(cfg)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT /api/config status = %d", resp.StatusCode)
	}
	loaded, err := LoadConfig(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Flags["name"] != "Shop CNC" || sup.Config().Flags["name"] != "Shop CNC" {
		t.Fatalf("config was not persisted/applied: loaded=%q supervisor=%q", loaded.Flags["name"], sup.Config().Flags["name"])
	}
}

func TestLocalWebDAVProxyInjectsConfiguredAuth(t *testing.T) {
	var gotPath, gotAuth, gotDestination, gotBody string
	dav := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotDestination = r.Header.Get("Destination")
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		w.WriteHeader(http.StatusCreated)
	}))
	defer dav.Close()

	cfg := DefaultConfig()
	cfg.Flags["dav-addr"] = strings.TrimPrefix(dav.URL, "http://")
	cfg.Flags["auth-user"] = "operator"
	cfg.Flags["auth-token"] = "secret"
	srv := NewServer(filepath.Join(t.TempDir(), "tray.json"), NewSupervisor(cfg, ""), nil)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	req, err := http.NewRequest(http.MethodPut, ts.URL+"/webdav/jobs/test.nc", strings.NewReader("gcode"))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Destination", ts.URL+"/webdav/jobs/renamed.nc")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("proxy status = %d", resp.StatusCode)
	}
	if gotPath != "/jobs/test.nc" {
		t.Fatalf("proxied path = %q, want /jobs/test.nc", gotPath)
	}
	if gotAuth != "Basic b3BlcmF0b3I6c2VjcmV0" {
		t.Fatalf("proxied auth = %q", gotAuth)
	}
	wantDestination := dav.URL + "/jobs/renamed.nc"
	if gotDestination != wantDestination {
		t.Fatalf("proxied Destination = %q, want %q", gotDestination, wantDestination)
	}
	if gotBody != "gcode" {
		t.Fatalf("proxied body = %q, want gcode", gotBody)
	}
}

func TestRequestFromLoopbackRejectsRemoteAddress(t *testing.T) {
	if !requestFromLoopback(&http.Request{RemoteAddr: "127.0.0.1:12345"}) {
		t.Fatal("loopback IPv4 request was rejected")
	}
	if !requestFromLoopback(&http.Request{RemoteAddr: "[::1]:12345"}) {
		t.Fatal("loopback IPv6 request was rejected")
	}
	if requestFromLoopback(&http.Request{RemoteAddr: "192.168.1.20:12345"}) {
		t.Fatal("remote IPv4 request was accepted")
	}
}

func TestServerPutConfigRestartsWhenManagerSettingsChange(t *testing.T) {
	cfg := DefaultConfig()
	cfg.AdminListen = "127.0.0.1:8430"
	configPath := filepath.Join(t.TempDir(), "tray.json")
	sup := NewSupervisor(cfg, "")
	srv := NewServer(configPath, sup, nil)
	srv.restartLag = 0
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	cfg.AdminListen = "127.0.0.1:8431"
	body, _ := json.Marshal(cfg)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT /api/config status = %d", resp.StatusCode)
	}
	var got struct {
		ManagerRestarting bool   `json:"manager_restarting"`
		ManagerURL        string `json:"manager_url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if !got.ManagerRestarting {
		t.Fatal("manager_restarting = false, want true")
	}
	if got.ManagerURL != "http://127.0.0.1:8431" {
		t.Fatalf("manager_url = %q", got.ManagerURL)
	}
	select {
	case <-srv.restartCh:
	case <-time.After(time.Second):
		t.Fatal("manager restart was not scheduled")
	}
}

func TestServerPutManagerConfigIgnoresInvalidProxyFlagsAndRestarts(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Flags["machine-transport"] = "bluetooth"
	configPath := filepath.Join(t.TempDir(), "tray.json")
	sup := NewSupervisor(cfg, "")
	srv := NewServer(configPath, sup, nil)
	srv.restartLag = 0
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	cfg.AdminListen = "127.0.0.1:8432"
	body, _ := json.Marshal(cfg)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/manager/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT /api/manager/config status = %d", resp.StatusCode)
	}
	if got := sup.Config().AdminListen; got != "127.0.0.1:8432" {
		t.Fatalf("AdminListen = %q", got)
	}
	if got := sup.Config().Flags["machine-transport"]; got != "bluetooth" {
		t.Fatalf("machine-transport = %q", got)
	}
	select {
	case <-srv.restartCh:
	case <-time.After(time.Second):
		t.Fatal("manager restart was not scheduled")
	}
}

func TestServerPutProxyConfigDoesNotTouchManagerSettingsOrRestart(t *testing.T) {
	cfg := DefaultConfig()
	cfg.AdminListen = "0.0.0.0:8430"
	cfg.AdminToken = ""
	configPath := filepath.Join(t.TempDir(), "tray.json")
	sup := NewSupervisor(cfg, "")
	srv := NewServer(configPath, sup, nil)
	srv.restartLag = 0
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	body := []byte(`{"flags":{"machine-transport":"usb","usb-device":"COM3"}}`)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/proxy/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT /api/proxy/config status = %d", resp.StatusCode)
	}
	var gotResp struct {
		ProxyRestarted bool `json:"proxy_restarted"`
		ProxyChanged   bool `json:"proxy_changed"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&gotResp); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if gotResp.ProxyRestarted {
		t.Fatal("stopped proxy should not be restarted")
	}
	if !gotResp.ProxyChanged {
		t.Fatal("proxy_changed = false, want true")
	}
	if got := sup.Config().AdminListen; got != "0.0.0.0:8430" {
		t.Fatalf("AdminListen changed to %q", got)
	}
	if got := sup.Config().AdminToken; got != "" {
		t.Fatalf("AdminToken changed to %q", got)
	}
	if got := sup.Config().Flags["machine-transport"]; got != "usb" {
		t.Fatalf("machine-transport = %q", got)
	}
	select {
	case <-srv.restartCh:
		t.Fatal("proxy save should not schedule manager restart")
	default:
	}
}

func TestServerPutProxyConfigAddsDefaultMachinePort(t *testing.T) {
	cfg := DefaultConfig()
	configPath := filepath.Join(t.TempDir(), "tray.json")
	sup := NewSupervisor(cfg, "")
	srv := NewServer(configPath, sup, nil)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	body := []byte(`{"flags":{"machine":"192.168.1.42"}}`)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/proxy/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		responseBody, _ := io.ReadAll(resp.Body)
		t.Fatalf("PUT /api/proxy/config status = %d: %s", resp.StatusCode, responseBody)
	}
	var got struct {
		Config Config `json:"config"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	for source, value := range map[string]string{
		"response":   got.Config.Flags["machine"],
		"supervisor": sup.Config().Flags["machine"],
	} {
		if value != "192.168.1.42:2222" {
			t.Fatalf("%s machine = %q, want default TCP port", source, value)
		}
	}
	loaded, err := LoadConfig(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if got := loaded.Flags["machine"]; got != "192.168.1.42:2222" {
		t.Fatalf("persisted machine = %q, want default TCP port", got)
	}
}

func TestServerPutProxyConfigRejectsMalformedMachineAddress(t *testing.T) {
	cfg := DefaultConfig()
	configPath := filepath.Join(t.TempDir(), "tray.json")
	sup := NewSupervisor(cfg, "")
	srv := NewServer(configPath, sup, nil)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	body := []byte(`{"flags":{"machine":"192.168.1.42:notaport"}}`)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/proxy/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	responseBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusBadRequest || !strings.Contains(string(responseBody), "machine TCP port") {
		t.Fatalf("PUT malformed machine status = %d body = %q, want 400 port error", resp.StatusCode, responseBody)
	}
	if got := sup.Config().Flags["machine"]; got != "" {
		t.Fatalf("malformed save changed supervisor machine to %q", got)
	}
	if _, err := os.Stat(configPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("malformed save wrote config: %v", err)
	}
}

func TestServerPutProxyConfigRestartsRunningProxy(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses a POSIX shell script as the supervised proxy")
	}
	dir := t.TempDir()
	proxy := filepath.Join(dir, "proxy.sh")
	if err := os.WriteFile(proxy, []byte("#!/bin/sh\ntrap 'exit 0' TERM INT\nwhile true; do sleep 1 & wait $!; done\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := DefaultConfig()
	cfg.ProxyBinary = proxy
	configPath := filepath.Join(dir, "tray.json")
	sup := NewSupervisor(cfg, "")
	if err := sup.Start(); err != nil {
		t.Fatalf("start proxy script: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = sup.Stop(ctx)
	})
	srv := NewServer(configPath, sup, nil)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	body := []byte(`{"flags":{"name":"Shop CNC"}}`)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/proxy/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT /api/proxy/config status = %d", resp.StatusCode)
	}
	var got struct {
		ProxyRestarted bool         `json:"proxy_restarted"`
		ProxyChanged   bool         `json:"proxy_changed"`
		Process        ProcessState `json:"process"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if !got.ProxyChanged || !got.ProxyRestarted {
		t.Fatalf("restart response = %+v, want changed and restarted", got)
	}
	if !got.Process.Running || got.Process.PID == 0 {
		t.Fatalf("process = %+v, want running proxy after restart", got.Process)
	}
}

func TestServerRestartManagerEndpointSchedulesRestart(t *testing.T) {
	cfg := DefaultConfig()
	configPath := filepath.Join(t.TempDir(), "tray.json")
	sup := NewSupervisor(cfg, "")
	srv := NewServer(configPath, sup, nil)
	srv.restartLag = 0
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Post(ts.URL+"/api/manager/restart", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST /api/manager/restart status = %d", resp.StatusCode)
	}
	select {
	case <-srv.restartCh:
	case <-time.After(time.Second):
		t.Fatal("manager restart was not scheduled")
	}
}
