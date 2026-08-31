package main

import "testing"

func TestValidateMachineTransport(t *testing.T) {
	tests := []struct {
		name      string
		kind      string
		device    string
		baud      int
		advertise bool
		advName   string
		wantErr   bool
	}{
		{name: "tcp default", kind: "tcp", baud: 115200},
		{name: "usb ok no advertise", kind: "usb", device: "/dev/cu.usbserial-test", baud: 115200},
		{name: "usb ok advertise with name", kind: "usb", device: "/dev/cu.usbserial-test", baud: 115200, advertise: true, advName: "Carvera USB"},
		{name: "bad kind", kind: "serial", baud: 115200, wantErr: true},
		{name: "usb missing device", kind: "usb", baud: 115200, wantErr: true},
		{name: "usb bad baud", kind: "usb", device: "/dev/cu.usbserial-test", wantErr: true},
		{name: "usb advertise missing name", kind: "usb", device: "/dev/cu.usbserial-test", baud: 115200, advertise: true, wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := validateMachineTransport(tc.kind, tc.device, tc.baud, tc.advertise, tc.advName)
			if (err != nil) != tc.wantErr {
				t.Fatalf("validateMachineTransport() err = %v, wantErr %v", err, tc.wantErr)
			}
		})
	}
}

func TestShouldListenForDiscovery(t *testing.T) {
	for _, tc := range []struct {
		name      string
		kind      string
		machine   string
		advertise bool
		advName   string
		want      bool
	}{
		{name: "tcp auto discover", kind: "tcp", want: true},
		{name: "tcp fixed no advertise", kind: "tcp", machine: "192.168.1.43:2222", want: false},
		{name: "tcp fixed advertise derives name", kind: "tcp", machine: "192.168.1.43:2222", advertise: true, want: true},
		{name: "tcp fixed advertise with explicit name", kind: "tcp", machine: "192.168.1.43:2222", advertise: true, advName: "Makera Z1 Proxy", want: false},
		{name: "usb never listens", kind: "usb", machine: "/dev/cu.usbserial-test", advertise: true, want: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := shouldListenForDiscovery(tc.kind, tc.machine, tc.advertise, tc.advName); got != tc.want {
				t.Fatalf("shouldListenForDiscovery() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestResolveUSBAdvertiseAddrsExplicit(t *testing.T) {
	pip, bcast, err := resolveUSBAdvertiseAddrs("192.168.1.50", "192.168.1.255")
	if err != nil {
		t.Fatalf("resolveUSBAdvertiseAddrs explicit: %v", err)
	}
	if pip != "192.168.1.50" || bcast != "192.168.1.255" {
		t.Fatalf("resolveUSBAdvertiseAddrs = %q %q", pip, bcast)
	}
	if _, _, err := resolveUSBAdvertiseAddrs("not-an-ip", ""); err == nil {
		t.Fatal("invalid proxy IP should fail")
	}
}

func TestIsLoopbackBind(t *testing.T) {
	for _, tc := range []struct {
		addr string
		want bool
	}{
		{addr: "localhost:8420", want: true},
		{addr: "127.0.0.1:8420", want: true},
		{addr: "[::1]:8420", want: true},
		{addr: ":8420", want: false},
		{addr: "0.0.0.0:8420", want: false},
		{addr: "[::]:8420", want: false},
		{addr: "192.168.1.20:8420", want: false},
		{addr: "bad-addr", want: false},
	} {
		if got := isLoopbackBind(tc.addr); got != tc.want {
			t.Errorf("isLoopbackBind(%q) = %v, want %v", tc.addr, got, tc.want)
		}
	}
}

func TestValidateHTTPExposure(t *testing.T) {
	if err := validateHTTPExposure("127.0.0.1:8420", "localhost:8421", "", false); err != nil {
		t.Fatalf("loopback without token: %v", err)
	}
	if err := validateHTTPExposure(":8420", "127.0.0.1:8421", "", false); err == nil {
		t.Fatal("wildcard API bind without token should fail")
	}
	if err := validateHTTPExposure("127.0.0.1:8420", "0.0.0.0:8421", "", false); err == nil {
		t.Fatal("wildcard WebDAV bind without token should fail")
	}
	if err := validateHTTPExposure(":8420", "0.0.0.0:8421", "secret", false); err != nil {
		t.Fatalf("token should allow non-loopback bind: %v", err)
	}
	if err := validateHTTPExposure(":8420", "0.0.0.0:8421", "", true); err != nil {
		t.Fatalf("explicit insecure override should allow non-loopback bind: %v", err)
	}
}
