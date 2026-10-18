# Deploy Nexus Code projects through EpicGlobal

Nexus Code publishes projects directly to your existing EpicGlobal host. It
does not create a GitHub repository, DigitalOcean Container Registry, or
DigitalOcean App Platform service.

## Supported deployment types

- **Static site:** Nexus builds the saved revision in the isolated runner,
  packages only the build output, then uploads it through EpicGlobal's existing
  protected `/api/orchestrator/upload` endpoint. The source tree is not sent to
  that endpoint. Built ZIP files must remain below EpicGlobal's 100 MB limit.
- **Full-stack app:** Nexus sends the saved Node.js project to a restricted
  SSH deploy agent on the Droplet. The agent builds it as a dedicated,
  unprivileged Linux account, runs it in a resource-limited systemd service,
  health-checks it, updates EpicGlobal's project registry, and asks EpicGlobal
  to rebuild Caddy routes through its protected repair endpoint. Updates use a
  second release and port before switching the public route.

Both types use a project URL under `epicglobal.app`. The full-stack project must
have a root `package.json` with a `scripts.start` command. Its server must read
`PORT` and listen on `0.0.0.0`. Optional runtime variables can be entered in
Nexus Code as `KEY=value` lines; Nexus does not save these values in workspace
files. Do not include `.env` files. Runtime variables are provided to the
application process, not to its build scripts.

## Nexus server configuration

Set the following in the server-side Nexus environment:

```text
EPICGLOBAL_API_URL=https://api.epicglobal.app
EPICGLOBAL_ORCHESTRATOR_API_KEY=your-EpicGlobal-orchestrator-key
AUTH_PASSWORD=your-Nexus-login-password
AUTH_COOKIE_SECRET=a-unique-random-secret-at-least-16-characters
CODING_RUNNER_URL=https://your-private-runner-endpoint
CODING_RUNNER_TOKEN=the-same-token-configured-on-the-runner
```

The API key must be one accepted by EpicGlobal's protected
`/api/orchestrator/*` endpoints. Keep it server-side; it is passed only to the
runner for the current deployment and is not included in project files or
browser responses.

## One-time Droplet setup for full-stack hosting

Static hosting does not require SSH setup. Full-stack hosting needs the
restricted host-side agent below; it is not installed automatically, and a
deployment cannot run until this setup is complete.

1. Confirm the Droplet already has the EpicGlobal wildcard DNS and Caddy
   configuration needed for `*.epicglobal.app`. Install system-wide Node.js,
   npm, `unzip`, `flock`, systemd, and Caddy if not already present.
2. Find the `projects.json` used by EpicGlobal's running API process. It is the
   `projects.json` in that process's working directory; do not guess a path or
   edit the EpicGlobal repository. Create `/etc/nexus-deploy-agent.json` as
   root, mode `0600`, containing the exact registry path and dedicated Nexus
   storage paths:

   ```json
   {
     "registryPath": "/absolute/path/to/EpicGlobal/projects.json",
     "deploymentRoot": "/var/lib/nexus-deployments/apps",
     "stateRoot": "/var/lib/nexus-deployments",
     "pm2User": "root",
     "pm2Home": "/root"
   }
   ```

   `pm2User` and `pm2Home` must match the account and home used by the
   EpicGlobal PM2 daemon (often `root` and `/root`). The agent creates a small
   PM2 health supervisor so EpicGlobal's existing watchdog can restart the
   systemd-managed app rather than removing its registry entry.
3. Copy `coding-runner/epicglobal-droplet-agent.mjs` to
   `/usr/local/libexec/nexus-droplet-agent.mjs`, owned by root and mode `0755`.
   Install this root-owned launcher at `/usr/local/sbin/nexus-deploy-agent`:

   ```sh
   #!/bin/sh
   exec /usr/bin/flock -x /run/lock/nexus-deploy-agent.lock \
     /usr/bin/node /usr/local/libexec/nexus-droplet-agent.mjs
   ```

   Set the launcher owner to root and mode `0755`. The agent serializes Nexus
   operations with `flock`; it modifies EpicGlobal's project registry and
   systemd routes, not the EpicGlobal source repository.
4. Create a dedicated SSH account named `nexus-deploy`, with no password
   login, and add this sudoers rule allowing it to run only the fixed launcher,
   with no arguments:

   ```text
   nexus-deploy ALL=(root) NOPASSWD: /usr/local/sbin/nexus-deploy-agent ""
   ```

   Put a dedicated public key in that account's `authorized_keys` with this
   forced command and forwarding restrictions:

   ```text
   command="sudo -n /usr/local/sbin/nexus-deploy-agent",no-agent-forwarding,no-port-forwarding,no-pty,no-X11-forwarding,no-user-rc ssh-ed25519 AAAA...
   ```

   The account cannot get a shell through this key. The root-owned config,
   agent, and launcher must not be writable by `nexus-deploy`. For PM2 users
   other than root, the agent installs a per-project sudoers rule limited to
   restarting that project's systemd service.
5. Configure the coding runner with the matching host, private key (base64),
   and a verified `known_hosts` line:

   ```text
   CODING_DEPLOY_SSH_HOST=your-droplet-hostname-or-ip
   CODING_DEPLOY_SSH_USER=nexus-deploy
   CODING_DEPLOY_SSH_PORT=22
   CODING_DEPLOY_SSH_PRIVATE_KEY_BASE64=base64-encoded-private-key
   CODING_DEPLOY_SSH_KNOWN_HOSTS=your-droplet-hostname-or-ip ssh-ed25519 AAAA...
   ```

   Verify the host-key fingerprint through a trusted channel before using it;
   do not trust an unverified `ssh-keyscan` result. Keep the runner's
   authenticated API private and restart it after configuring the key.
6. Restart Nexus and the runner. In Nexus Code, wait for the saved revision,
   select **Static site** or **Full-stack app**, and choose **Deploy**. Nexus
   shows the build/deployment logs and resulting public URL. Use **Take site
   offline** to remove a deployment.

## Limits and operating notes

- The runner rejects `.env` files. Runtime variables are validated and kept
  outside the workspace source; full-stack build scripts do not receive them.
- Full-stack releases are built under per-project unprivileged accounts. The
  running systemd service is limited to 512 MB memory, 100% of one CPU, and
  128 tasks. Droplet-level capacity and networking still apply.
- Runner deployment jobs time out after 30 minutes by default. Each Droplet
  install, build, and prune command is independently limited to 8 minutes.
- Configure the Droplet firewall to allow inbound SSH and web traffic only
  (normally ports 22, 80, and 443). The applications listen on allocated
  backend ports for Caddy; those ports should not be open to the public
  internet.
- Static deployments use EpicGlobal's existing upload API, which replaces the
  old static files before finishing the Caddy update; EpicGlobal does not offer
  atomic static rollback through this endpoint.
- The host agent uses EpicGlobal's existing registry and repair API to build
  Caddy routes. Do not run the EpicGlobal cleanup endpoint while Nexus sites
  are active.
- No deployment has been tested against your live Droplet yet. Configure the
  server-side key, runner SSH settings, and the one-time host agent first.
