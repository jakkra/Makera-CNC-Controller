// Package discovery handles Carvera UDP machine discovery on port 3333.
//
// The real machine broadcasts "name,ip,port,busy" once per second. The official
// controller binds UDP 3333 and reads those datagrams to populate its machine
// list, then opens TCP to the advertised ip:port.
//
// To make the proxy transparent, we re-advertise the machine under the proxy's
// own address so the controller connects to us instead of the machine. We learn
// the real machine's identity by listening to its genuine broadcasts.
package discovery

import (
	"context"
	"fmt"
	"log"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

const Port = 3333

// Machine is a parsed discovery record.
type Machine struct {
	Name string
	IP   string
	Port int
	Busy bool
}

func parse(s string) (Machine, bool) {
	f := strings.Split(strings.TrimSpace(s), ",")
	if len(f) < 4 {
		return Machine{}, false
	}
	port, err := strconv.Atoi(strings.TrimSpace(f[2]))
	if err != nil || port < 1 || port > 65535 || strings.TrimSpace(f[0]) == "" {
		return Machine{}, false
	}
	ip := net.ParseIP(strings.TrimSpace(f[1]))
	if ip == nil || ip.To4() == nil || ip.IsUnspecified() || ip.IsMulticast() {
		return Machine{}, false
	}
	return Machine{Name: strings.TrimSpace(f[0]), IP: ip.String(), Port: port, Busy: strings.TrimSpace(f[3]) == "1"}, true
}

func (m Machine) format() string {
	busy := "0"
	if m.Busy {
		busy = "1"
	}
	return fmt.Sprintf("%s,%s,%d,%s", m.Name, m.IP, m.Port, busy)
}

// Listener watches for genuine machine broadcasts and reports the most recently
// seen machine. It binds 3333 with SO_REUSEADDR/REUSEPORT so it can coexist with
// the controller (which also binds 3333) on the same host during testing.
type Listener struct {
	// TargetName pins discovery to one machine. Set before Listen starts.
	// Named records expire after ten seconds without a broadcast.
	TargetName string
	mu         sync.RWMutex
	last       *Machine
	seen       time.Time
	self       *Machine
}

// SetSelf records the identity this proxy currently advertises. A UDP socket
// bound to 0.0.0.0:3333 receives broadcasts sent from the same host, so without
// this filter the proxy would learn its own re-advertisement as "the machine"
// and dial itself. The Advertiser calls this before every broadcast.
func (l *Listener) SetSelf(m Machine) {
	l.mu.Lock()
	l.self = &m
	l.mu.Unlock()
}

func (l *Listener) isSelf(m Machine) bool {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if l.self == nil {
		return false
	}
	// Match on ip:port, not name: that pair is what uniquely identifies the
	// proxy's advertisement, and a name match would wrongly filter the real
	// machine if the operator picks the same advertised name.
	return m.IP == l.self.IP && m.Port == l.self.Port
}

// Latest returns the most recently observed machine, or false if none yet.
func (l *Listener) Latest() (Machine, bool) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if l.last == nil || (l.TargetName != "" && time.Since(l.seen) > 10*time.Second) {
		return Machine{}, false
	}
	return *l.last, true
}

// Listen blocks, reading machine broadcasts until the conn is closed. Records
// matching the identity registered via SetSelf are ignored so the proxy never
// learns from its own re-advertisements.
func (l *Listener) Listen(conn *net.UDPConn) {
	buf := make([]byte, 256)
	for {
		n, _, err := conn.ReadFromUDP(buf)
		if err != nil {
			return
		}
		l.observe(string(buf[:n]))
	}
}

// observe accepts only the configured identity and records address changes.
func (l *Listener) observe(record string) {
	m, ok := parse(record)
	if !ok || l.isSelf(m) || (l.TargetName != "" && m.Name != l.TargetName) {
		return
	}
	l.mu.Lock()
	changed := l.last == nil || l.last.IP != m.IP || l.last.Port != m.Port || l.last.Name != m.Name
	l.last = &m
	l.seen = time.Now()
	l.mu.Unlock()
	if changed {
		log.Printf("discovery: learned machine %q at %s:%d (busy=%v)", m.Name, m.IP, m.Port, m.Busy)
	}
}

// Advertiser re-broadcasts a machine record pointing at the proxy. advertise()
// is what the controller will see and connect to.
type Advertiser struct {
	Listener   *Listener
	ProxyIP    string // address the controller should connect to (this host)
	ProxyPort  int    // proxy's TCP listen port
	Name       string // advertised machine name; empty = real name + NameSuffix
	NameSuffix string // appended to the real machine name when Name is empty
	Interval   time.Duration
	// RequireMachine waits for a real machine broadcast before advertising, even
	// when Name is set explicitly.
	RequireMachine bool
}

// advertisedName returns the name to broadcast for the real machine realName.
func (a *Advertiser) advertisedName(realName string) string {
	if a.Name != "" {
		return a.Name
	}
	return realName + a.NameSuffix
}

// Run broadcasts at Interval, or once per second when Interval is unset, to the
// given destination (a directed-broadcast address, or a unicast host such as
// host.docker.internal when broadcasts can't traverse the network) until stop
// is closed. With an explicit Name it advertises immediately; otherwise it waits
// until a real machine has been learned, since the advertised name is derived
// from the real one. The busy flag is copied from the machine's own broadcasts
// when available.
func (a *Advertiser) Run(broadcast string, stop <-chan struct{}) error {
	// SO_BROADCAST is required to send to a broadcast address on Linux (and is
	// harmless for unicast destinations); Go does not set it by default.
	d := net.Dialer{Control: broadcastable}
	conn, err := d.Dial("udp4", net.JoinHostPort(broadcast, strconv.Itoa(Port)))
	if err != nil {
		return err
	}
	defer conn.Close()

	interval := a.Interval
	if interval <= 0 {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return nil
		case <-ticker.C:
			m, ok := a.Listener.Latest()
			if !ok && (a.Name == "" || a.RequireMachine) {
				continue
			}
			adv := Machine{
				Name: a.advertisedName(m.Name),
				IP:   a.ProxyIP,
				Port: a.ProxyPort,
				Busy: ok && m.Busy,
			}
			a.Listener.SetSelf(adv)
			if _, err := conn.Write([]byte(adv.format())); err != nil {
				log.Printf("discovery: advertise write failed: %v", err)
			}
		}
	}
}

// OpenListenSocket binds the discovery port for reading with SO_REUSEADDR and
// SO_REUSEPORT (where the platform supports them) so it can coexist with other
// reuse-aware listeners on the same host. Note the official controller binds
// 3333 without these options, so it still cannot share the port with a
// natively-running proxy — running the proxy in a container (own network
// namespace) avoids that conflict entirely.
func OpenListenSocket() (*net.UDPConn, error) {
	lc := net.ListenConfig{Control: reusePort}
	pc, err := lc.ListenPacket(context.Background(), "udp4", fmt.Sprintf("0.0.0.0:%d", Port))
	if err != nil {
		return nil, err
	}
	return pc.(*net.UDPConn), nil
}

// LocalIPToward returns the local IPv4 address the OS would use as the source
// when sending to target (e.g. the machine's IP). It opens a UDP socket but
// sends nothing — the kernel resolves the route on "connect". This lets the
// proxy auto-fill -proxy-ip without the user knowing which interface reaches
// the machine.
func LocalIPToward(target string) (net.IP, error) {
	c, err := net.Dial("udp4", net.JoinHostPort(target, "9")) // port arbitrary; no packet sent
	if err != nil {
		return nil, err
	}
	defer c.Close()
	ip := c.LocalAddr().(*net.UDPAddr).IP.To4()
	if ip == nil {
		return nil, fmt.Errorf("discovery: no IPv4 route toward %s", target)
	}
	return ip, nil
}

// BroadcastFor returns the IPv4 directed-broadcast address of the local
// interface that owns localIP (localIP | ^netmask). This is the address the
// proxy advertises on so the controller, which listens for broadcasts, sees it.
func BroadcastFor(localIP net.IP) (net.IP, error) {
	want := localIP.To4()
	if want == nil {
		return nil, fmt.Errorf("discovery: %v is not IPv4", localIP)
	}
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	for _, ifc := range ifaces {
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok || ipn.IP.To4() == nil {
				continue
			}
			if ipn.IP.To4().Equal(want) {
				ip := ipn.IP.To4()
				mask := ipn.Mask
				if len(mask) != 4 {
					mask = ipn.Mask[len(ipn.Mask)-4:]
				}
				b := make(net.IP, 4)
				for i := 0; i < 4; i++ {
					b[i] = ip[i] | ^mask[i]
				}
				return b, nil
			}
		}
	}
	return nil, fmt.Errorf("discovery: no interface owns %v", localIP)
}

// AutoAdvertiseAddrs derives the (proxyIP, broadcast) the advertiser should use,
// given the machine address (host or host:port) to route toward. Both are
// computed from the local interface that reaches the machine.
func AutoAdvertiseAddrs(machineHostPort string) (proxyIP, broadcast string, err error) {
	host := machineHostPort
	if h, _, e := net.SplitHostPort(machineHostPort); e == nil {
		host = h
	}
	lip, err := LocalIPToward(host)
	if err != nil {
		return "", "", err
	}
	b, err := BroadcastFor(lip)
	if err != nil {
		return "", "", err
	}
	return lip.String(), b.String(), nil
}

// SingleActiveLANAdvertiseAddrs derives advertise addresses from the only
// active non-loopback broadcast-capable IPv4 interface. It is used when the
// machine is reached over USB and there is no machine IP to route toward.
func SingleActiveLANAdvertiseAddrs() (proxyIP, broadcast string, err error) {
	type candidate struct {
		ip    net.IP
		bcast net.IP
		iface string
	}
	var candidates []candidate
	ifaces, err := net.Interfaces()
	if err != nil {
		return "", "", err
	}
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 || ifc.Flags&net.FlagBroadcast == 0 {
			continue
		}
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipn.IP.To4()
			if ip == nil || ip.IsLoopback() || ip.IsUnspecified() {
				continue
			}
			mask := ipn.Mask
			if len(mask) != 4 {
				if len(mask) < 4 {
					continue
				}
				mask = mask[len(mask)-4:]
			}
			b := make(net.IP, 4)
			for i := 0; i < 4; i++ {
				b[i] = ip[i] | ^mask[i]
			}
			candidates = append(candidates, candidate{ip: append(net.IP(nil), ip...), bcast: b, iface: ifc.Name})
		}
	}
	switch len(candidates) {
	case 0:
		return "", "", fmt.Errorf("discovery: no active non-loopback IPv4 LAN interface found")
	case 1:
		return candidates[0].ip.String(), candidates[0].bcast.String(), nil
	default:
		names := make([]string, 0, len(candidates))
		for _, c := range candidates {
			names = append(names, c.iface+"="+c.ip.String())
		}
		return "", "", fmt.Errorf("discovery: multiple active IPv4 LAN interfaces (%s)", strings.Join(names, ", "))
	}
}
