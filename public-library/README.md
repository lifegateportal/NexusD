# EpicGlobal Public Library

This static site displays the existing public library at `https://nexusdirector.epicglobal.app/library` in a full-screen frame. The original library UI, reader, navigation, and API-backed features remain on the DigitalOcean NexusDirector deployment; this project does not make a reduced duplicate.

## Deploy through Nexus Code

1. Import the contents of this directory as a Nexus Code project named `Public Library`.
2. Select **Static Site** and deploy. The project includes `package.json`, `package-lock.json`, and a Vite build that emits the static `dist/index.html`.
3. Use the EpicGlobal URL shown in deployment status as the public library address.

The NexusDirector `/library` route must remain available for the frame. Do not redirect that route to this static site, or it will create a loop.

## Local development

```sh
npm install
npm run dev
```

The Vite server runs at `http://localhost:5173` by default.