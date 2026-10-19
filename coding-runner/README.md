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
export CODING_RUNNER_BIND_IP=127.0.0.1
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

For a runner on a separate host, set `CODING_RUNNER_BIND_IP` to that host's
private VPC address and allow inbound TCP port `8090` only from the Nexus
server's private address. Set `CODING_RUNNER_URL` on the Nexus server to
`http://<runner-private-ip>:8090`. Do not bind the runner to its public
interface or expose port `8090` publicly.

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

## EpicGlobal deployments

Nexus Code sends a saved revision to `POST /deployments`. Static projects are
built inside the isolated sandbox and only the built ZIP is uploaded to
EpicGlobal. Full-stack Node.js projects are packaged and sent over SSH to the
Droplet's forced-command deploy agent. The agent is maintained here at
`epicglobal-droplet-agent.mjs`; the setup procedure and required Nexus server
configuration are in the
[EpicGlobal deployment guide](../docs/nexus-code-epicglobal-deployments.md).

For full-stack hosting, configure these runner variables:

```text
CODING_DEPLOY_SSH_HOST=your-droplet-hostname-or-ip
CODING_DEPLOY_SSH_USER=nexus-deploy
CODING_DEPLOY_SSH_PORT=22
CODING_DEPLOY_SSH_PRIVATE_KEY_BASE64=base64-encoded-private-key
CODING_DEPLOY_SSH_KNOWN_HOSTS=your-droplet-hostname-or-ip ssh-ed25519 AAAA...
```

The SSH key is used only by the runner. Its Droplet-side key is restricted to
the root-owned deploy-agent launcher; do not configure an unrestricted SSH
account or forward this key into project builds. Verify and pin the Droplet host
key. The runner receives the EpicGlobal orchestrator API key only with a
deployment request and does not expose it to the sandbox or the project.

Both static builds and full-stack source packages are limited to a 4 MB source
revision. Full-stack builds run on the Droplet under a per-project unprivileged
account; the installed systemd service has memory, CPU, and task limits.
Deployment jobs are serialized by default and bounded by
`CODING_RUNNER_BUILD_TIMEOUT_MS` (30 minutes by default). Keep the authenticated
runner API private and operate it on a dedicated host: it has access to the
Docker socket, which is equivalent to host-level administrative access.
