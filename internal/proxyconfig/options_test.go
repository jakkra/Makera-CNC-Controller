package proxyconfig

import "testing"

func TestNotificationOptionsAreExposedAndTokenIsSecret(t *testing.T) {
	options := make(map[string]Option)
	for _, option := range Options() {
		options[option.Name] = option
	}

	token, ok := options["notify-ntfy-token"]
	if !ok || !token.Secret || token.Type != OptionString {
		t.Fatalf("notify token option = %#v, present=%v", token, ok)
	}
	if got := options["notify-ntfy-url"]; got.Type != OptionString || got.Default != "" {
		t.Fatalf("notify URL option = %#v", got)
	}
	if got := options["notify-resolved"]; got.Type != OptionBool || got.Default != "false" {
		t.Fatalf("notify resolved option = %#v", got)
	}
}

func TestCameraOptionsAreExposed(t *testing.T) {
	options := make(map[string]Option)
	for _, option := range Options() {
		options[option.Name] = option
	}
	for _, name := range []string{"camera-builtin-ws-url", "camera-external-url"} {
		option, ok := options[name]
		if !ok || option.Type != OptionString || option.Default != "" {
			t.Fatalf("camera option %q = %#v, present=%v", name, option, ok)
		}
	}
	if got := options["camera-external-mode"]; got.Type != OptionString || got.Default != "mjpeg" || len(got.Choices) != 2 {
		t.Fatalf("camera external mode = %#v", got)
	}
}
