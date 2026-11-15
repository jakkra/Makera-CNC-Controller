package main

import (
	"context"
	"fmt"
	"github.com/uwin/cnc-proxy/internal/carveratest"
	"github.com/uwin/cnc-proxy/internal/client"
	"github.com/uwin/cnc-proxy/internal/discovery"
	"github.com/uwin/cnc-proxy/internal/session"
	"net"
	"testing"
	"time"
)

// Exercise real UDP discovery, TCP reconnect and protocol status polling after
// the selected machine changes endpoint, including unrelated advertisements.
func TestNamedDiscoveryReconnect(t *testing.T) {
	udp, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	listener := &discovery.Listener{TargetName: "selected"}
	done := make(chan struct{})
	go func() { defer close(done); listener.Listen(udp) }()
	defer func() { udp.Close(); <-done }()
	sender, err := net.Dial("udp4", udp.LocalAddr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer sender.Close()
	first, err := carveratest.New()
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := carveratest.New()
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	second.SetStatus("<Run|MPos:1,2,3>")
	announce := func(name, addr string) {
		t.Helper()
		host, port, _ := net.SplitHostPort(addr)
		if _, err := fmt.Fprintf(sender, "%s,%s,%s,0", name, host, port); err != nil {
			t.Fatal(err)
		}
	}
	resolve := machineDialer("", listener)
	arb := session.New(session.Config{PollInterval: 10 * time.Millisecond, Dial: func() (*client.Conn, error) {
		addr, err := resolve()
		if err != nil {
			return nil, err
		}
		return client.Dial(addr, 100*time.Millisecond)
	}})
	defer arb.EnterRelay()
	ctx, cancel := context.WithCancel(context.Background())
	pollDone := make(chan struct{})
	go func() { defer close(pollDone); arb.Poll(ctx, 50*time.Millisecond) }()
	defer func() { cancel(); <-pollDone }()
	wait := func(want string) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			st, _ := arb.Tracker().Current()
			if string(st.State) == want {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatalf("never observed %s", want)
	}
	announce("selected", first.Addr())
	wait("Idle")
	first.SetDropStatusReplies(true)
	announce("selected", second.Addr())
	deadline := time.Now().Add(time.Second)
	for {
		addr, _ := resolve()
		if addr == second.Addr() {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("address did not update")
		}
		time.Sleep(time.Millisecond)
	}
	announce("unrelated", first.Addr())
	wait("Run")
}
