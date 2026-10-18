import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MAX_SOURCE_BYTES = 4_000_000;
const MAX_STATIC_ARCHIVE_BYTES = 95 * 1024 * 1024;
const PROJECT_NAME_PATTERN = /^nx-[a-z0-9-]{8,40}$/;
const DEPLOYMENT_ID_PATTERN = /^dep-[a-z0-9-]{36}$/;
const WORKSPACE_ID_PATTERN = /^cw-[a-z0-9-]{8,80}$/;
const REVISION_ID_PATTERN = /^cr-[a-z0-9-]{8,100}$/;
const ENV_FILE_PATTERN = /^\.env(?:$|\.(?!example$))/i;

export function parseDeploymentRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid project deployment request.");
  }
  const allowedKeys = [
    "id",
    "workspaceId",
    "revisionId",
    "kind",
    "projectName",
    "environment",
    "epicGlobalApiUrl",
    "epicGlobalApiKey",
    "files",
  ];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new Error("Deployment request contains unsupported fields.");
  }
  if (typeof value.id !== "string" || !DEPLOYMENT_ID_PATTERN.test(value.id)) {
    throw new Error("Invalid deployment id.");
  }
  if (typeof value.workspaceId !== "string" || !WORKSPACE_ID_PATTERN.test(value.workspaceId)) {
    throw new Error("Invalid workspace id.");
  }
  if (typeof value.revisionId !== "string" || !REVISION_ID_PATTERN.test(value.revisionId)) {
    throw new Error("Invalid revision id.");
  }
  if (value.kind !== "static" && value.kind !== "fullstack") {
    throw new Error("Deployment kind must be static or fullstack.");
  }
  if (typeof value.projectName !== "string" || !PROJECT_NAME_PATTERN.test(value.projectName)) {
    throw new Error("Invalid EpicGlobal project name.");
  }
  if (typeof value.epicGlobalApiUrl !== "string") throw new Error("EpicGlobal API URL is required.");
  const apiUrl = new URL(value.epicGlobalApiUrl);
  if (apiUrl.protocol !== "https:" || apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash) {
    throw new Error("EpicGlobal API URL must be a clean HTTPS URL.");
  }
  if (typeof value.epicGlobalApiKey !== "string" || value.epicGlobalApiKey.length < 1 || value.epicGlobalApiKey.length > 500) {
    throw new Error("EpicGlobal orchestrator credentials are missing.");
  }
  if (!value.environment || typeof value.environment !== "object" || Array.isArray(value.environment)) {
    throw new Error("Runtime environment variables must be an object.");
  }
  if (Object.keys(value.environment).length > 50) throw new Error("No more than 50 runtime variables are allowed.");
  let environmentBytes = 0;
  for (const [key, environmentValue] of Object.entries(value.environment)) {
    if (
      !/^[A-Z_][A-Z0-9_]{0,127}$/.test(key)
      || ["PORT", "HOST", "NODE_ENV", "PATH", "HOME"].includes(key)
      || typeof environmentValue !== "string"
      || environmentValue.length > 8_000
      || /[\r\n\0]/.test(environmentValue)
    ) {
      throw new Error(`Runtime variable ${key} is invalid.`);
    }
    environmentBytes += Buffer.byteLength(`${key}=${environmentValue}`, "utf8");
  }
  if (environmentBytes > 32_000) throw new Error("Runtime variables must total less than 32 KB.");
  if (value.kind === "static" && Object.keys(value.environment).length > 0) {
    throw new Error("Runtime variables are available for full-stack apps only.");
  }
  if (!Array.isArray(value.files) || value.files.length > 200) {
    throw new Error("A deployment can contain no more than 200 files.");
  }

  const names = new Set();
  let totalBytes = 0;
  const files = [];
  for (const file of value.files) {
    if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("Invalid coding file.");
    if (typeof file.name !== "string" || file.name.length < 1 || file.name.length > 240) {
      throw new Error("Invalid coding file path.");
    }
    const name = file.name.replaceAll("\\", "/");
    const segments = name.split("/");
    if (
      name.startsWith("/")
      || name.includes("//")
      || segments.some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw new Error("Coding file paths must be relative and normalized.");
    }
    if (names.has(name)) throw new Error(`Duplicate coding file: ${name}`);
    names.add(name);
    if (segments.some((segment) => ENV_FILE_PATTERN.test(segment))) {
      throw new Error("Remove .env secrets from the project before deploying.");
    }
    if (typeof file.content !== "string" || file.content.length > 500_000) {
      throw new Error(`Coding file ${name} is too large.`);
    }
    totalBytes += Buffer.byteLength(file.content, "utf8");
    if (totalBytes > MAX_SOURCE_BYTES) throw new Error("Coding files are too large to deploy.");
    files.push({ name, content: file.content });
  }

  const packageFile = files.find((file) => file.name === "package.json");
  if (value.kind === "fullstack") {
    if (!packageFile) throw new Error("Full-stack hosting needs a root package.json.");
    const manifest = parsePackageManifest(packageFile.content);
    if (typeof manifest.scripts?.start !== "string" || !manifest.scripts.start.trim()) {
      throw new Error("Add a start script to package.json before deploying.");
    }
  } else if (packageFile) {
    const manifest = parsePackageManifest(packageFile.content);
    if (typeof manifest.scripts?.build !== "string" && !files.some((file) => (
      file.name === "index.html" || file.name === "public/index.html"
    ))) {
      throw new Error("Static deployment needs a build script or an index.html file.");
    }
  } else if (!files.some((file) => file.name === "index.html")) {
    throw new Error("Static deployment needs a root index.html.");
  }

  return {
    id: value.id,
    workspaceId: value.workspaceId,
    revisionId: value.revisionId,
    kind: value.kind,
    projectName: value.projectName,
    environment: value.environment,
    epicGlobalApiUrl: apiUrl.origin + apiUrl.pathname.replace(/\/$/, ""),
    epicGlobalApiKey: value.epicGlobalApiKey,
    files,
  };
}

function parsePackageManifest(content) {
  let manifest;
  try {
    manifest = JSON.parse(content);
  } catch {
    throw new Error("The project root package.json is not valid JSON.");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("The project root package.json must contain an object.");
  }
  if (manifest.scripts !== undefined && (
    !manifest.scripts || typeof manifest.scripts !== "object" || Array.isArray(manifest.scripts)
  )) {
    throw new Error("The project root package.json has an invalid scripts section.");
  }
  return manifest;
}

export function deploymentPayload(build) {
  return {
    id: build.id,
    deploymentId: build.request.id,
    status: build.status,
    phase: build.phase ?? null,
    url: build.url ?? null,
    createdAt: build.createdAt,
    updatedAt: build.updatedAt,
  };
}

async function writeWorkspace(files, workRoot) {
  const directory = await mkdtemp(join(workRoot, "deploy-"));
  await chmod(directory, 0o777);
  for (const file of files) {
    if (file.name.split("/").some((segment) => segment === ".git" || segment === "node_modules" || segment === ".next")) {
      continue;
    }
    const target = join(directory, ...file.name.split("/"));
    await mkdir(dirname(target), { recursive: true, mode: 0o777 });
    await chmod(dirname(target), 0o777);
    await writeFile(target, file.content, { encoding: "utf8", mode: 0o666 });
  }
  return directory;
}

async function listFilesWithoutSymlinks(directory, relativeDirectory = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    const relPath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const info = await lstat(entryPath);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
      throw new Error("Build output may contain regular files and directories only.");
    }
    if (info.isDirectory()) files.push(...await listFilesWithoutSymlinks(entryPath, relPath));
    else files.push(relPath);
  }
  return files;
}

function runProcess(build, command, args, options, appendBuildLog, timeoutMs) {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["pipe", "pipe", "pipe"],
    });
    build.process = child;
    child.stdout.on("data", (chunk) => appendBuildLog(build, chunk));
    child.stderr.on("data", (chunk) => appendBuildLog(build, chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectProcess(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      build.process = undefined;
      if (build.cancelled) rejectProcess(new Error("Deployment was cancelled."));
      else if (timedOut) rejectProcess(new Error(`Deployment command exceeded ${timeoutMs}ms.`));
      else if (code === 0) resolveProcess();
      else rejectProcess(new Error(signal ? `Command was terminated by ${signal}.` : `Command exited with code ${code ?? 1}.`));
    });
    child.stdin.end();
  });
}

function findStaticOutput(directory, files) {
  const packageManifest = files.find((file) => file.name === "package.json");
  const manifest = packageManifest ? parsePackageManifest(packageManifest.content) : null;
  const outputDirectories = manifest?.scripts?.build
    ? ["dist", "build", "out", "public"]
    : ["public", "."];
  for (const outputName of outputDirectories) {
    const outputDirectory = outputName === "." ? directory : join(directory, outputName);
    try {
      if (
        (outputName === "." || statSyncDirectory(outputDirectory))
        && statSyncDirectory(join(outputDirectory, "index.html"), true)
      ) return outputDirectory;
    } catch {
      continue;
    }
  }
  throw new Error("Static build completed, but no supported output folder was found (dist, build, out, or public).");
}

function statSyncDirectory(path, file = false) {
  const info = statSync(path);
  return file ? info.isFile() : info.isDirectory();
}

async function makeArchive(build, sourceDirectory, archivePath, appendBuildLog, timeoutMs, skipSymlinks = false) {
  if (skipSymlinks) await listFilesWithoutSymlinks(sourceDirectory);
  await runProcess(build, "zip", ["-q", "-r", archivePath, "."], { cwd: sourceDirectory }, appendBuildLog, timeoutMs);
}

async function createSshCredentials(build, appendBuildLog) {
  const host = process.env.CODING_DEPLOY_SSH_HOST?.trim();
  const user = process.env.CODING_DEPLOY_SSH_USER?.trim() || "nexus-deploy";
  const port = Number.parseInt(process.env.CODING_DEPLOY_SSH_PORT || "22", 10);
  const privateKey = process.env.CODING_DEPLOY_SSH_PRIVATE_KEY_BASE64?.trim();
  const knownHosts = process.env.CODING_DEPLOY_SSH_KNOWN_HOSTS?.replaceAll("\\n", "\n").trim();
  if (
    !host || !/^[a-zA-Z0-9.-]+$/.test(host)
    || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user)
    || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || !privateKey || !knownHosts
  ) {
    throw new Error("Full-stack hosting is not configured on the isolated runner. Configure its restricted SSH key and known-hosts entry.");
  }
  let decodedKey;
  try {
    decodedKey = Buffer.from(privateKey, "base64");
    if (decodedKey.length < 128 || !decodedKey.toString("utf8").includes("PRIVATE KEY")) throw new Error("invalid");
  } catch {
    throw new Error("The isolated runner SSH private key is invalid.");
  }
  const tempDirectory = await mkdtemp("/tmp/nexus-epicglobal-ssh-");
  await chmod(tempDirectory, 0o700);
  const privateKeyPath = join(tempDirectory, "id_deploy");
  const knownHostsPath = join(tempDirectory, "known_hosts");
  await writeFile(privateKeyPath, decodedKey, { mode: 0o600 });
  await writeFile(knownHostsPath, `${knownHosts}\n`, { mode: 0o600 });
  appendBuildLog(build, `[runner] Connecting to the configured EpicGlobal Droplet over restricted SSH\n`);
  return {
    host,
    user,
    port,
    privateKeyPath,
    knownHostsPath,
    tempDirectory,
  };
}

function sshArguments(credentials) {
  return [
    "-i", credentials.privateKeyPath,
    "-p", String(credentials.port),
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${credentials.knownHostsPath}`,
    "-o", "ForwardAgent=no",
    "-o", "ClearAllForwardings=yes",
    "-o", "PermitLocalCommand=no",
    "-o", "ConnectTimeout=10",
    "-o", "LogLevel=ERROR",
    `${credentials.user}@${credentials.host}`,
  ];
}

async function runSshRequest(build, payload, credentials, appendBuildLog, timeoutMs) {
  let stdout = "";
  const child = spawn("ssh", sshArguments(credentials), { stdio: ["pipe", "pipe", "pipe"] });
  build.process = child;
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
    appendBuildLog(build, chunk);
  });
  child.stderr.on("data", (chunk) => appendBuildLog(build, chunk));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  }, timeoutMs);
  const result = await new Promise((resolveProcess, rejectProcess) => {
    child.once("error", rejectProcess);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      build.process = undefined;
      if (build.cancelled) rejectProcess(new Error("Deployment was cancelled."));
      else if (timedOut) rejectProcess(new Error(`Droplet deployment exceeded ${timeoutMs}ms.`));
      else if (code === 0) resolveProcess();
      else rejectProcess(new Error(signal ? `SSH was terminated by ${signal}.` : `SSH exited with code ${code ?? 1}.`));
    });
    child.stdin.end(JSON.stringify(payload));
  });
  void result;
  let response;
  try {
    response = JSON.parse(stdout.trim());
  } catch {
    throw new Error("The Droplet deployment agent returned an invalid response.");
  }
  if (!response || response.success !== true) {
    throw new Error(typeof response?.error === "string" ? response.error : "The Droplet deployment agent failed.");
  }
  return response;
}

async function uploadStaticSite(build, directory, appendBuildLog, timeoutMs) {
  const outputDirectory = findStaticOutput(directory, build.request.files);
  const outputFiles = await listFilesWithoutSymlinks(outputDirectory);
  if (!outputFiles.some((file) => file === "index.html")) {
    throw new Error("The static build output must contain index.html at its root.");
  }
  const artifactPath = join(dirname(directory), `${build.id}.zip`);
  try {
    appendBuildLog(build, `[runner] Packing ${outputFiles.length} built files for EpicGlobal\n`);
    await makeArchive(build, outputDirectory, artifactPath, appendBuildLog, timeoutMs);
    const archiveInfo = await stat(artifactPath);
    if (archiveInfo.size < 1 || archiveInfo.size > MAX_STATIC_ARCHIVE_BYTES) {
      throw new Error("Built static files must fit within EpicGlobal's 100 MB upload limit.");
    }
    const archive = await readFile(artifactPath);
    const form = new FormData();
    form.set("projectName", build.request.projectName);
    form.set("file", new Blob([archive], { type: "application/zip" }), `${build.request.projectName}.zip`);
    appendBuildLog(build, `[runner] Uploading the built static files to EpicGlobal\n`);
    const response = await fetch(`${build.request.epicGlobalApiUrl}/api/orchestrator/upload`, {
      method: "POST",
      headers: { "x-api-key": build.request.epicGlobalApiKey },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.success || typeof result.url !== "string") {
      throw new Error(typeof result?.error === "string" ? result.error : "EpicGlobal rejected the static site upload.");
    }
    const deployedUrl = new URL(result.url);
    if (deployedUrl.protocol !== "https:" || deployedUrl.hostname !== `${build.request.projectName}.epicglobal.app`) {
      throw new Error("EpicGlobal returned an unexpected static site URL.");
    }
    return deployedUrl.toString();
  } finally {
    await rm(artifactPath, { force: true });
  }
}

export async function executeDeployment(build, runtime) {
  const {
    workRoot,
    appendBuildLog,
    dockerArguments,
    runBuildCommand,
    buildTimeoutMs,
  } = runtime;
  let directory;
  let sshCredentials;
  build.status = "building";
  build.phase = build.request.kind === "static" ? "Building static files" : "Preparing full-stack source";
  build.updatedAt = new Date().toISOString();
  try {
    directory = await writeWorkspace(build.request.files, workRoot);
    if (build.cancelled) throw new Error("Deployment was cancelled.");
    if (build.request.kind === "static") {
      const command = [
        "if [ -f package.json ] && node -e 'const p=require(\"./package.json\");process.exit(p.scripts?.build?0:1)'; then",
        "  if [ -f package-lock.json ]; then npm_config_cache=/tmp/npm-cache npm ci --no-audit --no-fund;",
        "  else npm_config_cache=/tmp/npm-cache npm install --no-audit --no-fund; fi;",
        "  npm_config_cache=/tmp/npm-cache npm run build;",
        "fi",
      ].join(" ");
      const sandboxJob = {
        ...build,
        request: { ...build.request, network: true, command },
      };
      if (build.request.files.some((file) => file.name === "package.json")) {
        appendBuildLog(build, "[runner] Building the static site in the isolated container\n");
        await runBuildCommand(build, dockerArguments(sandboxJob, directory));
      }
      if (build.cancelled) throw new Error("Deployment was cancelled.");
      build.phase = "Uploading to EpicGlobal";
      build.status = "deploying";
      build.updatedAt = new Date().toISOString();
      build.url = await uploadStaticSite(build, directory, appendBuildLog, buildTimeoutMs);
    } else {
      build.phase = "Deploying to the EpicGlobal Droplet";
      build.status = "deploying";
      build.updatedAt = new Date().toISOString();
      const archivePath = join(dirname(directory), `${build.id}.zip`);
      try {
        appendBuildLog(build, "[runner] Packaging the saved project revision\n");
        await makeArchive(build, directory, archivePath, appendBuildLog, buildTimeoutMs, true);
        const archive = await readFile(archivePath);
        sshCredentials = await createSshCredentials(build, appendBuildLog);
        const response = await runSshRequest(build, {
          action: "deploy",
          deploymentId: build.request.id,
          projectName: build.request.projectName,
          revisionId: build.request.revisionId,
          archiveBase64: archive.toString("base64"),
          environment: build.request.environment,
          epicGlobalApiUrl: build.request.epicGlobalApiUrl,
          epicGlobalApiKey: build.request.epicGlobalApiKey,
        }, sshCredentials, appendBuildLog, buildTimeoutMs);
        if (typeof response.url !== "string") throw new Error("The Droplet agent did not return a public URL.");
        const deployedUrl = new URL(response.url);
        if (deployedUrl.protocol !== "https:" || deployedUrl.hostname !== `${build.request.projectName}.epicglobal.app`) {
          throw new Error("The Droplet agent returned an unexpected public URL.");
        }
        build.url = deployedUrl.toString();
      } finally {
        await rm(archivePath, { force: true });
        if (sshCredentials) await rm(sshCredentials.tempDirectory, { recursive: true, force: true });
      }
    }
    build.status = "completed";
    build.phase = "Published";
    appendBuildLog(build, `[runner] Site is live at ${build.url}\n`);
  } catch (error) {
    build.status = "failed";
    build.error = build.cancelled
      ? "Deployment was cancelled."
      : error instanceof Error ? error.message : "Deployment failed.";
    build.phase = "Failed";
    appendBuildLog(build, `\n[runner] ${build.error}\n`);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
    build.request.epicGlobalApiKey = "";
    build.request.environment = {};
    build.updatedAt = new Date().toISOString();
    build.process = undefined;
  }
}

export async function deleteHostedProject(value, timeoutMs) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid project deletion request.");
  if (Object.keys(value).some((key) => !["kind", "epicGlobalApiUrl", "epicGlobalApiKey", "projectName"].includes(key))) {
    throw new Error("Project deletion request contains unsupported fields.");
  }
  if (!PROJECT_NAME_PATTERN.test(value.projectName || "")) throw new Error("Invalid EpicGlobal project name.");
  if (value.kind !== "static" && value.kind !== "fullstack") throw new Error("Invalid deployment kind.");
  if (typeof value.epicGlobalApiUrl !== "string" || typeof value.epicGlobalApiKey !== "string" || !value.epicGlobalApiKey) {
    throw new Error("EpicGlobal orchestrator credentials are missing.");
  }
  const apiUrl = new URL(value.epicGlobalApiUrl);
  if (apiUrl.protocol !== "https:" || apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash) {
    throw new Error("EpicGlobal API URL must be a clean HTTPS URL.");
  }

  if (value.kind === "static") {
    const response = await fetch(`${apiUrl.origin + apiUrl.pathname.replace(/\/$/, "")}/api/orchestrator/delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": value.epicGlobalApiKey,
      },
      body: JSON.stringify({ projectName: value.projectName }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.success) {
      throw new Error(typeof result?.error === "string" ? result.error : "EpicGlobal could not remove the static site.");
    }
    return { success: true, logs: `${value.projectName} was removed from EpicGlobal.\n` };
  }

  const build = {
    cancelled: false,
    process: undefined,
  };
  const appendBuildLog = (_job, _chunk) => {};
  const credentials = await createSshCredentials(build, appendBuildLog);
  try {
    const response = await runSshRequest(build, {
      action: "delete",
      projectName: value.projectName,
      epicGlobalApiUrl: apiUrl.origin + apiUrl.pathname.replace(/\/$/, ""),
      epicGlobalApiKey: value.epicGlobalApiKey,
    }, credentials, appendBuildLog, timeoutMs);
    return { success: true, logs: `${value.projectName} was removed from the Droplet.\n` };
  } finally {
    await rm(credentials.tempDirectory, { recursive: true, force: true });
  }
}
