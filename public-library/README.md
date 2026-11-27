# Standalone Public Library

This static site is intended for `library.epicglobal.app`. Cloudflare Pages serves only this static frontend. Keep the NexusDirector application and API on DigitalOcean; this site does not deploy or call that backend. It reads the public book catalog and manifests directly from R2.

## Deploy to Cloudflare Pages

Create a Cloudflare Pages project from this repository for the frontend only, with:

- Root directory: `/`
- Build command: `pnpm install --frozen-lockfile && pnpm library:site:build`
- Build output directory: `public-library/dist`
- Build environment variable: `R2_PUBLIC_URL`, set to the public base URL for the R2 bucket

After the first deploy, add `library.epicglobal.app` as a custom domain in Pages and complete the DNS instructions Cloudflare provides.

## R2 CORS

Because the static site reads the public catalog and manifests in the browser, configure the R2 bucket CORS policy to allow `GET` requests from `https://library.epicglobal.app`. Add `http://localhost:5173` while testing locally. The bucket remains read-only to this site; no R2 credentials belong in the frontend.

The site reads `published/index.json` and `published/{slug}/manifest.json`, so newly published books appear without rebuilding the Pages project. This first version supports browsing and online reading. EPUB downloads are not published as files today; NexusDirector currently generates them through its DigitalOcean API. No backend URL or API CORS configuration is needed for this read-only version.

## Local development

Set `R2_PUBLIC_URL` in the repository's ignored `.env.local` file, then run:

```sh
pnpm library:site:dev
```

The Vite server runs at `http://localhost:5173` by default.