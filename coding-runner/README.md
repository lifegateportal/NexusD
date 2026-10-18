# Nexus Code runner

This service is the execution boundary for Nexus Code. The Next.js process
only sends the current revision to this service; it never executes generated
code itself.

Nexus Code's Preview panel defaults to a StackBlitz WebContainer, which runs
project commands such as `npm run dev` in the browser without this Docker
service. The `/coding` page sends the COOP/COEP headers required by
WebContainers. StackBlitz's embedded preview may still prevent cross-origin
isolation; in that case, open Nexus Code in a top-level browser tab. Choose
**Isolated runner** in the panel to use this service instead; it remains useful
when a project needs the runner's server-side container environment.
Start the WebContainer separately from its terminal commands. The container
mounts the project once and stays available for commands such as `npm install`
and `npm run dev`; command output streams in the Preview panel, and the app
preview appears when a dev server reports its ready port.

## Security boundary

Each run starts a fresh Docker container with:

- no network by default (`network: false`)
- a read-only root filesystem
- a temporary `noexec` `/tmp`
- dropped Linux capabilities
- `no-new-privileges`
- CPU, memory, process-count, output-size, and wall-clock limits
- an ephemeral workspace that is deleted after the command exits

The runner needs access to the Docker socket to create sandbox containers. Run
it on a dedicated host or VM and do not expose port `8090` publicly. The
Docker socket is equivalent to host-level administrative access.

The `network: true` option is intentionally explicit and should only be
enabled for trusted tasks.

## Start locally

```bash
export CODING_RUNNER_TOKEN="$(openssl rand -hex 32)"
export CODING_RUNNER_HOST_WORK_ROOT="$PWD/coding-runner/.runner-work"
mkdir -p "$CODING_RUNNER_HOST_WORK_ROOT"
docker compose -f coding-runner/docker-compose.yml build
docker compose -f coding-runner/docker-compose.yml up -d
```

Set the same token in the Next.js environment:

```bash
CODING_RUNNER_URL=http://127.0.0.1:8090
CODING_RUNNER_TOKEN=the-same-value
```

Check readiness:

```bash
curl http://127.0.0.1:8090/healthz
```

`POST /runs` returns a queued `CodingRun`. Poll `GET /runs/{runId}` with the
same bearer token to read status and bounded logs.

Temporary live previews use `POST /previews` with a workspace snapshot,
revision, command, port, and explicit `network: true`. The runner keeps the
sandbox container alive for the preview, and the Nexus Code web route proxies
browser requests through the authenticated sidecar. Stop previews with
`DELETE /previews/{previewId}`; stale previews are removed after the configured
retention period. Network access is intentionally required for this feature so
the sidecar can reach the preview port, and should only be enabled for trusted
projects.

## DigitalOcean image builds

Nexus Code can send a saved Node.js revision to `POST /deployments`. The runner
builds an AMD64 image with a generated Node 22 Dockerfile, pushes it to the
configured DigitalOcean Container Registry, and exposes bounded build logs at
`GET /deployments/{buildId}`. Projects must include a root `package.json` with
a `start` script. `.env` files are rejected and excluded from the build context.

The runner receives short-lived registry credentials for each build. It does
not receive the long-lived DigitalOcean API token; Nexus uses that token to
request the registry credentials and to create or update the App Platform app.
The build executes project npm install/build scripts inside Docker's build
environment. Run this service on a dedicated, patched host and keep its
authenticated API private. The runner has access to the host Docker socket,
which is equivalent to host-level administrative access; do not use a shared
host containing unrelated workloads or secrets.

Image builds are limited by `CODING_RUNNER_BUILD_TIMEOUT_MS` and
`CODING_RUNNER_MAX_CONCURRENT_BUILDS`; default build concurrency is one.
Configure host-level CPU, memory, and disk limits for the dedicated Docker
daemon that runs the builder. The runner cannot enforce those limits on the
daemon's BuildKit workers with the Docker CLI.
