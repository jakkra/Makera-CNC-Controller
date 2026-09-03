# Sensei runtime

The Surface runs three persistent services:

- `sensei-cnc-proxy.service` — a `jakkra` user service for the proxy and web UI.
- `sensei-ustreamer.service` — a system service that runs the C920 streamer as
  `jakkra` with the `video` supplementary group.
- `sensei-kiosk.service` — a `jakkra` graphical-session service that keeps the
  local Firefox dashboard in kiosk mode.

The private proxy configuration belongs in `~/.config/sensei/proxy.env` and is
intentionally not stored in Git. Start from `user/proxy.env.example` and keep
the file mode at `0600`.

## Development and local release

Keep the installed services running while editing and testing the working copy.
Run focused or full tests as appropriate. When a change is ready for the live
Surface, run:

```sh
scripts/update-sensei-proxy.sh
```

It builds a candidate binary, retains one previous binary under
`~/.local/share/sensei/releases/`, restarts only the proxy, checks the local
API, and automatically restores the previous binary if that health check fails.
The camera and kiosk stay running during a proxy update.
