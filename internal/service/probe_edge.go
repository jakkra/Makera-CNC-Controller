package service

import (
	"fmt"
	"strings"
	"time"

	"github.com/uwin/cnc-proxy/internal/client"
	"github.com/uwin/cnc-proxy/internal/machine"
	"github.com/uwin/cnc-proxy/internal/session"
)

type ProbeEdgeRequest struct {
	Axis          string  `json:"axis"`
	Direction     int     `json:"direction"`
	TravelMM      float64 `json:"travel_mm"`
	TipDiameterMM float64 `json:"tip_diameter_mm"`
}

type ProbeEdgeResult struct {
	Axis          string  `json:"axis"`
	MachineEdgeMM float64 `json:"machine_edge_mm"`
}

// ProbeEdge takes a single lateral measurement with the probe already at
// contact height. It retracts along the same axis and leaves the work offset
// intact.
func (s *Service) ProbeEdge(req ProbeEdgeRequest) (ProbeEdgeResult, error) {
	axis := strings.ToLower(req.Axis)
	if (axis != "x" && axis != "y") || (req.Direction != -1 && req.Direction != 1) {
		return ProbeEdgeResult{}, fmt.Errorf("%w: choose X+, X−, Y+ or Y−", ErrInvalidArgument)
	}
	if !finite(req.TravelMM) || req.TravelMM < 0.1 || req.TravelMM > 40 || !finite(req.TipDiameterMM) || req.TipDiameterMM < 0.01 || req.TipDiameterMM > 20 {
		return ProbeEdgeResult{}, fmt.Errorf("%w: travel must be 0.1–40 mm and tip diameter 0.01–20 mm", ErrInvalidArgument)
	}
	letter := strings.ToUpper(axis)
	delta := float64(req.Direction) * req.TravelMM
	var result ProbeEdgeResult
	err := s.arb.WithMachine(true, func(c *client.Conn) error {
		start, err := s.queryRecoveryStatus(c)
		if err != nil {
			return err
		}
		if start.State != machine.Idle {
			return session.ErrNotIdle
		}
		if start.Tool == nil || start.Tool.Active != ToolID3DProbe {
			return fmt.Errorf("%w: active tool is %s; select the wired 3D Probe", ErrProbeUnavailable, toolStatusLabel(start.Tool))
		}
		if start.Controller != nil && start.Controller.InchMode {
			return fmt.Errorf("%w: switch the machine to millimeters before measuring an edge", ErrProbeUnavailable)
		}
		limits := s.store.UISettings().Machine.Learned.SoftEndstop
		lower, upper := limits.XMin, limits.XMax
		if axis == "y" {
			lower, upper = limits.YMin, limits.YMax
		}
		coordinate, ok := finiteAxisValue(start.MPos, axis)
		if !ok || !finite(lower) || !finite(upper) || lower >= upper {
			return fmt.Errorf("%w: current %s and learned travel limits are required", ErrProbeUnavailable, letter)
		}
		end := coordinate + delta
		if coordinate < lower || coordinate > upper || end < lower || end > upper {
			return fmt.Errorf("%w: probe travel exceeds learned %s limits", ErrInvalidArgument, letter)
		}

		out, err := s.sendProbeLine(c, fmt.Sprintf("G38.2 %s%.4f F50", letter, delta), true)
		if err != nil {
			return err
		}
		contact, hit, err := parseProbeResult(out)
		if err != nil {
			return fmt.Errorf("%w: %v", ErrProbeUnavailable, err)
		}
		if !hit {
			// G38.2 without contact halts the firmware with ALARM: Probe fail.
			return fmt.Errorf("%w: no %s edge found within %.1f mm; the machine is in Alarm, reset it before continuing", ErrProbeUnavailable, letter, req.TravelMM)
		}
		touch, valid := finiteAxisValue(contact, axis)
		if !valid || touch < min(coordinate, end)-tracePositionTolerance || touch > max(coordinate, end)+tracePositionTolerance {
			return fmt.Errorf("%w: no valid %s contact reported within the requested travel", ErrProbeUnavailable, letter)
		}
		if _, err := s.waitTraceMotion(c, contact, 4*time.Second); err != nil {
			return fmt.Errorf("%w: could not verify the probe stopped at the reported contact: %v", ErrMachineStatusStale, err)
		}
		if _, err := s.sendProbeLine(c, fmt.Sprintf("G53 G0 %s%.4f", letter, coordinate), false); err != nil {
			return err
		}
		if _, err := s.waitTraceMotion(c, machine.AxisValues{axis: coordinate}, probeIdleTimeout); err != nil {
			return fmt.Errorf("%w: probe contacted the edge, but the return to start could not be verified: %v", ErrMachineStatusStale, err)
		}
		result = ProbeEdgeResult{Axis: axis, MachineEdgeMM: touch + float64(req.Direction)*req.TipDiameterMM/2}
		return nil
	})
	return result, err
}
