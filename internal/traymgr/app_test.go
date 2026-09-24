package traymgr

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestNewAppCanonicalizesChoiceCasing(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tray.json")
	cfg := DefaultConfig()
	cfg.Flags["machine-transport"] = "USB"
	writeRawConfig(t, path, cfg)

	app, err := NewApp(path, nil)
	if err != nil {
		t.Fatalf("NewApp: %v", err)
	}
	if got := app.Supervisor.Config().Flags["machine-transport"]; got != "usb" {
		t.Fatalf("machine-transport = %q, want usb", got)
	}

	loaded, err := LoadConfig(path)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if got := loaded.Flags["machine-transport"]; got != "usb" {
		t.Fatalf("persisted machine-transport = %q, want usb", got)
	}
}

func TestNewAppStartsWithInvalidProxyFlag(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tray.json")
	cfg := DefaultConfig()
	cfg.Flags["machine-transport"] = "bluetooth"
	writeRawConfig(t, path, cfg)

	app, err := NewApp(path, nil)
	if err != nil {
		t.Fatalf("NewApp should not fail on invalid proxy flag: %v", err)
	}
	if got := app.Supervisor.Config().Flags["machine-transport"]; got != "bluetooth" {
		t.Fatalf("machine-transport = %q, want original invalid value", got)
	}
	if err := app.Supervisor.Start(); err == nil {
		t.Fatal("Start should still reject invalid proxy flag")
	}
}

func TestSetWebDAVMountEnabledPersistsDespiteInvalidProxyFlag(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tray.json")
	cfg := DefaultConfig()
	cfg.Flags["machine-transport"] = "bluetooth"
	cfg.Flags["dav-addr"] = "0.0.0.0:8421"
	cfg.Flags["auth-user"] = "operator"
	cfg.Flags["auth-token"] = "secret"
	writeRawConfig(t, path, cfg)

	app, err := NewApp(path, nil)
	if err != nil {
		t.Fatalf("NewApp: %v", err)
	}

	var got webDAVMountRequest
	unmounted := false
	restore := replaceWebDAVMountFuncs(func(ctx context.Context, req webDAVMountRequest) error {
		got = req
		return nil
	}, func(ctx context.Context, req webDAVMountRequest) error {
		unmounted = true
		return nil
	}, func(ctx context.Context, req webDAVMountRequest) (bool, error) {
		return true, nil
	})
	defer restore()

	if err := app.SetWebDAVMountEnabled(context.Background(), true); err != nil {
		t.Fatalf("SetWebDAVMountEnabled: %v", err)
	}
	if !app.Supervisor.Config().WebDAVMount.Enabled {
		t.Fatal("supervisor config mount flag = false, want true")
	}
	loaded, err := LoadConfig(path)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if !loaded.WebDAVMount.Enabled {
		t.Fatal("persisted mount flag = false, want true")
	}
	if !unmounted {
		t.Fatal("fresh mount did not clear existing WebDAV mapping first")
	}
	wantURL := "http://127.0.0.1:8421/"
	if runtime.GOOS == "windows" {
		wantURL = "http://127.0.0.1:8430/webdav/"
	}
	if got.URL != wantURL {
		t.Fatalf("mount URL = %q, want %q", got.URL, wantURL)
	}
	if !got.Fresh {
		t.Fatal("mount request Fresh = false, want true")
	}
	if runtime.GOOS != "windows" && (got.User != "operator" || got.Password != "secret") {
		t.Fatalf("mount auth = %q/%q, want configured auth", got.User, got.Password)
	}
	if runtime.GOOS == "windows" && (got.User != "" || got.Password != "") {
		t.Fatalf("windows mount auth = %q/%q, want empty auth via local proxy", got.User, got.Password)
	}
}

func TestSetWebDAVMountDisabledPersistsAndUnmounts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tray.json")
	cfg := DefaultConfig()
	cfg.WebDAVMount.Enabled = true
	writeRawConfig(t, path, cfg)

	app, err := NewApp(path, nil)
	if err != nil {
		t.Fatalf("NewApp: %v", err)
	}

	unmounted := false
	restore := replaceWebDAVMountFuncs(func(ctx context.Context, req webDAVMountRequest) error {
		t.Fatal("mount should not be called")
		return nil
	}, func(ctx context.Context, req webDAVMountRequest) error {
		unmounted = true
		return nil
	}, func(ctx context.Context, req webDAVMountRequest) (bool, error) {
		return false, nil
	})
	defer restore()

	if err := app.SetWebDAVMountEnabled(context.Background(), false); err != nil {
		t.Fatalf("SetWebDAVMountEnabled: %v", err)
	}
	if !unmounted {
		t.Fatal("unmount was not called")
	}
	loaded, err := LoadConfig(path)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if loaded.WebDAVMount.Enabled {
		t.Fatal("persisted mount flag = true, want false")
	}
}

func TestSetWebDAVMountDisabledFailsIfStillMounted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tray.json")
	cfg := DefaultConfig()
	cfg.WebDAVMount.Enabled = true
	writeRawConfig(t, path, cfg)

	app, err := NewApp(path, nil)
	if err != nil {
		t.Fatalf("NewApp: %v", err)
	}

	restore := replaceWebDAVMountFuncs(func(ctx context.Context, req webDAVMountRequest) error {
		t.Fatal("mount should not be called")
		return nil
	}, func(ctx context.Context, req webDAVMountRequest) error {
		return nil
	}, func(ctx context.Context, req webDAVMountRequest) (bool, error) {
		return true, nil
	})
	defer restore()

	if err := app.SetWebDAVMountEnabled(context.Background(), false); err == nil {
		t.Fatal("SetWebDAVMountEnabled succeeded, want still-mounted error")
	}
	got := app.Server.recentNotifications()
	if len(got) != 1 {
		t.Fatalf("notifications = %+v, want one failure", got)
	}
	if got[0].Message != "WebDAV unmount failed: webdav unmount command completed but the mount is still present" {
		t.Fatalf("notification message = %q", got[0].Message)
	}
}

func TestWebDAVMountStatusSeparatesDesiredFromMounted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tray.json")
	cfg := DefaultConfig()
	cfg.WebDAVMount.Enabled = true
	writeRawConfig(t, path, cfg)

	app, err := NewApp(path, nil)
	if err != nil {
		t.Fatalf("NewApp: %v", err)
	}
	restore := replaceWebDAVMountFuncs(func(ctx context.Context, req webDAVMountRequest) error {
		return nil
	}, func(ctx context.Context, req webDAVMountRequest) error {
		return nil
	}, func(ctx context.Context, req webDAVMountRequest) (bool, error) {
		return false, nil
	})
	defer restore()

	st := app.WebDAVMountStatus(context.Background())
	if !st.Desired {
		t.Fatal("desired = false, want true")
	}
	if st.Mounted {
		t.Fatal("mounted = true, want false")
	}
}

func TestSetWebDAVMountEnabledRecordsMountFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tray.json")
	cfg := DefaultConfig()
	writeRawConfig(t, path, cfg)

	rec := &recordingNotifier{}
	app, err := NewApp(path, rec)
	if err != nil {
		t.Fatalf("NewApp: %v", err)
	}
	restore := replaceWebDAVMountFuncs(func(ctx context.Context, req webDAVMountRequest) error {
		return errors.New("net use failed")
	}, func(ctx context.Context, req webDAVMountRequest) error {
		return nil
	}, func(ctx context.Context, req webDAVMountRequest) (bool, error) {
		return false, nil
	})
	defer restore()

	if err := app.SetWebDAVMountEnabled(context.Background(), true); err == nil {
		t.Fatal("SetWebDAVMountEnabled succeeded, want error")
	}
	got := app.Server.recentNotifications()
	if len(got) != 1 {
		t.Fatalf("notifications = %+v, want one failure", got)
	}
	if got[0].Level != "error" || got[0].Message != "WebDAV mount failed: net use failed" {
		t.Fatalf("notification = %+v", got[0])
	}
	if len(rec.got) != 1 {
		t.Fatalf("notifier got %d notifications, want 1", len(rec.got))
	}
	logText := managerLogText(app.Server.recentManagerLog())
	for _, want := range []string{
		"mount requested target=",
		"mount native call starting target=",
		"WebDAV mount failed: net use failed",
	} {
		if !strings.Contains(logText, want) {
			t.Fatalf("manager log missing %q in:\n%s", want, logText)
		}
	}
	st := app.WebDAVMountStatus(context.Background())
	if st.Error != "net use failed" {
		t.Fatalf("status error = %q, want mount error", st.Error)
	}
	if st.ErrorAction != "mount" {
		t.Fatalf("status error action = %q, want mount", st.ErrorAction)
	}
}

func TestRemountWebDAVRecordsFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tray.json")
	cfg := DefaultConfig()
	cfg.WebDAVMount.Enabled = true
	writeRawConfig(t, path, cfg)

	app, err := NewApp(path, nil)
	if err != nil {
		t.Fatalf("NewApp: %v", err)
	}
	restore := replaceWebDAVMountFuncs(func(ctx context.Context, req webDAVMountRequest) error {
		return errors.New("proxy refused connection")
	}, func(ctx context.Context, req webDAVMountRequest) error {
		return nil
	}, func(ctx context.Context, req webDAVMountRequest) (bool, error) {
		return false, nil
	})
	defer restore()

	if err := app.RemountWebDAV(context.Background()); err == nil {
		t.Fatal("RemountWebDAV succeeded, want error")
	}
	got := app.Server.recentNotifications()
	if len(got) != 1 {
		t.Fatalf("notifications = %+v, want one failure", got)
	}
	if got[0].Message != "WebDAV remount failed: proxy refused connection" {
		t.Fatalf("notification message = %q", got[0].Message)
	}
}

func TestRemountWebDAVRefreshesMountedDriveWhenDisabled(t *testing.T) {
	if !WebDAVMountSupported() {
		t.Skip("native WebDAV remount is not supported on this platform")
	}
	path := filepath.Join(t.TempDir(), "tray.json")
	cfg := DefaultConfig()
	cfg.WebDAVMount.Enabled = false
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

	if err := app.RemountWebDAV(context.Background()); err != nil {
		t.Fatalf("RemountWebDAV: %v", err)
	}
	if mounts != 1 || unmounts != 1 {
		t.Fatalf("mounts=%d unmounts=%d, want 1/1", mounts, unmounts)
	}
	if got, want := fmt.Sprint(fresh), "[true]"; got != want {
		t.Fatalf("fresh mount flags = %s, want %s", got, want)
	}
	if app.Supervisor.Config().WebDAVMount.Enabled {
		t.Fatal("remount changed disabled config flag")
	}
}

func TestRemountWebDAVSkipsWhenDisabledAndUnmounted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tray.json")
	cfg := DefaultConfig()
	cfg.WebDAVMount.Enabled = false
	writeRawConfig(t, path, cfg)

	app, err := NewApp(path, nil)
	if err != nil {
		t.Fatalf("NewApp: %v", err)
	}
	var mounts, unmounts int
	restore := replaceWebDAVMountFuncs(func(ctx context.Context, req webDAVMountRequest) error {
		mounts++
		return nil
	}, func(ctx context.Context, req webDAVMountRequest) error {
		unmounts++
		return nil
	}, func(ctx context.Context, req webDAVMountRequest) (bool, error) {
		return false, nil
	})
	defer restore()

	if err := app.RemountWebDAV(context.Background()); err != nil {
		t.Fatalf("RemountWebDAV: %v", err)
	}
	if mounts != 0 || unmounts != 0 {
		t.Fatalf("mounts=%d unmounts=%d, want 0/0", mounts, unmounts)
	}
	logText := managerLogText(app.Server.recentManagerLog())
	if !strings.Contains(logText, "remount skipped because WebDAV mount is disabled and no mount is present") {
		t.Fatalf("manager log = %q", logText)
	}
}

func TestWebDAVMountStatusReportsBusyWithoutBlocking(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tray.json")
	cfg := DefaultConfig()
	cfg.WebDAVMount.Enabled = true
	writeRawConfig(t, path, cfg)

	app, err := NewApp(path, nil)
	if err != nil {
		t.Fatalf("NewApp: %v", err)
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	restore := replaceWebDAVMountFuncs(func(ctx context.Context, req webDAVMountRequest) error {
		once.Do(func() { close(entered) })
		<-release
		return nil
	}, func(ctx context.Context, req webDAVMountRequest) error {
		return nil
	}, func(ctx context.Context, req webDAVMountRequest) (bool, error) {
		return true, nil
	})
	defer restore()

	done := make(chan error, 1)
	go func() {
		done <- app.RemountWebDAV(context.Background())
	}()
	<-entered
	st := app.WebDAVMountStatus(context.Background())
	if !st.Busy {
		t.Fatalf("status = %+v, want busy", st)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatalf("RemountWebDAV: %v", err)
	}
}

func TestSetWebDAVMountDisabledCancelsInFlightAutomaticMount(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tray.json")
	cfg := DefaultConfig()
	cfg.WebDAVMount.Enabled = true
	writeRawConfig(t, path, cfg)

	app, err := NewApp(path, nil)
	if err != nil {
		t.Fatalf("NewApp: %v", err)
	}
	entered := make(chan struct{})
	canceled := make(chan struct{})
	unmounted := make(chan struct{}, 1)
	var once sync.Once
	restore := replaceWebDAVMountFuncs(func(ctx context.Context, req webDAVMountRequest) error {
		once.Do(func() { close(entered) })
		<-ctx.Done()
		close(canceled)
		return ctx.Err()
	}, func(ctx context.Context, req webDAVMountRequest) error {
		unmounted <- struct{}{}
		return nil
	}, func(ctx context.Context, req webDAVMountRequest) (bool, error) {
		return false, nil
	})
	defer restore()

	autoDone := make(chan error, 1)
	go func() { autoDone <- app.remountWebDAVQuiet(context.Background()) }()
	<-entered

	disableDone := make(chan error, 1)
	go func() { disableDone <- app.SetWebDAVMountEnabled(context.Background(), false) }()

	select {
	case <-canceled:
	case <-time.After(time.Second):
		t.Fatal("disable did not cancel the in-flight automatic mount")
	}
	if err := <-autoDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("automatic mount error = %v, want context canceled", err)
	}
	if err := <-disableDone; err != nil {
		t.Fatalf("disable: %v", err)
	}
	select {
	case <-unmounted:
	default:
		t.Fatal("disable did not run verified unmount cleanup")
	}
	if app.Supervisor.Config().WebDAVMount.Enabled {
		t.Fatal("mount remained enabled in supervisor config")
	}
	loaded, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.WebDAVMount.Enabled {
		t.Fatal("mount remained enabled in persisted config")
	}
}

func TestQuietRemountFreshensAfterProxyRestart(t *testing.T) {
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

	started := time.Now()
	setSupervisorStartedForTest(app.Supervisor, started)
	if err := app.remountWebDAVQuiet(context.Background()); err != nil {
		t.Fatalf("first quiet remount: %v", err)
	}
	if mounts != 1 || unmounts != 1 {
		t.Fatalf("first quiet remount mounts=%d unmounts=%d, want 1/1", mounts, unmounts)
	}
	if err := app.remountWebDAVQuiet(context.Background()); err != nil {
		t.Fatalf("second quiet remount: %v", err)
	}
	if mounts != 2 || unmounts != 1 {
		t.Fatalf("second quiet remount mounts=%d unmounts=%d, want 2/1", mounts, unmounts)
	}
	setSupervisorStartedForTest(app.Supervisor, started.Add(time.Second))
	if err := app.remountWebDAVQuiet(context.Background()); err != nil {
		t.Fatalf("quiet remount after restart: %v", err)
	}
	if mounts != 3 || unmounts != 2 {
		t.Fatalf("after restart mounts=%d unmounts=%d, want 3/2", mounts, unmounts)
	}
	if got, want := fmt.Sprint(fresh), "[true false true]"; got != want {
		t.Fatalf("fresh mount flags = %s, want %s", got, want)
	}
}

func setSupervisorStartedForTest(s *Supervisor, started time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cmd = &exec.Cmd{Process: &os.Process{Pid: 12345}}
	s.started = started
}

func managerLogText(entries []ManagerLogEntry) string {
	var lines []string
	for _, entry := range entries {
		lines = append(lines, entry.Level+" "+entry.Source+": "+entry.Message)
	}
	return strings.Join(lines, "\n")
}

func replaceWebDAVMountFuncs(mount func(context.Context, webDAVMountRequest) error, unmount func(context.Context, webDAVMountRequest) error, mounted func(context.Context, webDAVMountRequest) (bool, error)) func() {
	oldMount := mountWebDAVNativeFunc
	oldUnmount := unmountWebDAVNativeFunc
	oldMounted := webDAVMountedNativeFunc
	mountWebDAVNativeFunc = mount
	unmountWebDAVNativeFunc = unmount
	webDAVMountedNativeFunc = mounted
	return func() {
		mountWebDAVNativeFunc = oldMount
		unmountWebDAVNativeFunc = oldUnmount
		webDAVMountedNativeFunc = oldMounted
	}
}

func writeRawConfig(t *testing.T, path string, cfg Config) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o644); err != nil {
		t.Fatal(err)
	}
}
