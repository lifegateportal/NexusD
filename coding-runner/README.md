# Nexus Code runner

This service is the execution boundary for Nexus Code. The Next.js process
only sends the current revision to this service; it never executes generated
code itself.

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
