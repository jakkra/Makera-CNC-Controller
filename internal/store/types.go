// Package store holds the proxy's durable view of the machine's file space: the
// catalog of files and their sync state, and an ordered queue of pending
// operations. Both survive restarts and offline periods, which is what gives
// the filesystem its Google-Drive-like behavior: a write is accepted locally
// immediately and reconciled with the machine later, when it is reachable and
// idle.
package store

import "time"

// SyncState describes where a catalog entry stands relative to the machine.
type SyncState string

const (
	// Synced: local cache and machine agree (MD5 match).
	Synced SyncState = "synced"
	// LocalOnly: exists locally, no upload queued yet (transient).
	LocalOnly SyncState = "local_only"
	// PendingUpload: an upload job is queued but not started.
	PendingUpload SyncState = "pending_upload"
	// Uploading: an upload job is actively transferring.
	Uploading SyncState = "uploading"
	// PendingDelete: a delete job is queued.
	PendingDelete SyncState = "pending_delete"
	// Deleting: a delete job is running.
	Deleting SyncState = "deleting"
	// PendingRename: a rename job is queued.
	PendingRename SyncState = "pending_rename"
	// RemoteOnly: known to exist on the machine but not cached locally.
	RemoteOnly SyncState = "remote_only"
	// Error: the last operation on this entry failed.
	Error SyncState = "error"
)

// CacheState describes whether a catalog entry's CachePath may be served.
type CacheState string

const (
	// CacheNone means no local file content is available.
	CacheNone CacheState = "none"
	// CacheReady means local bytes may be served without machine I/O.
	CacheReady CacheState = "ready"
	// CacheValidating means local bytes exist but are blocked until the machine
	// confirms they still match.
	CacheValidating CacheState = "validating"
)

// Entry is one file (or directory) in the catalog. Path is the machine-absolute
// path (e.g. "/sd/gcodes/part.nc"). For directories, Size is 0 and MD5 empty.
type Entry struct {
	Path           string     `json:"path"`
	IsDir          bool       `json:"is_dir"`
	Size           int64      `json:"size"`
	MTime          time.Time  `json:"mtime"`
	MD5            string     `json:"md5,omitempty"`        // content MD5 (uncompressed)
	CachePath      string     `json:"cache_path,omitempty"` // local cache file, if held
	CacheState     CacheState `json:"cache_state"`
	CacheCheckedAt time.Time  `json:"cache_checked_at,omitempty"`
	Sync           SyncState  `json:"sync"`
	Error          string     `json:"error,omitempty"` // detail when Sync == Error
	UpdatedAt      time.Time  `json:"updated_at"`
}

// JobKind is the type of a queued operation.
type JobKind string

const (
	JobUpload JobKind = "upload"
	JobDelete JobKind = "delete"
	JobRename JobKind = "rename"
	JobMkdir  JobKind = "mkdir"
)

// JobState is the lifecycle state of a job.
type JobState string

const (
	Queued  JobState = "queued"
	Running JobState = "running"
	Done    JobState = "done"
	Failed  JobState = "failed"
)

// Job is one durable operation against the machine. Jobs are executed in order
// (FIFO) and are idempotent so a retry after a crash is safe.
type Job struct {
	ID        int64     `json:"id"`
	Kind      JobKind   `json:"kind"`
	Path      string    `json:"path"`                 // primary target (machine-absolute)
	DestPath  string    `json:"dest_path,omitempty"`  // for rename
	CachePath string    `json:"cache_path,omitempty"` // local source for upload
	MD5       string    `json:"md5,omitempty"`        // expected content MD5 for upload
	Size      int64     `json:"size,omitempty"`
	State     JobState  `json:"state"`
	Attempts  int       `json:"attempts"`
	LastError string    `json:"last_error,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`

	// Diagnostic fields are populated on API copies only; they are not part of
	// the durable queue semantics.
	BlockedReason  string     `json:"blocked_reason,omitempty"`
	BlockedMessage string     `json:"blocked_message,omitempty"`
	BlockedUntil   *time.Time `json:"blocked_until,omitempty"`
}

// UISettings is durable operator UI configuration. It is intentionally kept in
// the store file with the catalog/queue so a deployment restart preserves the
// control console layout without requiring browser-local state.
type UISettings struct {
	Macros       []Macro           `json:"macros"`
	MacroButtons []MacroSlot       `json:"macro_buttons"`
	Log          LogSettings       `json:"log"`
	Gamepad      Gamepad           `json:"gamepad"`
	Machine      MachineUI         `json:"machine"`
	Dashboard    DashboardSettings `json:"dashboard"`
}

// ExecutionContext is the small, durable part of the currently observed job
// execution state that an operator may need after the proxy restarts. It is
// deliberately separate from UISettings: browser settings saves must never
// overwrite machine-observed execution state.
//
// The fields are observations, not a command queue. In particular, a restored
// context never causes a spindle or job action on its own.
type ExecutionContext struct {
	Job     ExecutionJobContext     `json:"job"`
	Spindle ExecutionSpindleContext `json:"spindle"`
}

// ExecutionJobContext records the latest player identity/progress that was
// actually observable. Source says where Path/CurrentLine came from, rather
// than implying that the proxy knows more than the firmware reported.
type ExecutionJobContext struct {
	Path        string    `json:"path,omitempty"`
	CurrentLine int64     `json:"current_line,omitempty"`
	Source      string    `json:"source,omitempty"`
	UpdatedAt   time.Time `json:"updated_at,omitempty"`
}

// ExecutionSpindleContext caches a commanded spindle direction/speed only
// after it was observed in gcode traffic or explicitly issued by this proxy.
// SpeedKnown remains false when a status report has RPM but no safe start
// command can be reconstructed. Stopped means an M5 command was observed; it
// is intentionally distinct from a momentary zero-RPM status reading.
type ExecutionSpindleContext struct {
	Direction  string    `json:"direction,omitempty"`
	SpeedRPM   float64   `json:"speed_rpm,omitempty"`
	SpeedKnown bool      `json:"speed_known"`
	Stopped    bool      `json:"stopped"`
	Source     string    `json:"source,omitempty"`
	UpdatedAt  time.Time `json:"updated_at,omitempty"`
}

// DashboardSettings stores named recording/dashboard layouts. A profile ID is
// stable so /dashboard?profile=<id> URLs survive display-name edits.
type DashboardSettings struct {
	Profiles         []DashboardProfile `json:"profiles"`
	DefaultProfileID string             `json:"default_profile_id"`
}

// DashboardProfile controls dashboard organization without affecting the
// machine. Panels is both the visible set and its display order.
type DashboardProfile struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Layout     string   `json:"layout"`
	Density    string   `json:"density"`
	Background string   `json:"background"`
	Panels     []string `json:"panels"`
	GcodeLines int      `json:"gcode_lines"`
}

// Macro is a named sequence of gcode/console lines that can be assigned to a
// button in the web console.
type Macro struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description,omitempty"`
	Lines       []string  `json:"lines"`
	Color       string    `json:"color,omitempty"`
	CreatedAt   time.Time `json:"created_at,omitempty"`
	UpdatedAt   time.Time `json:"updated_at,omitempty"`
}

// MacroSlot places a macro button in a named UI region.
type MacroSlot struct {
	ID      string `json:"id"`
	MacroID string `json:"macro_id"`
	Region  string `json:"region"` // "toolbar" | "panel"
	Order   int    `json:"order"`
}

// LogSettings stores operator preferences for the log console.
type LogSettings struct {
	Filter     string `json:"filter,omitempty"`
	Autoscroll bool   `json:"autoscroll"`
}

// MachineUI stores local machine control preferences used by the web control
// surface. These values are UI state only; changing them never touches the
// machine.
type MachineUI struct {
	WorkArea        WorkArea                  `json:"work_area"`
	Origin          XYPoint                   `json:"origin"`
	SavedOrigins    []SavedOrigin             `json:"saved_origins"`
	FeedMinMMMin    float64                   `json:"feed_min_mm_min"`
	FeedMaxMMMin    float64                   `json:"feed_max_mm_min"`
	TapFeedMMMin    float64                   `json:"tap_feed_mm_min"`
	SafeZMM         float64                   `json:"safe_z_mm"`
	SafeZDisabled   bool                      `json:"safe_z_disabled,omitempty"`
	Learned         MachineLearned            `json:"learned,omitempty"`
	LearnedProfiles map[string]MachineLearned `json:"learned_profiles,omitempty"`
}

// MachineLearned is a read-only snapshot of parameters reported by the
// firmware. It is local proxy metadata: refreshing it reads from the machine,
// but changing or restoring it never writes firmware configuration.
type MachineLearned struct {
	LearnedAt     time.Time                 `json:"learned_at,omitempty"`
	Source        string                    `json:"source,omitempty"`
	Identity      MachineIdentity           `json:"identity,omitempty"`
	WorkArea      WorkArea                  `json:"work_area,omitempty"`
	ZMinMM        float64                   `json:"z_min_mm,omitempty"`
	ZMaxMM        float64                   `json:"z_max_mm,omitempty"`
	AMin          float64                   `json:"a_min,omitempty"`
	AMax          float64                   `json:"a_max,omitempty"`
	CMin          float64                   `json:"c_min,omitempty"`
	CMax          float64                   `json:"c_max,omitempty"`
	Feed          MachineFeedProfile        `json:"feed,omitempty"`
	SoftEndstop   MachineSoftEndstopProfile `json:"soft_endstop,omitempty"`
	Anchors       MachineAnchorProfile      `json:"anchors,omitempty"`
	Clearance     MachineClearanceProfile   `json:"clearance,omitempty"`
	Probe         MachineProbeProfile       `json:"probe,omitempty"`
	Config        map[string]string         `json:"config,omitempty"`
	ConfigNumbers map[string]float64        `json:"config_numbers,omitempty"`
	ConfigBools   map[string]bool           `json:"config_bools,omitempty"`
	Diagnostics   map[string][]float64      `json:"diagnostics,omitempty"`
	RawDiagnose   string                    `json:"raw_diagnose,omitempty"`
}

// MachineIdentity captures read-only firmware identity queries.
type MachineIdentity struct {
	Model    string `json:"model,omitempty"`
	Version  string `json:"version,omitempty"`
	FileType string `json:"file_type,omitempty"`
}

// MachineFeedProfile contains known feed-rate parameters reported in
// /sd/config.txt. Values are in mm/min unless otherwise noted.
type MachineFeedProfile struct {
	DefaultMMMin float64 `json:"default_mm_min,omitempty"`
	SeekMMMin    float64 `json:"seek_mm_min,omitempty"`
	XMaxMMMin    float64 `json:"x_max_mm_min,omitempty"`
	YMaxMMMin    float64 `json:"y_max_mm_min,omitempty"`
	ZMaxMMMin    float64 `json:"z_max_mm_min,omitempty"`
	AMax         float64 `json:"a_max,omitempty"`
	ATCMaxMMMin  float64 `json:"atc_max_mm_min,omitempty"`
	MaxXYMMMin   float64 `json:"max_xy_mm_min,omitempty"`
}

// MachineSoftEndstopProfile contains soft-limit settings from firmware config.
type MachineSoftEndstopProfile struct {
	Enabled bool    `json:"enabled,omitempty"`
	XMin    float64 `json:"x_min,omitempty"`
	XMax    float64 `json:"x_max,omitempty"`
	YMin    float64 `json:"y_min,omitempty"`
	YMax    float64 `json:"y_max,omitempty"`
	ZMin    float64 `json:"z_min,omitempty"`
	ZMax    float64 `json:"z_max,omitempty"`
}

// MachineAnchorProfile contains the fixed XY reference points reported by the
// firmware. They are read-only machine metadata used when setting a work
// origin; changing them is intentionally not supported by the proxy.
type MachineAnchorProfile struct {
	Available bool    `json:"available,omitempty"`
	Anchor1   XYPoint `json:"anchor1,omitempty"`
	Anchor2   XYPoint `json:"anchor2,omitempty"`
}

// MachineClearanceProfile contains known machine-coordinate clearance points.
type MachineClearanceProfile struct {
	X float64 `json:"x,omitempty"`
	Y float64 `json:"y,omitempty"`
	Z float64 `json:"z,omitempty"`
}

// MachineProbeProfile contains probe-related rates/distances from config.
type MachineProbeProfile struct {
	FastRateMMMin float64 `json:"fast_rate_mm_min,omitempty"`
	SlowRateMMMin float64 `json:"slow_rate_mm_min,omitempty"`
	RetractMM     float64 `json:"retract_mm,omitempty"`
}

// SavedOrigin is a labeled machine-coordinate work zero used by the web
// control surface. Saving or deleting one is UI state only; recalling it is what
// sends machine commands.
type SavedOrigin struct {
	ID        string    `json:"id"`
	Label     string    `json:"label"`
	Origin    XYPoint   `json:"origin"`
	CreatedAt time.Time `json:"created_at,omitempty"`
}

// WorkArea is the top-down machine-coordinate XY travel envelope shown in
// Control and used to translate pointer taps into machine targets.
type WorkArea struct {
	XMin float64 `json:"x_min"`
	XMax float64 `json:"x_max"`
	YMin float64 `json:"y_min"`
	YMax float64 `json:"y_max"`
}

// XYPoint is a machine-coordinate point.
type XYPoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// Gamepad stores browser gamepad mapping and speed preferences for the jog UI.
// The server still enforces the configured jog speed limits; these settings only
// scale and map the normalized client input before it is sent to the jog
// WebSocket.
type Gamepad struct {
	Axes          GamepadAxes `json:"axes"`
	DeadmanButton int         `json:"deadman_button"`
	SlowButtons   []int       `json:"slow_buttons"`
	// OutlineButton adds a point while outline capture is active. A nil value
	// is normalized to the standard-mapping right trigger for older profiles.
	OutlineButton *int                 `json:"outline_button"`
	MacroButtons  []GamepadMacroButton `json:"macro_buttons"`
}

// GamepadAxes maps physical browser axes into machine axes.
type GamepadAxes struct {
	X GamepadAxis `json:"x"`
	Y GamepadAxis `json:"y"`
	Z GamepadAxis `json:"z"`
}

// GamepadAxis configures one physical axis. Scale is 0..1, applied client-side
// before the normalized axis value is sent to the jog engine.
type GamepadAxis struct {
	Axis   int     `json:"axis"`
	Invert bool    `json:"invert"`
	Scale  float64 `json:"scale"`
}

// GamepadMacroButton maps one physical gamepad button to a saved gcode macro.
// The web UI fires these edge-triggered while jog is armed and the deadman is
// held; execution still goes through the normal /api/gcode path.
type GamepadMacroButton struct {
	ID      string `json:"id"`
	Button  int    `json:"button"`
	MacroID string `json:"macro_id"`
}
