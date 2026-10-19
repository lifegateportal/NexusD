# Deploy Nexus Code projects through EpicGlobal

Nexus Code publishes projects directly to your existing EpicGlobal host. It
does not create a GitHub repository, DigitalOcean Container Registry, or
DigitalOcean App Platform service.

## Supported deployment types

- **Static site:** Nexus builds the saved revision in the browser's WebContainer
  (or packages plain HTML/CSS/JS directly), then sends a bounded ZIP of the
  published files through the Nexus server to EpicGlobal's protected
  `/api/orchestrator/upload` endpoint. The EpicGlobal API key stays on the
  server; the project source and build dependencies are not sent to EpicGlobal.
  Browser builds currently use npm and support `dist`, `build`, `out`, and
  `public` output folders. The ZIP limit is 25 MB and unpacked output is limited
  to 50 MB.
- **Full-stack app:** Nexus sends the saved Node.js project to a restricted
  SSH deploy agent on the Droplet. The agent builds it as a dedicated,
  unprivileged Linux account, runs it in a resource-limited systemd service,
  health-checks it, updates EpicGlobal's project registry, and asks EpicGlobal
  to rebuild Caddy routes through its protected repair endpoint. Updates use a
  second release and port before switching the public route.

Both types use a project URL under `epicglobal.app`. Static build scripts run on
the user's device, so Nexus Code must be opened in a secure, cross-origin-
isolated browser tab with WebContainer support. Plain static files do not need
WebContainers. The full-stack project must have a root `package.json` with a
`scripts.start` command. Its server must read `PORT` and listen on `0.0.0.0`.
Optional runtime variables can be entered in Nexus Code as `KEY=value` lines;
Nexus does not save these values in workspace files. Do not include `.env`
files. Runtime variables are provided to the application process, not to its
build scripts.

Nexus Code's explorer can create a device-local root `.env.local` for the
browser WebContainer preview. Its contents stay in that browser's local
storage (not encrypted); they are excluded from workspace revisions, assistant
requests, project ZIPs, GitHub publishing, and both deployment types. This
file is for local preview only. Never put a private key in a browser-facing
variable such as `VITE_*`, `REACT_APP_*`, or `NEXT_PUBLIC_*`; use full-stack
deployment runtime variables for private server-side credentials.

Coding conversations are stored locally by project. Switching projects loads
that project's active conversation; **New chat** preserves the current thread
in **History**. The latest 20 threads are retained in this browser, not synced
to the Nexus server.

Explorer ZIP uploads create a separate project; folder imports merge into the
open project. Imports support up to 200 UTF-8 text files and 4 MB of source,
not binary assets. ZIP downloads contain shared workspace files only and
exclude device-local `.env.local`.

## React apps with AI and cloud storage

React frontends can be deployed as static files, but private AI credentials and
privileged storage operations need a server endpoint. For those projects,
generate a Node app that serves the React build and its API routes from the
same origin, then choose **Full-stack app** when full-stack hosting is enabled.
Use each project's own provider credentials; never reuse Nexus's AI or R2
credentials.

Keep provider secrets in server-side `process.env` and list only placeholder
variable names in `.env.example`. Enter real values in the deployment
runtime-variable field. Do not use `VITE_*`, `REACT_APP_*`, or `NEXT_PUBLIC_*`
for secrets: build-time browser variables are visible to site visitors.
Runtime variables are not supplied to build scripts.

Recommended patterns:

| Integration | Server-side credentials and browser flow |
| --- | --- |
| OpenAI | `OPENAI_API_KEY`; call OpenAI from a validated Node API route. |
| Anthropic Claude | `ANTHROPIC_API_KEY`; call Anthropic from a validated Node API route. |
| Google Gemini | `GOOGLE_GENERATIVE_AI_API_KEY`; call Gemini from a validated Node API route. |
| DeepSeek | `DEEPSEEK_API_KEY`; call DeepSeek from a validated Node API route. |
| OpenAI-compatible API | `OPENAI_COMPATIBLE_API_KEY` and `OPENAI_COMPATIBLE_BASE_URL`; configure the base URL on the server, never accept an arbitrary URL from the browser. |
| Cloudflare Workers AI | `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`; call Workers AI from a Node API route. |
| Cloudflare R2 | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET_NAME`; return short-lived, scoped signed upload URLs and send file bytes directly from the browser to R2. |
| AWS S3 | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, and `S3_BUCKET_NAME`; use short-lived, scoped signed upload URLs. |
| Supabase Storage | Use the anon key only with authenticated client access and RLS. Keep `SUPABASE_SERVICE_ROLE_KEY` server-side if the server creates signed upload URLs. |
| Firebase Storage | Use the browser SDK with user authentication and restrictive Storage Rules. Never expose a Firebase Admin service-account credential. |

Validate upload size, content type, and user authorization before issuing an
upload token or signed URL. Generate object keys on the server instead of
accepting arbitrary bucket paths from the browser. Use provider-side rules and
least-privilege credentials. Static hosting remains suitable when the project
uses only documented browser-safe credentials and enforces access with provider
authentication and rules.

## Nexus server configuration

Static hosting does not need a coding runner, Docker, SSH access, a new Droplet,
or a GitHub repository. Set the following in the server-side Nexus environment:

```text
EPICGLOBAL_API_URL=https://api.epicglobal.app
EPICGLOBAL_ORCHESTRATOR_API_KEY=your-EpicGlobal-orchestrator-key
AUTH_PASSWORD=your-Nexus-login-password
AUTH_COOKIE_SECRET=a-unique-random-secret-at-least-16-characters
```

The EpicGlobal key is used only by the Nexus server. Do not put it in browser
code, workspace files, or a `.env` file.

Full-stack deployment becomes available when the EpicGlobal key and isolated
runner are configured. It uses the existing Droplet and shares its resources
with your other sites. Keep a resource margin before deploying another Node
service; the server-side switch below can explicitly pause full-stack hosting:

```text
CODING_FULLSTACK_ENABLED=false  # optional emergency/maintenance pause
CODING_RUNNER_URL=http://<runner-private-ip>:8090
CODING_RUNNER_TOKEN=the-same-token-configured-on-the-runner
```

If `CODING_FULLSTACK_ENABLED` is unset, it defaults to enabled; set it to
`false` and restart Nexus to pause full-stack deployments.

Run the coding runner on a dedicated host because it requires Docker socket
access. For a separate DigitalOcean Droplet, place it in the same region and
VPC as the Nexus/EpicGlobal server. Bind runner port `8090` to the runner's
private VPC address only, and allow inbound TCP `8090` only from the
Nexus/EpicGlobal server's private address. The runner compose configuration
uses localhost by default; set `CODING_RUNNER_BIND_IP` to the private address
on the runner host. Do not expose port `8090` publicly.

The API key must be one accepted by EpicGlobal's protected
`/api/orchestrator/*` endpoints. Keep it server-side: Nexus uses it directly
for static uploads and deletion, and passes it to the runner only for enabled
full-stack deployments. It is never included in project files or browser
responses.

## One-time Droplet setup for full-stack hosting

Static hosting does not require SSH setup. Full-stack hosting requires the
restricted host-side agent below; it is not installed automatically. Each
deployed service is limited to 512 MB memory and one CPU, but all services
still share the Droplet's overall resources.

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
6. Restart Nexus and the runner. Once the EpicGlobal key and private runner
   configuration are present, select **Full-stack app** in Nexus Code unless
   `CODING_FULLSTACK_ENABLED=false` is set. Static sites can be published
   independently by selecting **Static site** and choosing **Deploy**; the
   browser builds and sends only the static artifact.
   **Take site offline** removes the hosted project.

## Limits and operating notes

- The runner rejects `.env` files. Runtime variables are validated and kept
  outside the workspace source; full-stack build scripts do not receive them.
- Full-stack releases are built under per-project unprivileged accounts. The
  running systemd service is limited to 512 MB memory, 100% of one CPU, and
  128 tasks. Droplet-level capacity and networking still apply.
- Static artifacts are capped at 25 MB compressed and 50 MB unpacked to bound
  memory and protect the shared host. The Nexus server validates archive paths,
  file types, and the root `index.html` before relaying the ZIP to EpicGlobal.
- If the Nexus virtual host is behind Nginx, its Nexus-only configuration must
  accept request bodies up to 26 MB and allow at least 360 seconds for the
  upload route. Do not change the EpicGlobal virtual host's limits for Nexus.
- Runner deployment jobs time out after 30 minutes by default. Each Droplet
  install, build, and prune command is independently limited to 8 minutes.
- Configure the Droplet firewall to allow inbound SSH and web traffic only
  (normally ports 22, 80, and 443). The applications listen on allocated
  backend ports for Caddy; those ports should not be open to the public
  internet.
- Static deployments use EpicGlobal's existing upload API, which replaces the
  target project's old static files before finishing the Caddy update;
  EpicGlobal does not offer atomic static rollback through this endpoint.
  Other EpicGlobal projects are not intentionally restarted, but the existing
  upload API is responsible for applying the target site's update.
- The host agent uses EpicGlobal's existing registry and repair API to build
  Caddy routes. Do not run the EpicGlobal cleanup endpoint while Nexus sites
  are active.
- No deployment has been tested against your live Droplet yet. Static
  publishing needs only the Nexus server-side API key. Runner SSH settings and
  the one-time host agent are needed only if full-stack hosting is later
  enabled.
