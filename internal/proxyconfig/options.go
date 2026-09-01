// Package proxyconfig describes the proxy process flags that host-side tools
// can render and validate without hard-coding UI fields independently.
package proxyconfig

import (
	"encoding/json"
	"io"

	"github.com/uwin/cnc-proxy/internal/jog"
	"github.com/uwin/cnc-proxy/internal/machinetransport"
)

type OptionType string

const (
	OptionString   OptionType = "string"
	OptionBool     OptionType = "bool"
	OptionInt      OptionType = "int"
	OptionInt64    OptionType = "int64"
	OptionFloat    OptionType = "float"
	OptionDuration OptionType = "duration"
)

type Option struct {
	Name        string     `json:"name"`
	Label       string     `json:"label"`
	Type        OptionType `json:"type"`
	Default     string     `json:"default"`
	Placeholder string     `json:"placeholder,omitempty"`
	Choices     []string   `json:"choices,omitempty"`
	Secret      bool       `json:"secret,omitempty"`
}

type Schema struct {
	Options []Option `json:"options"`
}

func Options() []Option {
	jogDefaults := jog.DefaultConfig()
	return []Option{
		{Name: "tcp-port", Label: "Controller TCP Port", Type: OptionInt, Default: "2222"},
		{Name: "machine-transport", Label: "Machine Transport", Type: OptionString, Default: machinetransport.KindTCP, Choices: []string{machinetransport.KindTCP, machinetransport.KindUSB}},
		{Name: "machine", Label: "TCP Machine Address", Type: OptionString, Default: "", Placeholder: "192.168.1.42 or 192.168.1.42:2222"},
		{Name: "camera-builtin-ws-url", Label: "Built-in Camera WebSocket URL", Type: OptionString, Default: "", Placeholder: "ws://192.168.1.42:82/ws_video"},
		{Name: "camera-external-url", Label: "External Camera URL", Type: OptionString, Default: "", Placeholder: "http://camera.local/mjpeg or https://camera.example/snapshot.jpg"},
		{Name: "camera-external-mode", Label: "External Camera Mode", Type: OptionString, Default: "mjpeg", Choices: []string{"mjpeg", "snapshot"}},
		{Name: "usb-device", Label: "USB Device", Type: OptionString, Default: "", Placeholder: "/dev/cu.usbserial-... or COM3"},
		{Name: "usb-baud", Label: "USB Baud", Type: OptionInt, Default: "115200"},
		{Name: "usb-reset-on-open", Label: "USB Reset On Open", Type: OptionBool, Default: "false"},
		{Name: "advertise", Label: "Advertise To Controller", Type: OptionBool, Default: "false"},
		{Name: "proxy-ip", Label: "Advertised Proxy IP", Type: OptionString, Default: "", Placeholder: "192.168.1.50"},
		{Name: "broadcast", Label: "Discovery Broadcast", Type: OptionString, Default: "", Placeholder: "192.168.1.255"},
		{Name: "name", Label: "Advertised Name", Type: OptionString, Default: ""},
		{Name: "name-suffix", Label: "Advertised Name Suffix", Type: OptionString, Default: " (proxy)"},
		{Name: "no-advertise", Label: "Deprecated No Advertise", Type: OptionBool, Default: "false"},
		{Name: "api-addr", Label: "API/Web UI Address", Type: OptionString, Default: "127.0.0.1:8420"},
		{Name: "api-allowed-hosts", Label: "Allowed Reverse Proxy Hosts", Type: OptionString, Default: "", Placeholder: "z1-controller.your-tailnet.ts.net"},
		{Name: "dav-addr", Label: "WebDAV Address", Type: OptionString, Default: "127.0.0.1:8421"},
		{Name: "auth-user", Label: "HTTP Auth User", Type: OptionString, Default: "cnc"},
		{Name: "auth-token", Label: "HTTP Auth Token", Type: OptionString, Default: "", Secret: true},
		{Name: "allow-insecure-http", Label: "Allow Insecure HTTP Bind", Type: OptionBool, Default: "false"},
		{Name: "data-dir", Label: "Data Directory", Type: OptionString, Default: ""},
		{Name: "api-max-upload-mb", Label: "Max Upload MiB", Type: OptionInt64, Default: "512"},
		{Name: "api-max-json-kb", Label: "Max JSON KiB", Type: OptionInt64, Default: "1024"},
		{Name: "api-max-backup-mb", Label: "Max Backup MiB", Type: OptionInt64, Default: "64"},
		{Name: "jog-enabled", Label: "Gamepad Jog Enabled", Type: OptionBool, Default: "true"},
		{Name: "jog-max-xy-mm-min", Label: "Max XY Jog mm/min", Type: OptionFloat, Default: trimFloat(jogDefaults.MaxXYMMMin)},
		{Name: "jog-max-z-mm-min", Label: "Max Z Jog mm/min", Type: OptionFloat, Default: trimFloat(jogDefaults.MaxZMMMin)},
		{Name: "jog-tick", Label: "Jog Tick", Type: OptionDuration, Default: jogDefaults.Tick.String()},
		{Name: "jog-status-interval", Label: "Jog Status Interval", Type: OptionDuration, Default: jogDefaults.StatusInterval.String()},
		{Name: "jog-deadman-timeout", Label: "Jog Deadman Timeout", Type: OptionDuration, Default: jogDefaults.DeadmanTimeout.String()},
		{Name: "jog-motion", Label: "Jog Motion Primitive", Type: OptionString, Default: string(jogDefaults.MotionPrimitive), Choices: []string{string(jog.MotionPrimitiveInstant), string(jog.MotionPrimitiveG53)}},
		{Name: "notify-ntfy-url", Label: "ntfy Topic URL", Type: OptionString, Default: "", Placeholder: "https://ntfy.example.net/private-z1-topic"},
		{Name: "notify-ntfy-token", Label: "ntfy Topic Token", Type: OptionString, Default: "", Secret: true},
		{Name: "notify-machine-name", Label: "Notification Machine Name", Type: OptionString, Default: "Makera Z1"},
		{Name: "notify-dashboard-url", Label: "Notification Dashboard URL", Type: OptionString, Default: "", Placeholder: "http://z1-controller.your-tailnet.ts.net:8420/"},
		{Name: "notify-resolved", Label: "Notify When Attention Clears", Type: OptionBool, Default: "false"},
	}
}

func WriteSchema(w io.Writer) error {
	return json.NewEncoder(w).Encode(Schema{Options: Options()})
}

func trimFloat(v float64) string {
	b, _ := json.Marshal(v)
	return string(b)
}
