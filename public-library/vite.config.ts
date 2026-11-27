import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";

const siteRoot = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(siteRoot, "..");

export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, projectRoot, "");
  const publicR2Url = (process.env.R2_PUBLIC_URL ?? fileEnv.R2_PUBLIC_URL ?? "").replace(/\/$/, "");

  return {
    root: siteRoot,
    define: {
      "import.meta.env.VITE_LIBRARY_R2_PUBLIC_URL": JSON.stringify(publicR2Url),
    },
    build: {
      outDir: resolve(siteRoot, "dist"),
      emptyOutDir: true,
    },
  };
});