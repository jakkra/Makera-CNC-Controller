# Target-computer development and deployment

This guide applies to a native Linux computer that runs the Sensei controller.
It is intentionally separate from the generic Docker and Windows deployment
instructions in the README.

## What is local and what is remote

Development is performed **on the target computer**, normally through SSH.
Therefore, “local” in the commands below means local to that computer—not the
developer's laptop and not the CNC.

| System | Role |
|---|---|
| Target computer | Source worktree, Go build host, Sensei runtime, optional camera host and kiosk |
| CNC | Physical machine reached by the proxy; never modify its firmware |
| Git `origin` | The source-control remote configured for the clone; inspect it with `git remote -v` |

The examples use this conventional worktree path; choose another path if the
target installation requires it:

```text
~/src/Makera-CNC-Controller
```

The controller web UI is available locally at `http://127.0.0.1:8420/` when
the default native configuration is used. Network exposure and authentication
are deployment-specific and are not part of this guide.

## Daily development workflow

```sh
cd ~/src/Makera-CNC-Controller
git status
git switch codex/sensei-controller
```

Make and test focused changes in this worktree. Go commands must always use
`-mod=mod`; `vendor/` contains read-only Makera reference sources, not Go
dependencies.

```sh
# Frontend unit tests for a focused UI change.
node --test internal/api/web/app.test.mjs

# Focused Go package test.
/usr/local/go/bin/go test -mod=mod ./internal/service

# Release/checkpoint verification.
/usr/local/go/bin/go test -mod=mod -race ./...
/usr/local/go/bin/go vet -mod=mod ./...
```

The full race suite is deliberately reserved for a release checkpoint or
protocol/concurrency work: it can be slow on a small target computer. Do not
run an ad-hoc development proxy on port 8420 while the installed service owns
that port.

## Commit and push

Use the branch agreed for the installation; the examples use
`codex/sensei-controller`.

```sh
git add <changed-files>
git commit -m "concise change summary"
git push origin codex/sensei-controller
```

Check `git status` before and after committing. Do not commit private proxy
configuration, credentials, service environment files, or other
machine-local configuration.

## Deploy to the running target service

The installed runtime is intentionally separate from the source worktree.
Keep the service running while editing and testing; deploy only a deliberate,
tested commit:

```sh
scripts/update-sensei-proxy.sh
```

The script builds `./cmd/proxy`, saves the previous binary, installs a new
candidate, restarts only `sensei-cnc-proxy.service`, then checks
`http://127.0.0.1:8420/api/machine`. If that check fails, it restores the
previous binary automatically.

It does **not** restart the CNC, camera streamer, or kiosk browser. A brief
connection-refused line during the proxy restart is expected while the health
check retries.

Useful runtime paths:

```text
Installed proxy: ~/.local/bin/sensei-cnc-proxy
Previous release: ~/.local/share/sensei/releases/sensei-cnc-proxy.previous
Private config:   ~/.config/sensei/proxy.env
```

## Target-computer services

```sh
systemctl --user status sensei-cnc-proxy.service
systemctl --user status sensei-kiosk.service
sudo systemctl status sensei-ustreamer.service
```

| Service | Responsibility |
|---|---|
| `sensei-cnc-proxy.service` | CNC proxy, API, web UI and WebDAV |
| `sensei-kiosk.service` | Optional local fullscreen dashboard |
| `sensei-ustreamer.service` | Optional external-camera stream |

For proxy logs:

```sh
journalctl --user -u sensei-cnc-proxy.service --no-pager -n 150
```

Never restart the CNC merely to deploy or troubleshoot the web UI. If a
machine-affecting behavior is under investigation, trace the full path—DOM
event, HTTP request, handler, service policy, arbiter, machine frame,
observable status, and UI feedback—before changing code.
