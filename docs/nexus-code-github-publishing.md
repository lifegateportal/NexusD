# Nexus Code export and GitHub publishing

Nexus Code can download the current project as a ZIP or publish its current saved revision to an existing repository owned by the connected GitHub account.

## Configure GitHub OAuth

1. On GitHub, open **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Set the application homepage to your hosted Nexus site.
3. Set **Authorization callback URL** to:
   `https://YOUR-NEXUS-HOST/api/coding/github/callback`
   For local development, use `http://localhost:5000/api/coding/github/callback`.
4. Save the app and copy its Client ID and generate a Client secret.
5. Add these variables to your host's server-side environment configuration:

   ```text
   GITHUB_OAUTH_CLIENT_ID=your-client-id
   GITHUB_OAUTH_CLIENT_SECRET=your-client-secret
   GITHUB_OAUTH_CALLBACK_URL=https://YOUR-NEXUS-HOST/api/coding/github/callback
   GITHUB_OAUTH_SESSION_SECRET=a-unique-random-secret-at-least-32-characters
   ```

   `GITHUB_OAUTH_CALLBACK_URL` must exactly match the callback configured in the OAuth App. Production URLs must use HTTPS. Generate a strong session secret (for example, `openssl rand -hex 32`) and do not commit any of these values to the repository.
6. Restart or redeploy Nexus after adding the variables.
7. In Nexus Code, choose **Connect GitHub**, approve access, select one of your personal repositories, and publish.

The OAuth `repo` permission is required so Nexus can write to both public and private repositories. GitHub grants that permission across your repositories; Nexus limits its picker and server-side publishing validation to repositories owned by the connected personal account. The access token is encrypted in a Secure, HttpOnly cookie and is never sent to browser JavaScript. **Disconnect** clears that browser's saved token. To revoke the OAuth app's authorization itself, remove the app under your GitHub account's application settings.

## What publishing changes

Publishing creates a commit on the selected repository's default branch. Files with matching relative paths are replaced by the Nexus Code versions. Existing repository files not present in the Nexus workspace are retained; Nexus does not delete them. Check the repository and commit message before confirming publication.

**Export ZIP** downloads the current project files with their relative paths preserved. It does not include Nexus chat history, terminal output, or WebContainer state.
