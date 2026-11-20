# Shorts capture worker

The capture worker renders the existing Shorts preview in Chromium on a
virtual display, records its audio and video with FFmpeg, then stores the MP4
in a private Cloudflare R2 bucket. It runs on the same Linux host as Nexus so
the app and worker can share a persistent job directory. Captures run in real
time and only one job is processed at a time.

## Host requirements

- Node.js 20 or newer and the repository's installed production dependencies
- Chromium, Xvfb, PulseAudio with `pactl`, and FFmpeg
- FFmpeg enabled with `x11grab`, PulseAudio input, and `libx264`
- A persistent directory writable only by the Nexus service account
- A separate **private** R2 bucket for capture output

Install the distro equivalents of those packages. For Debian-based hosts, the
package names are commonly `chromium`, `xvfb`, `pulseaudio`,
`pulseaudio-utils`, and `ffmpeg`. Confirm the installed FFmpeg exposes the
required inputs before starting the service.

## Environment

Configure these values for both the Nexus web process and the worker:

- `SHORT_CAPTURE_JOB_DIR`: shared persistent job directory, such as
  `/var/lib/nexus-short-capture`
- `SHORT_CAPTURE_R2_BUCKET`: private output bucket
- `SHORT_CAPTURE_APP_ORIGIN`: local Nexus URL, such as
  `http://127.0.0.1:3000`
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`
- `AUTH_PASSWORD` and `AUTH_COOKIE_SECRET`

The worker also supports `SHORT_CAPTURE_CHROMIUM_PATH`,
`SHORT_CAPTURE_FFMPEG_PATH`, `SHORT_CAPTURE_XVFB_PATH`,
`SHORT_CAPTURE_PULSE_SINK`, and `SHORT_CAPTURE_DISPLAY`. Defaults are
`/usr/bin/chromium`, `ffmpeg`, `Xvfb`, `nexus_capture`, and `:99`.

If YouTube playback works in the normal editor but fails in capture, set
`SHORT_CAPTURE_BROWSER_ORIGIN` to the trusted public HTTPS origin for this
Nexus deployment (for example, `https://nexusdirector.example`). The worker
uses this origin only for its browser page and session cookie; keep
`SHORT_CAPTURE_APP_ORIGIN` pointed at localhost. Do not set the browser origin
to a host you do not control.

The capture page sends YouTube's recommended
`Referrer-Policy: strict-origin-when-cross-origin` header so the embedded
player receives the site's origin without the private capture URL.

Create the job directory and grant access to the same service account that
runs Nexus and PM2:

```bash
sudo install -d -o nexus -g nexus -m 700 /var/lib/nexus-short-capture
```

Replace `nexus` with the actual service account. Store credentials in the
host's environment/PM2 configuration, not in this repository.

## Start the worker

Run one PM2 instance from the repository root:

```bash
pm2 start scripts/short-capture-worker.mjs --name nexus-short-capture --interpreter node
pm2 save
```

The Shorts Studio capture endpoint checks the worker heartbeat before queuing
a job. If it is unavailable, the endpoint returns an explicit error. The
worker uses the configured local app URL and existing Director login to load
the capture-only preview. Do not expose a worker port; the queue is a
host-local directory.

## Output and limitations

The downloadable file is an MP4 stored in the private R2 bucket. Each download
request receives a fresh one-hour signed R2 URL. Shorts Studio restores the
latest capture for a project when it is reopened. Job records and output
objects are retained until manually removed; monitor bucket usage. The capture takes
approximately the selected playback duration, and output quality depends on
the YouTube playback resolution and the Shorts preview crop.
The worker starts recording after the embedded video is confirmed to be playing,
so its initial paused-player screen is not included in the MP4.

For the first run, use an owned public or unlisted video that plays in the
embedded player. A private, age-restricted, or non-embeddable video may require
additional account access or may not be capturable.
