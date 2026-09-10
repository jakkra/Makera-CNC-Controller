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

## Camera resolution and focus

The bundled C920 unit captures 1920×1080 MJPEG at 15 fps. It disables
continuous autofocus at startup and uses a fixed focus value of 5. uStreamer
exposes image controls, but not autofocus controls; the Overview camera toolbar
provides Auto/Manual focus controls when the proxy can access the device.
Because the proxy runs as the desktop user, that user must be a member of the
`video` group for the controls to work (one-time setup: `sudo usermod -aG video
jakkra`, then start a new login session).
Inspect the camera's V4L2
controls with:

```sh
v4l2-ctl -d /dev/v4l/by-id/usb-046d_HD_Pro_Webcam_C920_46EAAC8F-video-index0 --list-ctrls-menus
```

For this C920, `focus_automatic_continuous` is the autofocus switch and
`focus_absolute` accepts values from 0 to 250 in steps of 5. Autofocus can be
disabled and a fixed focus selected:

```sh
v4l2-ctl -d /dev/v4l/by-id/usb-046d_HD_Pro_Webcam_C920_46EAAC8F-video-index0 --set-ctrl=focus_automatic_continuous=0
v4l2-ctl -d /dev/v4l/by-id/usb-046d_HD_Pro_Webcam_C920_46EAAC8F-video-index0 --set-ctrl=focus_absolute=<value>
```
