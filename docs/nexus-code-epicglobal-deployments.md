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
- **Full-stack app:** Nexus packages the saved Node.js project as a ZIP and
  sends it to EpicGlobal's protected `/api/orchestrator/nexus-deploy` endpoint.
  EpicGlobal builds and starts it through its existing PM2 deployment queue,
  then routes the project's subdomain through Caddy. No GitHub repository,
  coding runner, Docker, SSH deploy account, or additional Droplet is needed.

Both types use a project URL under `epicglobal.app`. Static build scripts run on
the user's device, so Nexus Code must be opened in a secure, cross-origin-
isolated browser tab with WebContainer support. Plain static files do not need
WebContainers. The full-stack project must have a root `package.json` with a
`scripts.start` command. Its server must read `PORT` and listen on `0.0.0.0`.
For a React project, use **Static site** if it is browser-only. Choose
**Full-stack app** when the React build is served by a Node.js server that also
provides API routes or other server-side operations.
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

Full-stack deployment becomes available when the EpicGlobal key is configured.
It uses the existing Droplet and shares its resources with your other sites.
Keep a resource margin before deploying another Node service; the server-side
switch below can explicitly pause full-stack hosting:

```text
CODING_FULLSTACK_ENABLED=false  # optional emergency/maintenance pause
```

If `CODING_FULLSTACK_ENABLED` is unset, it defaults to enabled; set it to
`false` and restart Nexus to pause full-stack deployments. `CODING_RUNNER_URL`
and `CODING_RUNNER_TOKEN` are not used for deployment; they remain optional
for runner-backed command and preview features.

The API key must be accepted by EpicGlobal's protected
`/api/orchestrator/*` endpoints. Keep it server-side. Nexus uses it for static
uploads, full-stack ZIP deployments, and deletion; it is never included in
project files or browser responses.

## Enable full-stack hosting

1. Deploy the updated EpicGlobal API code so its running server exposes
   `POST /api/orchestrator/nexus-deploy`. This route is protected by the
   existing EpicGlobal orchestrator API key and uses the existing host and PM2
   queue.
2. Set `EPICGLOBAL_API_URL`, `EPICGLOBAL_ORCHESTRATOR_API_KEY`, and
   `CODING_FULLSTACK_ENABLED=true` (or leave the flag unset) in Nexus's
   server-side environment, then restart Nexus.
3. In Nexus, choose **Full-stack app**, enter optional runtime variables, and
   deploy. The project needs a root `package.json` with a `start` script; the
   app must listen on the `PORT` supplied by EpicGlobal. The deployment URL is
   `https://<project-name>.epicglobal.app`.

No runner, Docker setup, SSH key, or second Droplet is needed for full-stack
deployment. The existing coding runner may still be used separately for
isolated terminal and preview features.

## Full-stack deployment errors

Nexus shows the HTTP status and EpicGlobal's response details in deployment
status. Common responses:

- **404:** The running EpicGlobal API does not have
  `/api/orchestrator/nexus-deploy`; deploy and restart EpicGlobal with the
  direct Nexus deployment endpoint.
- **401/403:** The API key configured on Nexus does not match
  EpicGlobal's `ORCHESTRATOR_API_KEY`.
- **413:** The EpicGlobal API host or a reverse proxy rejected the request
  size. Nexus source is limited to 4 MB and the ZIP to 8 MB.
- **400:** EpicGlobal rejected the project archive, runtime variables, or
  `package.json`; read the error and build output shown in deployment status.
- **5xx or timeout:** Check the EpicGlobal API logs and deployment history;
  the API host or an upstream proxy may have timed out while the host built
  the project.

## Limits and operating notes

- Full-stack uploads reject `.env` files, unsafe paths, symbolic links, and
  special files. ZIP uploads and extracted source are each capped at 8 MB;
  Nexus workspace source is capped at 4 MB. Runtime variables are not added to
  the ZIP and are supplied only to the running app, not its build scripts.
- Full-stack installs and builds run on the EpicGlobal host using the same
  operating-system account and permissions as its existing Git-based deploys.
  This is convenient but is not per-project isolation: only deploy code and
  dependencies you trust. Running applications share the Droplet's CPU,
  memory, and disk.
- Full-stack install/build commands are limited to 8 minutes; EpicGlobal
  checks that the app responds on its allocated port before publishing the
  Caddy route.
- Static artifacts are capped at 25 MB compressed and 50 MB unpacked to bound
  memory and protect the shared host. The Nexus server validates archive paths,
  file types, and the root `index.html` before relaying the ZIP to EpicGlobal.
- If the Nexus virtual host is behind Nginx, its Nexus-only configuration must
  accept request bodies up to 26 MB and allow at least 360 seconds for static
  uploads. Do not change the EpicGlobal virtual host's limits for Nexus.
- Configure the Droplet firewall to allow inbound SSH and web traffic only
  (normally ports 22, 80, and 443). The applications listen on allocated
  backend ports for Caddy; those ports should not be open to the public
  internet.
- Static deployments use EpicGlobal's existing upload API, which replaces the
  target project's old static files before finishing the Caddy update;
  EpicGlobal does not offer atomic static rollback through this endpoint.
  Other EpicGlobal projects are not intentionally restarted, but the existing
  upload API is responsible for applying the target site's update.
- No deployment has been tested against your live Droplet yet. Both deployment
  types need only the Nexus server-side EpicGlobal API key; full-stack
  deployments additionally require the updated EpicGlobal API code.
