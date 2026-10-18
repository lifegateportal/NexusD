# Nexus Code deployments to DigitalOcean

Nexus Code deploys saved project revisions directly to DigitalOcean App
Platform. It does not create, connect to, or require a GitHub repository.

## First-release support

- Node.js projects with a root `package.json` and a non-empty `scripts.start`.
- Projects may include an optional `build` script.
- The build runs in the isolated Nexus coding runner and produces an AMD64
  container image in your DigitalOcean Container Registry (DOCR).
- App Platform hosts the image and provides its `ondigitalocean.app` URL.
- Nexus configures one `apps-s-1vcpu-1gb` web service on port 8080 per project.
- Each deployment uses an immutable revision tag. Nexus preserves existing
  App Platform environment settings when updating the app's image.

Static-only projects, custom Dockerfiles, deployment secrets entered in Nexus,
custom domains, and database provisioning are not included in this first
release. Do not include `.env` files in a project. Configure runtime secrets
through the corresponding app in the DigitalOcean control panel. The app's
start command must bind to `0.0.0.0` and listen on the `PORT` environment
variable, which Nexus configures as `8080`.

## DigitalOcean setup

1. Create a DigitalOcean Container Registry in your account. Note its lowercase
   registry name.
2. Create a DigitalOcean API token with `registry:read`, `apps:create`,
   `apps:read`, `apps:update`, and `apps:delete` access. Store it only in
   Nexus's server-side environment configuration.
3. On the Nexus server, set:

   ```text
   DIGITALOCEAN_API_TOKEN=your-server-side-token
   DIGITALOCEAN_REGISTRY_NAME=your-registry-name
   DIGITALOCEAN_REGION=nyc
   AUTH_PASSWORD=your-nexus-login-password
   AUTH_COOKIE_SECRET=a-unique-random-secret-at-least-16-characters
   CODING_RUNNER_URL=https://your-private-runner-endpoint
   CODING_RUNNER_TOKEN=the-same-token-configured-on-the-runner
   ```

   `DIGITALOCEAN_REGION` defaults to `nyc`. The API token, Nexus login
   credentials, and runner token are server-only secrets; never put them in a
   project file or browser code.
4. Deploy the coding runner on a dedicated Docker host. Follow
   [the runner setup guide](../coding-runner/README.md), and keep its
   authenticated API private. Allow outbound access to DigitalOcean APIs,
   DOCR, and package registries so image builds can install dependencies.
5. Restart Nexus and the runner after configuration. In Nexus Code, wait for
   project edits to save, then select **Deploy** and confirm the DigitalOcean
   deployment. Nexus shows build logs, deployment status, and the live URL.

## Costs and operations

DigitalOcean charges for App Platform resources and Container Registry usage.
The first release creates one 1-vCPU/1-GB App Platform service per project.
Nexus asks for confirmation before deployment and before deleting a deployed
app. Deleting the app takes the website offline; it does not delete the Nexus
workspace.

Nexus builds the exact saved workspace revision. Later deploys update the
existing App Platform app to a new immutable image tag. Deployment errors and
logs are available in Nexus Code; DigitalOcean's app dashboard provides the
provider-side deployment details and billing controls.
