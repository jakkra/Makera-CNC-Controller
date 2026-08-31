// Command proxy is the Makera Carvera companion: a transparent pass-through
// proxy plus a file-handling API for the machine.
//
// It does several things at once:
//   - Relays the official controller's TCP 2222 session byte-for-byte to the
//     machine over TCP or USB, and answers UDP discovery so the controller finds
//     the proxy.
//   - Owns the machine connection whenever no controller is attached, polling
//     status and draining a durable job queue while the machine is idle.
//   - Serves an HTTP API + web UI for uploading and managing files, with
//     Google-Drive-style deferred sync (writes are accepted immediately and
//     pushed to the machine later).
//
// Usage (auto-discover the machine and advertise the proxy in its place):
//
//	proxy -proxy-ip 192.168.1.50 -broadcast 192.168.1.255
//
// Point at a known machine and skip discovery/advertising (e.g. loopback tests):
//
//	proxy -machine 192.168.1.42:2222 -no-advertise
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/uwin/cnc-proxy/internal/api"
	"github.com/uwin/cnc-proxy/internal/attention"
	"github.com/uwin/cnc-proxy/internal/client"
	"github.com/uwin/cnc-proxy/internal/davfs"
	"github.com/uwin/cnc-proxy/internal/discovery"
	"github.com/uwin/cnc-proxy/internal/httpauth"
	"github.com/uwin/cnc-proxy/internal/jog"
	"github.com/uwin/cnc-proxy/internal/machinetransport"
	"github.com/uwin/cnc-proxy/internal/notifications"
	"github.com/uwin/cnc-proxy/internal/proxyconfig"
	"github.com/uwin/cnc-proxy/internal/relay"
	"github.com/uwin/cnc-proxy/internal/service"
	"github.com/uwin/cnc-proxy/internal/session"
	"github.com/uwin/cnc-proxy/internal/store"
	"github.com/uwin/cnc-proxy/internal/synceng"
)

func main() {
	jogDefaults := jog.DefaultConfig()
	var (
		printConfigSchema = flag.Bool("print-config-schema", false, "print proxy flag schema as JSON and exit")
		tcpPort           = flag.Int("tcp-port", 2222, "TCP port to listen on for the controller")
		machineTransport  = flag.String("machine-transport", machinetransport.KindTCP, "machine-side transport: tcp or usb")
		machineAddr       = flag.String("machine", "", "machine TCP host or host:port (default port 2222); if empty in TCP mode, learned via UDP discovery")
		usbDevice         = flag.String("usb-device", "", "USB/serial device for -machine-transport=usb (for example /dev/cu.usbserial-...)")
		usbBaud           = flag.Int("usb-baud", 115200, "USB serial baud rate")
		usbResetOnOpen    = flag.Bool("usb-reset-on-open", false, "toggle DTR when opening the USB serial device")
		advertise         = flag.Bool("advertise", false, "re-advertise the proxy over UDP so the official controller connects through it (transparent mode)")
		proxyIP           = flag.String("proxy-ip", "", "IP the controller should connect to (this host); auto-derived if empty")
		broadcast         = flag.String("broadcast", "", "broadcast address to advertise on; auto-derived if empty")
		name              = flag.String("name", "", "advertised machine name; replaces the real name entirely (default: real name + -name-suffix)")
		nameSuffix        = flag.String("name-suffix", " (proxy)", "suffix appended to the advertised machine name when -name is not set")
		noAdvertise       = flag.Bool("no-advertise", false, "deprecated no-op; advertising is now opt-in via -advertise")
		apiAddr           = flag.String("api-addr", "127.0.0.1:8420", "address for the HTTP API + web UI")
		davAddr           = flag.String("dav-addr", "127.0.0.1:8421", "address for the WebDAV filesystem server")
		authUser          = flag.String("auth-user", "cnc", "HTTP Basic Auth username for API/WebDAV when -auth-token is set")
		authToken         = flag.String("auth-token", "", "HTTP Basic Auth token/password for API/WebDAV")
		insecureHTTP      = flag.Bool("allow-insecure-http", false, "allow API/WebDAV to bind beyond loopback without -auth-token")
		dataDir           = flag.String("data-dir", defaultDataDir(), "directory for the catalog, job queue, and file cache")
		apiUploadMB       = flag.Int64("api-max-upload-mb", 512, "maximum API/WebDAV upload body size in MiB")
		apiJSONKB         = flag.Int64("api-max-json-kb", 1024, "maximum API JSON request body size in KiB")
		apiBackupMB       = flag.Int64("api-max-backup-mb", 64, "maximum API backup import body size in MiB")
		apiReadOnly       = flag.Bool("api-read-only", false, "disable all mutating API/UI actions; keep observer views available")
		jogEnabled        = flag.Bool("jog-enabled", jogDefaults.Enabled, "enable low-latency gamepad jogging API/UI")
		jogMaxXY          = flag.Float64("jog-max-xy-mm-min", jogDefaults.MaxXYMMMin, "maximum XY jog speed in mm/min")
		jogMaxZ           = flag.Float64("jog-max-z-mm-min", jogDefaults.MaxZMMMin, "maximum Z jog speed in mm/min")
		jogTick           = flag.Duration("jog-tick", jogDefaults.Tick, "gamepad jog motion tick interval")
		jogStatus         = flag.Duration("jog-status-interval", jogDefaults.StatusInterval, "status polling interval while a jog lease is armed")
		jogDeadman        = flag.Duration("jog-deadman-timeout", jogDefaults.DeadmanTimeout, "maximum age of held-deadman gamepad input before motion stops")
		jogMotion         = flag.String("jog-motion", string(jogDefaults.MotionPrimitive), "gamepad jog motion primitive: instant or g53")
		notifyNtfyURL     = flag.String("notify-ntfy-url", "", "complete ntfy topic URL; empty disables mobile notifications")
		notifyNtfyToken   = flag.String("notify-ntfy-token", "", "optional bearer token for the ntfy topic")
		notifyMachineName = flag.String("notify-machine-name", "Makera Z1", "machine name used in mobile notifications")
		notifyDashboard   = flag.String("notify-dashboard-url", "", "authenticated controller URL opened when a notification is tapped")
		notifyResolved    = flag.Bool("notify-resolved", false, "send a follow-up when an attention state clears")
	)
	applyEnvDefaults()
	flag.Parse()
	if *printConfigSchema {
		if err := json.NewEncoder(os.Stdout).Encode(proxyconfig.Schema{Options: proxyconfig.Options()}); err != nil {
			log.Fatal(err)
		}
		return
	}

	transportKind := machinetransport.NormalizeKind(*machineTransport)
	if err := validateMachineTransport(transportKind, *usbDevice, *usbBaud, *advertise, *name); err != nil {
		log.Fatal(err)
	}
	if strings.Contains(*name, ",") || strings.Contains(*nameSuffix, ",") {
		log.Fatal("-name/-name-suffix must not contain ',' (the discovery wire format is comma-separated)")
	}
	if err := validateHTTPExposure(*apiAddr, *davAddr, *authToken, *insecureHTTP); err != nil {
		log.Fatal(err)
	}
	if *jogMotion != string(jog.MotionPrimitiveInstant) && *jogMotion != string(jog.MotionPrimitiveG53) {
		log.Fatalf("-jog-motion must be %q or %q", jog.MotionPrimitiveInstant, jog.MotionPrimitiveG53)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	_ = *noAdvertise // deprecated flag, kept so old invocations don't error

	// --- Discovery ---
	// In TCP mode, listen only when discovery is actually needed: to learn the
	// machine when -machine is omitted, or to learn its name for advertising.
	// A fixed machine with advertising disabled does not need UDP at all. This
	// also lets the proxy coexist with Studio or another listener that owns
	// udp/3333 on platforms where the port cannot be shared.
	disc := &discovery.Listener{}
	if shouldListenForDiscovery(transportKind, *machineAddr, *advertise, *name) {
		udp, err := discovery.OpenListenSocket()
		if err != nil {
			log.Fatalf("cannot bind UDP discovery port %d: %v", discovery.Port, err)
		}
		defer udp.Close()
		go disc.Listen(udp)
		log.Printf("discovery: listening on udp/%d", discovery.Port)
	} else if transportKind == machinetransport.KindUSB {
		log.Printf("discovery: machine discovery disabled in USB transport mode")
	} else if *advertise {
		log.Printf("discovery: listener disabled (fixed machine address and advertised name)")
	} else {
		log.Printf("discovery: disabled (fixed machine address and advertising off)")
	}

	dialAddr := machineDialer(*machineAddr, disc)
	machineOpen := machineOpener(transportKind, dialAddr, *usbDevice, *usbBaud, *usbResetOnOpen)
	filePacketSize := machinetransport.PacketSizeForKind(transportKind)

	stop := make(chan struct{})
	if *advertise {
		if transportKind == machinetransport.KindUSB && (*proxyIP == "" || *broadcast == "") {
			autoIP, autoBcast, derr := resolveUSBAdvertiseAddrs(*proxyIP, *broadcast)
			if derr != nil {
				log.Fatalf("discovery: cannot auto-select advertise addresses for USB mode (%v); pass -proxy-ip and -broadcast explicitly", derr)
			}
			if *proxyIP == "" {
				*proxyIP = autoIP
			}
			if *broadcast == "" {
				*broadcast = autoBcast
			}
		}
		// Transparent mode: re-advertise so the official controller connects
		// through us. Resolve the addresses to advertise; auto-derive any that
		// the user didn't pin via flags. Run in a goroutine because in pure
		// auto mode we must wait for the machine to be discovered first.
		go func() {
			pip, bcast := *proxyIP, *broadcast
			if pip == "" || bcast == "" {
				if transportKind == machinetransport.KindUSB {
					log.Printf("discovery: USB mode requires -proxy-ip and -broadcast when auto-selection is unavailable")
					return
				}
				machine := resolveMachineForAdvertise(*machineAddr, disc, stop)
				if machine == "" {
					return // shutting down before a machine appeared
				}
				autoIP, autoBcast, derr := discovery.AutoAdvertiseAddrs(machine)
				if derr != nil {
					log.Printf("discovery: cannot auto-derive advertise addresses (%v); "+
						"pass -proxy-ip and -broadcast explicitly", derr)
					return
				}
				if pip == "" {
					pip = autoIP
				}
				if bcast == "" {
					bcast = autoBcast
				}
			}
			adv := &discovery.Advertiser{Listener: disc, ProxyIP: pip, ProxyPort: *tcpPort, Name: *name, NameSuffix: *nameSuffix}
			log.Printf("discovery: advertising proxy at %s:%d on %s", pip, *tcpPort, bcast)
			if err := adv.Run(bcast, stop); err != nil {
				log.Printf("advertiser stopped: %v", err)
			}
		}()
	}

	// --- Store, arbiter, sync engine, service, API ---
	if err := os.MkdirAll(*dataDir, 0o755); err != nil {
		log.Fatalf("cannot create data dir %s: %v", *dataDir, err)
	}
	st, err := store.Open(filepath.Join(*dataDir, "state.json"))
	if err != nil {
		log.Fatalf("cannot open store: %v", err)
	}

	arb := session.New(session.Config{
		Dial: func() (*client.Conn, error) {
			opened, err := machineOpen()
			if err != nil {
				return nil, err
			}
			return client.NewTransport(opened.Conn, client.WithFilePacketSize(opened.PacketSize)), nil
		},
		FilePacketSize:            filePacketSize,
		PreserveConnOnPollTimeout: transportKind == machinetransport.KindUSB,
	})
	go arb.Poll(ctx, 5*time.Second)

	eng := synceng.New(synceng.Config{Store: st, Arbiter: arb})
	svc, err := service.New(st, arb)
	if err != nil {
		log.Fatalf("cannot create service: %v", err)
	}
	var notificationDispatcher *notifications.Dispatcher
	if strings.TrimSpace(*notifyNtfyURL) != "" {
		sender, nerr := notifications.NewNtfySender(*notifyNtfyURL, *notifyNtfyToken)
		if nerr != nil {
			log.Fatal(nerr)
		}
		notificationDispatcher, nerr = notifications.New(notifications.Config{
			Sender:       sender,
			MachineName:  *notifyMachineName,
			DashboardURL: *notifyDashboard,
			SendResolved: *notifyResolved,
		})
		if nerr != nil {
			log.Fatal(nerr)
		}
		attentionChanges, unsubscribeAttention := svc.SubscribeAttention()
		if active := svc.Attention().Active; active != nil {
			if nerr := notificationDispatcher.Handle(ctx, attention.Change{Kind: attention.ChangeOpened, Event: *active}); nerr != nil {
				log.Printf("notifications: initial ntfy delivery failed: %v", nerr)
			}
		}
		go func() {
			defer unsubscribeAttention()
			notificationDispatcher.Run(ctx, attentionChanges)
		}()
		log.Printf("notifications: ntfy enabled")
	}
	if err := eng.PrepareStartupCacheValidation(); err != nil {
		log.Fatalf("cannot prepare startup cache validation: %v", err)
	}
	go eng.RunStartupCacheValidation(ctx, 5*time.Second, 8)
	go eng.Run(ctx, 2*time.Second)
	// Periodically fold in files added/removed on the machine out-of-band.
	go eng.RunReconcile(ctx, 30*time.Second, 8)
	// Less frequently, use md5sum to catch same-size out-of-band changes.
	go eng.RunDeepReconcile(ctx, 5*time.Minute, 8)
	go svc.RunMaintenance(ctx, 10*time.Minute, 24*time.Hour, 24*time.Hour)
	go svc.RunMachineLearning(ctx)
	jogMgr := jog.New(arb, jog.Config{
		Enabled:         *jogEnabled,
		MaxXYMMMin:      *jogMaxXY,
		MaxZMMMin:       *jogMaxZ,
		Tick:            *jogTick,
		StatusInterval:  *jogStatus,
		DeadmanTimeout:  *jogDeadman,
		MotionPrimitive: jog.MotionPrimitive(*jogMotion),
		SoftLimits: func() jog.SoftLimits {
			soft := svc.UISettings().Machine.Learned.SoftEndstop
			zMax := soft.ZMax
			if zMax == 0 {
				// Profiles learned before ZMax was persisted still target the
				// same firmware, whose XYZ upper soft endpoint is fixed at -1.
				zMax = -1
			}
			return jog.SoftLimits{
				Enabled: soft.Enabled,
				XMin:    soft.XMin, XMax: soft.XMax,
				YMin: soft.YMin, YMax: soft.YMax,
				ZMin: soft.ZMin, ZMax: zMax,
			}
		},
		Log: svc.GcodeLog(),
	})

	authCfg := httpauth.Config{User: *authUser, Token: *authToken}
	apiAuthCfg := authCfg
	apiAuthCfg.SuppressAPIChallenge = true
	apiSrv := hardenedAPIServer(*apiAddr, httpauth.Middleware(apiAuthCfg, api.NewWithOptions(svc, api.Options{
		Jog:            jogMgr,
		MaxUploadBytes: mib(*apiUploadMB),
		MaxJSONBytes:   kib(*apiJSONKB),
		MaxBackupBytes: mib(*apiBackupMB),
		Notifications:  notificationDispatcher,
		ReadOnly:       *apiReadOnly,
	}).Handler()))
	go func() {
		log.Printf("api: listening on %s", *apiAddr)
		if err := apiSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("api: %v", err)
		}
	}()

	davSrv := hardenedDAVServer(*davAddr, httpauth.Middleware(authCfg, limitRequestBody(mib(*apiUploadMB), davfs.NewWithOptions(svc, davfs.Options{
		MovementDisarmer: jogMgr,
	}).Handler(""))))
	go func() {
		log.Printf("webdav: listening on %s (mount this address)", *davAddr)
		if err := davSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("webdav: %v", err)
		}
	}()

	// --- Relay (with arbiter as observer + injection source) ---
	relaySrv := &relay.Server{
		Dial:          dialAddr,
		MachineDial:   machineOpen,
		Observer:      arb,
		DownloadCache: svc,
		// Sniff the controller's gcode/console traffic into the shared log the
		// API streams to web clients (read-only; frames are never altered).
		GcodeLog: svc.GcodeLog(),
	}
	// Let owner-mode operations (sync engine, API) inject onto the controller's
	// shared connection during relay mode, between the controller's transactions.
	arb.SetInjector(injectorAdapter{relaySrv})
	// And let realtime control (feed-hold/resume/halt) reach the machine
	// out-of-band during relay mode, so an emergency halt works even mid-program.
	arb.SetControlWriter(relaySrv)
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", *tcpPort))
	if err != nil {
		log.Fatalf("cannot listen on tcp/%d: %v", *tcpPort, err)
	}
	log.Printf("relay: listening on tcp/%d", *tcpPort)

	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig
		log.Print("shutting down")
		cancel()
		close(stop)
		shutdownCtx, c := context.WithTimeout(context.Background(), 3*time.Second)
		defer c()
		apiSrv.Shutdown(shutdownCtx)
		davSrv.Shutdown(shutdownCtx)
		ln.Close()
	}()

	if err := relaySrv.Serve(ln); err != nil {
		log.Fatalf("relay: %v", err)
	}
}

// resolveMachineForAdvertise returns the machine IP the advertiser should route
// toward for auto-deriving its own addresses. If fixed (-machine) is set it is
// used directly; otherwise it waits for discovery to learn a machine, polling
// until one appears or stop is closed (returns "" on shutdown).
func resolveMachineForAdvertise(fixed string, l *discovery.Listener, stop <-chan struct{}) string {
	if fixed != "" {
		return fixed
	}
	t := time.NewTicker(500 * time.Millisecond)
	defer t.Stop()
	for {
		if m, ok := l.Latest(); ok {
			return m.IP
		}
		select {
		case <-stop:
			return ""
		case <-t.C:
		}
	}
}

// machineDialer resolves the machine address: a fixed address if provided,
// otherwise the most recently discovered machine.
func machineDialer(fixed string, l *discovery.Listener) func() (string, error) {
	return func() (string, error) {
		if fixed != "" {
			return fixed, nil
		}
		m, ok := l.Latest()
		if !ok {
			return "", errors.New("no machine discovered yet")
		}
		return net.JoinHostPort(m.IP, strconv.Itoa(m.Port)), nil
	}
}

func machineOpener(kind string, tcpAddr func() (string, error), usbDevice string, usbBaud int, usbResetOnOpen bool) func() (*machinetransport.Opened, error) {
	return func() (*machinetransport.Opened, error) {
		return machinetransport.Open(machinetransport.Config{
			Kind:           kind,
			TCPAddr:        tcpAddr,
			USBDevice:      usbDevice,
			USBBaud:        usbBaud,
			USBResetOnOpen: usbResetOnOpen,
			DialTimeout:    5 * time.Second,
		})
	}
}

func validateMachineTransport(kind, usbDevice string, usbBaud int, advertise bool, name string) error {
	kind = machinetransport.NormalizeKind(kind)
	if err := machinetransport.ValidateKind(kind); err != nil {
		return err
	}
	if kind != machinetransport.KindUSB {
		return nil
	}
	if usbDevice == "" {
		return errors.New("-usb-device is required when -machine-transport=usb")
	}
	if usbBaud <= 0 {
		return errors.New("-usb-baud must be positive")
	}
	if advertise && strings.TrimSpace(name) == "" {
		return errors.New("-name is required with -advertise when -machine-transport=usb")
	}
	return nil
}

func shouldListenForDiscovery(kind, machineAddr string, advertise bool, advertisedName string) bool {
	if kind != machinetransport.KindTCP {
		return false
	}
	if strings.TrimSpace(machineAddr) == "" {
		return true
	}
	// With a known machine and explicit advertised name, discovery is not
	// needed. This is essential on Windows, where Makera Studio owns UDP/3333
	// exclusively and a native proxy cannot bind it alongside the controller.
	return advertise && strings.TrimSpace(advertisedName) == ""
}

func resolveUSBAdvertiseAddrs(proxyIP, broadcast string) (string, string, error) {
	if proxyIP != "" && broadcast != "" {
		return proxyIP, broadcast, nil
	}
	if proxyIP != "" {
		ip := net.ParseIP(proxyIP)
		if ip == nil {
			return "", "", fmt.Errorf("invalid -proxy-ip %q", proxyIP)
		}
		b, err := discovery.BroadcastFor(ip)
		if err != nil {
			return "", "", err
		}
		return proxyIP, b.String(), nil
	}
	autoIP, autoBcast, err := discovery.SingleActiveLANAdvertiseAddrs()
	if err != nil {
		return "", "", err
	}
	if broadcast != "" {
		autoBcast = broadcast
	}
	return autoIP, autoBcast, nil
}

func validateHTTPExposure(apiAddr, davAddr, authToken string, allowInsecure bool) error {
	if authToken != "" || allowInsecure {
		return nil
	}
	if !isLoopbackBind(apiAddr) || !isLoopbackBind(davAddr) {
		return errors.New("api/webdav bind beyond loopback requires -auth-token (or explicit -allow-insecure-http)")
	}
	return nil
}

func isLoopbackBind(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if host == "localhost" {
		return true
	}
	if host == "" {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func hardenedAPIServer(addr string, h http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           h,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Minute,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
}

func hardenedDAVServer(addr string, h http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           h,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Minute,
		WriteTimeout:      15 * time.Minute,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
}

func limitRequestBody(max int64, next http.Handler) http.Handler {
	if max <= 0 {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, max)
		next.ServeHTTP(w, r)
	})
}

func mib(v int64) int64 {
	if v <= 0 {
		return 0
	}
	return v << 20
}

func kib(v int64) int64 {
	if v <= 0 {
		return 0
	}
	return v << 10
}

// injectorAdapter bridges *relay.Server to session.Injector. The two packages
// declare structurally identical injector interfaces but can't import each
// other's types without a cycle, so this thin adapter converts the result.
type injectorAdapter struct{ srv *relay.Server }

func (a injectorAdapter) AcquireMachine() (session.InjectTransport, func(), error) {
	it, release, err := a.srv.AcquireMachine()
	if err != nil {
		return nil, nil, err
	}
	return it, release, nil
}

func (a injectorAdapter) AcquireInteractive() (session.InjectTransport, <-chan struct{}, func(), error) {
	it, abort, release, err := a.srv.AcquireInteractive()
	if err != nil {
		return nil, nil, nil, err
	}
	return it, abort, release, nil
}

// applyEnvDefaults lets every flag be set through the environment as
// CNC_<NAME> with '-' mapped to '_' (e.g. CNC_TCP_PORT=2222, CNC_NAME=Shop,
// CNC_ADVERTISE=true). Explicit command-line flags still win, since this runs
// before flag.Parse and only adjusts defaults. This is the natural interface
// for container deployments, where flags are awkward to override per-site.
func applyEnvDefaults() {
	flag.VisitAll(func(f *flag.Flag) {
		env := "CNC_" + strings.ToUpper(strings.ReplaceAll(f.Name, "-", "_"))
		if v, ok := os.LookupEnv(env); ok {
			if err := f.Value.Set(v); err != nil {
				log.Fatalf("invalid %s=%q: %v", env, v, err)
			}
		}
	})
}

func defaultDataDir() string {
	if home, err := os.UserConfigDir(); err == nil {
		return filepath.Join(home, "cnc-proxy")
	}
	return ".cnc-proxy"
}
