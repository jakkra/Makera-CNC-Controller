package api

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/uwin/cnc-proxy/internal/jog"
	"github.com/uwin/cnc-proxy/internal/machine"
	"github.com/uwin/cnc-proxy/internal/service"
)

func (s *Server) getJogCapabilities(w http.ResponseWriter, r *http.Request) {
	if s.jog == nil {
		writeJSON(w, http.StatusOK, jog.Capabilities{
			Enabled:      false,
			Axes:         []string{"x", "y", "z", "a"},
			Availability: jog.Availability{Available: false, Reason: jog.CodeDisabled},
		})
		return
	}
	writeJSON(w, http.StatusOK, s.jog.Capabilities())
}

type jogClientMessage struct {
	Type      string             `json:"type"`
	Seq       int64              `json:"seq"`
	Deadman   bool               `json:"deadman"`
	Axes      map[string]float64 `json:"axes"`
	Slow      bool               `json:"slow"`
	Action    string             `json:"action"`
	Axis      string             `json:"axis"`
	Distance  float64            `json:"distance"`
	Value     *float64           `json:"value"`
	Reference string             `json:"reference"`
	X         float64            `json:"x"`
	Y         float64            `json:"y"`
	Target    map[string]float64 `json:"target"`
	Feed      float64            `json:"feed_mm_min"`
	SafeZ     float64            `json:"safe_z_mm"`
	SafeZOn   *bool              `json:"safe_z_enabled"`
}

func (s *Server) jogWS(w http.ResponseWriter, r *http.Request) {
	if s.jog == nil {
		writeErr(w, http.StatusServiceUnavailable, jog.CodeDisabled)
		return
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	defer c.Close(websocket.StatusNormalClosure, "")
	c.SetReadLimit(4096)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	sess, err := s.jog.Start(ctx)
	if err != nil {
		writeWSEvent(ctx, c, jog.Event{Type: "error", Code: jog.CodeBusy, Message: err.Error()})
		c.Close(websocket.StatusPolicyViolation, err.Error())
		return
	}
	defer sess.Close()

	writeDone := make(chan struct{})
	go func() {
		defer close(writeDone)
		for ev := range sess.Events() {
			if err := writeWSEvent(ctx, c, ev); err != nil {
				cancel()
				return
			}
		}
	}()

	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			cancel()
			<-writeDone
			return
		}
		var msg jogClientMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			sess.ReportError(0, jog.CodeBadInput, "invalid JSON: "+err.Error())
			continue
		}
		switch msg.Type {
		case "arm":
			sess.Arm(msg.Seq)
		case "disarm":
			sess.Disarm(msg.Seq)
		case "control":
			sess.Control(msg.Seq, msg.Action)
		case "input":
			axes, err := parseJogAxes(msg.Axes)
			if err != nil {
				sess.ReportError(msg.Seq, jog.CodeBadInput, err.Error())
				continue
			}
			sess.SetInput(jog.Input{Seq: msg.Seq, Axes: axes, Deadman: msg.Deadman, Slow: msg.Slow})
		case "capture_position":
			sess.CapturePosition(msg.Seq)
		case "step":
			sess.Step(msg.Seq, msg.Axis, msg.Distance)
		case "origin":
			value := 0.0
			if msg.Value != nil {
				value = *msg.Value
			}
			if math.IsNaN(value) || math.IsInf(value, 0) {
				sess.ReportError(msg.Seq, jog.CodeBadInput, "origin value must be finite")
				continue
			}
			sess.SetOrigin(msg.Seq, msg.Axis, value)
		case "origin_reference":
			origin, err := s.svc.ResolveMachineOrigin(service.MachineOriginRequest{
				Reference: msg.Reference,
				X:         msg.X,
				Y:         msg.Y,
			})
			if err != nil {
				sess.ReportError(msg.Seq, jog.CodeBadInput, err.Error())
				continue
			}
			sess.SetMachineOrigin(msg.Seq, machine.AxisValues{"x": origin.X, "y": origin.Y})
		case "target":
			target, err := parseJogTarget(msg.Target)
			if err != nil {
				sess.ReportError(msg.Seq, jog.CodeBadInput, err.Error())
				continue
			}
			safeZEnabled := true
			if msg.SafeZOn != nil {
				safeZEnabled = *msg.SafeZOn
			}
			if safeZEnabled && (math.IsNaN(msg.SafeZ) || math.IsInf(msg.SafeZ, 0)) {
				sess.ReportError(msg.Seq, jog.CodeBadInput, "safe_z_mm must be finite")
				continue
			}
			safeZ := msg.SafeZ
			if safeZEnabled {
				safeZ = s.svc.SafeZTargetMM(safeZ)
			}
			sess.Target(msg.Seq, target, msg.Feed, safeZEnabled, safeZ)
		default:
			sess.ReportError(msg.Seq, jog.CodeBadInput, "type must be one of: arm, input, capture_position, target, step, origin, origin_reference, control, disarm")
		}
	}
}

func writeWSEvent(ctx context.Context, c *websocket.Conn, ev jog.Event) error {
	b, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	wctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return c.Write(wctx, websocket.MessageText, b)
}

func parseJogAxes(in map[string]float64) (jog.Axes, error) {
	var out jog.Axes
	for k, v := range in {
		if math.IsNaN(v) || math.IsInf(v, 0) || v < -1 || v > 1 {
			return out, fmt.Errorf("axis %q must be between -1 and 1", k)
		}
		switch k {
		case "x":
			out.X = v
		case "y":
			out.Y = v
		case "z":
			out.Z = v
		case "a":
			out.A = v
		default:
			return out, fmt.Errorf("unsupported axis %q", k)
		}
	}
	if out.A != 0 && (out.X != 0 || out.Y != 0 || out.Z != 0) {
		return jog.Axes{}, fmt.Errorf("A-axis jog cannot be combined with XYZ motion")
	}
	return out, nil
}

func parseJogTarget(in map[string]float64) (machine.AxisValues, error) {
	if len(in) == 0 {
		return nil, fmt.Errorf("target requires at least one axis")
	}
	out := machine.AxisValues{}
	for k, v := range in {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return nil, fmt.Errorf("target %q must be finite", k)
		}
		if k != "x" && k != "y" && k != "z" {
			return nil, fmt.Errorf("unsupported target axis %q", k)
		}
		out[k] = v
	}
	return out, nil
}
