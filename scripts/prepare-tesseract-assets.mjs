import { cp, mkdir, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(projectRoot, "public", "vendor", "tesseract");
const tesseractDirectory = dirname(require.resolve("tesseract.js/package.json"));
const coreDirectory = dirname(require.resolve("tesseract.js-core/package.json", { paths: [tesseractDirectory] }));
const workerFile = join(tesseractDirectory, "dist", "worker.min.js");
const languageDirectory = dirname(require.resolve("@tesseract.js-data/eng/package.json"));

await mkdir(destination, { recursive: true });
await cp(workerFile, join(destination, "worker.min.js"));

const coreFiles = (await readdir(coreDirectory))
  .filter((file) => /^tesseract-core.*\.(?:js|wasm)$/.test(file));
for (const file of coreFiles) {
  await cp(join(coreDirectory, file), join(destination, file));
}

await cp(
  join(languageDirectory, "4.0.0_best_int", "eng.traineddata.gz"),
  join(destination, "eng.traineddata.gz"),
);

console.log(`Prepared local Tesseract assets in ${destination}`);
