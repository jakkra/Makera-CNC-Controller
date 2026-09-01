// Package api exposes the service over HTTP/REST plus a Server-Sent Events
// stream for the web UI. It is a thin transport layer: all behavior lives in
// the service, so the API never blocks on the machine.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/uwin/cnc-proxy/internal/attention"
	"github.com/uwin/cnc-proxy/internal/camera"
	"github.com/uwin/cnc-proxy/internal/gcodelog"
	"github.com/uwin/cnc-proxy/internal/jog"
	"github.com/uwin/cnc-proxy/internal/machine"
	"github.com/uwin/cnc-proxy/internal/notifications"
	"github.com/uwin/cnc-proxy/internal/service"
	"github.com/uwin/cnc-proxy/internal/session"
	"github.com/uwin/cnc-proxy/internal/store"
	"github.com/uwin/cnc-proxy/internal/webguard"
)

// Server holds the HTTP handlers.
type Server struct {
	svc            *service.Service
	jog            *jog.Manager
	maxUploadBytes int64
	maxJSONBytes   int64
	maxBackupBytes int64
	notifications  *notifications.Dispatcher
	readOnly       bool
	allowedHosts   []string
	camera         *camera.Manager
}

// Options configures optional API surfaces.
type Options struct {
	Jog            *jog.Manager
	MaxUploadBytes int64
	MaxJSONBytes   int64
	MaxBackupBytes int64
	Notifications  *notifications.Dispatcher
	// Camera contains fixed process-start upstreams. Browser requests cannot
	// select their own camera URL.
	Camera *camera.Manager
	// AllowedHosts admits exact reverse-proxy Host values in addition to IP
	// literals and localhost. It never enables wildcard or suffix matching.
	AllowedHosts []string
	// ReadOnly rejects every mutating HTTP method while retaining observer data.
	ReadOnly bool
}

// New creates an API server.
func New(svc *service.Service) *Server { return NewWithOptions(svc, Options{}) }

// NewWithOptions creates an API server with optional feature managers.
func NewWithOptions(svc *service.Service, opts Options) *Server {
	if opts.MaxUploadBytes <= 0 {
		opts.MaxUploadBytes = 512 << 20
	}
	if opts.MaxJSONBytes <= 0 {
		opts.MaxJSONBytes = 1 << 20
	}
	if opts.MaxBackupBytes <= 0 {
		opts.MaxBackupBytes = 64 << 20
	}
	return &Server{
		svc:            svc,
		jog:            opts.Jog,
		maxUploadBytes: opts.MaxUploadBytes,
		maxJSONBytes:   opts.MaxJSONBytes,
		maxBackupBytes: opts.MaxBackupBytes,
		notifications:  opts.Notifications,
		readOnly:       opts.ReadOnly,
		allowedHosts:   append([]string(nil), opts.AllowedHosts...),
		camera:         opts.Camera,
	}
}

// Handler returns the configured HTTP mux.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/machine", s.getMachine)
	mux.HandleFunc("GET /api/machine/status", s.getMachine)
	mux.HandleFunc("GET /api/cameras", s.getCameras)
	mux.HandleFunc("GET /api/camera/builtin/ws", s.builtinCameraWS)
	mux.HandleFunc("GET /api/camera/external", s.externalCamera)
	mux.HandleFunc("GET /api/capabilities", s.getCapabilities)
	mux.HandleFunc("GET /api/files", s.getFiles)
	mux.HandleFunc("POST /api/files", s.postFile)
	mux.HandleFunc("POST /api/files/retry", s.retryFileJob)
	mux.HandleFunc("POST /api/files/discard", s.discardFile)
	mux.HandleFunc("GET /api/files/", s.getFileContent)    // GET /api/files/{path...}
	mux.HandleFunc("DELETE /api/files/", s.deleteFile)     // DELETE /api/files/{path...}
	mux.HandleFunc("POST /api/files/rename", s.renameFile) // body: {from,to}
	mux.HandleFunc("POST /api/dirs", s.postDir)            // body: {path}
	mux.HandleFunc("GET /api/jobs", s.getJobs)
	mux.HandleFunc("GET /api/runs", s.getRuns)
	mux.HandleFunc("DELETE /api/runs", s.clearRuns)
	mux.HandleFunc("GET /api/attention", s.getAttention)
	mux.HandleFunc("GET /api/notifications", s.getNotifications)
	mux.HandleFunc("POST /api/notifications/test", s.testNotification)
	mux.HandleFunc("POST /api/gcode", s.postGcode) // body: {line}
	mux.HandleFunc("POST /api/origin/reference", s.setMachineOrigin)
	mux.HandleFunc("GET /api/gcode/active", s.getActiveGcode)
	mux.HandleFunc("GET /api/gcode/active/segments", s.getActiveGcodeSegments)
	mux.HandleFunc("GET /api/gcode/active/source", s.getActiveGcodeSource)
	mux.HandleFunc("POST /api/gcode/active", s.selectActiveGcode)  // body: {path}
	mux.HandleFunc("POST /api/gcode/active/run", s.runActiveGcode) // runs selected path
	mux.HandleFunc("POST /api/gcode/active/paused-command", s.runPausedJobCommand)
	mux.HandleFunc("POST /api/tool/current", s.setCurrentTool)         // body: {tool_id}
	mux.HandleFunc("POST /api/tool/change", s.changeTool)              // body: {tool_id}
	mux.HandleFunc("POST /api/tool/continue", s.continueToolChange)    // runs M490.2
	mux.HandleFunc("POST /api/tool/drop", s.dropCurrentTool)           // runs M6T-1
	mux.HandleFunc("POST /api/tool/calibrate", s.calibrateCurrentTool) // starts M491
	mux.HandleFunc("POST /api/probe/z", s.probeZ)                      // one serialized Z probe
	mux.HandleFunc("POST /api/probe/auto-z", s.autoZProbe)             // controller-style M495 auto Z probe
	mux.HandleFunc("POST /api/probe/floor", s.floorZProbe)             // verified floor Z zero + safe retract
	mux.HandleFunc("POST /api/probe/3d", s.probe3D)                    // controller-style wired M480 3D probe
	mux.HandleFunc("POST /api/outline/trace", s.traceOutline)          // serialized probe-laser outline trace
	mux.HandleFunc("GET /api/gcode/log", s.getGcodeLog)                // recent gcode I/O lines
	mux.HandleFunc("POST /api/control", s.postControl)                 // realtime, job-player, or recovery action
	mux.HandleFunc("POST /api/feed-override", s.postFeedOverride)      // body: {percent}; valid while running
	mux.HandleFunc("POST /api/outputs/auto-vacuum", s.postAutoVacuum)  // body: {enabled}; valid while running
	mux.HandleFunc("GET /api/ui/settings", s.getUISettings)
	mux.HandleFunc("PUT /api/ui/settings", s.putUISettings)
	mux.HandleFunc("POST /api/machine/learn", s.learnMachineParameters)
	mux.HandleFunc("GET /api/backup", s.getBackup)
	mux.HandleFunc("POST /api/backup/import", s.postBackupImport)
	mux.HandleFunc("GET /api/jog/capabilities", s.getJogCapabilities)
	mux.HandleFunc("GET /api/jog/ws", s.jogWS)
	mux.HandleFunc("GET /api/events", s.events)
	// Everything not under /api/ is the embedded web UI.
	mux.Handle("/", webHandler())
	return sameOriginGuard(s.readOnlyGuard(mux), s.allowedHosts)
}

func (s *Server) readOnlyGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.readOnly && r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
			writeErr(w, http.StatusForbidden, "API control is disabled: this proxy is in read-only observer mode")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func (s *Server) decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	defer r.Body.Close()
	err := json.NewDecoder(http.MaxBytesReader(w, r.Body, s.maxJSONBytes)).Decode(dst)
	if err == nil {
		return true
	}
	if requestBodyTooLarge(err) {
		writeErr(w, http.StatusRequestEntityTooLarge, "request body too large")
	} else {
		writeErr(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
	}
	return false
}

func requestBodyTooLarge(err error) bool {
	return err != nil && strings.Contains(err.Error(), "http: request body too large")
}

func (s *Server) getMachine(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, s.svc.Status())
}

func (s *Server) getCapabilities(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"read_only": s.readOnly})
}

func (s *Server) getFiles(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.svc.Files())
}

func (s *Server) getJobs(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.svc.Jobs())
}

func (s *Server) getRuns(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.svc.RunHistory())
}

func (s *Server) getAttention(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, s.svc.Attention())
}

func (s *Server) getNotifications(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if s.notifications == nil {
		writeJSON(w, http.StatusOK, notifications.DisabledSnapshot())
		return
	}
	writeJSON(w, http.StatusOK, s.notifications.Snapshot())
}

func (s *Server) testNotification(w http.ResponseWriter, r *http.Request) {
	if s.notifications == nil {
		writeErr(w, http.StatusConflict, "mobile notifications are not configured")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	if err := s.notifications.SendTest(ctx); err != nil {
		writeErr(w, http.StatusBadGateway, "notification delivery failed: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "sent"})
}

func (s *Server) clearRuns(w http.ResponseWriter, r *http.Request) {
	s.svc.ClearRunHistory()
	writeJSON(w, http.StatusOK, map[string]string{"status": "cleared"})
}

// postFile accepts either a multipart upload (field "file", path from form
// "path" or the filename) or a raw body with the path in the "X-Path" header /
// "path" query parameter.
func (s *Server) postFile(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, s.maxUploadBytes)
	ct := r.Header.Get("Content-Type")
	if strings.HasPrefix(ct, "multipart/form-data") {
		f, hdr, err := r.FormFile("file")
		if err != nil {
			if requestBodyTooLarge(err) {
				writeErr(w, http.StatusRequestEntityTooLarge, "upload too large")
				return
			}
			writeErr(w, http.StatusBadRequest, "missing file field: "+err.Error())
			return
		}
		defer f.Close()
		remote := r.FormValue("path")
		if remote == "" {
			remote = hdr.Filename
		}
		s.doUpload(w, remote, f)
		return
	}
	remote := r.URL.Query().Get("path")
	if remote == "" {
		remote = r.Header.Get("X-Path")
	}
	if remote == "" {
		writeErr(w, http.StatusBadRequest, "path required (query ?path= or X-Path header)")
		return
	}
	defer r.Body.Close()
	s.doUpload(w, remote, r.Body)
}

func (s *Server) doUpload(w http.ResponseWriter, remote string, r io.Reader) {
	entry, err := s.svc.Upload(remote, r)
	if err != nil {
		if requestBodyTooLarge(err) {
			writeErr(w, http.StatusRequestEntityTooLarge, "upload too large")
			return
		}
		s.mapError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, entry)
}

func (s *Server) getFileContent(w http.ResponseWriter, r *http.Request) {
	remote := strings.TrimPrefix(r.URL.Path, "/api/files/")
	rc, entry, err := s.svc.Open(remote)
	if err != nil {
		s.mapError(w, err)
		return
	}
	defer rc.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", entry.Size))
	io.Copy(w, rc)
}

func (s *Server) deleteFile(w http.ResponseWriter, r *http.Request) {
	remote := strings.TrimPrefix(r.URL.Path, "/api/files/")
	if err := s.svc.Delete(remote); err != nil {
		s.mapError(w, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (s *Server) retryFileJob(w http.ResponseWriter, r *http.Request) {
	var body struct {
		JobID int64 `json:"job_id"`
	}
	if !s.decodeJSON(w, r, &body) {
		return
	}
	if body.JobID <= 0 {
		writeErr(w, http.StatusBadRequest, "job_id required")
		return
	}
	job, err := s.svc.RetryJob(body.JobID)
	if err != nil {
		s.mapError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, job)
}

func (s *Server) discardFile(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path string `json:"path"`
	}
	if !s.decodeJSON(w, r, &body) {
		return
	}
	if body.Path == "" {
		writeErr(w, http.StatusBadRequest, "path required")
		return
	}
	if err := s.svc.DiscardLocal(body.Path); err != nil {
		s.mapError(w, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (s *Server) renameFile(w http.ResponseWriter, r *http.Request) {
	var body struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if !s.decodeJSON(w, r, &body) {
		return
	}
	if err := s.svc.Rename(body.From, body.To); err != nil {
		s.mapError(w, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (s *Server) postDir(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path string `json:"path"`
	}
	if !s.decodeJSON(w, r, &body) {
		return
	}
	entry, err := s.svc.Mkdir(body.Path)
	if err != nil {
		s.mapError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, entry)
}

func (s *Server) mapError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, service.ErrInvalidArgument):
		writeErr(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, service.ErrNotFound):
		writeErr(w, http.StatusNotFound, err.Error())
	case errors.Is(err, service.ErrNotCached):
		writeErr(w, http.StatusConflict, err.Error())
	case errors.Is(err, service.ErrCacheValidationPending):
		writeErr(w, http.StatusServiceUnavailable, err.Error())
	case errors.Is(err, service.ErrRecoveryUnavailable):
		writeErr(w, http.StatusConflict, err.Error())
	case errors.Is(err, service.ErrRetryUnavailable):
		writeErr(w, http.StatusConflict, err.Error())
	case errors.Is(err, service.ErrDiscardUnavailable):
		writeErr(w, http.StatusConflict, err.Error())
	case errors.Is(err, service.ErrDirectoryNotEmpty):
		writeErr(w, http.StatusConflict, err.Error())
	case errors.Is(err, service.ErrNoActiveGcode):
		writeErr(w, http.StatusConflict, err.Error())
	case errors.Is(err, service.ErrActiveGcodeUnavailable):
		writeErr(w, http.StatusConflict, err.Error())
	case errors.Is(err, service.ErrProbeUnavailable):
		writeErr(w, http.StatusConflict, err.Error())
	case errors.Is(err, service.ErrToolChangeUnavailable):
		writeErr(w, http.StatusConflict, err.Error())
	case errors.Is(err, service.ErrJobControlUnavailable):
		writeErr(w, http.StatusConflict, err.Error())
	case errors.Is(err, service.ErrMachineStatusStale):
		writeErr(w, http.StatusServiceUnavailable, err.Error())
	case errors.Is(err, service.ErrMachineParametersUnavailable):
		writeErr(w, http.StatusServiceUnavailable, err.Error())
	case session.Retryable(err):
		// Machine busy / controller mid-transfer / not idle: try again later.
		writeErr(w, http.StatusServiceUnavailable, err.Error())
	default:
		log.Printf("api: internal service error: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal service error")
	}
}

// postGcode runs a single gcode line on the machine and returns its output. It
// works whether or not a controller is connected (injected during relay mode).
func (s *Server) postGcode(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Line string `json:"line"`
	}
	if !s.decodeJSON(w, r, &body) {
		return
	}
	if body.Line == "" {
		writeErr(w, http.StatusBadRequest, "line required")
		return
	}
	out, err := s.svc.SendGcode(body.Line)
	if err != nil {
		s.mapError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"output": out})
}

func (s *Server) setMachineOrigin(w http.ResponseWriter, r *http.Request) {
	var body service.MachineOriginRequest
	if !s.decodeJSON(w, r, &body) {
		return
	}
	result, err := s.svc.SetMachineOrigin(body)
	if err != nil {
		s.mapError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) probeZ(w http.ResponseWriter, r *http.Request) {
	var body service.ProbeZRequest
	if !s.decodeJSON(w, r, &body) {
		return
	}
	res, err := s.svc.ProbeZ(body)
	if err != nil {
		s.mapError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) autoZProbe(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close()
	res, err := s.svc.AutoZProbe()
	if err != nil {
		s.mapError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) floorZProbe(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close()
	res, err := s.svc.ProbeFloor()
	if err != nil {
		s.mapError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) probe3D(w http.ResponseWriter, r *http.Request) {
	var body service.Probe3DRequest
	if !s.decodeJSON(w, r, &body) {
		return
	}
	res, err := s.svc.Probe3D(body)
	if err != nil {
		s.mapError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, res)
}

func (s *Server) traceOutline(w http.ResponseWriter, r *http.Request) {
	var body service.TraceOutlineRequest
	if !s.decodeJSON(w, r, &body) {
		return
	}
	res, err := s.svc.TraceOutline(body)
	if err != nil {
		s.mapError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) getActiveGcode(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.svc.ActiveGcode())
}

func (s *Server) getActiveGcodeSegments(w http.ResponseWriter, r *http.Request) {
	start, err := queryInt(r, "start", 0)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	limit, err := queryInt(r, "limit", 5000)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	window, err := s.svc.ActiveGcodeSegments(start, limit)
	if err != nil {
		if errors.Is(err, service.ErrNoActiveGcode) {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		s.mapError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, window)
}

func (s *Server) getActiveGcodeSource(w http.ResponseWriter, r *http.Request) {
	startLine, err := queryInt(r, "start_line", 1)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	limit, err := queryInt(r, "limit", 500)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	window, err := s.svc.ActiveGcodeSource(startLine, limit)
	if err != nil {
		if errors.Is(err, service.ErrNoActiveGcode) {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		s.mapError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, window)
}

func queryInt(r *http.Request, name string, fallback int) (int, error) {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer", name)
	}
	return value, nil
}

func (s *Server) runPausedJobCommand(w http.ResponseWriter, r *http.Request) {
	var body service.PausedJobCommandRequest
	if !s.decodeJSON(w, r, &body) {
		return
	}
	result, err := s.svc.RunPausedJobCommand(body)
	if err != nil {
		s.mapError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) selectActiveGcode(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path string `json:"path"`
	}
	if !s.decodeJSON(w, r, &body) {
		return
	}
	if body.Path == "" {
		writeErr(w, http.StatusBadRequest, "path required")
		return
	}
	active, err := s.svc.SelectActiveGcode(body.Path)
	if err != nil {
		s.mapError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, active)
}

func (s *Server) runActiveGcode(w http.ResponseWriter, r *http.Request) {
	res, err := s.svc.RunActiveGcode()
	if err != nil {
		s.mapError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, res)
}

func (s *Server) setCurrentTool(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ToolID *int `json:"tool_id"`
		ID     *int `json:"id"`
	}
	if !s.decodeJSON(w, r, &body) {
		return
	}
	toolID := body.ToolID
	if toolID == nil {
		toolID = body.ID
	}
	if toolID == nil {
		writeErr(w, http.StatusBadRequest, "tool_id required")
		return
	}
	res, err := s.svc.SetCurrentToolID(*toolID)
	if err != nil {
		s.mapError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, res)
}

func (s *Server) changeTool(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ToolID *int `json:"tool_id"`
		ID     *int `json:"id"`
	}
	if !s.decodeJSON(w, r, &body) {
		return
	}
	toolID := body.ToolID
	if toolID == nil {
		toolID = body.ID
	}
	if toolID == nil {
		writeErr(w, http.StatusBadRequest, "tool_id required")
		return
	}
	res, err := s.svc.ChangeTool(*toolID)
	if err != nil {
		s.mapError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, res)
}

func (s *Server) continueToolChange(w http.ResponseWriter, r *http.Request) {
	res, err := s.svc.ContinueToolChange()
	if err != nil {
		s.mapError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, res)
}

func (s *Server) dropCurrentTool(w http.ResponseWriter, r *http.Request) {
	res, err := s.svc.DropCurrentTool()
	if err != nil {
		s.mapError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, res)
}

func (s *Server) calibrateCurrentTool(w http.ResponseWriter, r *http.Request) {
	res, err := s.svc.CalibrateCurrentTool()
	if err != nil {
		s.mapError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, res)
}

// getGcodeLog returns the retained gcode I/O lines (oldest first), so a client
// can backfill history before following the live SSE stream.
func (s *Server) getGcodeLog(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.svc.GcodeLog().Recent())
}

func (s *Server) getUISettings(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.svc.UISettings())
}

func (s *Server) putUISettings(w http.ResponseWriter, r *http.Request) {
	var body store.UISettings
	if !s.decodeJSON(w, r, &body) {
		return
	}
	ui, err := s.svc.SetUISettings(body)
	if err != nil {
		s.mapError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ui)
}

func (s *Server) learnMachineParameters(w http.ResponseWriter, r *http.Request) {
	res, err := s.svc.LearnMachineParameters()
	if err != nil {
		s.mapError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// postControl injects a realtime control action, transitions the firmware job
// player, or runs an explicit alarm recovery action. Realtime hold/resume/halt
// remain out-of-band. Job pause/resume and recovery are serialized commands.
func (s *Server) postControl(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Action string `json:"action"`
	}
	if !s.decodeJSON(w, r, &body) {
		return
	}
	action := strings.ToLower(strings.TrimSpace(body.Action))
	if action == "pause_job" || action == "pause" || action == "suspend" {
		result, err := s.svc.PauseJob()
		if err != nil {
			s.mapError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, result)
		return
	}
	if action == "resume_job" {
		result, err := s.svc.ResumeJob()
		if err != nil {
			s.mapError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, result)
		return
	}
	if action == "recover" || action == "unlock" || action == "home" || action == "reset" {
		result, err := s.svc.RecoverAlarm(action)
		if err != nil {
			s.mapError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, result)
		return
	}
	var c byte
	canonicalAction := action
	switch action {
	case "hold", "feedhold":
		c = service.ControlFeedHold
		canonicalAction = "hold"
	case "resume":
		c = service.ControlResume
	case "halt", "stop", "estop":
		c = service.ControlHalt
		canonicalAction = "halt"
	default:
		writeErr(w, http.StatusBadRequest, "action must be one of: hold, resume, halt, pause_job, resume_job, recover, unlock, home, reset")
		return
	}
	if err := s.svc.SendControl(c); err != nil {
		s.mapError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, struct {
		Action   string `json:"action"`
		Accepted bool   `json:"accepted"`
		Message  string `json:"message"`
	}{
		Action:   canonicalAction,
		Accepted: true,
		Message:  realtimeControlMessage(canonicalAction),
	})
}

func realtimeControlMessage(action string) string {
	switch action {
	case "hold":
		return "Hold command sent."
	case "resume":
		return "Resume command sent."
	case "halt":
		return "Halt command sent."
	default:
		return "Realtime control command sent."
	}
}

func (s *Server) postFeedOverride(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Percent int `json:"percent"`
	}
	if !s.decodeJSON(w, r, &body) {
		return
	}
	result, err := s.svc.SetFeedOverride(body.Percent)
	if err != nil {
		s.mapError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) postAutoVacuum(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	if !s.decodeJSON(w, r, &body) {
		return
	}
	if body.Enabled == nil {
		writeErr(w, http.StatusBadRequest, "enabled required")
		return
	}
	result, err := s.svc.SetAutoVacuum(*body.Enabled)
	if err != nil {
		s.mapError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) getBackup(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Disposition", `attachment; filename="cnc-proxy-backup.json"`)
	writeJSON(w, http.StatusOK, s.svc.ExportBackup())
}

func (s *Server) postBackupImport(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close()
	var backup service.Backup
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, s.maxBackupBytes)).Decode(&backup); err != nil {
		if requestBodyTooLarge(err) {
			writeErr(w, http.StatusRequestEntityTooLarge, "backup import body too large")
		} else {
			writeErr(w, http.StatusBadRequest, "invalid backup JSON: "+err.Error())
		}
		return
	}
	if err := s.svc.ImportBackup(backup); err != nil {
		s.mapError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "imported"})
}

// events streams catalog/job/machine/gcode changes as Server-Sent Events.
// Optional scope narrows the stream for UI surfaces that should not depend on
// unrelated data being loaded:
//   - all or empty: machine, attention, files, jobs, and gcode
//   - control: machine, attention, and gcode only
//   - files: machine, files, and jobs only
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	scope := strings.ToLower(r.URL.Query().Get("scope"))
	if scope != "" && scope != "all" && scope != "control" && scope != "files" {
		scope = "all"
	}
	includeFiles := scope == "" || scope == "all" || scope == "files"
	includeGcode := scope == "" || scope == "all" || scope == "control"
	includeMachine := scope == "" || scope == "all" || scope == "control" || scope == "files"
	includeAttention := scope == "" || scope == "all" || scope == "control"

	var ch <-chan store.Event
	var unsub func()
	if includeFiles {
		ch, unsub = s.svc.Subscribe()
		defer unsub()
	}
	var gch <-chan gcodelog.Line
	var gunsub func()
	if includeGcode {
		gch, gunsub = s.svc.GcodeLog().Subscribe()
		defer gunsub()
	}
	var mch <-chan machine.Status
	var munsub func()
	if includeMachine {
		mch, munsub = s.svc.SubscribeMachineStatus()
		defer munsub()
	}
	var ach <-chan attention.Change
	var aunsub func()
	if includeAttention {
		ach, aunsub = s.svc.SubscribeAttention()
		defer aunsub()
	}

	// Send an initial snapshot so a fresh client is immediately consistent.
	// Subscriptions are already active, so lines logged from here on arrive as
	// gcode events; duplicates against the snapshot are detectable by seq.
	snap := map[string]any{
		"machine": s.svc.Status(),
	}
	if includeFiles {
		snap["files"] = s.svc.Files()
		snap["jobs"] = s.svc.Jobs()
	}
	if includeGcode {
		snap["gcode"] = s.svc.GcodeLog().Recent()
		snap["runs"] = s.svc.RunHistory()
	}
	if includeAttention {
		snap["attention"] = s.svc.Attention()
	}
	sendEvent(w, "snapshot", snap)
	flusher.Flush()

	for {
		select {
		case <-r.Context().Done():
			return
		case ev, ok := <-ch:
			if !ok {
				return
			}
			sendEvent(w, "change", s.svc.EnrichEventJob(ev))
			flusher.Flush()
		case ln, ok := <-gch:
			if !ok {
				return
			}
			sendEvent(w, "gcode", ln)
			flusher.Flush()
		case _, ok := <-mch:
			if !ok {
				return
			}
			sendEvent(w, "machine", s.svc.Status())
			flusher.Flush()
		case change, ok := <-ach:
			if !ok {
				return
			}
			sendEvent(w, "attention", change)
			flusher.Flush()
		}
	}
}

func sendEvent(w io.Writer, event string, v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
}

func sameOriginGuard(next http.Handler, allowedHosts []string) http.Handler {
	return webguard.Handler(next, webguard.Options{
		RequiresSameOrigin: requiresSameOrigin,
		AllowHost:          webguard.AllowIPLiteralLocalhostOr(allowedHosts...),
		Reject: func(w http.ResponseWriter, message string) {
			writeErr(w, http.StatusForbidden, message)
		},
	})
}

func requiresSameOrigin(r *http.Request) bool {
	if r.URL.Path == "/api/jog/ws" {
		return true
	}
	if r.URL.Path == "/api/backup" {
		return true
	}
	if !strings.HasPrefix(r.URL.Path, "/api/") {
		return false
	}
	return true
}
