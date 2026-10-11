import { cp, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(projectRoot, "public", "vendor", "tesseract");
const coreDirectory = join(projectRoot, "node_modules", "tesseract.js-core");
const workerFile = join(projectRoot, "node_modules", "tesseract.js", "dist", "worker.min.js");
const languageDirectory = join(projectRoot, "node_modules", "@tesseract.js-data", "eng");

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
