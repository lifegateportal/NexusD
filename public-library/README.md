# EpicGlobal Public Library

This directory is a self-contained static-site project for EpicGlobal's Static Site deployment. It does not contain or call the NexusDirector backend. It reads the public book catalog and manifests from R2.

## Before deployment

Edit `public/library-config.js` and replace `REPLACE_WITH_PUBLIC_R2_URL` with the public R2 base URL. This is a public read URL, not an access key; do not put R2 credentials in this project. Configure the R2 bucket's CORS policy to allow `GET` requests from the deployed site origin.

## Deploy through Nexus Code

1. Import the contents of this directory as a new Nexus Code project named `Public Library`.
2. Select **Static Site** and deploy. The project includes `package.json`, `package-lock.json`, and an `npm run build` script; the built files are written to `dist`.
3. Use the EpicGlobal URL shown in deployment status for the public library.
4. Update the **My Library** link on the EpicGlobal website to that deployed URL.

The site uses hash-based book routes, so direct links and refreshes work without host-side rewrite rules. New publications appear from R2 without rebuilding the site. EPUB downloads are not published as files today; NexusDirector currently generates EPUBs through its API.

## Local development

```sh
npm install
npm run dev
```

The Vite server runs at `http://localhost:5173` by default.