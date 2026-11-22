// Package machine models the CNC's reported run state, which gates all file
// operations: the firmware only accepts file commands when Idle.
package machine

import (
	"strconv"
	"strings"
	"sync"
	"time"
)

// State is the machine's run state, taken from the first field of a status
// report like "<Idle|MPos:...|...>".
type State string

const (
	Unknown State = ""
	Idle    State = "Idle"
	Run     State = "Run"
	Hold    State = "Hold"
	Alarm   State = "Alarm"
	Sleep   State = "Sleep"
	Home    State = "Home"
	Pause   State = "Pause"
	Wait    State = "Wait"
	Tool    State = "Tool"
)

// CanRunFileOps reports whether file operations are safe to execute. Only Idle
// qualifies; anything else (running a job, paused, alarmed, unknown) must wait.
func (s State) CanRunFileOps() bool {
	return s == Idle
}

// AxisValues are ordered coordinate values keyed by lower-case axis names
// ("x", "y", "z", "a", "b", "c"). Missing axes are simply absent.
type AxisValues map[string]float64

// Triple is a firmware status triple such as feed current/target/override.
type Triple struct {
	Current  float64 `json:"current"`
	Target   float64 `json:"target"`
	Override float64 `json:"override"`
}

// Spindle describes the S: status field as emitted by Carvera firmware. The
// optional extended values are present on newer machine models; pointers keep
// a reported zero distinct from a model that does not report the field.
type Spindle struct {
	CurrentRPM   float64  `json:"current_rpm"`
	TargetRPM    float64  `json:"target_rpm"`
	Override     float64  `json:"override"`
	VacuumMode   *float64 `json:"vacuum_mode,omitempty"`
	SpindleTempC *float64 `json:"spindle_temp_c,omitempty"`
	PowerTempC   *float64 `json:"power_temp_c,omitempty"`
	BlowingMode  *float64 `json:"blowing_mode,omitempty"`
	BedCleanMode *float64 `json:"bed_clean_mode,omitempty"`
	ExternalMode *float64 `json:"external_mode,omitempty"`
}

// ToolStatus describes the T: status field when present.
type ToolStatus struct {
	Active int     `json:"active"`
	Offset float64 `json:"offset"`
	Target *int    `json:"target,omitempty"`
}

// LaserStatus describes the optional L: status field.
type LaserStatus struct {
	Mode    bool    `json:"mode"`
	State   bool    `json:"state"`
	Testing bool    `json:"testing"`
	Power   float64 `json:"power"`
	Scale   float64 `json:"scale"`
}

// ControllerStatus describes the optional C: machine/mode status field.
type ControllerStatus struct {
	Model        int  `json:"model"`
	Functions    int  `json:"functions"`
	InchMode     bool `json:"inch_mode"`
	AbsoluteMode bool `json:"absolute_mode"`
}

// HaltReason describes the firmware's H: alarm/halt reason field. The ranges
// mirror the official controller's recovery policy.
type HaltReason struct {
	Code     int    `json:"code"`
	Message  string `json:"message"`
	Recovery string `json:"recovery"`
	Severity string `json:"severity"`
}

// Status is the parsed machine status payload from STATUS_RES. It preserves all
// raw fields while normalizing the fields the proxy needs for safe operation.
type Status struct {
	State      State             `json:"state"`
	Raw        string            `json:"raw,omitempty"`
	Fields     map[string]string `json:"fields,omitempty"`
	MPos       AxisValues        `json:"mpos,omitempty"`
	WPos       AxisValues        `json:"wpos,omitempty"`
	Feed       *Triple           `json:"feed,omitempty"`
	Spindle    *Spindle          `json:"spindle,omitempty"`
	Tool       *ToolStatus       `json:"tool,omitempty"`
	Laser      *LaserStatus      `json:"laser,omitempty"`
	Controller *ControllerStatus `json:"controller,omitempty"`
	ProbeV     *float64          `json:"wireless_probe_voltage,omitempty"`
	ATCState   *int              `json:"atc_state,omitempty"`
	LevelDelta *float64          `json:"leveling_max_delta,omitempty"`
	HaltReason *HaltReason       `json:"halt_reason,omitempty"`
	Progress   []float64         `json:"progress,omitempty"`
	Machine    []float64         `json:"machine,omitempty"`
	ObservedAt time.Time         `json:"observed_at,omitempty"`
}

func (s Status) copy() Status {
	cp := s
	cp.Fields = copyStringMap(s.Fields)
	cp.MPos = copyAxisValues(s.MPos)
	cp.WPos = copyAxisValues(s.WPos)
	if s.Feed != nil {
		v := *s.Feed
		cp.Feed = &v
	}
	if s.Spindle != nil {
		v := *s.Spindle
		v.VacuumMode = copyFloat64(s.Spindle.VacuumMode)
		v.SpindleTempC = copyFloat64(s.Spindle.SpindleTempC)
		v.PowerTempC = copyFloat64(s.Spindle.PowerTempC)
		v.BlowingMode = copyFloat64(s.Spindle.BlowingMode)
		v.BedCleanMode = copyFloat64(s.Spindle.BedCleanMode)
		v.ExternalMode = copyFloat64(s.Spindle.ExternalMode)
		cp.Spindle = &v
	}
	if s.Tool != nil {
		v := *s.Tool
		if s.Tool.Target != nil {
			target := *s.Tool.Target
			v.Target = &target
		}
		cp.Tool = &v
	}
	if s.Laser != nil {
		v := *s.Laser
		cp.Laser = &v
	}
	if s.Controller != nil {
		v := *s.Controller
		cp.Controller = &v
	}
	cp.ProbeV = copyFloat64(s.ProbeV)
	if s.ATCState != nil {
		v := *s.ATCState
		cp.ATCState = &v
	}
	cp.LevelDelta = copyFloat64(s.LevelDelta)
	if s.HaltReason != nil {
		v := *s.HaltReason
		cp.HaltReason = &v
	}
	cp.Progress = append([]float64(nil), s.Progress...)
	cp.Machine = append([]float64(nil), s.Machine...)
	return cp
}

// ParseStatus extracts the run state from a status report payload. It accepts
// the report with or without the enclosing angle brackets and tolerates
// trailing whitespace. A well-formed status report with an unknown state returns
// (Unknown, true) so callers can fail closed and avoid trusting an older Idle.
// Returns (Unknown, false) only when the payload doesn't look like a status
// report at all.
func ParseStatus(payload string) (State, bool) {
	st, ok := ParseStatusPayload(payload)
	return st.State, ok
}

// ParseStatusPayload parses a STATUS_RES payload into a Status. The ObservedAt
// field is intentionally left zero; Tracker fills it with its clock.
func ParseStatusPayload(payload string) (Status, bool) {
	raw := strings.TrimSpace(payload)
	bracketed := strings.HasPrefix(raw, "<") && strings.HasSuffix(raw, ">")
	body := strings.TrimPrefix(raw, "<")
	body = strings.TrimSuffix(body, ">")
	if body == "" {
		return Status{}, false
	}

	parts := strings.Split(body, "|")
	first := strings.TrimSpace(parts[0])
	state := normalizeState(first)
	ok := state != Unknown || bracketed || len(parts) > 1
	if !ok {
		return Status{}, false
	}

	st := Status{
		State:  state,
		Raw:    raw,
		Fields: map[string]string{},
	}
	for _, part := range parts[1:] {
		key, val, found := strings.Cut(strings.TrimSpace(part), ":")
		if !found {
			continue
		}
		key = strings.TrimSpace(key)
		val = strings.TrimSpace(val)
		if key == "" {
			continue
		}
		storeField(st.Fields, key, val)
		switch key {
		case "MPos":
			st.MPos = parseAxes(val)
		case "WPos":
			st.WPos = parseAxes(val)
		case "F":
			st.Feed = parseTriple(val)
		case "S":
			st.Spindle = parseSpindle(val)
		case "T":
			st.Tool = parseTool(val)
		case "W":
			st.ProbeV = parseFirstFloat(val)
		case "L":
			st.Laser = parseLaser(val)
		case "A":
			st.ATCState = parseFirstInt(val)
		case "O":
			st.LevelDelta = parseFirstFloat(val)
		case "H":
			if reason := ParseHaltReason(val); reason != nil {
				st.HaltReason = reason
			}
		case "P":
			st.Progress = parseNumberList(val)
		case "C":
			st.Machine = parseNumberList(val)
			st.Controller = parseController(val)
		}
	}
	if len(st.Fields) == 0 {
		st.Fields = nil
	}
	return st, true
}

func normalizeState(s string) State {
	switch State(strings.TrimSpace(s)) {
	case Idle:
		return Idle
	case Run:
		return Run
	case Hold:
		return Hold
	case Alarm:
		return Alarm
	case Sleep:
		return Sleep
	case Home:
		return Home
	case Pause:
		return Pause
	case Wait:
		return Wait
	case Tool:
		return Tool
	default:
		return Unknown
	}
}

func storeField(fields map[string]string, key, val string) {
	if _, ok := fields[key]; !ok {
		fields[key] = val
		return
	}
	for i := 2; ; i++ {
		k := key + "#" + strconv.Itoa(i)
		if _, ok := fields[k]; !ok {
			fields[k] = val
			return
		}
	}
}

func parseAxes(s string) AxisValues {
	vals := parseNumberList(s)
	if len(vals) == 0 {
		return nil
	}
	names := []string{"x", "y", "z", "a", "b", "c"}
	out := make(AxisValues, len(vals))
	for i, v := range vals {
		if i >= len(names) {
			break
		}
		out[names[i]] = v
	}
	return out
}

func parseTriple(s string) *Triple {
	vals := parseNumberList(s)
	if len(vals) < 3 {
		return nil
	}
	return &Triple{Current: vals[0], Target: vals[1], Override: vals[2]}
}

func parseSpindle(s string) *Spindle {
	vals := parseNumberList(s)
	if len(vals) < 3 {
		return nil
	}
	spindle := &Spindle{CurrentRPM: vals[0], TargetRPM: vals[1], Override: vals[2]}
	optional := []**float64{
		&spindle.VacuumMode,
		&spindle.SpindleTempC,
		&spindle.PowerTempC,
		&spindle.BlowingMode,
		&spindle.BedCleanMode,
		&spindle.ExternalMode,
	}
	for i, target := range optional {
		if index := i + 3; index < len(vals) {
			value := vals[index]
			*target = &value
		}
	}
	return spindle
}

func copyFloat64(value *float64) *float64 {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func parseFirstFloat(s string) *float64 {
	vals := parseNumberList(s)
	if len(vals) == 0 {
		return nil
	}
	return &vals[0]
}

func parseFirstInt(s string) *int {
	value := parseFirstFloat(s)
	if value == nil {
		return nil
	}
	out := int(*value)
	return &out
}

func parseLaser(s string) *LaserStatus {
	vals := parseNumberList(s)
	if len(vals) < 5 {
		return nil
	}
	return &LaserStatus{
		Mode:    vals[0] != 0,
		State:   vals[1] != 0,
		Testing: vals[2] != 0,
		Power:   vals[3],
		Scale:   vals[4],
	}
}

func parseController(s string) *ControllerStatus {
	vals := parseNumberList(s)
	if len(vals) < 4 {
		return nil
	}
	return &ControllerStatus{
		Model:        int(vals[0]),
		Functions:    int(vals[1]),
		InchMode:     vals[2] != 0,
		AbsoluteMode: vals[3] != 0,
	}
}

func parseTool(s string) *ToolStatus {
	vals := parseNumberList(s)
	if len(vals) < 2 {
		return nil
	}
	t := &ToolStatus{Active: int(vals[0]), Offset: vals[1]}
	if len(vals) >= 3 {
		target := int(vals[2])
		t.Target = &target
	}
	return t
}

// ParseHaltReason parses the first integer in an H: field.
func ParseHaltReason(s string) *HaltReason {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	first := s
	if i := strings.IndexByte(first, ','); i >= 0 {
		first = first[:i]
	}
	code, err := strconv.Atoi(strings.TrimSpace(first))
	if err != nil {
		return nil
	}
	reason := DescribeHaltReason(code)
	return &reason
}

// DescribeHaltReason returns the official-controller meaning and recovery class
// for a firmware halt reason code.
func DescribeHaltReason(code int) HaltReason {
	reason := HaltReason{Code: code, Message: "Unknown alarm", Recovery: "inspect", Severity: "unknown"}
	if msg, ok := haltReasonMessages[code]; ok {
		reason.Message = msg
	}
	switch {
	case code >= 1 && code <= 20:
		reason.Recovery = "unlock"
		reason.Severity = "unlock"
	case code >= 21 && code <= 40:
		reason.Recovery = "reset"
		reason.Severity = "reset"
	case code >= 41:
		reason.Recovery = "power_cycle"
		reason.Severity = "power_cycle"
	}
	return reason
}

var haltReasonMessages = map[int]string{
	1:  "Halt manually",
	2:  "Home fail",
	3:  "Probe fail",
	4:  "Calibrate fail",
	5:  "ATC home fail",
	6:  "ATC invalid tool number",
	7:  "ATC drop tool fail",
	8:  "ATC position occupied",
	9:  "Spindle overheated",
	10: "Soft limit triggered",
	11: "Cover opened when playing",
	12: "Wireless probe dead or not set",
	13: "Emergency stop button pressed",
	14: "Power overheated",
	15: "Machine has not been homed",
	21: "Hard limit triggered",
	22: "X axis motor error",
	23: "Y axis motor error",
	24: "Z axis motor error",
	25: "Spindle stall",
	26: "SD card read fail",
	41: "Spindle alarm",
}

func parseNumberList(s string) []float64 {
	parts := strings.Split(s, ",")
	out := make([]float64, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		v, err := strconv.ParseFloat(part, 64)
		if err != nil {
			return nil
		}
		out = append(out, v)
	}
	return out
}

// Tracker holds the latest observed machine state with the time it was seen.
// It is safe for concurrent use: the relay observer and the sync engine both
// read it, and observers from either mode write it.
type Tracker struct {
	lastNonIdle time.Time
	mu          sync.RWMutex
	status      Status
	now         func() time.Time // injectable for tests
	subs        map[int]chan Status
	nextSub     int
}

// NewTracker returns a Tracker using wall-clock time.
func NewTracker() *Tracker {
	return &Tracker{now: time.Now}
}

// Observe records a freshly parsed state.
func (t *Tracker) Observe(s State) {
	t.mu.Lock()
	t.status = Status{State: s, ObservedAt: t.nowTime()}
	if s != Idle {
		t.lastNonIdle = t.status.ObservedAt
	}
	t.publishLocked(t.status)
	t.mu.Unlock()
}

// ObserveStatusPayload parses a status report and records it if valid. Returns
// true if the payload was a recognizable status report.
func (t *Tracker) ObserveStatusPayload(payload string) bool {
	st, ok := ParseStatusPayload(payload)
	if !ok {
		return false
	}
	t.mu.Lock()
	st.ObservedAt = t.nowTime()
	t.status = st
	if st.State != Idle {
		t.lastNonIdle = st.ObservedAt
	}
	t.publishLocked(st)
	t.mu.Unlock()
	return true
}

// Snapshot returns the current state and how long ago it was observed.
func (t *Tracker) Snapshot() (State, time.Duration) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	if t.status.ObservedAt.IsZero() {
		return Unknown, 0
	}
	return t.status.State, t.nowTime().Sub(t.status.ObservedAt)
}

// Current returns the latest parsed status and how long ago it was observed.
func (t *Tracker) Current() (Status, time.Duration) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	if t.status.ObservedAt.IsZero() {
		return Status{State: Unknown}, 0
	}
	return t.status.copy(), t.nowTime().Sub(t.status.ObservedAt)
}

// Fresh reports whether the state was observed within maxAge. A stale state
// (e.g. no status seen recently) should not be trusted to gate file ops.
func (t *Tracker) Fresh(maxAge time.Duration) bool {
	t.mu.RLock()
	defer t.mu.RUnlock()
	if t.status.ObservedAt.IsZero() {
		return false
	}
	return t.nowTime().Sub(t.status.ObservedAt) <= maxAge
}

// Subscribe returns future observed statuses. The current status is not
// replayed; callers should combine this with Current for an initial snapshot.
func (t *Tracker) Subscribe() (<-chan Status, func()) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.subs == nil {
		t.subs = map[int]chan Status{}
	}
	id := t.nextSub
	t.nextSub++
	ch := make(chan Status, 32)
	t.subs[id] = ch
	return ch, func() {
		t.mu.Lock()
		defer t.mu.Unlock()
		if c, ok := t.subs[id]; ok {
			delete(t.subs, id)
			close(c)
		}
	}
}

func (t *Tracker) publishLocked(st Status) {
	for _, ch := range t.subs {
		select {
		case ch <- st.copy():
		default:
		}
	}
}

func (t *Tracker) nowTime() time.Time {
	if t.now != nil {
		return t.now()
	}
	return time.Now()
}

func copyAxisValues(in AxisValues) AxisValues {
	if len(in) == 0 {
		return nil
	}
	out := make(AxisValues, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func copyStringMap(in map[string]string) map[string]string {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func (t *Tracker) LastNonIdle() time.Time {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.lastNonIdle
}
