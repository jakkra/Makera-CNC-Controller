package api

import (
	"context"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/uwin/cnc-proxy/internal/camera"
)

const cameraFrameLimit = 8 << 20

// getCameras reports configuration only. It does not probe a camera, because
// an idle configured source must not be presented to the operator as live.
func (s *Server) getCameras(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if s.camera == nil {
		writeJSON(w, http.StatusOK, camera.DisabledStatus())
		return
	}
	writeJSON(w, http.StatusOK, s.camera.Status())
}

// builtinCameraWS bridges the one fixed Z1 WebSocket JPEG source to a
// same-origin client. Browser messages are deliberately consumed but never
// forwarded upstream; the only upstream control strings are start_stream and
// stop_stream owned by this server.
func (s *Server) builtinCameraWS(w http.ResponseWriter, r *http.Request) {
	if s.camera == nil || s.camera.BuiltinWSURL() == "" {
		writeErr(w, http.StatusServiceUnavailable, "built-in camera is not configured")
		return
	}
	upstream, _, err := websocket.Dial(r.Context(), s.camera.BuiltinWSURL(), &websocket.DialOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		writeErr(w, http.StatusBadGateway, "built-in camera is unavailable")
		return
	}
	upstream.SetReadLimit(cameraFrameLimit)

	downstream, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	defer downstream.Close(websocket.StatusNormalClosure, "")
	downstream.SetReadLimit(1024)

	streamCtx, cancelStream := context.WithCancel(context.Background())
	defer func() {
		// Send stop while the upstream read is still valid. Cancelling a coder
		// websocket read first closes the connection and loses this command.
		stopCtx, cancelStop := context.WithTimeout(context.Background(), 2*time.Second)
		_ = upstream.Write(stopCtx, websocket.MessageText, []byte("stop_stream"))
		cancelStop()
		cancelStream()
		_ = upstream.Close(websocket.StatusNormalClosure, "")
	}()
	startCtx, startCancel := context.WithTimeout(streamCtx, 2*time.Second)
	err = upstream.Write(startCtx, websocket.MessageText, []byte("start_stream"))
	startCancel()
	if err != nil {
		_ = downstream.Close(websocket.StatusInternalError, "camera start failed")
		return
	}

	// A browser closing the downstream socket must stop the Z1 stream even if
	// the upstream has not produced another JPEG yet. Incoming data is ignored
	// rather than becoming an unreviewed control channel to the machine camera.
	downstreamClosed := make(chan struct{})
	go func() {
		defer close(downstreamClosed)
		for {
			if _, _, err := downstream.Read(streamCtx); err != nil {
				return
			}
		}
	}()
	type cameraFrame struct {
		typ  websocket.MessageType
		data []byte
		err  error
	}
	frames := make(chan cameraFrame)
	go func() {
		for {
			typ, data, err := upstream.Read(streamCtx)
			select {
			case frames <- cameraFrame{typ: typ, data: data, err: err}:
			case <-streamCtx.Done():
				return
			}
			if err != nil {
				return
			}
		}
	}()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-downstreamClosed:
			return
		case frame := <-frames:
			if frame.err != nil {
				return
			}
			writeCtx, writeCancel := context.WithTimeout(streamCtx, 5*time.Second)
			err = downstream.Write(writeCtx, frame.typ, frame.data)
			writeCancel()
			if err != nil {
				return
			}
		}
	}
}

// externalCamera proxies a single operator-configured MJPEG or snapshot URL.
// No query parameters, client headers, redirects, or arbitrary destinations
// are accepted, which keeps the endpoint from becoming a browser SSRF relay.
func (s *Server) externalCamera(w http.ResponseWriter, r *http.Request) {
	if s.camera == nil {
		writeErr(w, http.StatusServiceUnavailable, "external camera is not configured")
		return
	}
	resp, err := s.camera.ExternalResponse(r.Context())
	if errors.Is(err, camera.ErrNotConfigured) {
		writeErr(w, http.StatusServiceUnavailable, "external camera is not configured")
		return
	}
	if err != nil {
		writeErr(w, http.StatusBadGateway, "external camera is unavailable")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		writeErr(w, http.StatusBadGateway, "external camera returned an unsuccessful response")
		return
	}
	contentType, ok := allowedCameraContentType(resp.Header.Get("Content-Type"))
	if !ok {
		writeErr(w, http.StatusBadGateway, "external camera returned an unsupported content type")
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if length := resp.Header.Get("Content-Length"); length != "" {
		w.Header().Set("Content-Length", length)
	}
	w.WriteHeader(http.StatusOK)
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
	_, _ = io.Copy(w, resp.Body)
}

func allowedCameraContentType(raw string) (string, bool) {
	mediaType, params, err := mime.ParseMediaType(raw)
	if err != nil {
		return "", false
	}
	mediaType = strings.ToLower(mediaType)
	switch mediaType {
	case "image/jpeg", "image/png", "multipart/x-mixed-replace":
		return mime.FormatMediaType(mediaType, params), true
	default:
		return "", false
	}
}
