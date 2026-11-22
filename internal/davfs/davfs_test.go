package davfs

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/net/webdav"

	"github.com/uwin/cnc-proxy/internal/carveratest"
	"github.com/uwin/cnc-proxy/internal/client"
	"github.com/uwin/cnc-proxy/internal/httpauth"
	"github.com/uwin/cnc-proxy/internal/jog"
	"github.com/uwin/cnc-proxy/internal/machine"
	"github.com/uwin/cnc-proxy/internal/service"
	"github.com/uwin/cnc-proxy/internal/session"
	"github.com/uwin/cnc-proxy/internal/store"
	"github.com/uwin/cnc-proxy/internal/synceng"
)

func newFS(t *testing.T) (*FS, *service.Service) {
	t.Helper()
	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	arb := session.New(session.Config{Dial: func() (*client.Conn, error) { return nil, io.EOF }})
	svc, err := service.New(st, arb)
	if err != nil {
		t.Fatal(err)
	}
	return New(svc), svc
}

// TestJunkFilesNotSynced ensures OS-metadata files written into the mount are
// accepted (so the file manager is happy) but never reach the catalog/queue and
// thus never the CNC.
func TestJunkFilesNotSynced(t *testing.T) {
	fs, svc := newFS(t)
	ctx := context.Background()

	for _, junk := range []string{"/._part.nc", "/.DS_Store", "/sub/._x", "/Thumbs.db"} {
		wf, err := fs.OpenFile(ctx, junk, os.O_CREATE|os.O_WRONLY, 0o644)
		if err != nil {
			t.Fatalf("open junk %q: %v", junk, err)
		}
		if _, err := wf.Write([]byte("garbage")); err != nil {
			t.Errorf("write junk %q: %v", junk, err)
		}
		if err := wf.Close(); err != nil {
			t.Errorf("close junk %q: %v", junk, err)
		}
		// Stat must report it as nonexistent, and nothing should be enqueued.
		if _, err := fs.Stat(ctx, junk); !os.IsNotExist(err) {
			t.Errorf("stat junk %q = %v, want NotExist", junk, err)
		}
	}
	if files := svc.Files(); len(files) != 0 {
		t.Errorf("junk leaked into catalog: %+v", files)
	}
	// Mkdir/Remove/Rename of junk are no-op successes.
	if err := fs.Mkdir(ctx, "/.Spotlight-V100", 0o755); err != nil {
		t.Errorf("mkdir junk: %v", err)
	}
	if err := fs.RemoveAll(ctx, "/._gone"); err != nil {
		t.Errorf("remove junk: %v", err)
	}
}

func TestWriteThenReadAndStat(t *testing.T) {
	fs, _ := newFS(t)
	ctx := context.Background()

	// Open for write, write content, close → flushes into the service.
	wf, err := fs.OpenFile(ctx, "/part.nc", os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	content := []byte("G0 X0 Y0\nG1 X10 Y10\n")
	if _, err := wf.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := wf.Close(); err != nil {
		t.Fatal(err)
	}

	// Stat should now find it.
	fi, err := fs.Stat(ctx, "/part.nc")
	if err != nil {
		t.Fatalf("stat after write: %v", err)
	}
	if fi.Name() != "part.nc" || fi.Size() != int64(len(content)) || fi.IsDir() {
		t.Errorf("fileinfo = name=%q size=%d dir=%v", fi.Name(), fi.Size(), fi.IsDir())
	}

	// Read it back from cache.
	rf, err := fs.OpenFile(ctx, "/part.nc", os.O_RDONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer rf.Close()
	got, _ := io.ReadAll(rf)
	if string(got) != string(content) {
		t.Errorf("read back = %q", got)
	}
}

func TestWebDAVSaveDisarmsMovementAndAllowsSync(t *testing.T) {
	m, err := carveratest.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	status := "<Idle|MPos:0,0,0|WPos:0,0,0>"
	m.SetStatus(status)

	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	tracker := machine.NewTracker()
	if !tracker.ObserveStatusPayload(status) {
		t.Fatal("status precondition failed")
	}
	arb := session.New(session.Config{
		Tracker:     tracker,
		StateMaxAge: time.Second,
		Dial: func() (*client.Conn, error) {
			return client.Dial(m.Addr(), 2*time.Second, client.WithUploadStartDelay(0))
		},
	})
	svc, err := service.New(st, arb)
	if err != nil {
		t.Fatal(err)
	}
	jogCfg := jog.DefaultConfig()
	jogCfg.Tick = 20 * time.Millisecond
	jogCfg.StatusInterval = 40 * time.Millisecond
	jogMgr := jog.New(arb, jogCfg)
	jogSession, err := jogMgr.Start(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer jogSession.Close()
	waitForDAVJogEvent(t, jogSession, "hello")
	jogSession.Arm(1)
	waitForDAVJogEvent(t, jogSession, "ack")
	armed := waitForDAVJogEvent(t, jogSession, "state")
	if armed.Armed == nil || !*armed.Armed {
		t.Fatalf("jog state before WebDAV save = %+v, want armed", armed)
	}

	ctx, cancel := context.WithCancel(context.Background())
	eng := synceng.New(synceng.Config{Store: st, Arbiter: arb, OpTimeout: 3 * time.Second, BaseBackoff: time.Millisecond})
	done := make(chan struct{})
	go func() {
		defer close(done)
		eng.Run(ctx, 10*time.Millisecond)
	}()
	defer func() {
		cancel()
		<-done
	}()

	srv := httptest.NewServer(NewWithOptions(svc, Options{MovementDisarmer: jogMgr}).Handler(""))
	defer srv.Close()
	content := []byte("G90\nG0 X5 Y5\n")
	resp, err := http.DefaultClient.Do(mustReq(t, http.MethodPut, srv.URL+"/auto-disarm.nc", bytes.NewReader(content)))
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusNoContent {
		t.Fatalf("PUT status = %d, want successful save", resp.StatusCode)
	}
	disarmed := waitForDAVJogEvent(t, jogSession, "state")
	if disarmed.Seq != 0 || disarmed.Armed == nil || *disarmed.Armed {
		t.Fatalf("jog state after WebDAV save = %+v, want server-initiated disarm", disarmed)
	}

	deadline := time.Now().Add(2 * time.Second)
	for {
		got, ok := m.File("/sd/gcodes/auto-disarm.nc")
		if ok && bytes.Equal(got, content) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("saved WebDAV file did not sync after automatic disarm; machine content=%q present=%t", got, ok)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func waitForDAVJogEvent(t *testing.T, session *jog.Session, eventType string) jog.Event {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case event, ok := <-session.Events():
			if !ok {
				t.Fatalf("jog events closed before %q", eventType)
			}
			if event.Type == eventType {
				return event
			}
		case <-deadline:
			t.Fatalf("timeout waiting for jog event %q", eventType)
		}
	}
}

func TestWebDAVLockPlaceholderDoesNotUploadEmptyFile(t *testing.T) {
	m, err := carveratest.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	m.SetStatus("<Idle|MPos:0,0,0|WPos:0,0,0>")

	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	tr := machine.NewTracker()
	tr.Observe(machine.Idle)
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
	srv := httptest.NewServer(New(svc).Handler(""))
	defer srv.Close()

	lockBody := `<?xml version="1.0" encoding="utf-8"?>
<D:lockinfo xmlns:D="DAV:">
  <D:lockscope><D:exclusive/></D:lockscope>
  <D:locktype><D:write/></D:locktype>
  <D:owner>webdav test</D:owner>
</D:lockinfo>`
	lockReq, err := http.NewRequest("LOCK", srv.URL+"/locked.nc", strings.NewReader(lockBody))
	if err != nil {
		t.Fatal(err)
	}
	lockReq.Header.Set("Depth", "0")
	lockReq.Header.Set("Timeout", "Second-60")
	lockReq.Header.Set("Content-Type", "application/xml")
	lockResp, err := http.DefaultClient.Do(lockReq)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, lockResp.Body)
	lockResp.Body.Close()
	if lockResp.StatusCode != http.StatusCreated {
		t.Fatalf("LOCK status = %d, want 201", lockResp.StatusCode)
	}
	lockToken := lockResp.Header.Get("Lock-Token")
	if lockToken == "" {
		t.Fatal("LOCK response missing Lock-Token")
	}
	if files := svc.Files(); len(files) != 0 {
		t.Fatalf("LOCK placeholder created catalog entries: %+v", files)
	}
	if jobs := svc.Jobs(); len(jobs) != 0 {
		t.Fatalf("LOCK placeholder queued jobs: %+v", jobs)
	}

	content := []byte("G0 X0 Y0\nG1 X10 Y10\n")
	putReq, err := http.NewRequest(http.MethodPut, srv.URL+"/locked.nc", bytes.NewReader(content))
	if err != nil {
		t.Fatal(err)
	}
	putReq.Header.Set("If", "("+lockToken+")")
	putResp, err := http.DefaultClient.Do(putReq)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, putResp.Body)
	putResp.Body.Close()
	if putResp.StatusCode != http.StatusCreated && putResp.StatusCode != http.StatusNoContent {
		t.Fatalf("PUT status = %d", putResp.StatusCode)
	}
	entry, ok := svc.Lookup("locked.nc")
	if !ok {
		t.Fatal("PUT did not create catalog entry")
	}
	if entry.Size != int64(len(content)) {
		t.Fatalf("catalog size = %d, want %d", entry.Size, len(content))
	}
	jobs := svc.Jobs()
	if len(jobs) != 1 || jobs[0].Kind != store.JobUpload || jobs[0].Size != int64(len(content)) {
		t.Fatalf("jobs after PUT = %+v, want one content upload", jobs)
	}

	ctx, cancel := context.WithCancel(context.Background())
	eng := synceng.New(synceng.Config{Store: st, Arbiter: arb, OpTimeout: 3 * time.Second, BaseBackoff: time.Millisecond})
	done := make(chan struct{})
	go func() {
		defer close(done)
		eng.Run(ctx, 10*time.Millisecond)
	}()
	defer func() {
		cancel()
		<-done
	}()
	deadline := time.Now().Add(2 * time.Second)
	for {
		got, ok := m.File("/sd/gcodes/locked.nc")
		if ok && bytes.Equal(got, content) {
			return
		}
		if ok && len(got) == 0 {
			t.Fatalf("machine received zero-byte LOCK placeholder before content upload")
		}
		if time.Now().After(deadline) {
			t.Fatalf("machine file was not uploaded with content before timeout")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestWebDAVZeroPutPlaceholderDoesNotBeatContentPut(t *testing.T) {
	m, err := carveratest.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	m.SetStatus("<Idle|MPos:0,0,0|WPos:0,0,0>")

	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	tr := machine.NewTracker()
	tr.Observe(machine.Idle)
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
	srv := httptest.NewServer(New(svc).Handler(""))
	defer srv.Close()

	emptyResp, err := http.DefaultClient.Do(mustReq(t, http.MethodPut, srv.URL+"/placeholder.nc", nil))
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, emptyResp.Body)
	emptyResp.Body.Close()
	if emptyResp.StatusCode != http.StatusCreated {
		t.Fatalf("empty PUT status = %d, want 201", emptyResp.StatusCode)
	}

	ctx, cancel := context.WithCancel(context.Background())
	eng := synceng.New(synceng.Config{Store: st, Arbiter: arb, OpTimeout: 3 * time.Second, BaseBackoff: time.Millisecond})
	done := make(chan struct{})
	go func() {
		defer close(done)
		eng.Run(ctx, 10*time.Millisecond)
	}()
	defer func() {
		cancel()
		<-done
	}()
	time.Sleep(100 * time.Millisecond)
	if got, ok := m.File("/sd/gcodes/placeholder.nc"); ok {
		t.Fatalf("machine received placeholder before content: %d bytes", len(got))
	}

	content := []byte("G0 X0\nG1 X5\n")
	putResp, err := http.DefaultClient.Do(mustReq(t, http.MethodPut, srv.URL+"/placeholder.nc", bytes.NewReader(content)))
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, putResp.Body)
	putResp.Body.Close()
	if putResp.StatusCode != http.StatusCreated && putResp.StatusCode != http.StatusNoContent {
		t.Fatalf("content PUT status = %d", putResp.StatusCode)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		got, ok := m.File("/sd/gcodes/placeholder.nc")
		if ok && bytes.Equal(got, content) {
			return
		}
		if ok && len(got) == 0 {
			t.Fatalf("machine received zero-byte placeholder instead of content")
		}
		if time.Now().After(deadline) {
			t.Fatalf("machine file was not uploaded with content before timeout")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestWebDAVPropPatchDoesNotReplaceContentWithEmptyUpload(t *testing.T) {
	m, err := carveratest.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	m.SetStatus("<Idle|MPos:0,0,0|WPos:0,0,0>")

	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	tr := machine.NewTracker()
	tr.Observe(machine.Idle)
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
	srv := httptest.NewServer(New(svc).Handler(""))
	defer srv.Close()

	content := []byte("G0 X0\nG1 X5\n")
	putResp, err := http.DefaultClient.Do(mustReq(t, http.MethodPut, srv.URL+"/propped.nc", bytes.NewReader(content)))
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, putResp.Body)
	putResp.Body.Close()
	if putResp.StatusCode != http.StatusCreated && putResp.StatusCode != http.StatusNoContent {
		t.Fatalf("PUT status = %d", putResp.StatusCode)
	}

	body := `<?xml version="1.0" encoding="utf-8"?>
<D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:schemas-microsoft-com:">
  <D:set>
    <D:prop>
      <Z:Win32LastModifiedTime>Tue, 16 Jun 2026 10:00:00 GMT</Z:Win32LastModifiedTime>
    </D:prop>
  </D:set>
</D:propertyupdate>`
	patchReq := mustReq(t, "PROPPATCH", srv.URL+"/propped.nc", strings.NewReader(body))
	patchReq.Header.Set("Content-Type", "application/xml")
	patchResp, err := http.DefaultClient.Do(patchReq)
	if err != nil {
		t.Fatal(err)
	}
	patchBody, err := io.ReadAll(patchResp.Body)
	patchResp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if patchResp.StatusCode != http.StatusMultiStatus {
		t.Fatalf("PROPPATCH status = %d, want 207", patchResp.StatusCode)
	}
	assertPropPatchAccepted(t, patchBody)

	entry, ok := svc.Lookup("propped.nc")
	if !ok {
		t.Fatal("entry missing after PROPPATCH")
	}
	if entry.Size != int64(len(content)) {
		t.Fatalf("entry size after PROPPATCH = %d, want %d", entry.Size, len(content))
	}
	rc, _, err := svc.ReadCache("propped.nc")
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(rc)
	rc.Close()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, content) {
		t.Fatalf("cache after PROPPATCH = %q, want %q", string(got), string(content))
	}
	jobs := svc.Jobs()
	if len(jobs) != 1 || jobs[0].Kind != store.JobUpload || jobs[0].Size != int64(len(content)) {
		t.Fatalf("jobs after PROPPATCH = %+v, want one original content upload", jobs)
	}

	ctx, cancel := context.WithCancel(context.Background())
	eng := synceng.New(synceng.Config{Store: st, Arbiter: arb, OpTimeout: 3 * time.Second, BaseBackoff: time.Millisecond})
	done := make(chan struct{})
	go func() {
		defer close(done)
		eng.Run(ctx, 10*time.Millisecond)
	}()
	defer func() {
		cancel()
		<-done
	}()
	deadline := time.Now().Add(2 * time.Second)
	for {
		got, ok := m.File("/sd/gcodes/propped.nc")
		if ok && bytes.Equal(got, content) {
			return
		}
		if ok && len(got) == 0 {
			t.Fatalf("machine received zero-byte PROPPATCH side effect")
		}
		if time.Now().After(deadline) {
			t.Fatalf("machine file was not uploaded with content before timeout")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestWebDAVRangedPutAssemblesOriginalContent(t *testing.T) {
	m, err := carveratest.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	m.SetStatus("<Idle|MPos:0,0,0|WPos:0,0,0>")

	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	tr := machine.NewTracker()
	tr.Observe(machine.Idle)
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
	t.Cleanup(svc.Close)
	srv := httptest.NewServer(New(svc).Handler(""))
	defer srv.Close()

	content := []byte("G0 X0 Y0\nG1 X10 Y10\nM30\n")
	split := 9
	first := mustReq(t, http.MethodPut, srv.URL+"/ranged.nc", bytes.NewReader(content[:split]))
	first.Header.Set("Content-Range", fmt.Sprintf("bytes 0-%d/%d", split-1, len(content)))
	firstResp, err := http.DefaultClient.Do(first)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, firstResp.Body)
	firstResp.Body.Close()
	if firstResp.StatusCode != http.StatusCreated && firstResp.StatusCode != http.StatusNoContent {
		t.Fatalf("first ranged PUT status = %d", firstResp.StatusCode)
	}
	entry, ok := svc.Lookup("ranged.nc")
	if !ok {
		t.Fatal("first range did not create catalog entry")
	}
	if entry.Sync != store.LocalOnly || entry.Size != int64(split) {
		t.Fatalf("entry after first range = %+v, want local_only %d bytes", entry, split)
	}
	if len(svc.Upcoming().Items) != 0 {
		t.Fatal("partial range entered Up next")
	}
	if jobs := svc.Jobs(); len(jobs) != 0 {
		t.Fatalf("first range queued jobs: %+v", jobs)
	}

	second := mustReq(t, http.MethodPut, srv.URL+"/ranged.nc", bytes.NewReader(content[split:]))
	second.Header.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", split, len(content)-1, len(content)))
	secondResp, err := http.DefaultClient.Do(second)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, secondResp.Body)
	secondResp.Body.Close()
	if secondResp.StatusCode != http.StatusCreated && secondResp.StatusCode != http.StatusNoContent {
		t.Fatalf("second ranged PUT status = %d", secondResp.StatusCode)
	}
	entry, ok = svc.Lookup("ranged.nc")
	if !ok {
		t.Fatal("second range removed catalog entry")
	}
	if entry.Sync != store.PendingUpload || entry.Size != int64(len(content)) {
		t.Fatalf("entry after final range = %+v, want pending_upload %d bytes", entry, len(content))
	}
	jobs := svc.Jobs()
	if len(jobs) != 1 || jobs[0].Kind != store.JobUpload || jobs[0].Size != int64(len(content)) {
		t.Fatalf("jobs after final range = %+v, want one full upload", jobs)
	}

	ctx, cancel := context.WithCancel(context.Background())
	eng := synceng.New(synceng.Config{Store: st, Arbiter: arb, OpTimeout: 3 * time.Second, BaseBackoff: time.Millisecond})
	done := make(chan struct{})
	go func() {
		defer close(done)
		eng.Run(ctx, 10*time.Millisecond)
	}()
	defer func() {
		cancel()
		<-done
	}()
	deadline := time.Now().Add(2 * time.Second)
	for {
		got, ok := m.File("/sd/gcodes/ranged.nc")
		if ok && bytes.Equal(got, content) && svc.Upcoming().OfferID == jobs[0].ID {
			return
		}
		if ok && len(got) != len(content) {
			t.Fatalf("machine received %d-byte ranged fragment, want %d bytes", len(got), len(content))
		}
		if time.Now().After(deadline) {
			t.Fatalf("machine file was not uploaded with ranged content before timeout")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestWebDAVDeleteHidesSyncedFileFromMount(t *testing.T) {
	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	arb := session.New(session.Config{Dial: func() (*client.Conn, error) { return nil, io.EOF }})
	svc, err := service.New(st, arb)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Upload("web.nc", bytes.NewReader([]byte("G1 X1\n"))); err != nil {
		t.Fatal(err)
	}
	if err := st.SetEntrySync("/sd/gcodes/web.nc", store.Synced, ""); err != nil {
		t.Fatal(err)
	}
	fs := New(svc)
	srv := httptest.NewServer(fs.Handler(""))
	defer srv.Close()

	resp, err := http.DefaultClient.Do(mustReq(t, http.MethodDelete, srv.URL+"/web.nc", nil))
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE status = %d, want 204", resp.StatusCode)
	}
	if _, err := fs.Stat(context.Background(), "/web.nc"); !os.IsNotExist(err) {
		t.Fatalf("stat after accepted delete = %v, want not exist", err)
	}
	dir, err := fs.OpenFile(context.Background(), "/", os.O_RDONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	infos, err := dir.Readdir(0)
	if err != nil {
		t.Fatal(err)
	}
	for _, info := range infos {
		if info.Name() == "web.nc" {
			t.Fatal("pending-delete file still visible in WebDAV listing")
		}
	}
}

func TestWebDAVPutAfterWebDeleteReplacesDeleteIntent(t *testing.T) {
	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	arb := session.New(session.Config{Dial: func() (*client.Conn, error) { return nil, io.EOF }})
	svc, err := service.New(st, arb)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Upload("web.nc", bytes.NewReader([]byte("old\n"))); err != nil {
		t.Fatal(err)
	}
	if err := st.SetEntrySync("/sd/gcodes/web.nc", store.Synced, ""); err != nil {
		t.Fatal(err)
	}
	if err := svc.Delete("web.nc"); err != nil {
		t.Fatalf("web delete: %v", err)
	}
	fs := New(svc)
	if _, err := fs.Stat(context.Background(), "/web.nc"); !os.IsNotExist(err) {
		t.Fatalf("stat after web delete = %v, want not exist", err)
	}
	srv := httptest.NewServer(fs.Handler(""))
	defer srv.Close()

	content := []byte("new\n")
	resp, err := http.DefaultClient.Do(mustReq(t, http.MethodPut, srv.URL+"/web.nc", bytes.NewReader(content)))
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusNoContent {
		t.Fatalf("PUT status = %d", resp.StatusCode)
	}
	entry, ok := svc.Lookup("web.nc")
	if !ok {
		t.Fatal("replacement PUT did not create catalog entry")
	}
	if entry.Sync != store.PendingUpload || entry.Size != int64(len(content)) {
		t.Fatalf("entry after replacement PUT = %+v, want pending upload with %d bytes", entry, len(content))
	}
	rc, _, err := svc.ReadCache("web.nc")
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(rc)
	rc.Close()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, content) {
		t.Fatalf("cache = %q, want %q", string(got), string(content))
	}

	var queuedDeletes, queuedUploads int
	for _, job := range svc.Jobs() {
		switch {
		case job.Path == "/sd/gcodes/web.nc" && job.Kind == store.JobDelete && job.State == store.Queued:
			queuedDeletes++
		case job.Path == "/sd/gcodes/web.nc" && job.Kind == store.JobUpload && job.State == store.Queued:
			queuedUploads++
		}
	}
	if queuedDeletes != 0 || queuedUploads != 1 {
		t.Fatalf("jobs = %+v, want no queued delete and one replacement upload", svc.Jobs())
	}
}

func TestWebDAVResponsesDisableCachingAndExposeCatalogETag(t *testing.T) {
	fs, svc := newFS(t)
	content := []byte("G0 X0\n")
	entry, err := svc.Upload("cache.nc", bytes.NewReader(content))
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(fs.Handler(""))
	defer srv.Close()

	headResp, err := http.DefaultClient.Do(mustReq(t, http.MethodHead, srv.URL+"/cache.nc", nil))
	if err != nil {
		t.Fatal(err)
	}
	headResp.Body.Close()
	if headResp.StatusCode != http.StatusOK {
		t.Fatalf("HEAD status = %d, want 200", headResp.StatusCode)
	}
	assertNoCacheHeaders(t, headResp.Header)
	if got, want := headResp.Header.Get("ETag"), entryETag(entry); got != want {
		t.Fatalf("HEAD ETag = %q, want catalog ETag %q", got, want)
	}

	if err := svc.Delete("cache.nc"); err != nil {
		t.Fatal(err)
	}
	missingResp, err := http.DefaultClient.Do(mustReq(t, http.MethodHead, srv.URL+"/cache.nc", nil))
	if err != nil {
		t.Fatal(err)
	}
	missingResp.Body.Close()
	if missingResp.StatusCode != http.StatusNotFound {
		t.Fatalf("HEAD after delete status = %d, want 404", missingResp.StatusCode)
	}
	assertNoCacheHeaders(t, missingResp.Header)
	if got := missingResp.Header.Get("ETag"); got != "" {
		t.Fatalf("HEAD after delete returned ETag %q, want none", got)
	}
}

func TestWebDAVOptionsDoesNotAdvertiseClass2Locking(t *testing.T) {
	fs, svc := newFS(t)
	if _, err := svc.Upload("options.nc", strings.NewReader("G0 X0\n")); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(fs.Handler(""))
	defer srv.Close()

	resp, err := http.DefaultClient.Do(mustReq(t, http.MethodOptions, srv.URL+"/options.nc", nil))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	assertNoCacheHeaders(t, resp.Header)
	if got := resp.Header.Get("DAV"); got != "1" {
		t.Fatalf("DAV header = %q, want class 1 only", got)
	}
	if allow := resp.Header.Get("Allow"); strings.Contains(allow, "LOCK") || strings.Contains(allow, "UNLOCK") {
		t.Fatalf("Allow advertises locking methods: %q", allow)
	}
}

func TestWebDAVDirectoryMetadataChangesWhenChildHiddenByDelete(t *testing.T) {
	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	arb := session.New(session.Config{Dial: func() (*client.Conn, error) { return nil, io.EOF }})
	svc, err := service.New(st, arb)
	if err != nil {
		t.Fatal(err)
	}
	fs := New(svc)
	if _, err := svc.Upload("cache.nc", strings.NewReader("G0 X0\n")); err != nil {
		t.Fatal(err)
	}
	if err := st.SetEntrySync("/sd/gcodes/cache.nc", store.Synced, ""); err != nil {
		t.Fatal(err)
	}
	before, err := fs.Stat(context.Background(), "/")
	if err != nil {
		t.Fatal(err)
	}
	beforeETag, err := before.(webdav.ETager).ETag(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Millisecond)
	if err := svc.Delete("cache.nc"); err != nil {
		t.Fatal(err)
	}
	after, err := fs.Stat(context.Background(), "/")
	if err != nil {
		t.Fatal(err)
	}
	afterETag, err := after.(webdav.ETager).ETag(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !after.ModTime().After(before.ModTime()) {
		t.Fatalf("root ModTime after delete = %s, want after %s", after.ModTime(), before.ModTime())
	}
	if afterETag == beforeETag {
		t.Fatalf("root ETag did not change after delete: %q", afterETag)
	}
}

func TestWebDAVAdvisoryLockDoesNotBlockSameNameWebDeleteReupload(t *testing.T) {
	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	arb := session.New(session.Config{Dial: func() (*client.Conn, error) { return nil, io.EOF }})
	svc, err := service.New(st, arb)
	if err != nil {
		t.Fatal(err)
	}
	fs := New(svc)
	srv := httptest.NewServer(fs.Handler(""))
	defer srv.Close()

	token := webdavLock(t, srv.URL+"/web.nc")
	putReq := mustReq(t, http.MethodPut, srv.URL+"/web.nc", strings.NewReader("old\n"))
	putReq.Header.Set("If", "("+token+")")
	putResp, err := http.DefaultClient.Do(putReq)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, putResp.Body)
	putResp.Body.Close()
	if putResp.StatusCode != http.StatusCreated && putResp.StatusCode != http.StatusNoContent {
		t.Fatalf("PUT status = %d", putResp.StatusCode)
	}
	if err := svc.Delete("web.nc"); err != nil {
		t.Fatalf("web delete: %v", err)
	}
	if _, err := fs.Stat(context.Background(), "/web.nc"); !os.IsNotExist(err) {
		t.Fatalf("stat after web delete = %v, want not exist", err)
	}

	secondToken := webdavLock(t, srv.URL+"/web.nc")
	if secondToken == token {
		t.Fatalf("second lock token = %q, want a fresh lock", secondToken)
	}
	unlockReq := mustReq(t, "UNLOCK", srv.URL+"/web.nc", nil)
	unlockReq.Header.Set("Lock-Token", token)
	unlockResp, err := http.DefaultClient.Do(unlockReq)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, unlockResp.Body)
	unlockResp.Body.Close()
	if unlockResp.StatusCode != http.StatusNoContent {
		t.Fatalf("late UNLOCK status = %d, want 204", unlockResp.StatusCode)
	}
}

func TestPermissiveLockSystemExpiresAbandonedTokens(t *testing.T) {
	ls := newPermissiveLockSystem()
	now := time.Now()
	token, err := ls.Create(now, webdav.LockDetails{
		Root:     "/stale.nc",
		Duration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ls.Refresh(now.Add(2*time.Second), token, time.Second); err != webdav.ErrNoSuchLock {
		t.Fatalf("Refresh expired token error = %v, want ErrNoSuchLock", err)
	}
	if len(ls.details) != 0 || len(ls.expires) != 0 {
		t.Fatalf("expired lock retained: details=%d expires=%d", len(ls.details), len(ls.expires))
	}
}

func TestWebDAVLockedPutAllowsFollowingPropPatch(t *testing.T) {
	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	arb := session.New(session.Config{Dial: func() (*client.Conn, error) { return nil, io.EOF }})
	svc, err := service.New(st, arb)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(New(svc).Handler(""))
	defer srv.Close()

	token := webdavLock(t, srv.URL+"/propped.nc")
	content := []byte("G0 X0\n")
	putReq := mustReq(t, http.MethodPut, srv.URL+"/propped.nc", bytes.NewReader(content))
	putReq.Header.Set("If", "("+token+")")
	putResp, err := http.DefaultClient.Do(putReq)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, putResp.Body)
	putResp.Body.Close()
	if putResp.StatusCode != http.StatusCreated && putResp.StatusCode != http.StatusNoContent {
		t.Fatalf("PUT status = %d", putResp.StatusCode)
	}

	body := `<?xml version="1.0" encoding="utf-8"?>
<D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:schemas-microsoft-com:">
  <D:set>
    <D:prop>
      <Z:Win32LastModifiedTime>Tue, 16 Jun 2026 10:00:00 GMT</Z:Win32LastModifiedTime>
    </D:prop>
  </D:set>
</D:propertyupdate>`
	patchReq := mustReq(t, "PROPPATCH", srv.URL+"/propped.nc", strings.NewReader(body))
	patchReq.Header.Set("If", "("+token+")")
	patchReq.Header.Set("Content-Type", "application/xml")
	patchResp, err := http.DefaultClient.Do(patchReq)
	if err != nil {
		t.Fatal(err)
	}
	patchBody, err := io.ReadAll(patchResp.Body)
	patchResp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if patchResp.StatusCode != http.StatusMultiStatus {
		t.Fatalf("PROPPATCH status = %d, want 207", patchResp.StatusCode)
	}
	assertPropPatchAccepted(t, patchBody)

	unlockReq := mustReq(t, "UNLOCK", srv.URL+"/propped.nc", nil)
	unlockReq.Header.Set("Lock-Token", token)
	unlockResp, err := http.DefaultClient.Do(unlockReq)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, unlockResp.Body)
	unlockResp.Body.Close()
	if unlockResp.StatusCode != http.StatusNoContent {
		t.Fatalf("UNLOCK status = %d, want 204", unlockResp.StatusCode)
	}
	entry, ok := svc.Lookup("propped.nc")
	if !ok || entry.Size != int64(len(content)) {
		t.Fatalf("entry after locked PROPPATCH = %+v ok=%v", entry, ok)
	}
}

func TestWebDAVPutOverwritesVisibleSyncedFile(t *testing.T) {
	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	arb := session.New(session.Config{Dial: func() (*client.Conn, error) { return nil, io.EOF }})
	svc, err := service.New(st, arb)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Upload("overwrite.nc", bytes.NewReader([]byte("old longer content\n"))); err != nil {
		t.Fatal(err)
	}
	if err := st.SetEntrySync("/sd/gcodes/overwrite.nc", store.Synced, ""); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(New(svc).Handler(""))
	defer srv.Close()

	content := []byte("new\n")
	resp, err := http.DefaultClient.Do(mustReq(t, http.MethodPut, srv.URL+"/overwrite.nc", bytes.NewReader(content)))
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusNoContent {
		t.Fatalf("PUT status = %d", resp.StatusCode)
	}
	entry, ok := svc.Lookup("overwrite.nc")
	if !ok {
		t.Fatal("overwritten entry missing")
	}
	if entry.Sync != store.PendingUpload || entry.Size != int64(len(content)) {
		t.Fatalf("entry after overwrite PUT = %+v, want pending upload with %d bytes", entry, len(content))
	}
	rc, _, err := svc.ReadCache("overwrite.nc")
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(rc)
	rc.Close()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, content) {
		t.Fatalf("cache = %q, want %q", string(got), string(content))
	}

	var queuedUploads int
	for _, job := range svc.Jobs() {
		if job.Path == "/sd/gcodes/overwrite.nc" && job.Kind == store.JobUpload && job.State == store.Queued {
			queuedUploads++
		}
	}
	if queuedUploads != 1 {
		t.Fatalf("jobs = %+v, want one queued overwrite upload", svc.Jobs())
	}
}

func webdavLock(t *testing.T, url string) string {
	t.Helper()
	body := `<?xml version="1.0" encoding="utf-8"?>
<D:lockinfo xmlns:D="DAV:">
  <D:lockscope><D:exclusive/></D:lockscope>
  <D:locktype><D:write/></D:locktype>
  <D:owner>webdav test</D:owner>
</D:lockinfo>`
	req := mustReq(t, "LOCK", url, strings.NewReader(body))
	req.Header.Set("Depth", "0")
	req.Header.Set("Timeout", "Second-60")
	req.Header.Set("Content-Type", "application/xml")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		t.Fatalf("LOCK status = %d", resp.StatusCode)
	}
	token := resp.Header.Get("Lock-Token")
	if token == "" {
		t.Fatal("LOCK response missing Lock-Token")
	}
	return token
}

func assertPropPatchAccepted(t *testing.T, body []byte) {
	t.Helper()
	text := string(body)
	if !strings.Contains(text, "HTTP/1.1 200 OK") {
		t.Fatalf("PROPPATCH multistatus did not accept dead properties:\n%s", text)
	}
	if strings.Contains(text, "403 Forbidden") || strings.Contains(text, "424 Failed Dependency") {
		t.Fatalf("PROPPATCH multistatus reported a property failure:\n%s", text)
	}
}

func assertNoCacheHeaders(t *testing.T, h http.Header) {
	t.Helper()
	if got := h.Get("Cache-Control"); !strings.Contains(got, "no-store") || !strings.Contains(got, "no-cache") || !strings.Contains(got, "max-age=0") {
		t.Fatalf("Cache-Control = %q, want no-store/no-cache/max-age=0", got)
	}
	if got := h.Get("Pragma"); got != "no-cache" {
		t.Fatalf("Pragma = %q, want no-cache", got)
	}
	if got := h.Get("Expires"); got != "0" {
		t.Fatalf("Expires = %q, want 0", got)
	}
}

func mustReq(t *testing.T, method, url string, body io.Reader) *http.Request {
	t.Helper()
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		t.Fatal(err)
	}
	return req
}

func TestStatMissing(t *testing.T) {
	fs, _ := newFS(t)
	if _, err := fs.Stat(context.Background(), "/nope.nc"); !os.IsNotExist(err) {
		t.Errorf("stat missing = %v, want NotExist", err)
	}
}

func TestRootIsDir(t *testing.T) {
	fs, _ := newFS(t)
	fi, err := fs.Stat(context.Background(), "/")
	if err != nil || !fi.IsDir() {
		t.Errorf("root stat = %+v err=%v", fi, err)
	}
}

func TestReaddir(t *testing.T) {
	fs, svc := newFS(t)
	ctx := context.Background()
	svc.Upload("a.nc", strings.NewReader("x"))
	svc.Upload("b.nc", strings.NewReader("yy"))
	svc.Mkdir("sub")

	dir, err := fs.OpenFile(ctx, "/", os.O_RDONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	infos, err := dir.Readdir(0)
	if err != nil {
		t.Fatal(err)
	}
	if len(infos) != 3 {
		t.Fatalf("readdir got %d entries, want 3", len(infos))
	}
	names := map[string]bool{}
	for _, fi := range infos {
		names[fi.Name()] = true
	}
	for _, want := range []string{"a.nc", "b.nc", "sub"} {
		if !names[want] {
			t.Errorf("missing %q in listing", want)
		}
	}
}

func TestReaddirOnlyDirectChildren(t *testing.T) {
	fs, svc := newFS(t)
	ctx := context.Background()
	svc.Mkdir("sub")
	svc.Upload("sub/nested.nc", strings.NewReader("x"))
	svc.Upload("top.nc", strings.NewReader("y"))

	dir, _ := fs.OpenFile(ctx, "/", os.O_RDONLY, 0)
	defer dir.Close()
	infos, _ := dir.Readdir(0)
	// Root should list "sub" and "top.nc" but NOT "nested.nc".
	for _, fi := range infos {
		if fi.Name() == "nested.nc" {
			t.Error("nested file should not appear in root listing")
		}
	}

	subdir, err := fs.OpenFile(ctx, "/sub", os.O_RDONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer subdir.Close()
	subInfos, _ := subdir.Readdir(0)
	if len(subInfos) != 1 || subInfos[0].Name() != "nested.nc" {
		t.Errorf("sub listing = %+v, want [nested.nc]", subInfos)
	}
}

func TestRemoveAndRename(t *testing.T) {
	fs, svc := newFS(t)
	ctx := context.Background()
	svc.Upload("a.nc", strings.NewReader("x"))

	if err := fs.Rename(ctx, "/a.nc", "/b.nc"); err != nil {
		t.Fatalf("rename: %v", err)
	}
	// The local pending upload is moved to the destination immediately; deleting
	// the old name now 404s, while deleting the destination is a local discard.
	if err := fs.RemoveAll(ctx, "/missing.nc"); !os.IsNotExist(err) {
		t.Errorf("remove missing = %v, want NotExist", err)
	}
	if err := fs.RemoveAll(ctx, "/a.nc"); !os.IsNotExist(err) {
		t.Errorf("remove old renamed path = %v, want NotExist", err)
	}
	if err := fs.RemoveAll(ctx, "/b.nc"); err != nil {
		t.Errorf("remove renamed destination: %v", err)
	}
}

func TestNonEmptyDirectoryMutationsReturnENOTEMPTY(t *testing.T) {
	fs, svc := newFS(t)
	ctx := context.Background()
	if _, err := svc.Mkdir("full"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Upload("full/child.nc", strings.NewReader("x")); err != nil {
		t.Fatal(err)
	}
	if err := fs.RemoveAll(ctx, "/full"); !errors.Is(err, syscall.ENOTEMPTY) {
		t.Fatalf("RemoveAll(non-empty) = %v, want ENOTEMPTY", err)
	}
	if err := fs.Rename(ctx, "/full", "/renamed"); !errors.Is(err, syscall.ENOTEMPTY) {
		t.Fatalf("Rename(non-empty) = %v, want ENOTEMPTY", err)
	}
}

func TestReadNotCached(t *testing.T) {
	m, err := carveratest.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	m.SetStatus("<Run|MPos:0,0,0|WPos:0,0,0>")
	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	tr := machine.NewTracker()
	tr.Observe(machine.Run)
	arb := session.New(session.Config{
		Tracker: tr,
		Dial: func() (*client.Conn, error) {
			return client.Dial(m.Addr(), time.Second, client.WithUploadStartDelay(0))
		},
	})
	svc, err := service.New(st, arb)
	if err != nil {
		t.Fatal(err)
	}
	fs := New(svc)
	ctx := context.Background()
	// A file known only on the machine (remote_only, no cache path).
	if err := svc.PutRemoteOnly("remote.nc", 1234, time.Unix(0, 0), ""); err != nil {
		t.Fatal(err)
	}

	_, err = fs.OpenFile(ctx, "/remote.nc", os.O_RDONLY, 0)
	if err == nil {
		t.Fatal("expected error reading a non-cached remote file")
	}
	var nce *notCachedError
	if !errors.As(err, &nce) {
		t.Errorf("error = %v, want notCachedError", err)
	}
}

func TestRemoteOnlyReadDoesNotDownloadFromMount(t *testing.T) {
	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	tr := machine.NewTracker()
	tr.Observe(machine.Idle)
	dialed := false
	arb := session.New(session.Config{
		Tracker: tr,
		Dial: func() (*client.Conn, error) {
			dialed = true
			return nil, errors.New("webdav read attempted a machine download")
		},
	})
	svc, err := service.New(st, arb)
	if err != nil {
		t.Fatal(err)
	}
	fs := New(svc)

	if err := svc.PutRemoteOnly("remote.nc", 5*1024*1024, time.Unix(0, 0), ""); err != nil {
		t.Fatal(err)
	}
	fi, err := fs.Stat(context.Background(), "/remote.nc")
	if err != nil {
		t.Fatalf("remote-only stat: %v", err)
	}
	if got, want := fi.Size(), int64(5*1024*1024); got != want {
		t.Fatalf("remote-only stat size = %d, want %d", got, want)
	}

	_, err = fs.OpenFile(context.Background(), "/remote.nc", os.O_RDONLY, 0)
	if err == nil {
		t.Fatal("expected not-cached error reading a remote-only file from the mount")
	}
	var nce *notCachedError
	if !errors.As(err, &nce) {
		t.Fatalf("error = %v, want notCachedError", err)
	}
	if dialed {
		t.Fatal("WebDAV mount read dialed the machine for an uncached remote-only file")
	}
}

func TestValidationPendingReadReturns503WithoutDownload(t *testing.T) {
	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	dialed := false
	arb := session.New(session.Config{
		Dial: func() (*client.Conn, error) {
			dialed = true
			return nil, errors.New("webdav validation-pending read attempted a machine download")
		},
	})
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
		MD5:        "not-used-here",
		CachePath:  cachePath,
		CacheState: store.CacheValidating,
		Sync:       store.Synced,
	}); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(New(svc).Handler(""))
	defer srv.Close()

	for _, method := range []string{http.MethodHead, http.MethodGet} {
		req, err := http.NewRequest(method, srv.URL+"/validating.nc", nil)
		if err != nil {
			t.Fatal(err)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusServiceUnavailable {
			t.Fatalf("%s status = %d, want 503", method, resp.StatusCode)
		}
		if got := resp.Header.Get("Retry-After"); got != "5" {
			t.Fatalf("%s Retry-After = %q, want 5", method, got)
		}
	}
	if dialed {
		t.Fatal("validation-pending WebDAV read dialed the machine")
	}
}

func TestPropfindRemoteOnlyDoesNotDownloadFromMount(t *testing.T) {
	st, _ := store.Open(filepath.Join(t.TempDir(), "state.json"))
	tr := machine.NewTracker()
	tr.Observe(machine.Idle)
	dialed := false
	arb := session.New(session.Config{
		Tracker: tr,
		Dial: func() (*client.Conn, error) {
			dialed = true
			return nil, errors.New("webdav propfind attempted a machine download")
		},
	})
	svc, err := service.New(st, arb)
	if err != nil {
		t.Fatal(err)
	}
	fs := New(svc)
	if err := svc.PutRemoteOnly("remote.unknowncnc", 5*1024*1024, time.Unix(0, 0), ""); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(fs.Handler(""))
	defer srv.Close()

	reqBody := strings.NewReader(`<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:displayname/>
    <D:getcontentlength/>
    <D:getcontenttype/>
    <D:getlastmodified/>
    <D:getetag/>
  </D:prop>
</D:propfind>`)
	req, err := http.NewRequest("PROPFIND", srv.URL+"/", reqBody)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Depth", "1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	respBody, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 207 {
		t.Fatalf("PROPFIND status = %d body %q, want 207", resp.StatusCode, string(respBody))
	}
	if !strings.Contains(string(respBody), "remote.unknowncnc") {
		t.Fatalf("PROPFIND body missing remote file: %q", string(respBody))
	}
	if !strings.Contains(string(respBody), "application/octet-stream") {
		t.Fatalf("PROPFIND body missing metadata-only content type: %q", string(respBody))
	}
	if dialed {
		t.Fatal("PROPFIND dialed the machine for an uncached remote-only file")
	}

	resp, err = http.Get(srv.URL + "/remote.unknowncnc")
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("GET remote-only status = %d, want 404", resp.StatusCode)
	}
	if dialed {
		t.Fatal("GET dialed the machine for an uncached remote-only file")
	}
}

func TestWebDAVAuthMiddleware(t *testing.T) {
	fs, _ := newFS(t)
	srv := httptest.NewServer(httpauth.Middleware(
		httpauth.Config{User: "operator", Token: "secret"},
		fs.Handler(""),
	))
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodOptions, srv.URL+"/", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated WebDAV status = %d, want 401", resp.StatusCode)
	}

	req, _ = http.NewRequest(http.MethodOptions, srv.URL+"/", nil)
	req.SetBasicAuth("operator", "secret")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		t.Fatal("authenticated WebDAV request was rejected")
	}
}
