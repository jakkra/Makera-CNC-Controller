package runhistory

import (
	"testing"
	"time"

	"github.com/uwin/cnc-proxy/internal/gcodelog"
	"github.com/uwin/cnc-proxy/internal/machine"
)

func TestHistoryDerivesRunFromPlayCommandAndStatus(t *testing.T) {
	h := New(10)
	start := time.Unix(1000, 0)
	h.ObserveLine(gcodelog.Line{
		Time:   start.Add(-time.Second),
		Dir:    gcodelog.DirSend,
		Source: gcodelog.SourceController,
		Text:   "play /sd/gcodes/my part.nc",
	})
	h.ObserveStatus(machine.Status{
		State:      machine.Run,
		ObservedAt: start,
		Raw:        "<Run|F:100,200,100|S:5000,12000,80|P:1,5,1>",
		Feed:       &machine.Triple{Current: 100, Target: 200, Override: 100},
		Spindle:    &machine.Spindle{CurrentRPM: 5000, TargetRPM: 12000, Override: 80},
		Progress:   []float64{1, 5, 1},
	})
	h.ObserveLine(gcodelog.Line{Time: start.Add(time.Second), Dir: gcodelog.DirSend, Source: gcodelog.SourceController, Text: "M220 S90"})
	h.ObserveStatus(machine.Status{
		State:      machine.Hold,
		ObservedAt: start.Add(2 * time.Second),
		Raw:        "<Hold|F:100,200,90|S:5000,12000,80>",
		Feed:       &machine.Triple{Current: 100, Target: 200, Override: 90},
		Spindle:    &machine.Spindle{CurrentRPM: 5000, TargetRPM: 12000, Override: 80},
	})
	h.ObserveStatus(machine.Status{
		State:      machine.Alarm,
		ObservedAt: start.Add(5 * time.Second),
		Raw:        "<Alarm|H:10>",
		HaltReason: machine.ParseHaltReason("10"),
	})

	runs := h.Recent()
	if len(runs) != 1 {
		t.Fatalf("runs = %d, want 1", len(runs))
	}
	run := runs[0]
	if run.Active || run.File != "/sd/gcodes/my part.nc" || run.Source != gcodelog.SourceController {
		t.Fatalf("run identity = %+v", run)
	}
	if run.DurationMs != 5000 || run.EndState != machine.Alarm {
		t.Fatalf("run timing/state = %+v", run)
	}
	if len(run.StateTransitions) != 3 || run.StateTransitions[1].State != machine.Hold {
		t.Fatalf("transitions = %+v", run.StateTransitions)
	}
	if len(run.Alarms) != 1 || run.Alarms[0].HaltReason == nil || run.Alarms[0].HaltReason.Code != 10 {
		t.Fatalf("alarms = %+v", run.Alarms)
	}
	if len(run.FeedOverrides) != 2 || run.FeedOverrides[1].Override != 90 {
		t.Fatalf("feed overrides = %+v", run.FeedOverrides)
	}
	if len(run.SpindleOverrides) != 1 || run.SpindleOverrides[0].Override != 80 {
		t.Fatalf("spindle overrides = %+v", run.SpindleOverrides)
	}
	if len(run.Commands) != 1 || run.Commands[0].Text != "M220 S90" {
		t.Fatalf("commands = %+v", run.Commands)
	}
}

func TestHistoryDoesNotTreatNormalFeedAndRPMSamplesAsOverrides(t *testing.T) {
	h := New(10)
	start := time.Unix(4000, 0)
	observe := func(when time.Time, feedCurrent, spindleCurrent, spindleTarget float64) {
		h.ObserveStatus(machine.Status{
			State: machine.Run, ObservedAt: when,
			Feed:     &machine.Triple{Current: feedCurrent, Target: 500, Override: 100},
			Spindle:  &machine.Spindle{CurrentRPM: spindleCurrent, TargetRPM: spindleTarget, Override: 100},
			Progress: []float64{1, 5, 1},
		})
	}
	observe(start, 420, 11800, 12000)
	observe(start.Add(time.Second), 480, 12120, 12000)
	observe(start.Add(2*time.Second), 300, 11750, 12000)
	observe(start.Add(3*time.Second), 300, 11750, 9000)
	runs := h.Recent()
	if len(runs) != 1 || len(runs[0].FeedOverrides) != 1 || len(runs[0].SpindleOverrides) != 2 {
		t.Fatalf("run history = %+v", runs)
	}
}

func TestHistoryIgnoresUnattributedShortRunTransitions(t *testing.T) {
	h := New(10)
	start := time.Unix(5000, 0)
	h.ObserveStatus(machine.Status{State: machine.Run, ObservedAt: start})
	h.ObserveStatus(machine.Status{State: machine.Idle, ObservedAt: start.Add(time.Second)})
	if runs := h.Recent(); len(runs) != 0 {
		t.Fatalf("unattributed motion became a run: %+v", runs)
	}
}

func TestHistoryReplacePreservesImportedRuns(t *testing.T) {
	h := New(2)
	end := time.Unix(2000, 0)
	h.Replace([]Run{
		{ID: 1, File: "old.nc", StartedAt: end.Add(-3 * time.Second), EndedAt: &end},
		{ID: 2, File: "new.nc", StartedAt: end.Add(-time.Second), Active: true},
	})
	runs := h.Recent()
	if len(runs) != 2 || runs[0].ID != 2 || !runs[0].Active || runs[1].ID != 1 {
		t.Fatalf("recent after replace = %+v", runs)
	}
}

func TestHistoryExpiresStaleFileHint(t *testing.T) {
	h := New(10)
	start := time.Unix(3000, 0)
	h.ObserveLine(gcodelog.Line{
		Time:   start,
		Dir:    gcodelog.DirSend,
		Source: gcodelog.SourceAPI,
		Text:   "play stale.nc",
	})
	h.ObserveStatus(machine.Status{
		State:      machine.Run,
		ObservedAt: start.Add(pendingFileHintMaxAge + time.Second),
	})

	runs := h.Recent()
	if len(runs) != 0 {
		t.Fatalf("stale file hint started a run: %+v", runs)
	}
}
