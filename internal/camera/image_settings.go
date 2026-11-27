package camera

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// ImageSettings are the external camera's exposure and image controls. They
// live on the camera itself and reset whenever it is unplugged, so the proxy
// keeps the operator's last choice and applies it again when the camera
// reappears.
type ImageSettings struct {
	AutoExposure     bool `json:"auto_exposure"`
	ExposureTime     int  `json:"exposure_time"`     // 100 µs units, manual exposure only
	Gain             int  `json:"gain"`              // 0-255
	Brightness       int  `json:"brightness"`        // 0-255
	PowerLine        int  `json:"power_line"`        // 0 off, 1 50 Hz, 2 60 Hz
	DynamicFramerate bool `json:"dynamic_framerate"` // allow fewer frames in low light
}

type ImageStatus struct {
	Available bool `json:"available"`
	ImageSettings
	ExposureMin int `json:"exposure_min"`
	ExposureMax int `json:"exposure_max"`
}

// storedCameraSettings is the file kept between proxy restarts.
type storedCameraSettings struct {
	Image *ImageSettings `json:"image,omitempty"`
	Focus *struct {
		Autofocus bool `json:"autofocus"`
		Absolute  int  `json:"absolute"`
	} `json:"focus,omitempty"`
}

const (
	exposureMin = 3
	exposureMax = 2047
)

func (s ImageSettings) validate() error {
	switch {
	case s.ExposureTime < exposureMin || s.ExposureTime > exposureMax:
		return fmt.Errorf("exposure time must be between %d and %d", exposureMin, exposureMax)
	case s.Gain < 0 || s.Gain > 255:
		return errors.New("gain must be between 0 and 255")
	case s.Brightness < 0 || s.Brightness > 255:
		return errors.New("brightness must be between 0 and 255")
	case s.PowerLine < 0 || s.PowerLine > 2:
		return errors.New("power line frequency must be off, 50 Hz or 60 Hz")
	}
	return nil
}

// v4l2 control assignments, in an order the camera accepts: the exposure
// mode first, then the manual exposure time that depends on it.
func (s ImageSettings) controls() []string {
	bool01 := func(v bool) string {
		if v {
			return "1"
		}
		return "0"
	}
	mode := "1" // manual
	if s.AutoExposure {
		mode = "3" // aperture priority, the camera's automatic mode
	}
	out := []string{
		"power_line_frequency=" + strconv.Itoa(s.PowerLine),
		"auto_exposure=" + mode,
		"exposure_dynamic_framerate=" + bool01(s.DynamicFramerate),
		"brightness=" + strconv.Itoa(s.Brightness),
	}
	// In automatic mode the camera drives gain itself; writing it fights the
	// automatic exposure.
	if !s.AutoExposure {
		out = append(out, "gain="+strconv.Itoa(s.Gain), "exposure_time_absolute="+strconv.Itoa(s.ExposureTime))
	}
	return out
}

func (m *Manager) runV4L2(ctx context.Context, args ...string) ([]byte, error) {
	output, err := exec.CommandContext(ctx, "v4l2-ctl", append([]string{"-d", m.externalDevice}, args...)...).CombinedOutput()
	if err != nil {
		return output, fmt.Errorf("%w: %s", err, strings.TrimSpace(string(output)))
	}
	return output, nil
}

func (m *Manager) Image(ctx context.Context) (ImageStatus, error) {
	if m == nil || m.externalDevice == "" {
		return ImageStatus{}, ErrFocusUnavailable
	}
	m.focusMu.Lock()
	defer m.focusMu.Unlock()
	return m.readImageLocked(ctx)
}

func (m *Manager) readImageLocked(ctx context.Context) (ImageStatus, error) {
	output, err := m.runV4L2(ctx, "--get-ctrl=auto_exposure,exposure_time_absolute,gain,brightness,power_line_frequency,exposure_dynamic_framerate")
	if err != nil {
		return ImageStatus{}, fmt.Errorf("read camera exposure: %w", err)
	}
	v := parseFocusControlOutput(output)
	for _, name := range []string{"auto_exposure", "exposure_time_absolute", "gain", "brightness", "power_line_frequency", "exposure_dynamic_framerate"} {
		if _, ok := v[name]; !ok {
			return ImageStatus{}, fmt.Errorf("camera did not report %s", name)
		}
	}
	return ImageStatus{
		Available: true,
		ImageSettings: ImageSettings{
			AutoExposure:     v["auto_exposure"] != 1,
			ExposureTime:     v["exposure_time_absolute"],
			Gain:             v["gain"],
			Brightness:       v["brightness"],
			PowerLine:        v["power_line_frequency"],
			DynamicFramerate: v["exposure_dynamic_framerate"] != 0,
		},
		ExposureMin: exposureMin,
		ExposureMax: exposureMax,
	}, nil
}

func (m *Manager) SetImage(ctx context.Context, s ImageSettings) (ImageStatus, error) {
	if m == nil || m.externalDevice == "" {
		return ImageStatus{}, ErrFocusUnavailable
	}
	if err := s.validate(); err != nil {
		return ImageStatus{}, err
	}
	m.focusMu.Lock()
	defer m.focusMu.Unlock()
	if err := m.applyImageLocked(ctx, s); err != nil {
		return ImageStatus{}, err
	}
	m.updateStoredLocked(func(stored *storedCameraSettings) { stored.Image = &s })
	return m.readImageLocked(ctx)
}

func (m *Manager) applyImageLocked(ctx context.Context, s ImageSettings) error {
	for _, control := range s.controls() {
		if _, err := m.runV4L2(ctx, "--set-ctrl="+control); err != nil {
			return fmt.Errorf("set camera %s: %w", strings.SplitN(control, "=", 2)[0], err)
		}
	}
	return nil
}

func (m *Manager) loadStoredLocked() storedCameraSettings {
	var stored storedCameraSettings
	if m.settingsPath == "" {
		return stored
	}
	data, err := os.ReadFile(m.settingsPath)
	if err == nil {
		_ = json.Unmarshal(data, &stored)
	}
	return stored
}

func (m *Manager) updateStoredLocked(change func(*storedCameraSettings)) {
	if m.settingsPath == "" {
		return
	}
	stored := m.loadStoredLocked()
	change(&stored)
	data, err := json.MarshalIndent(stored, "", "  ")
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(m.settingsPath), 0o755); err != nil {
		log.Printf("camera: save settings: %v", err)
		return
	}
	tmp := m.settingsPath + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err == nil {
		err = os.Rename(tmp, m.settingsPath)
		if err != nil {
			log.Printf("camera: save settings: %v", err)
		}
	} else {
		log.Printf("camera: save settings: %v", err)
	}
}

// applyStored writes the saved focus and image settings to the camera.
func (m *Manager) applyStored(ctx context.Context) error {
	m.focusMu.Lock()
	defer m.focusMu.Unlock()
	stored := m.loadStoredLocked()
	if stored.Image != nil {
		if err := m.applyImageLocked(ctx, *stored.Image); err != nil {
			return err
		}
	}
	if stored.Focus != nil {
		if err := m.applyFocusLocked(ctx, stored.Focus.Autofocus, stored.Focus.Absolute); err != nil {
			return err
		}
	}
	return nil
}

// WatchExternalDevice applies the saved settings whenever the external camera
// appears: at start and after it was unplugged or reset by the USB hub.
func (m *Manager) WatchExternalDevice(ctx context.Context, interval time.Duration) {
	if m == nil || m.externalDevice == "" || m.settingsPath == "" {
		return
	}
	present := false
	identity := ""
	for {
		target, err := filepath.EvalSymlinks(m.externalDevice)
		now := err == nil
		if now && (!present || target != identity) {
			// Give the driver a moment to finish enumerating the controls.
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Second):
			}
			applyCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			if err := m.applyStored(applyCtx); err != nil {
				log.Printf("camera: apply saved settings: %v", err)
			} else {
				log.Printf("camera: applied saved settings to %s", target)
			}
			cancel()
		}
		present, identity = now, target
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}
