package camera

import (
	"reflect"
	"testing"
)

func TestImageSettingsControlsSetModeBeforeManualExposure(t *testing.T) {
	manual := ImageSettings{AutoExposure: false, ExposureTime: 156, Gain: 40, Brightness: 128, PowerLine: 1}
	want := []string{"power_line_frequency=1", "auto_exposure=1", "exposure_dynamic_framerate=0", "gain=40", "brightness=128", "exposure_time_absolute=156"}
	if got := manual.controls(); !reflect.DeepEqual(got, want) {
		t.Fatalf("manual controls = %v, want %v", got, want)
	}
	auto := manual
	auto.AutoExposure = true
	auto.DynamicFramerate = true
	for _, control := range auto.controls() {
		if control == "exposure_time_absolute=156" {
			t.Fatal("automatic exposure must not write a manual exposure time")
		}
	}
	if auto.controls()[1] != "auto_exposure=3" || auto.controls()[2] != "exposure_dynamic_framerate=1" {
		t.Fatalf("auto controls = %v", auto.controls())
	}
}

func TestImageSettingsValidate(t *testing.T) {
	ok := ImageSettings{ExposureTime: 250, Gain: 0, Brightness: 128, PowerLine: 1}
	if err := ok.validate(); err != nil {
		t.Fatal(err)
	}
	for name, bad := range map[string]ImageSettings{
		"exposure":   {ExposureTime: 2, PowerLine: 1},
		"gain":       {ExposureTime: 250, Gain: 256, PowerLine: 1},
		"brightness": {ExposureTime: 250, Brightness: -1, PowerLine: 1},
		"power line": {ExposureTime: 250, PowerLine: 3},
	} {
		if bad.validate() == nil {
			t.Errorf("%s: expected a validation error", name)
		}
	}
}

func TestControlOutputReadsMenuValues(t *testing.T) {
	values := parseFocusControlOutput([]byte("gain: 0\nauto_exposure: 3 (Aperture Priority Mode)\npower_line_frequency: 1 (50 Hz)\n"))
	if values["auto_exposure"] != 3 || values["power_line_frequency"] != 1 || values["gain"] != 0 {
		t.Fatalf("values = %v", values)
	}
}
