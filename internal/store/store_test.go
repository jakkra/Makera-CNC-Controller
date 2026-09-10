package store

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPersistenceRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")

	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	s.PutEntry(Entry{Path: "/sd/gcodes/a.nc", Size: 10, Sync: PendingUpload})
	j, _ := s.Enqueue(Job{Kind: JobUpload, Path: "/sd/gcodes/a.nc", Size: 10})
	if j.ID != 1 {
		t.Errorf("first job id = %d, want 1", j.ID)
	}
	if err := s.SetActiveGcodePath("/sd/gcodes/a.nc"); err != nil {
		t.Fatal(err)
	}
	context := ExecutionContext{
		Job:     ExecutionJobContext{Path: "/sd/gcodes/a.nc", CurrentLine: 42, Source: "status", UpdatedAt: time.Unix(100, 0)},
		Spindle: ExecutionSpindleContext{Direction: "M4", SpeedRPM: 12000, SpeedKnown: true, Stopped: true, Source: "controller", UpdatedAt: time.Unix(101, 0)},
	}
	if err := s.SetExecutionContext(context); err != nil {
		t.Fatal(err)
	}

	// Reopen and verify state survived.
	s2, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	e, ok := s2.GetEntry("/sd/gcodes/a.nc")
	if !ok || e.Size != 10 || e.Sync != PendingUpload {
		t.Errorf("reloaded entry = %+v ok=%v", e, ok)
	}
	jobs := s2.ListJobs()
	if len(jobs) != 1 || jobs[0].Kind != JobUpload {
		t.Errorf("reloaded jobs = %+v", jobs)
	}
	if got := s2.ActiveGcodePath(); got != "/sd/gcodes/a.nc" {
		t.Errorf("reloaded active gcode path = %q", got)
	}
	if got := s2.ExecutionContext(); got != context {
		t.Errorf("reloaded execution context = %+v, want %+v", got, context)
	}
	// Next enqueued ID continues from persisted counter.
	j2, _ := s2.Enqueue(Job{Kind: JobDelete, Path: "/sd/gcodes/b.nc"})
	if j2.ID != 2 {
		t.Errorf("second job id = %d, want 2", j2.ID)
	}
}

func TestFlushFailureRollsBackAndPublishesNoEvents(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	events, unsubscribe := s.Subscribe()
	defer unsubscribe()

	if err := os.Mkdir(path, 0o755); err != nil {
		t.Fatal(err)
	}
	err = s.PutEntry(Entry{Path: "/sd/gcodes/fail.nc", Sync: PendingUpload})
	if err == nil {
		t.Fatal("PutEntry succeeded despite unwritable state path")
	}
	if _, ok := s.GetEntry("/sd/gcodes/fail.nc"); ok {
		t.Fatal("failed PutEntry leaked into in-memory catalog")
	}
	if jobs := s.ListJobs(); len(jobs) != 0 {
		t.Fatalf("failed PutEntry changed jobs: %+v", jobs)
	}
	select {
	case ev := <-events:
		t.Fatalf("event published for rolled-back write: %+v", ev)
	default:
	}
}

func TestBatchCommitPersistsEntryAndJobTogether(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Batch(func(b *Batch) error {
		b.PutEntry(Entry{Path: "/sd/gcodes/a.nc", Sync: PendingUpload})
		b.Enqueue(Job{Kind: JobUpload, Path: "/sd/gcodes/a.nc"})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if entry, ok := reopened.GetEntry("/sd/gcodes/a.nc"); !ok || entry.Sync != PendingUpload {
		t.Fatalf("reopened entry = %+v ok=%v", entry, ok)
	}
	if jobs := reopened.ListJobs(); len(jobs) != 1 || jobs[0].Kind != JobUpload || jobs[0].Path != "/sd/gcodes/a.nc" {
		t.Fatalf("reopened jobs = %+v", jobs)
	}
}

func TestBatchFunctionErrorRollsBackAllChanges(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	wantErr := errors.New("stop batch")
	err = s.Batch(func(b *Batch) error {
		b.PutEntry(Entry{Path: "/sd/gcodes/a.nc", Sync: PendingUpload})
		b.Enqueue(Job{Kind: JobUpload, Path: "/sd/gcodes/a.nc"})
		return wantErr
	})
	if !errors.Is(err, wantErr) {
		t.Fatalf("Batch err = %v, want %v", err, wantErr)
	}
	if _, ok := s.GetEntry("/sd/gcodes/a.nc"); ok {
		t.Fatal("failed batch leaked entry")
	}
	if jobs := s.ListJobs(); len(jobs) != 0 {
		t.Fatalf("failed batch leaked jobs: %+v", jobs)
	}
}

func TestUISettingsPersistenceRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	outlineButton := 6
	ui, err := s.SetUISettings(UISettings{
		Macros: []Macro{{
			ID:    "probe",
			Name:  "Probe",
			Lines: []string{"", "G38.2 Z-5 F50", "G10 L20 P1 Z0"},
		}},
		MacroButtons: []MacroSlot{{ID: "slot1", MacroID: "probe", Region: "toolbar", Order: 4}},
		Log:          LogSettings{Filter: "jog", Autoscroll: false},
		Dashboard: DashboardSettings{
			Profiles: []DashboardProfile{
				{ID: "overview", Name: "Overview", Layout: "job-focus", Density: "comfortable", Background: "solid", Panels: []string{"machine", "job"}, GcodeLines: 9},
				{ID: "recording", Name: "Recording", Layout: "grid", Density: "compact", Background: "transparent", Panels: []string{"job", "gcode", "telemetry"}, GcodeLines: 17},
			},
			DefaultProfileID: "recording",
		},
		Machine: MachineUI{
			WorkArea:      WorkArea{XMin: -300, XMax: 5, YMin: -210, YMax: 10},
			Origin:        XYPoint{X: 1, Y: 2},
			SavedOrigins:  []SavedOrigin{{ID: "fixture", Label: "Fixture", Origin: XYPoint{X: -12.5, Y: -20}}},
			FeedMinMMMin:  100,
			FeedMaxMMMin:  1800,
			TapFeedMMMin:  700,
			SafeZMM:       -1.5,
			SafeZDisabled: true,
			Learned: MachineLearned{
				Source:        "firmware",
				Identity:      MachineIdentity{Model: "CarveraAir", Version: "1.2.3", FileType: "lz"},
				WorkArea:      WorkArea{XMin: -302, XMax: 0, YMin: -212, YMax: 0},
				Feed:          MachineFeedProfile{MaxXYMMMin: 3000},
				Config:        map[string]string{"soft_endstop.x_min": "-302.0"},
				ConfigNumbers: map[string]float64{"alpha_max_rate": 3000},
				ConfigBools:   map[string]bool{"soft_endstop.enable": false},
				Diagnostics:   map[string][]float64{"E": {0, 1, 0, 1, 1, 0}},
			},
		},
		Gamepad: Gamepad{
			Axes: GamepadAxes{
				X: GamepadAxis{Axis: 2, Scale: 0.5},
				Y: GamepadAxis{Axis: 1, Scale: 0.75},
				Z: GamepadAxis{Axis: 3, Invert: true, Scale: 0.25},
			},
			DeadmanButton: 7,
			SlowButtons:   []int{6},
			OutlineButton: &outlineButton,
			MacroButtons:  []GamepadMacroButton{{ID: "gp1", Button: 1, MacroID: "probe"}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(ui.Macros) != 1 || len(ui.Macros[0].Lines) != 2 {
		t.Fatalf("normalized ui = %+v", ui)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	got := reopened.UISettings()
	if len(got.Macros) != 1 || got.Macros[0].ID != "probe" || got.Macros[0].Lines[0] != "G38.2 Z-5 F50" {
		t.Fatalf("reopened macros = %+v", got.Macros)
	}
	if len(got.MacroButtons) != 1 || got.MacroButtons[0].Region != "toolbar" {
		t.Fatalf("reopened buttons = %+v", got.MacroButtons)
	}
	if got.Log.Filter != "jog" || got.Log.Autoscroll {
		t.Fatalf("reopened log settings = %+v", got.Log)
	}
	if len(got.Dashboard.Profiles) != 2 || got.Dashboard.DefaultProfileID != "recording" || got.Dashboard.Profiles[1].Background != "transparent" || got.Dashboard.Profiles[1].GcodeLines != 17 {
		t.Fatalf("reopened dashboard settings = %+v", got.Dashboard)
	}
	if got.Machine.WorkArea.XMin != -300 || got.Machine.WorkArea.YMax != 10 || got.Machine.Origin.Y != 2 || got.Machine.FeedMinMMMin != 100 || got.Machine.FeedMaxMMMin != 1800 || got.Machine.TapFeedMMMin != 700 || got.Machine.SafeZMM != -1.5 || !got.Machine.SafeZDisabled {
		t.Fatalf("reopened machine settings = %+v", got.Machine)
	}
	if got.Machine.Learned.Identity.Model != "CarveraAir" || got.Machine.Learned.ConfigNumbers["alpha_max_rate"] != 3000 || len(got.Machine.Learned.Diagnostics["E"]) != 6 {
		t.Fatalf("reopened learned machine profile = %+v", got.Machine.Learned)
	}
	if profile, ok := got.Machine.LearnedProfiles["CarveraAir | 1.2.3 | lz"]; !ok || profile.ConfigNumbers["alpha_max_rate"] != 3000 {
		t.Fatalf("reopened learned machine profiles = %+v", got.Machine.LearnedProfiles)
	}
	if len(got.Machine.SavedOrigins) != 1 || got.Machine.SavedOrigins[0].Label != "Fixture" || got.Machine.SavedOrigins[0].Origin.X != -12.5 {
		t.Fatalf("reopened saved origins = %+v", got.Machine.SavedOrigins)
	}
	if got.Gamepad.Axes.X.Axis != 2 || got.Gamepad.Axes.X.Scale != 0.5 || got.Gamepad.DeadmanButton != 7 {
		t.Fatalf("reopened gamepad = %+v", got.Gamepad)
	}
	if len(got.Gamepad.SlowButtons) != 1 || got.Gamepad.SlowButtons[0] != 6 {
		t.Fatalf("reopened gamepad slow buttons = %+v", got.Gamepad.SlowButtons)
	}
	if got.Gamepad.OutlineButton == nil || *got.Gamepad.OutlineButton != 6 {
		t.Fatalf("reopened gamepad outline button = %+v", got.Gamepad.OutlineButton)
	}
	if len(got.Gamepad.MacroButtons) != 1 || got.Gamepad.MacroButtons[0].MacroID != "probe" {
		t.Fatalf("reopened gamepad macro buttons = %+v", got.Gamepad.MacroButtons)
	}
}

func TestUISettingsCopiesAndNormalizesSlots(t *testing.T) {
	s, _ := Open("")
	ui, err := s.SetUISettings(UISettings{
		Macros: []Macro{{ID: "probe", Name: "Probe", Lines: []string{"M114"}}},
		MacroButtons: []MacroSlot{
			{ID: "a", MacroID: "probe", Region: "toolbar", Order: 0},
			{ID: "b", MacroID: "probe", Region: "panel", Order: 1},
		},
		Log: LogSettings{Filter: "all", Autoscroll: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(ui.MacroButtons) != 1 {
		t.Fatalf("macro buttons = %+v, want one placement per macro", ui.MacroButtons)
	}

	ui.Macros[0].Lines[0] = "M115"
	got := s.UISettings()
	if got.Macros[0].Lines[0] != "M114" {
		t.Fatalf("SetUISettings returned shared macro lines: %+v", got.Macros)
	}
	got.Macros[0].Lines[0] = "version"
	got.Machine.SavedOrigins = append(got.Machine.SavedOrigins, SavedOrigin{ID: "x", Label: "X", Origin: XYPoint{X: 1, Y: 2}})
	got.Machine.Learned.Config = map[string]string{"soft_endstop.x_min": "-1"}
	got.Machine.Learned.ConfigNumbers = map[string]float64{"alpha_max_rate": 1}
	got.Machine.Learned.Diagnostics = map[string][]float64{"E": {9}}
	got.Gamepad.SlowButtons = append(got.Gamepad.SlowButtons, 9)
	got.Gamepad.MacroButtons = append(got.Gamepad.MacroButtons, GamepadMacroButton{ID: "x", Button: 2, MacroID: "probe"})
	got.Dashboard.Profiles[0].Panels[0] = "gcode"
	gotAgain := s.UISettings()
	if gotAgain.Macros[0].Lines[0] != "M114" {
		t.Fatalf("UISettings returned shared macro lines: %+v", gotAgain.Macros)
	}
	if len(gotAgain.Machine.SavedOrigins) != 0 {
		t.Fatalf("UISettings returned shared saved origins: %+v", gotAgain.Machine.SavedOrigins)
	}
	if len(gotAgain.Machine.Learned.Config) != 0 || len(gotAgain.Machine.Learned.Diagnostics) != 0 {
		t.Fatalf("UISettings returned shared learned profile maps: %+v", gotAgain.Machine.Learned)
	}
	if len(gotAgain.Gamepad.SlowButtons) != 2 || len(gotAgain.Gamepad.MacroButtons) != 0 {
		t.Fatalf("UISettings returned shared gamepad slices: %+v", gotAgain.Gamepad)
	}
	if gotAgain.Dashboard.Profiles[0].Panels[0] != "machine" {
		t.Fatalf("UISettings returned shared dashboard panels: %+v", gotAgain.Dashboard)
	}
}

func TestUISettingsDashboardDefaults(t *testing.T) {
	s, _ := Open("")
	got := s.UISettings().Dashboard
	if got.DefaultProfileID != "overview" || len(got.Profiles) != 1 {
		t.Fatalf("default dashboard = %+v", got)
	}
	profile := got.Profiles[0]
	if profile.Layout != "job-focus" || profile.Density != "comfortable" || profile.Background != "solid" || profile.GcodeLines != 9 || len(profile.Panels) != 4 {
		t.Fatalf("default dashboard profile = %+v", profile)
	}
}

func TestUISettingsGamepadDefaults(t *testing.T) {
	s, _ := Open("")
	got := s.UISettings()
	if got.Gamepad.Axes.X.Axis != 0 || got.Gamepad.Axes.X.Scale != 1 {
		t.Fatalf("default X axis = %+v", got.Gamepad.Axes.X)
	}
	if got.Gamepad.Axes.Y.Axis != 1 || !got.Gamepad.Axes.Y.Invert || got.Gamepad.Axes.Y.Scale != 1 {
		t.Fatalf("default Y axis = %+v", got.Gamepad.Axes.Y)
	}
	if got.Gamepad.Axes.Z.Axis != 3 || !got.Gamepad.Axes.Z.Invert || got.Gamepad.Axes.Z.Scale != 1 {
		t.Fatalf("default Z axis = %+v", got.Gamepad.Axes.Z)
	}
	if got.Gamepad.DeadmanButton != 0 || len(got.Gamepad.SlowButtons) != 2 || got.Gamepad.OutlineButton == nil || *got.Gamepad.OutlineButton != 7 {
		t.Fatalf("default gamepad buttons = %+v", got.Gamepad)
	}
}

func TestUISettingsMachineDefaults(t *testing.T) {
	s, _ := Open("")
	got := s.UISettings()
	if got.Machine.WorkArea.XMin != -302 || got.Machine.WorkArea.XMax != -1 || got.Machine.WorkArea.YMin != -212 || got.Machine.WorkArea.YMax != -1 {
		t.Fatalf("default machine work area = %+v", got.Machine.WorkArea)
	}
	if got.Machine.Origin.X != 0 || got.Machine.Origin.Y != 0 || got.Machine.FeedMinMMMin != 1 || got.Machine.FeedMaxMMMin != 3000 || got.Machine.TapFeedMMMin != 600 || got.Machine.SavedOrigins == nil || len(got.Machine.SavedOrigins) != 0 {
		t.Fatalf("default machine settings = %+v", got.Machine)
	}
}

func TestUISettingsMigratesNominalPreviewToTravelEnvelope(t *testing.T) {
	s, _ := Open("")
	ui := s.UISettings()
	ui.Machine.WorkArea = WorkArea{XMin: -300, XMax: 0, YMin: -200, YMax: 0}
	if _, err := s.SetUISettings(ui); err != nil {
		t.Fatal(err)
	}
	got := s.UISettings()
	want := WorkArea{XMin: -302, XMax: -1, YMin: -212, YMax: -1}
	if got.Machine.WorkArea != want {
		t.Fatalf("migrated machine travel envelope = %+v, want %+v", got.Machine.WorkArea, want)
	}
}

func TestUISettingsMigratesOldGeneratedFeedMax(t *testing.T) {
	s, _ := Open("")
	ui := s.UISettings()
	ui.Machine.FeedMinMMMin = 1
	ui.Machine.FeedMaxMMMin = 1200
	ui.Machine.TapFeedMMMin = 600
	if _, err := s.SetUISettings(ui); err != nil {
		t.Fatal(err)
	}
	got := s.UISettings()
	if got.Machine.FeedMaxMMMin != 3000 {
		t.Fatalf("migrated feed max = %v, want 3000", got.Machine.FeedMaxMMMin)
	}
}

func TestNextQueuedOrder(t *testing.T) {
	s, _ := Open("")
	s.Enqueue(Job{Kind: JobMkdir, Path: "/sd/gcodes/d"})
	s.Enqueue(Job{Kind: JobUpload, Path: "/sd/gcodes/d/a.nc"})

	j, ok := s.NextQueued()
	if !ok || j.Kind != JobMkdir {
		t.Fatalf("first queued = %+v ok=%v, want mkdir", j, ok)
	}
	// Mark it done; next should be the upload.
	s.UpdateJob(j.ID, func(j *Job) { j.State = Done })
	j2, _ := s.NextQueued()
	if j2.Kind != JobUpload {
		t.Errorf("second queued = %+v, want upload", j2)
	}
}

func TestSupersedeQueuedUploads(t *testing.T) {
	s, _ := Open("")
	// Two queued uploads of the same path, plus a delete of another path.
	s.Enqueue(Job{Kind: JobUpload, Path: "/sd/gcodes/a.nc"})
	s.Enqueue(Job{Kind: JobUpload, Path: "/sd/gcodes/a.nc"})
	s.Enqueue(Job{Kind: JobDelete, Path: "/sd/gcodes/b.nc"})

	n, err := s.SupersedeQueuedUploads("/sd/gcodes/a.nc")
	if err != nil || n != 2 {
		t.Fatalf("superseded = %d err=%v, want 2", n, err)
	}
	// Both a.nc uploads are now Done; the b.nc delete is untouched.
	for _, j := range s.ListJobs() {
		if j.Path == "/sd/gcodes/a.nc" && j.State != Done {
			t.Errorf("a.nc upload state = %q, want done", j.State)
		}
		if j.Kind == JobDelete && j.State != Queued {
			t.Errorf("delete state = %q, want queued (untouched)", j.State)
		}
	}
	// A running upload must NOT be superseded.
	j, _ := s.Enqueue(Job{Kind: JobUpload, Path: "/sd/gcodes/c.nc"})
	s.UpdateJob(j.ID, func(j *Job) { j.State = Running })
	n, _ = s.SupersedeQueuedUploads("/sd/gcodes/c.nc")
	if n != 0 {
		t.Errorf("superseded a running upload (%d), should not", n)
	}
}

func TestDiscardEntryMarksMatchingJobsDone(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.PutEntry(Entry{Path: "/sd/gcodes/a.nc", Sync: Error, Error: "upload failed"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Enqueue(Job{Kind: JobUpload, Path: "/sd/gcodes/a.nc"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Enqueue(Job{Kind: JobDelete, Path: "/sd/gcodes/a.nc"}); err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateJob(1, func(j *Job) {
		j.State = Failed
		j.LastError = "upload failed"
	}); err != nil {
		t.Fatal(err)
	}

	if _, ok, err := s.DiscardEntry("/sd/gcodes/a.nc", JobUpload, JobMkdir, JobDelete, JobRename); err != nil || !ok {
		t.Fatalf("discard ok=%v err=%v", ok, err)
	}
	if _, ok := s.GetEntry("/sd/gcodes/a.nc"); ok {
		t.Fatal("entry should be removed")
	}
	jobs := s.ListJobs()
	if jobs[0].State != Done || jobs[0].LastError != "" {
		t.Fatalf("upload job = %+v, want done without error", jobs[0])
	}
	if jobs[1].State != Done {
		t.Fatalf("delete job = %+v, want done", jobs[1])
	}

	reloaded, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := reloaded.GetEntry("/sd/gcodes/a.nc"); ok {
		t.Fatal("reloaded entry should be removed")
	}
	if got := reloaded.ListJobs()[0]; got.State != Done || got.LastError != "" {
		t.Fatalf("reloaded job = %+v, want done without error", got)
	}
}

func TestRetryJobRequeuesFailedJob(t *testing.T) {
	s, _ := Open("")
	j, err := s.Enqueue(Job{Kind: JobUpload, Path: "/sd/gcodes/a.nc"})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateJob(j.ID, func(j *Job) {
		j.State = Failed
		j.Attempts = 8
		j.LastError = "upload failed"
	}); err != nil {
		t.Fatal(err)
	}
	retried, ok, err := s.RetryJob(j.ID)
	if err != nil || !ok {
		t.Fatalf("retry ok=%v err=%v", ok, err)
	}
	if retried.State != Queued || retried.Attempts != 0 || retried.LastError != "" {
		t.Fatalf("retried job = %+v", retried)
	}
}

func TestDiscardJobsMarksQueuedAndFailedJobsDone(t *testing.T) {
	s, _ := Open("")
	queued, err := s.Enqueue(Job{Kind: JobUpload, Path: "/sd/gcodes/a.nc"})
	if err != nil {
		t.Fatal(err)
	}
	failed, err := s.Enqueue(Job{Kind: JobDelete, Path: "/sd/gcodes/a.nc"})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateJob(failed.ID, func(j *Job) {
		j.State = Failed
		j.LastError = "delete failed"
	}); err != nil {
		t.Fatal(err)
	}
	other, err := s.Enqueue(Job{Kind: JobUpload, Path: "/sd/gcodes/b.nc"})
	if err != nil {
		t.Fatal(err)
	}

	discarded, ok, err := s.DiscardJobs("/sd/gcodes/a.nc", JobUpload, JobDelete)
	if err != nil || !ok {
		t.Fatalf("discard jobs ok=%v err=%v", ok, err)
	}
	if len(discarded) != 2 {
		t.Fatalf("discarded jobs = %+v, want 2", discarded)
	}
	jobs := s.ListJobs()
	for _, j := range jobs {
		switch j.ID {
		case queued.ID, failed.ID:
			if j.State != Done || j.LastError != "" {
				t.Fatalf("discarded job = %+v, want done without error", j)
			}
		case other.ID:
			if j.State != Queued {
				t.Fatalf("other job = %+v, want queued", j)
			}
		}
	}
}

func TestStartJobOnlyStartsQueuedJobs(t *testing.T) {
	s, _ := Open("")
	j, err := s.Enqueue(Job{Kind: JobUpload, Path: "/sd/gcodes/a.nc"})
	if err != nil {
		t.Fatal(err)
	}
	started, ok, err := s.StartJob(j.ID)
	if err != nil || !ok {
		t.Fatalf("start queued ok=%v err=%v", ok, err)
	}
	if started.State != Running {
		t.Fatalf("started state = %q, want running", started.State)
	}
	again, ok, err := s.StartJob(j.ID)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatalf("start running ok=true job=%+v, want false", again)
	}
}

func TestSubscribeReceivesEvents(t *testing.T) {
	s, _ := Open("")
	ch, unsub := s.Subscribe()
	defer unsub()

	s.PutEntry(Entry{Path: "/sd/gcodes/x.nc", Sync: LocalOnly})
	select {
	case ev := <-ch:
		if ev.Kind != "entry" || ev.Entry == nil || ev.Entry.Path != "/sd/gcodes/x.nc" {
			t.Errorf("event = %+v", ev)
		}
	case <-time.After(time.Second):
		t.Fatal("no event received")
	}
}

func TestPruneDoneJobs(t *testing.T) {
	now := time.Unix(10000, 0)
	s, _ := Open("")
	s.now = func() time.Time { return now }

	j, _ := s.Enqueue(Job{Kind: JobUpload, Path: "/a"})
	s.UpdateJob(j.ID, func(j *Job) { j.State = Done })
	f, _ := s.Enqueue(Job{Kind: JobUpload, Path: "/b"})
	s.UpdateJob(f.ID, func(j *Job) { j.State = Failed })

	now = now.Add(time.Hour)
	removed, err := s.PruneDoneJobs(time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("removed = %d, want 1", removed)
	}

	jobs := s.ListJobs()
	if len(jobs) != 1 || jobs[0].State != Failed {
		t.Errorf("after prune = %+v, want only the failed job", jobs)
	}
}

func TestPruneFailedJobsBoundsEachPathAndPreservesLiveJobs(t *testing.T) {
	s, _ := Open("")
	for i := 0; i < 25; i++ {
		job, err := s.Enqueue(Job{Kind: JobUpload, Path: "/sd/gcodes/a.nc"})
		if err != nil {
			t.Fatal(err)
		}
		if err := s.UpdateJob(job.ID, func(j *Job) { j.State = Failed }); err != nil {
			t.Fatal(err)
		}
	}
	queued, err := s.Enqueue(Job{Kind: JobUpload, Path: "/sd/gcodes/a.nc"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.Enqueue(Job{Kind: JobUpload, Path: "/sd/gcodes/b.nc"})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateJob(other.ID, func(j *Job) { j.State = Failed }); err != nil {
		t.Fatal(err)
	}

	removed, err := s.PruneFailedJobs(20)
	if err != nil || removed != 5 {
		t.Fatalf("PruneFailedJobs removed=%d err=%v, want 5", removed, err)
	}
	failedA := 0
	for _, job := range s.ListJobs() {
		if job.Path == "/sd/gcodes/a.nc" && job.State == Failed {
			failedA++
		}
	}
	if failedA != 20 {
		t.Fatalf("retained failed a.nc jobs = %d, want 20", failedA)
	}
	if job, ok := s.GetJob(queued.ID); !ok || job.State != Queued {
		t.Fatalf("live queued job = %+v ok=%v, want preserved", job, ok)
	}
	if job, ok := s.GetJob(other.ID); !ok || job.State != Failed {
		t.Fatalf("other-path failed job = %+v ok=%v, want preserved", job, ok)
	}
}
