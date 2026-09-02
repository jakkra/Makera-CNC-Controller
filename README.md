# CNC Proxy

A companion service for the Makera Carvera CNC. It sits between the official
controller and the machine firmware and adds a file-handling API, a web UI, and
a mountable WebDAV filesystem — without modifying the controller or firmware.

## What it does

- **Transparent relay (TCP 2222):** forwards the official controller to the
  machine byte-for-byte over either TCP/WiFi or USB/FTDI on the machine side,
  and answers UDP discovery so the controller finds the proxy. Frames are
  observed (for machine state) but never altered, so the CRCs the controller
  validates stay intact.
- **Owns the machine when idle:** the firmware is single-conversation, so the
  proxy holds the connection only when no controller is attached. It polls
  status and runs queued file operations while the machine is `Idle`.
- **File-handling API + web UI (HTTP):** upload, list, delete, rename, with
  Google-Drive-style deferred sync — writes are accepted immediately and pushed
  to the machine later, when it's reachable and idle. Live status, sync jobs,
  gcode I/O, observed run history, backup/import, and operator diagnostics are
  shown through the operational web UI and SSE stream.
- **WebDAV filesystem (HTTP):** mount the machine's gcode directory natively on
  macOS/Windows/Linux. No driver install, nothing to sign — the OS's built-in
  WebDAV client connects to the server the proxy runs.

## Architecture

```
controller ──TCP 2222──▶ relay ──TCP/USB──▶ machine   (relay mode: controller present)
                          │
CAD app ──WebDAV──▶ davfs ─┤
browser ──HTTP───▶ api  ───┤
                          ▼
                  service ──▶ store (catalog + durable job queue)
                          ▲          │
                          │          ▼
                     sync engine ──▶ arbiter ──TCP/USB──▶ machine   (owner mode: no controller)
```

The **arbiter** enforces the single-conversation rule: at most one of
{controller, sync engine} talks to the machine. The **store** persists the
catalog and job queue, so pending uploads survive restarts and offline periods.
The **sync engine** drains the queue only in owner mode while the machine is
`Idle`.

### Packages

| Package | Role |
|---------|------|
| `internal/protocol` | Wire frames (CRC16-CCITT), commands, ls/md5 parsing |
| `internal/machinetransport` | Machine-side TCP or USB/serial transport opener |
| `internal/client` | Owner-mode machine connection: ls/rm/mv/mkdir/md5/ftype + upload & download handshakes |
| `internal/machine` | Run-state (`Idle`/`Run`/…) parsing and tracking |
| `internal/discovery` | UDP discovery listen + re-advertise |
| `internal/relay` | Byte-transparent TCP relay, single session |
| `internal/session` | Arbiter: relay vs owner mode, idle gating |
| `internal/gcodelog` | Bounded in-memory log of observed controller/API/jog gcode I/O |
| `internal/runhistory` | Observed run summaries derived from status and gcode log signals |
| `internal/store` | Durable catalog + job queue (atomic JSON) |
| `internal/synceng` | Deferred-sync loop with backoff; periodic reconcile sweep |
| `internal/quicklz` | QuickLZ 1.5.0 level-3 port (compress/decompress + `.lz` framing) |
| `internal/service` | App core shared by API and WebDAV; download-on-demand |
| `internal/api` | HTTP REST + SSE + embedded web UI |
| `internal/davfs` | WebDAV `FileSystem` over the service |
| `internal/apiclient` | Small HTTP client for the API, used by the tray app |
| `internal/carveratest` | Fake machine for tests (and `cmd/fakemachine`) |

Commands: `cmd/proxy` (the service), `cmd/fakemachine` (test machine),
`cmd/discoverybeacon` (native UDP discovery announcer + machine bridge for
Docker Desktop deployments), and `cmd/tray` (status companion: a dependency-free
status CLI by default, or a native menu-bar app with `-tags tray`).

## Source checkout

The Makera controller and firmware are read-only reference sources linked as
Git submodules. Clone with their pinned revisions:

```sh
git clone --recurse-submodules <repository-url>
```

For an existing checkout, run `git submodule update --init --recursive`.

## Build

```sh
go build -mod=mod -o cnc-proxy ./cmd/proxy
go build -mod=mod -o discoverybeacon ./cmd/discoverybeacon
go build -mod=mod -o deploy ./cmd/deploy
go build -mod=mod -tags tray -o cnc-tray ./cmd/tray
```

(`-mod=mod` is needed because the vendored Makera suite lives in `vendor/`,
which otherwise triggers Go's vendoring mode.)

## Run

The simplest form takes no addresses at all — the proxy finds the machine on
the LAN via UDP discovery and serves the API + WebDAV mount on loopback only:

```sh
./cnc-proxy
```

To put the proxy in front of the official controller (transparent mode), add
`-advertise`. It re-advertises itself so the controller connects through it,
auto-deriving this host's IP and the subnet broadcast from the discovered
machine — no address flags needed:

```sh
./cnc-proxy -advertise
```

You can still pin any address explicitly (e.g. a fixed machine, or to override
the auto-derived advertise addresses on a multi-homed host):

```sh
./cnc-proxy -machine 192.168.1.42:2222 -advertise \
  -proxy-ip 192.168.1.50 -broadcast 192.168.1.255
```

To connect the proxy to the machine over USB/FTDI while keeping the official
controller connected to the proxy over TCP/WiFi, run the proxy natively and
select USB as the machine-side transport:

```sh
./cnc-proxy -machine-transport=usb -usb-device /dev/cu.usbserial-XXXX \
  -advertise -name "Shop CNC"
```

USB mode uses the same framed Carvera protocol at 115200 8N1, no flow control,
and 128-byte file packets. DTR reset is off by default; pass
`-usb-reset-on-open` only when you explicitly want the controller-style DTR
toggle. With `-advertise`, USB mode requires `-name`; if this host has multiple
active LAN/VPN interfaces, also pass `-proxy-ip` and `-broadcast` explicitly.

Loopback testing against the bundled fake machine:

```sh
# terminal 1: a fake machine
go run -mod=mod ./cmd/fakemachine -addr 127.0.0.1:12222

# terminal 2: the proxy (fixed machine, no advertising)
./cnc-proxy -machine 127.0.0.1:12222 \
  -tcp-port 12200 -api-addr 127.0.0.1:8420 -dav-addr 127.0.0.1:8421
```

Then:
- Web UI: <http://127.0.0.1:8420/>
- Direct dashboard URL: <http://127.0.0.1:8420/dashboard>
- Recording/OBS dashboard: see [Recording dashboard](docs/recording-dashboard.md)
  for durable named layouts, profile URLs, transparent embed mode, optional
  machine telemetry, and bounded G-code streaming.
- API: `POST /api/files?path=part.nc` (raw body or multipart), `GET /api/files`,
  `DELETE /api/files/{path}`, `POST /api/files/rename`, `GET /api/machine`,
  `GET /api/machine/status`, `GET /api/jobs`, `GET /api/runs`,
  `GET /api/attention`, `GET /api/notifications`,
  `POST /api/notifications/test`,
  `POST /api/gcode` (body
  `{"line":"G0 X10"}`), `POST /api/control` (body
  `{"action":"hold|resume|halt|recover|unlock|home|reset"}`), `GET /api/gcode/log` (recent gcode I/O),
  `GET /api/backup`, `POST /api/backup/import`,
  `GET /api/events` (SSE: catalog/job changes plus all gcode I/O — both
  API-submitted and controller traffic observed by the relay; optional
  `?scope=control` omits catalog/jobs and `?scope=files` omits gcode),
  `GET|PUT /api/ui/settings` (durable web UI macros/dashboard/log/gamepad preferences),
  `GET /api/jog/capabilities`, and authenticated `GET /api/jog/ws` WebSocket
  for low-latency gamepad jogging.
  - **Home Assistant and automation:** use the existing JSON machine snapshot
    and realtime control API. See [Home Assistant and automation API](docs/home-assistant.md)
    for a complete authenticated REST sensor and halt-command configuration.
  - **Injecting gcode** works whether the proxy runs alone (owner mode) or with
    the official controller attached (relay mode — injected between the
    controller's transactions). Read-only queries (`M114`, `M115`, `version`,
    `$G`, …) run any time; motion and other state-changing commands require the
    machine to be Idle and return **503** while a program runs, so the proxy can
    never disturb a controller-driven job. Realtime control (`hold`/`resume`/
    `halt`) is out-of-band and always works, even mid-move — use `halt` as an
    emergency stop.
  - **Gamepad jogging** uses the firmware `$J` instant-jog command by default
    for short server-generated XYZ deltas without touching modal distance state;
    `-jog-motion=g53` keeps the older `G53 G0` machine-coordinate fallback. It
    requires the web UI to be armed and a held gamepad deadman button. In relay
    mode, jog motion is allowed only while the official controller is connected
    but the machine is freshly Idle; controller jobs, file transfers,
    unknown/stale state, or controller traffic abort/reject jogging. Realtime
    `halt` remains out-of-band.
    WebSocket client messages are `arm`, `input`, `control`, and `disarm`:
    `{"type":"input","seq":2,"deadman":true,"axes":{"x":0,"y":0,"z":0},"slow":false}`.
    Server messages are `hello`, `state`, `status`, `motion`, `ack`, and
    `error`; stable error codes include `disabled`, `not_idle`, `busy`,
    `stale_status`, `bad_input`, `controller_waiting`, `machine_error`, and
    `unauthorized`. Jog motion is attributed as source `jog` in the gcode log
    at a rate-limited cadence so the operator can audit motion without flooding
    the live console. The web UI persists gamepad axis mapping, inversion,
    client-side speed scaling, deadman/slow buttons, and gamepad macro-button
    bindings through `/api/ui/settings`; these mappings reduce the normalized
    input before it reaches the jog WebSocket and cannot raise the server's
    configured jog speed limits.
  - **Gcode macros** are stored server-side in the proxy data store via
    `/api/ui/settings`, including macro lines, button placement, gamepad button
    bindings, and log preferences. Macro buttons execute through the same
    `/api/gcode` endpoint as manual console input, so existing idle gating and
    relay safety behavior still apply.
  - **Run history** is derived from status frames and the shared gcode log; it
    does not poll the machine or alter controller traffic. Entries include the
    best observed file hint, source, start/end time, state transitions, alarms,
    halt reason, progress, feed/spindle override changes, and a bounded command
    trail. The history is intentionally best-effort: a controller can start a
    job without sending a filename-bearing command through the proxy.
  - **Backup/export/import** covers the durable `state.json` model (catalog,
    queue, macros, macro buttons, log preferences, and gamepad mappings), plus
    retained gcode log lines and run history. It is local proxy state only;
    importing a backup does not talk to the machine by itself.
- WebDAV mount: macOS Finder → Go → Connect to Server → `http://127.0.0.1:8421/`;
  Windows → Map network drive; Linux → `davs?://…` in the file manager.

API and WebDAV are unauthenticated only when both bind to loopback addresses.
If either is bound to a wildcard or LAN address, set `-auth-token` (Basic Auth
password; default user `cnc`) or explicitly pass `-allow-insecure-http`.

### Flags

| Flag | Default | Purpose |
|------|---------|---------|
| `-tcp-port` | 2222 | port the relay listens on for the controller |
| `-machine-transport` | `tcp` | machine-side transport: `tcp` or `usb` |
| `-machine` | (discover) | fixed machine TCP `host:port`; empty = learn via UDP in TCP mode |
| `-camera-builtin-ws-url` | auto from fixed `-machine` | Z1 camera WebSocket; normally `ws://<z1>:82/ws_video` |
| `-camera-external-url` | (empty) | fixed HTTP(S) MJPEG or snapshot URL for an external camera service |
| `-camera-external-mode` | `mjpeg` | `mjpeg` keeps one continuous stream; `snapshot` reloads a still image periodically |
| `-usb-device` | (empty) | USB/serial device for `-machine-transport=usb` |
| `-usb-baud` | 115200 | USB serial baud rate |
| `-usb-reset-on-open` | false | toggle DTR when opening the USB serial device |
| `-advertise` | false | transparent mode: re-advertise so the controller connects through the proxy |
| `-proxy-ip` | (auto) | IP the controller should connect to; auto-derived if empty |
| `-broadcast` | (auto) | broadcast (or unicast) address to advertise on; auto-derived if empty |
| `-name` | (empty) | advertised machine name; replaces the real name entirely |
| `-name-suffix` | ` (proxy)` | suffix on the advertised machine name when `-name` is not set |
| `-api-addr` | `127.0.0.1:8420` | HTTP API + web UI address |
| `-dav-addr` | `127.0.0.1:8421` | WebDAV server address |
| `-auth-user` | `cnc` | HTTP Basic Auth username for API/WebDAV when `-auth-token` is set |
| `-auth-token` | (empty) | HTTP Basic Auth token/password for API/WebDAV |
| `-allow-insecure-http` | false | allow API/WebDAV to bind beyond loopback without auth |
| `-data-dir` | OS config dir | catalog, job queue, and file cache |
| `-api-max-upload-mb` | 512 | maximum API/WebDAV upload request body size |
| `-api-max-json-kb` | 1024 | maximum JSON request body size for API mutations |
| `-api-max-backup-mb` | 64 | maximum backup import request body size |
| `-jog-enabled` | true | enable low-latency gamepad jogging API/UI |
| `-jog-max-xy-mm-min` | 1200 | maximum XY jog speed in mm/min |
| `-jog-max-z-mm-min` | 300 | maximum Z jog speed in mm/min |
| `-jog-tick` | 50ms | gamepad jog motion tick interval |
| `-jog-status-interval` | 100ms | status polling interval while a jog lease is armed |
| `-jog-deadman-timeout` | 150ms | maximum age of held-deadman input before motion stops |
| `-jog-motion` | instant | gamepad jog motion primitive: `instant` (`$J`) or `g53` |
| `-notify-ntfy-url` | (empty) | complete ntfy topic URL; empty disables mobile notifications |
| `-notify-ntfy-token` | (empty) | optional bearer token for a protected ntfy topic |
| `-notify-machine-name` | `Makera Z1` | machine name used in mobile notifications |
| `-notify-dashboard-url` | (empty) | authenticated controller/Tailscale URL opened when a notification is tapped |
| `-notify-resolved` | `false` | also notify when an attention state clears |

(`-no-advertise` still exists as a deprecated no-op so older invocations don't
break; advertising is now opt-in via `-advertise`.)

The dashboard consumes both cameras through same-origin proxy routes, so a
Tailscale/HTTPS client never has to reach a workshop-LAN camera directly. The
built-in Z1 source is derived automatically when `-machine` is fixed. A UVC
camera still needs a local Linux streaming service (for example an MJPEG URL),
whose fixed URL is supplied with `-camera-external-url`. Camera connections are
opened only while the Overview is visible; unavailable sources stay inline as
honest offline/unconfigured states instead of producing global error pop-ups.

Every flag can also be set through the environment as `CNC_<NAME>` with `-`
mapped to `_` (e.g. `CNC_MACHINE=192.168.1.42:2222`, `CNC_NAME="Shop CNC"`,
`CNC_AUTH_TOKEN=...`, `CNC_ADVERTISE=true`). Explicit command-line flags win
over the environment.

### Mobile attention notifications (ntfy)

The proxy derives a single attention episode from firmware `Tool`, `Wait`,
`Pause`, `Hold`, and `Alarm` transitions. Repeated status polls are deduplicated,
and the Z1 firmware's normal `Wait` → `Pause` sequence for `M600` remains one
episode. Generated G-code may include a validated `@z1-attention` marker before
`M600`; when the active cached file contains one, the event and notification can
identify the intended A-axis target instead of reporting a generic pause.

Notification delivery is disabled unless a complete ntfy topic URL is supplied:

```sh
./cnc-proxy \
  -notify-ntfy-url https://ntfy.example.net/private-z1-topic \
  -notify-ntfy-token 'replace-with-a-topic-token' \
  -notify-machine-name 'Workshop Z1' \
  -notify-dashboard-url 'http://z1-controller.your-tailnet.ts.net:8420/'
```

The sender uses ntfy's documented POST headers for title, priority, tags, click
URL, sequence ID, and optional bearer authentication. It deliberately sends no
HTTP action button that could start, resume, or move the machine. Keep the click
URL behind Tailscale/authentication. Alarm messages use maximum priority. Other
operator-attention messages use default priority for a shorter vibration and no
high-priority pop-over. Intermediate tool-unload events targeting T0 are
filtered; the following requested-tool event is still delivered.

`GET /api/attention` returns the active attention event plus bounded history.
`GET /api/notifications` returns provider state and delivery history, including
failed attempts. `POST /api/notifications/test` performs one real provider test
and returns success only after ntfy accepts it. The test endpoint does not touch
the CNC.

## Windows Tray Manager

Build the tray app with `-tags tray`. On Windows it runs from the system tray,
serves a local manager UI, can supervise/restart `cnc-proxy`, and can receive
authenticated notification/deployment requests:

```sh
go build -mod=mod -tags tray -o cnc-tray.exe ./cmd/tray
cnc-tray.exe
```

The manager UI defaults to `http://127.0.0.1:8430/`. It stores config in the OS
user config directory and keeps manager settings separate from proxy settings.
For remote access, set a manager token before binding beyond loopback; remote
manager binds without a token are rejected. When bound to `0.0.0.0`, the manager
UI shows the concrete LAN URLs to try; if those URLs fail from another computer,
check the Windows Firewall inbound rule for `cnc-tray.exe` or the selected TCP
port.

Tray manager endpoints:

- `PUT /api/manager/config` updates manager settings and restarts the manager HTTP listener.
- `PUT /api/proxy/config` updates proxy flags without changing manager settings.
- `POST /api/manager/restart` restarts only the manager HTTP listener inside the tray app.
- `POST /api/notify` with JSON `{"title":"CNC Proxy","message":"...","level":"info|warning|error"}` shows a tray/Windows notification.
- `POST /api/proxy/start|stop|restart|build` controls the supervised proxy.
- `POST /api/deploy` accepts a source zip, builds in `source_dir`, and restarts the proxy unless `?restart=false`. Add `?component=manager` to upgrade only the tray manager app, or `?component=all` to build both proxy and manager.

Send deployments from a development machine with:

```sh
go build -mod=mod -o deploy ./cmd/deploy
deploy -target http://192.168.1.50:8430 -token "$CNC_TRAY_TOKEN" -source .
```

To deploy source and upgrade the tray manager app in the same pass:

```sh
deploy -target http://192.168.1.50:8430 -token "$CNC_TRAY_TOKEN" -source . -component all
```

### Build A Windows Installer From macOS

The tray app uses cgo, so building the Windows tray binary from macOS needs a
Windows C toolchain. The repo includes a Docker-based builder with MinGW:

```sh
scripts/build-windows-installer.sh
```

Artifacts are written to `dist/windows/`:

- `cnc-proxy-installer.exe` — self-contained installer to run on the target PC.
- `cnc-proxy-installer-stub.exe` — installer without the appended payload.
- `cnc-proxy-windows-payload.zip` — raw payload containing `cnc-tray.exe`, `cnc-proxy.exe`, and `deploy.exe`.
- `payload/` — unpacked Windows binaries.

On the target PC, run:

```powershell
.\cnc-proxy-installer.exe -remote
```

`-remote` binds the tray manager to `0.0.0.0:8430` and generates a manager token
if one is not supplied with `-manager-token`. `-admin-token` remains as a
deprecated alias. Keep that token; remote deploys use it:

```sh
deploy -target http://<target-ip>:8430 -token "<printed-token>" -source .
```

The installer includes the initial Windows `cnc-proxy.exe` and `cnc-tray.exe`.
Later source-code deployments run the tray manager's `build_command` on the
target PC for `cnc-proxy.exe`, so the target must have Go available in `PATH`
unless you change the manager build command to a site-specific updater.

Remote source deployments can also replace the tray manager that receives the
deployment. Use `deploy ... -component all` to build both binaries, or
`deploy ... -manager` as a shortcut. Use `deploy ... -component manager` /
`-manager-only` to upgrade only `cnc-tray.exe`.
Source updates are mirrored into the configured source directory without
renaming that directory or retaining source backups. Deploys are serialized,
retry transient Windows sharing violations, and remove stale deploy staging,
previous-binary, and legacy source-backup artifacts on the next deployment.
The manager build uses `go build -mod=mod -tags tray ./cmd/tray` on the target
PC, so Windows targets also need whatever local Go/cgo toolchain is required to
build the tray app. The running tray app launches the staged new binary as a
finalizer, exits, and the finalizer replaces and relaunches the installed tray
app after Windows releases the old executable.

The manager-owned Windows proxy build is staged beside the installed binary,
then promoted after a successful compile. It also builds the proxy with the
Windows GUI subsystem so the supervised background process does not open a
console window. Custom build commands remain custom and are run as supplied.

## Run in Docker

The recommended deployment is Docker on the same computer that runs the
official Carvera Controller. Docker deployments use TCP/WiFi machine access;
USB/FTDI machine access is native-host only for now:

```sh
CNC_MACHINE=192.168.1.42:2222 CNC_NAME="Shop CNC" CNC_AUTH_TOKEN="$(openssl rand -hex 24)" docker compose up -d
```

Then the controller (on the same computer) sees `Shop CNC` in its machine list
and connects through the proxy at `127.0.0.1:2222`. Web UI at
<http://127.0.0.1:8420/>, WebDAV mount at `http://127.0.0.1:8421/`. Use Basic
Auth user `cnc` and the `CNC_AUTH_TOKEN` value. State persists in the
`cnc-data` volume across restarts.

Two LAN realities shape the container configuration (already encoded in
`docker-compose.yml`):

- **Discovery doesn't reach the container.** The machine's UDP broadcasts
  don't traverse Docker's NAT. Either pin `CNC_MACHINE` to the machine's
  `ip:port`, or run the native discovery beacon below and point `CNC_MACHINE`
  at the beacon's local bridge.
- **Advertising is unicast to the host.** The container can't usefully
  broadcast to the LAN either, so it sends the discovery record straight to
  `host.docker.internal` — the controller listening on UDP 3333 on the same
  computer receives it. `CNC_NAME` is required here: without the machine's
  broadcasts the proxy never learns the real name to derive one from.
  Controllers on *other* computers won't see this in-container advertisement;
  without the native beacon below, they'd keep connecting to the machine
  directly (which then refuses the proxy's relay — one client at a time).

A side benefit of the container's own network namespace: the proxy's UDP 3333
listener can't collide with the controller's, which it would when both run
natively on the same host (the controller binds without `SO_REUSEPORT`).

To make a Docker Desktop proxy discover the real CNC and become visible to
controllers on other computers, run the native discovery beacon on the host
while compose is up. In discovery mode it binds UDP 3333, learns the real
machine from its broadcasts, opens a local TCP bridge for the Docker proxy, and
broadcasts discovery records pointing controllers at the host's Docker-published
relay port. Disable the container's host-only announcer so the native beacon is
the only discovery advertisement:

```sh
CNC_ADVERTISE=false CNC_MACHINE=host.docker.internal:12222 CNC_NAME="Shop CNC" CNC_AUTH_TOKEN="$(openssl rand -hex 24)" docker compose up -d
go build -mod=mod -o discoverybeacon ./cmd/discoverybeacon
CNC_NAME="Shop CNC" ./discoverybeacon
```

The proxy dials `host.docker.internal:12222`; the native beacon forwards that
TCP stream to the latest discovered real machine. The advertised record is
`CNC_NAME,<host-lan-ip>,2222,0`, so controllers connect to the proxy at the
host's LAN IP instead of the real machine. If the host has multiple LAN/VPN
interfaces, pin the addresses explicitly:

```sh
./discoverybeacon -name "Shop CNC" \
  -proxy-ip 192.168.1.50 -broadcast 192.168.1.255 -proxy-port 2222
```

If the real machine IP is already known, the beacon can skip UDP discovery and
act as an announce-and-bridge helper:

```sh
./discoverybeacon -name "Shop CNC" -machine 192.168.1.42:2222
```

Discovery mode cannot run beside a same-host official controller that already
owns UDP 3333. In that case, either use the fixed `-machine` form above or run
the discovery beacon on a different LAN host.

The compose file binds API/WebDAV to host loopback (`127.0.0.1`) while the
container itself listens on `0.0.0.0` so Docker port publishing works. Publishing
those ports on the LAN requires keeping `CNC_AUTH_TOKEN` set.

## Sync states

Each file carries a sync state shown in the web UI: `synced`, `pending_upload`,
`uploading`, `pending_delete`, `deleting`, `pending_rename`, `remote_only`,
`error`. A write lands as `pending_upload` and becomes `synced` once the machine
confirms the MD5.

## Security, diagnostics, and maintenance

- HTTP servers set header/body timeouts, header-size limits, and configurable
  request body caps. API and WebDAV upload limits share `-api-max-upload-mb`;
  JSON mutations use `-api-max-json-kb`; backup imports use
  `-api-max-backup-mb`.
- Browser-originated machine-action requests are rejected unless their
  `Origin`/`Referer` matches the API host. This covers file mutations, gcode,
  realtime/recovery control, UI settings writes, backup import, and the jog
  WebSocket while still allowing non-browser API clients without origin headers.
- `GET /api/jobs` includes transient `blocked_reason`, `blocked_message`, and
  `blocked_until` diagnostics so operators can see whether a job is waiting on
  stale status, non-Idle machine state, controller relay mode, retry backoff, or
  a previous failure.
- A background maintenance pass prunes completed jobs older than 24 hours and
  removes old unreferenced cache files. Catalog entries and non-completed jobs
  keep their referenced cache files pinned.

## Test

```sh
go test -mod=mod ./...
```

The `internal/carveratest` fake machine emulates the firmware's framed protocol
(management commands + upload/download handshakes + QuickLZ `.lz` handling), so
the client, arbiter, sync engine, API, and WebDAV layers are exercised
end-to-end without hardware.

The QuickLZ port is cross-validated byte-for-byte against the actual firmware C
implementation via a cgo test:

```sh
CGO_ENABLED=1 go test -mod=mod -tags cgo_compat ./internal/quicklz/
```

## Download-on-demand, reconcile, and compression

- **Download-on-demand:** reading a `remote_only` file (known on the machine but
  not cached) fetches it through the arbiter and caches it. If the machine sent
  a compressed `.lz` sidecar, it is decompressed transparently (detected by
  comparing against the machine-reported uncompressed MD5).
- **Reconcile sweep:** every 30s in owner mode while idle, the engine walks the
  machine's gcode tree and folds in files added/removed out-of-band (e.g. by the
  controller), without disturbing in-flight local changes. A slower deep
  reconcile periodically uses `md5sum` on cached synced files to catch same-size
  out-of-band edits.
- **Upload compression:** uploads larger than 4 KB are QuickLZ-compressed when
  the firmware advertises `.lz` support (`ftype`), cutting transfer size. The
  MD5 sent and verified is always of the uncompressed content.

## Status & limitations

- **Native badges:** intentionally not provided. Finder/Explorer overlay badges
  require code signing on macOS, which is ruled out. Sync status lives in the
  web UI and the menu-bar/tray companion (`cmd/tray`) instead.
- **Real-hardware validation:** the protocol and sync flow are verified against
  the fake machine and (for QuickLZ) the firmware C code. Real releases should
  also run the hardware validation runbook in `docs/hardware-validation.md`.

## Next steps

- Run `docs/hardware-validation.md` against a real Carvera + the official
  controller before tagging production releases.
