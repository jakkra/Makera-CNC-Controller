package client

import (
	"bytes"
	"crypto/md5"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/uwin/cnc-proxy/internal/carveratest"
	"github.com/uwin/cnc-proxy/internal/protocol"
)

const testTimeout = 3 * time.Second

func dialFake(t *testing.T, m *carveratest.FakeMachine) *Conn {
	t.Helper()
	conn, err := Dial(m.Addr(), testTimeout, WithUploadStartDelay(0))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func TestQueryActivePlayback(t *testing.T) {
	m, err := carveratest.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	content := []byte("G21\nG0 X1\n")
	const path = "/sd/gcodes/external job.nc"
	m.PutFile(path, content)
	m.SetActivePlayback(path)

	got, err := dialFake(t, m).QueryActivePlayback(testTimeout)
	if err != nil {
		t.Fatal(err)
	}
	wantMD5 := md5.Sum(content)
	if got.Path != path || got.MD5 != hex.EncodeToString(wantMD5[:]) {
		t.Fatalf("active playback = %+v", got)
	}
}

func TestQueryActivePlaybackNone(t *testing.T) {
	m, err := carveratest.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	got, err := dialFake(t, m).QueryActivePlayback(testTimeout)
	if err != nil || got.Path != "" || got.MD5 != "" {
		t.Fatalf("active playback = %+v, %v", got, err)
	}
}

// uploadFixture uploads content to remote via the client so the fake machine
// holds it, returning the content for later comparison.
func uploadFixture(t *testing.T, conn *Conn, remote string, size int) []byte {
	t.Helper()
	content := make([]byte, size)
	rand.Read(content)
	sum := md5.Sum(content)
	err := conn.Upload(remote, bytes.NewReader(content), int64(size), hex.EncodeToString(sum[:]), testTimeout, nil)
	if err != nil {
		t.Fatalf("upload fixture: %v", err)
	}
	return content
}

func readTestFrame(t *testing.T, c net.Conn, scan *protocol.Scanner) protocol.Frame {
	t.Helper()
	f, err := readTestFrameErr(c, scan)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func readTestFrameErr(c net.Conn, scan *protocol.Scanner) (protocol.Frame, error) {
	buf := make([]byte, 1024)
	for {
		_ = c.SetReadDeadline(time.Now().Add(testTimeout))
		n, err := c.Read(buf)
		if n > 0 {
			frames := scan.Push(buf[:n])
			if len(frames) > 0 {
				return frames[0], nil
			}
		}
		if err != nil {
			return protocol.Frame{}, err
		}
	}
}

func TestListReflectsUploads(t *testing.T) {
	m, err := carveratest.New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	conn := dialFake(t, m)

	uploadFixture(t, conn, "/sd/gcodes/a.nc", 100)
	conn.Mkdir("/sd/gcodes/sub", testTimeout)

	entries, err := conn.List("/sd/gcodes", testTimeout)
	if err != nil {
		t.Fatal(err)
	}
	var sawFile, sawDir bool
	for _, e := range entries {
		if e.Name == "a.nc" && !e.IsDir && e.Size == 100 {
			sawFile = true
		}
		if e.Name == "sub" && e.IsDir {
			sawDir = true
		}
	}
	if !sawFile || !sawDir {
		t.Errorf("listing missing entries: %+v", entries)
	}
}

func TestRemoveRenameMkdir(t *testing.T) {
	m, _ := carveratest.New()
	defer m.Close()
	conn := dialFake(t, m)

	if err := conn.Remove("/sd/gcodes/x.nc", testTimeout); err != nil {
		t.Errorf("Remove: %v", err)
	}
	if err := conn.Rename("/sd/gcodes/a.nc", "/sd/gcodes/b.nc", testTimeout); err != nil {
		t.Errorf("Rename: %v", err)
	}
	if err := conn.Mkdir("/sd/gcodes/new", testTimeout); err != nil {
		t.Errorf("Mkdir: %v", err)
	}
	if !m.HasDir("/sd/gcodes/new") {
		t.Error("mkdir not recorded on machine")
	}
}

func TestMd5MatchesUploadedContent(t *testing.T) {
	m, _ := carveratest.New()
	defer m.Close()
	conn := dialFake(t, m)

	content := uploadFixture(t, conn, "/sd/gcodes/x.nc", 256)
	want := md5.Sum(content)

	got, err := conn.Md5("/sd/gcodes/x.nc", testTimeout)
	if err != nil {
		t.Fatal(err)
	}
	if got != hex.EncodeToString(want[:]) {
		t.Errorf("md5 = %q, want %q", got, hex.EncodeToString(want[:]))
	}
}

func TestQueryState(t *testing.T) {
	m, _ := carveratest.New()
	defer m.Close()
	m.SetStatus("<Idle|MPos:0,0,0|WPos:0,0,0>")
	conn := dialFake(t, m)

	payload, err := conn.QueryState(testTimeout)
	if err != nil {
		t.Fatal(err)
	}
	if payload != "<Idle|MPos:0,0,0|WPos:0,0,0>" {
		t.Errorf("status = %q", payload)
	}
}

func TestQueryStateSurfacesPrecedingMotionError(t *testing.T) {
	conn := gcodeServer(t, func(c net.Conn) {
		c.Write(protocol.Encode(protocol.CmdNormalInfo, []byte("error:no delta jog specified\n")))
		c.Write(protocol.Encode(protocol.CmdStatusRes, []byte("<Idle|MPos:0,0,0>")))
	})

	_, err := conn.QueryState(testTimeout)
	if err == nil || !strings.Contains(err.Error(), "no delta jog specified") {
		t.Fatalf("QueryState error = %v, want preceding firmware jog error", err)
	}
}

func TestQueryStateDrainsBurstOfPrecedingMotionErrors(t *testing.T) {
	clientSide, serverSide := net.Pipe()
	defer clientSide.Close()
	defer serverSide.Close()
	conn := New(clientSide)

	go func() {
		serverSide.Write(protocol.Encode(protocol.CmdNormalInfo, []byte("error:planner busy one\n")))
		serverSide.Write(protocol.Encode(protocol.CmdNormalInfo, []byte("error:planner busy two\n")))
		var scan protocol.Scanner
		buf := make([]byte, 128)
		for {
			n, err := serverSide.Read(buf)
			for _, frame := range scan.Push(buf[:n]) {
				if frame.Cmd == protocol.CmdCtrlSingle && string(frame.Data) == "?" {
					serverSide.Write(protocol.Encode(protocol.CmdStatusRes, []byte("<Idle|MPos:0,0,0>")))
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()

	if _, err := conn.QueryState(testTimeout); err == nil || !strings.Contains(err.Error(), "planner busy") {
		t.Fatalf("burst diagnostic = %v, want planner error", err)
	}
	payload, err := conn.QueryState(testTimeout)
	if err != nil {
		t.Fatalf("fresh query after burst drain: %v", err)
	}
	if payload != "<Idle|MPos:0,0,0>" {
		t.Fatalf("fresh status after burst drain = %q", payload)
	}
}

func TestWriteGcodeLineCompletesShortTransportWrites(t *testing.T) {
	clientSide, serverSide := net.Pipe()
	defer clientSide.Close()
	defer serverSide.Close()

	conn := New(&shortWriteConn{Conn: clientSide, max: 3})
	got := make(chan protocol.Frame, 1)
	go func() {
		var scan protocol.Scanner
		buf := make([]byte, 64)
		for {
			n, err := serverSide.Read(buf)
			for _, frame := range scan.Push(buf[:n]) {
				got <- frame
				return
			}
			if err != nil {
				return
			}
		}
	}()

	if err := conn.WriteGcodeLine("$J X4.0000 F1.0000"); err != nil {
		t.Fatal(err)
	}
	select {
	case frame := <-got:
		if frame.Cmd != protocol.CmdCtrlMulti || string(frame.Data) != "$J X4.0000 F1.0000" {
			t.Fatalf("short-write frame = cmd=%02x data=%q", byte(frame.Cmd), frame.Data)
		}
	case <-time.After(time.Second):
		t.Fatal("short transport writes never produced a complete frame")
	}
}

func TestWriteConsoleCommandStripsOEMLineEnding(t *testing.T) {
	clientSide, serverSide := net.Pipe()
	defer clientSide.Close()
	defer serverSide.Close()

	conn := New(clientSide)
	got := make(chan protocol.Frame, 1)
	go func() {
		var scan protocol.Scanner
		buf := make([]byte, 64)
		for {
			n, err := serverSide.Read(buf)
			for _, frame := range scan.Push(buf[:n]) {
				got <- frame
				return
			}
			if err != nil {
				return
			}
		}
	}()

	if err := conn.WriteConsoleCommand("play /sd/gcodes/test.nc\r\n"); err != nil {
		t.Fatal(err)
	}
	select {
	case frame := <-got:
		if frame.Cmd != protocol.CmdCtrlMulti || string(frame.Data) != "play /sd/gcodes/test.nc" {
			t.Fatalf("console frame = cmd=%02x data=%q", byte(frame.Cmd), frame.Data)
		}
	case <-time.After(time.Second):
		t.Fatal("console command never produced a complete frame")
	}
}

type shortWriteConn struct {
	net.Conn
	max int
}

func (c *shortWriteConn) Write(p []byte) (int, error) {
	if c.max > 0 && len(p) > c.max {
		p = p[:c.max]
	}
	return c.Conn.Write(p)
}

func TestUploadRoundTrip(t *testing.T) {
	m, _ := carveratest.New()
	defer m.Close()
	conn := dialFake(t, m)

	content := make([]byte, WifiPacketSize*2+1234)
	rand.Read(content)
	sum := md5.Sum(content)

	var lastSent, lastTotal uint32
	err := conn.Upload("/sd/gcodes/big.nc", bytes.NewReader(content), int64(len(content)), hex.EncodeToString(sum[:]), testTimeout,
		func(sent, total uint32) { lastSent, lastTotal = sent, total })
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}

	got, ok := m.File("/sd/gcodes/big.nc")
	if !ok || !bytes.Equal(got, content) {
		t.Errorf("uploaded bytes differ: got %d bytes ok=%v, want %d", len(got), ok, len(content))
	}
	if lastSent != lastTotal || lastTotal != 3 {
		t.Errorf("progress final = %d/%d, want 3/3", lastSent, lastTotal)
	}
}

func TestUploadWaitsAfterFileStart(t *testing.T) {
	clientSide, serverSide := net.Pipe()
	defer clientSide.Close()
	defer serverSide.Close()

	const startDelay = 25 * time.Millisecond
	conn := New(clientSide, WithUploadStartDelay(startDelay))
	result := make(chan struct {
		delta time.Duration
		err   error
	}, 1)
	go func() {
		defer serverSide.Close()
		var scan protocol.Scanner
		readFrame := func() (protocol.Frame, error) {
			buf := make([]byte, 1024)
			for {
				_ = serverSide.SetReadDeadline(time.Now().Add(testTimeout))
				n, err := serverSide.Read(buf)
				if n > 0 {
					frames := scan.Push(buf[:n])
					if len(frames) > 0 {
						return frames[0], nil
					}
				}
				if err != nil {
					return protocol.Frame{}, err
				}
			}
		}

		startFrame, err := readFrame()
		if err != nil {
			result <- struct {
				delta time.Duration
				err   error
			}{err: err}
			return
		}
		if startFrame.Cmd != protocol.CmdFileStart {
			result <- struct {
				delta time.Duration
				err   error
			}{err: errors.New("first frame was not FILE_START")}
			return
		}
		started := time.Now()
		md5Frame, err := readFrame()
		if err != nil {
			result <- struct {
				delta time.Duration
				err   error
			}{err: err}
			return
		}
		if md5Frame.Cmd != protocol.CmdFileMD5 {
			result <- struct {
				delta time.Duration
				err   error
			}{err: errors.New("second frame was not FILE_MD5")}
			return
		}
		_, err = serverSide.Write(protocol.Encode(protocol.CmdFileCancel, []byte("ok\r\n")))
		result <- struct {
			delta time.Duration
			err   error
		}{delta: time.Since(started), err: err}
	}()

	sum := md5.Sum([]byte("x"))
	err := conn.Upload("/sd/gcodes/a.nc", bytes.NewReader([]byte("x")), 1, hex.EncodeToString(sum[:]), time.Second, nil)
	if !errors.Is(err, ErrUploadCanceled) {
		t.Fatalf("Upload err = %v, want ErrUploadCanceled", err)
	}
	got := <-result
	if got.err != nil {
		t.Fatal(got.err)
	}
	if got.delta < startDelay-5*time.Millisecond {
		t.Fatalf("FILE_MD5 sent after %s, want at least %s", got.delta, startDelay)
	}
}

func TestUploadCanceledIncludesMachineReason(t *testing.T) {
	clientSide, serverSide := net.Pipe()
	defer clientSide.Close()
	defer serverSide.Close()

	conn := New(clientSide, WithUploadStartDelay(0))
	done := make(chan error, 1)
	go func() {
		defer serverSide.Close()
		var scan protocol.Scanner
		seenMD5 := false
		buf := make([]byte, 1024)
		for !seenMD5 {
			_ = serverSide.SetReadDeadline(time.Now().Add(testTimeout))
			n, err := serverSide.Read(buf)
			if n > 0 {
				for _, f := range scan.Push(buf[:n]) {
					if f.Cmd == protocol.CmdFileMD5 {
						seenMD5 = true
						break
					}
				}
			}
			if err != nil {
				done <- err
				return
			}
		}
		if _, err := serverSide.Write(protocol.Encode(protocol.CmdFileCancel, []byte("ok\r\n"))); err != nil {
			done <- err
			return
		}
		if _, err := serverSide.Write(protocol.Encode(protocol.CmdNormalInfo, []byte("Error: failed to open file [/sd/gcodes/a.nc]!\r\n"))); err != nil {
			done <- err
			return
		}
		done <- nil
	}()

	sum := md5.Sum([]byte("x"))
	err := conn.Upload("/sd/gcodes/a.nc", bytes.NewReader([]byte("x")), 1, hex.EncodeToString(sum[:]), time.Second, nil)
	var cancelErr *UploadCanceledError
	if !errors.As(err, &cancelErr) {
		t.Fatalf("Upload err = %T %[1]v, want UploadCanceledError", err)
	}
	if cancelErr.Reason != "Error: failed to open file [/sd/gcodes/a.nc]!" {
		t.Fatalf("cancel reason = %q", cancelErr.Reason)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestUploadResendsLastFrameOnFileRetry(t *testing.T) {
	clientSide, serverSide := net.Pipe()
	defer clientSide.Close()
	defer serverSide.Close()

	content := []byte("retry me")
	sum := md5.Sum(content)
	md5hex := hex.EncodeToString(sum[:])
	conn := New(clientSide, WithUploadStartDelay(0))

	serverErr := make(chan error, 1)
	go func() {
		defer serverSide.Close()
		var scan protocol.Scanner
		expect := func(cmd byte) (protocol.Frame, error) {
			f, err := readTestFrameErr(serverSide, &scan)
			if err != nil {
				return protocol.Frame{}, err
			}
			if f.Cmd != cmd {
				return protocol.Frame{}, fmt.Errorf("frame = %s, want %s", protocol.CmdName(f.Cmd), protocol.CmdName(cmd))
			}
			return f, nil
		}
		if _, err := expect(protocol.CmdFileStart); err != nil {
			serverErr <- err
			return
		}
		md5Frame, err := expect(protocol.CmdFileMD5)
		if err != nil {
			serverErr <- err
			return
		}
		if string(md5Frame.Data) != md5hex {
			serverErr <- fmt.Errorf("md5 frame = %q, want %q", string(md5Frame.Data), md5hex)
			return
		}
		if _, err := serverSide.Write(protocol.Encode(protocol.CmdFileRetry, nil)); err != nil {
			serverErr <- err
			return
		}
		retriedMD5, err := expect(protocol.CmdFileMD5)
		if err != nil {
			serverErr <- err
			return
		}
		if !bytes.Equal(retriedMD5.Data, md5Frame.Data) {
			serverErr <- errors.New("FILE_RETRY did not resend the last FILE_MD5 frame")
			return
		}

		if _, err := serverSide.Write(protocol.Encode(protocol.CmdFileView, nil)); err != nil {
			serverErr <- err
			return
		}
		viewFrame, err := expect(protocol.CmdFileView)
		if err != nil {
			serverErr <- err
			return
		}
		if _, err := serverSide.Write(protocol.Encode(protocol.CmdFileRetry, nil)); err != nil {
			serverErr <- err
			return
		}
		retriedView, err := expect(protocol.CmdFileView)
		if err != nil {
			serverErr <- err
			return
		}
		if !bytes.Equal(retriedView.Data, viewFrame.Data) {
			serverErr <- errors.New("FILE_RETRY did not resend the last FILE_VIEW frame")
			return
		}

		req := []byte{0, 0, 0, 1}
		if _, err := serverSide.Write(protocol.Encode(protocol.CmdFileData, req)); err != nil {
			serverErr <- err
			return
		}
		dataFrame, err := expect(protocol.CmdFileData)
		if err != nil {
			serverErr <- err
			return
		}
		if !bytes.Equal(dataFrame.Data, append(append([]byte(nil), req...), content...)) {
			serverErr <- fmt.Errorf("data frame = %x, want seq+content", dataFrame.Data)
			return
		}
		if _, err := serverSide.Write(protocol.Encode(protocol.CmdFileRetry, nil)); err != nil {
			serverErr <- err
			return
		}
		retriedData, err := expect(protocol.CmdFileData)
		if err != nil {
			serverErr <- err
			return
		}
		if !bytes.Equal(retriedData.Data, dataFrame.Data) {
			serverErr <- errors.New("FILE_RETRY did not resend the last FILE_DATA frame")
			return
		}
		_, err = serverSide.Write(protocol.Encode(protocol.CmdFileEnd, nil))
		serverErr <- err
	}()

	if err := conn.Upload("/sd/gcodes/retry.nc", bytes.NewReader(content), int64(len(content)), md5hex, testTimeout, nil); err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if err := <-serverErr; err != nil {
		t.Fatal(err)
	}
}

func TestUploadAdvertisesConfiguredPacketSize(t *testing.T) {
	for _, tc := range []struct {
		name string
		opts []Option
		want int
	}{
		{name: "tcp default", want: WifiPacketSize},
		{name: "usb", opts: []Option{WithFilePacketSize(USBPacketSize)}, want: USBPacketSize},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, _ := carveratest.New()
			defer m.Close()
			opts := append(tc.opts, WithUploadStartDelay(0))
			conn, err := Dial(m.Addr(), testTimeout, opts...)
			if err != nil {
				t.Fatalf("dial: %v", err)
			}
			defer conn.Close()

			content := make([]byte, USBPacketSize*2+17)
			rand.Read(content)
			sum := md5.Sum(content)
			if err := conn.Upload("/sd/gcodes/pkt.nc", bytes.NewReader(content), int64(len(content)), hex.EncodeToString(sum[:]), testTimeout, nil); err != nil {
				t.Fatalf("Upload: %v", err)
			}
			sizes := m.UploadPacketSizes()
			if len(sizes) != 1 || sizes[0] != tc.want {
				t.Fatalf("upload packet sizes = %v, want [%d]", sizes, tc.want)
			}
		})
	}
}

func TestDownloadRoundTrip(t *testing.T) {
	m, _ := carveratest.New()
	defer m.Close()
	conn := dialFake(t, m)

	// Seed a multi-chunk file on the machine via upload, then download it.
	content := uploadFixture(t, conn, "/sd/gcodes/dl.nc", WifiPacketSize*2+777)

	var buf bytes.Buffer
	var lastRecv, lastTotal uint32
	gotMD5, written, err := conn.Download("/sd/gcodes/dl.nc", &buf, testTimeout,
		func(recv, total uint32) { lastRecv, lastTotal = recv, total })
	if err != nil {
		t.Fatalf("Download: %v", err)
	}
	if written != int64(len(content)) || !bytes.Equal(buf.Bytes(), content) {
		t.Errorf("downloaded %d bytes, want %d (equal=%v)", written, len(content), bytes.Equal(buf.Bytes(), content))
	}
	sum := md5.Sum(content)
	if gotMD5 != hex.EncodeToString(sum[:]) {
		t.Errorf("download md5 = %q, want %q", gotMD5, hex.EncodeToString(sum[:]))
	}
	if lastRecv != lastTotal || lastTotal != 3 {
		t.Errorf("progress final = %d/%d, want 3/3", lastRecv, lastTotal)
	}
}

func TestDownloadHandlesUSBPacketSize(t *testing.T) {
	m, _ := carveratest.New()
	defer m.Close()
	m.SetDownloadPacketSize(USBPacketSize)
	conn := dialFake(t, m)

	content := uploadFixture(t, conn, "/sd/gcodes/usb-dl.nc", USBPacketSize*2+33)

	var buf bytes.Buffer
	var lastRecv, lastTotal uint32
	gotMD5, written, err := conn.Download("/sd/gcodes/usb-dl.nc", &buf, testTimeout,
		func(recv, total uint32) { lastRecv, lastTotal = recv, total })
	if err != nil {
		t.Fatalf("Download: %v", err)
	}
	if written != int64(len(content)) || !bytes.Equal(buf.Bytes(), content) {
		t.Errorf("downloaded %d bytes, want %d (equal=%v)", written, len(content), bytes.Equal(buf.Bytes(), content))
	}
	sum := md5.Sum(content)
	if gotMD5 != hex.EncodeToString(sum[:]) {
		t.Errorf("download md5 = %q, want %q", gotMD5, hex.EncodeToString(sum[:]))
	}
	if lastRecv != lastTotal || lastTotal != 3 {
		t.Errorf("progress final = %d/%d, want 3/3", lastRecv, lastTotal)
	}
}

func TestDownloadMissing(t *testing.T) {
	m, _ := carveratest.New()
	defer m.Close()
	conn := dialFake(t, m)

	_, _, err := conn.Download("/sd/gcodes/nope.nc", io.Discard, testTimeout, nil)
	if err != ErrDownloadCanceled {
		t.Errorf("download missing = %v, want ErrDownloadCanceled", err)
	}
}

// gcodeServer scripts a single response to one CTRL_MULTI gcode line: it sends
// the given frames, then optionally closes the connection. Used to exercise
// SendGcode's termination logic without the full fake machine.
func gcodeServer(t *testing.T, reply func(c net.Conn)) *Conn {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		// Read the one inbound gcode frame, then reply.
		buf := make([]byte, 512)
		c.SetReadDeadline(time.Now().Add(2 * time.Second))
		c.Read(buf)
		reply(c)
	}()
	conn, err := Dial(ln.Addr().String(), testTimeout)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

// reply is a GcodeOpts for a command we expect the firmware to answer, with a
// short cap so tests stay fast.
var reply = GcodeOpts{ExpectReply: true, Settle: 150 * time.Millisecond, Cap: 2 * time.Second}

// fireForget is a GcodeOpts for a silent (motion/modal) command.
var fireForget = GcodeOpts{ExpectReply: false, Settle: 150 * time.Millisecond, Cap: 2 * time.Second}

func TestSendGcodeOkTerminates(t *testing.T) {
	conn := gcodeServer(t, func(c net.Conn) {
		c.Write(protocol.Encode(protocol.CmdNormalInfo, []byte("ok\r\n")))
	})
	out, err := conn.SendGcodeLine("M400", reply)
	if err != nil || out != "" {
		t.Errorf("ok-only: out=%q err=%v", out, err)
	}
}

func TestSendGcodeOkWithPayload(t *testing.T) {
	conn := gcodeServer(t, func(c net.Conn) {
		c.Write(protocol.Encode(protocol.CmdNormalInfo, []byte("ok C: X:1.0 Y:2.0\r\n")))
	})
	out, err := conn.SendGcodeLine("M114", reply)
	if err != nil || out != "C: X:1.0 Y:2.0" {
		t.Errorf("ok-payload: out=%q err=%v", out, err)
	}
}

func TestSendGcodeOutputNoOkTerminatesOnSettle(t *testing.T) {
	// A console command (e.g. version) that emits output with NO "ok". The reader
	// must return the output once the line goes quiescent, not hang to the cap.
	conn := gcodeServer(t, func(c net.Conn) {
		c.Write(protocol.Encode(protocol.CmdNormalInfo, []byte("version = 1.0.5\n")))
		// Deliberately keep the connection open; termination must come from the
		// settle window, not an EOF.
		time.Sleep(time.Second)
	})
	t0 := time.Now()
	out, err := conn.SendGcodeLine("version", reply)
	if err != nil {
		t.Errorf("output-no-ok: unexpected err=%v (out=%q)", err, out)
	}
	if out != "version = 1.0.5" {
		t.Errorf("output-no-ok: out=%q", out)
	}
	if time.Since(t0) > time.Second {
		t.Errorf("took %v; should terminate on settle window, not block", time.Since(t0))
	}
}

func TestSendGcodeMultiLineOutput(t *testing.T) {
	// A multi-line no-ok reply (e.g. M503) is joined with newlines.
	conn := gcodeServer(t, func(c net.Conn) {
		c.Write(protocol.Encode(protocol.CmdNormalInfo, []byte("line1\n")))
		c.Write(protocol.Encode(protocol.CmdNormalInfo, []byte("line2\n")))
	})
	out, err := conn.SendGcodeLine("M503", reply)
	if err != nil || out != "line1\nline2" {
		t.Errorf("multi-line: out=%q err=%v", out, err)
	}
}

func TestSendGcodeDiagResponse(t *testing.T) {
	// diagnose returns DIAG_RES on the real firmware, not NORMAL_INFO.
	conn := gcodeServer(t, func(c net.Conn) {
		c.Write(protocol.Encode(protocol.CmdDiagRes, []byte("{S:0,0|I:0}\n")))
	})
	out, err := conn.SendGcodeLine("diagnose", reply)
	if err != nil || out != "{S:0,0|I:0}" {
		t.Errorf("diag: out=%q err=%v", out, err)
	}
}

func TestSendGcodeReplyExpectedNoOutputIsError(t *testing.T) {
	conn := gcodeServer(t, func(c net.Conn) {
		time.Sleep(time.Second) // stay connected, stay silent
	})
	_, err := conn.SendGcodeLine("M114", reply)
	if err == nil {
		t.Fatal("reply-expected command with no reply should error")
	}
}

func TestSendGcodeFireAndForgetSilent(t *testing.T) {
	// A silent motion command: the firmware sends nothing. SendGcodeLine must
	// return promptly (within the settle window), not block to the cap.
	conn := gcodeServer(t, func(c net.Conn) {
		time.Sleep(time.Second) // stay connected, stay silent
	})
	t0 := time.Now()
	out, err := conn.SendGcodeLine("G91 G0 X-10", fireForget)
	if err != nil {
		t.Fatalf("fire-and-forget motion: %v", err)
	}
	if out != "" {
		t.Errorf("out = %q, want empty", out)
	}
	if time.Since(t0) > 700*time.Millisecond {
		t.Errorf("took %v; fire-and-forget should return after the settle window", time.Since(t0))
	}
}

func TestSendGcodeFireAndForgetCatchesError(t *testing.T) {
	// Even fire-and-forget commands surface an immediate error/alarm line the
	// firmware emits before halting (e.g. a malformed command).
	conn := gcodeServer(t, func(c net.Conn) {
		c.Write(protocol.Encode(protocol.CmdNormalInfo, []byte("error:Bad command\r\n")))
	})
	_, err := conn.SendGcodeLine("G999", fireForget)
	if err == nil {
		t.Error("expected error for error: response during drain")
	}
}

func TestSendGcodeNoOutputClose(t *testing.T) {
	// Connection closes with no output at all, before any settle → a genuine
	// error so the arbiter drops and reconnects.
	conn := gcodeServer(t, func(c net.Conn) { c.Close() })
	_, err := conn.SendGcodeLine("M114", reply)
	if err == nil {
		t.Error("no-output close should return an error")
	}
}

func TestSendGcodeError(t *testing.T) {
	conn := gcodeServer(t, func(c net.Conn) {
		c.Write(protocol.Encode(protocol.CmdNormalInfo, []byte("error:Bad command\r\n")))
	})
	_, err := conn.SendGcodeLine("M114", reply)
	if err == nil {
		t.Error("expected error for error: response")
	}
}

// TestSendGcodeInterleavedStatusIgnored confirms a STATUS_RES frame arriving
// mid-reply is fed to the observer and does not terminate or corrupt the
// command's output.
func TestSendGcodeInterleavedStatusIgnored(t *testing.T) {
	conn := gcodeServer(t, func(c net.Conn) {
		c.Write(protocol.Encode(protocol.CmdStatusRes, []byte("<Idle|MPos:0,0,0>")))
		c.Write(protocol.Encode(protocol.CmdNormalInfo, []byte("ok C: X:9.0\r\n")))
	})
	var observed string
	conn.SetStatusObserver(func(p string) { observed = p })
	out, err := conn.SendGcodeLine("M114", reply)
	if err != nil || out != "C: X:9.0" {
		t.Errorf("interleaved-status: out=%q err=%v", out, err)
	}
	if observed != "<Idle|MPos:0,0,0>" {
		t.Errorf("observer got %q, want the status payload", observed)
	}
}

func TestSendControl(t *testing.T) {
	m, err := carveratest.New()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	conn := dialFake(t, m)

	for _, c := range []byte{'!', '~', 0x18} {
		if err := conn.SendControl(c); err != nil {
			t.Fatalf("SendControl(%#x): %v", c, err)
		}
	}
	// Give the fake a moment to record them.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if len(m.Controls()) == 3 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got := m.Controls(); len(got) != 3 || got[0] != '!' || got[1] != '~' || got[2] != 0x18 {
		t.Errorf("controls = %v, want [! ~ 0x18]", got)
	}
}

func TestUploadEmptyFile(t *testing.T) {
	m, _ := carveratest.New()
	defer m.Close()
	conn := dialFake(t, m)

	sum := md5.Sum(nil)
	err := conn.Upload("/sd/gcodes/empty.nc", bytes.NewReader(nil), 0, hex.EncodeToString(sum[:]), testTimeout, nil)
	if err != nil {
		t.Fatalf("Upload empty: %v", err)
	}
	got, ok := m.File("/sd/gcodes/empty.nc")
	if !ok || len(got) != 0 {
		t.Errorf("empty upload = %q ok=%v", got, ok)
	}
}
