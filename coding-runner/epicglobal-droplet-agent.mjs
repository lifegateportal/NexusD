import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  chown,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const CONFIG_PATH = process.env.NEXUS_DEPLOY_AGENT_CONFIG || "/etc/nexus-deploy-agent.json";
const PROJECT_PATTERN = /^nx-[a-z0-9-]{8,40}$/;
const DEPLOYMENT_PATTERN = /^dep-[a-z0-9-]{36}$/;
const REVISION_PATTERN = /^cr-[a-z0-9-]{8,100}$/;
const MAX_REQUEST_BYTES = 16_000_000;
const MAX_COMMAND_OUTPUT = 256_000;
const BUILD_TIMEOUT_MS = 8 * 60 * 1000;
const PM2_SUPERVISOR_PATH = "/usr/local/libexec/nexus-droplet-agent.mjs";

function writeLog(message) {
  process.stderr.write(`[nexus-deploy] ${message}\n`);
}

function cleanApiBase(value) {
  if (typeof value !== "string") throw new Error("EpicGlobal API URL is required.");
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("EpicGlobal API URL must be a clean HTTPS URL.");
  }
  return parsed.origin + parsed.pathname.replace(/\/$/, "");
}

async function readRequest() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("Deployment request is too large.");
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Deployment request must be valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Deployment request must be a JSON object.");
  }
  return value;
}

function exactKeys(value, allowed) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error("Deployment request contains unsupported fields.");
  }
}

function parseDeployRequest(value) {
  exactKeys(value, [
    "action",
    "deploymentId",
    "projectName",
    "revisionId",
    "archiveBase64",
    "environment",
    "epicGlobalApiUrl",
    "epicGlobalApiKey",
  ]);
  if (value.action !== "deploy") throw new Error("Unsupported deployment action.");
  if (typeof value.projectName !== "string" || !PROJECT_PATTERN.test(value.projectName)) {
    throw new Error("Invalid EpicGlobal project name.");
  }
  if (typeof value.deploymentId !== "string" || !DEPLOYMENT_PATTERN.test(value.deploymentId)) {
    throw new Error("Invalid deployment id.");
  }
  if (typeof value.revisionId !== "string" || !REVISION_PATTERN.test(value.revisionId)) {
    throw new Error("Invalid revision id.");
  }
  if (typeof value.archiveBase64 !== "string" || value.archiveBase64.length < 1 || value.archiveBase64.length > 14_000_000) {
    throw new Error("Project archive is missing or too large.");
  }
  const archive = Buffer.from(value.archiveBase64, "base64");
  if (archive.length < 1 || archive.length > 10_500_000) throw new Error("Project archive is too large.");
  if (archive.toString("base64") !== value.archiveBase64) throw new Error("Project archive encoding is invalid.");
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
  if (typeof value.epicGlobalApiKey !== "string" || value.epicGlobalApiKey.length < 1 || value.epicGlobalApiKey.length > 500) {
    throw new Error("EpicGlobal orchestrator credentials are missing.");
  }
  return {
    ...value,
    apiBase: cleanApiBase(value.epicGlobalApiUrl),
    archive,
  };
}

function parseDeleteRequest(value) {
  exactKeys(value, ["action", "projectName", "epicGlobalApiUrl", "epicGlobalApiKey"]);
  if (value.action !== "delete") throw new Error("Unsupported project action.");
  if (typeof value.projectName !== "string" || !PROJECT_PATTERN.test(value.projectName)) {
    throw new Error("Invalid EpicGlobal project name.");
  }
  if (typeof value.epicGlobalApiKey !== "string" || value.epicGlobalApiKey.length < 1 || value.epicGlobalApiKey.length > 500) {
    throw new Error("EpicGlobal orchestrator credentials are missing.");
  }
  return { ...value, apiBase: cleanApiBase(value.epicGlobalApiUrl) };
}

async function loadConfig() {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch (error) {
    throw new Error(`Could not read the deploy-agent configuration: ${error instanceof Error ? error.message : "invalid file"}`);
  }
  const config = {
    registryPath: parsed?.registryPath,
    deploymentRoot: parsed?.deploymentRoot,
    stateRoot: parsed?.stateRoot,
    pm2User: parsed?.pm2User,
    pm2Home: parsed?.pm2Home,
  };
  if (
    !parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.keys(parsed).some((key) => !["registryPath", "deploymentRoot", "stateRoot", "pm2User", "pm2Home"].includes(key))
  ) {
    throw new Error("Deploy-agent configuration contains unsupported fields.");
  }
  for (const [key, value] of Object.entries(config)) {
    if (key === "pm2User") continue;
    if (
      typeof value !== "string"
      || !value.startsWith("/")
      || /[\r\n= ]/.test(value)
    ) {
      throw new Error(`Invalid absolute path configured for ${key}.`);
    }
    config[key] = resolve(value);
  }
  if (
    typeof config.pm2User !== "string"
    || !/^[a-z_][a-z0-9_-]{0,31}$/.test(config.pm2User)
    || config.deploymentRoot === "/"
    || config.stateRoot === "/"
    || config.registryPath === "/"
  ) {
    throw new Error("Deploy-agent paths must not point to the filesystem root.");
  }
  return config;
}

async function run(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, options.timeoutMs ?? BUILD_TIMEOUT_MS);
    const capture = (chunk) => {
      if (output.length < MAX_COMMAND_OUTPUT) output += chunk.toString("utf8").slice(0, MAX_COMMAND_OUTPUT - output.length);
      if (options.stream) options.stream(chunk);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectCommand(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) rejectCommand(new Error(`Command exceeded ${options.timeoutMs ?? BUILD_TIMEOUT_MS}ms.`));
      else if (code === 0) resolveCommand(output);
      else rejectCommand(new Error(
        `${command} failed${signal ? ` (${signal})` : ` with exit code ${code ?? 1}`}${output ? `: ${output.slice(-6000)}` : ""}`,
      ));
    });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function safeChildPath(parent, child) {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(resolvedParent, child);
  const fromParent = relative(resolvedParent, resolvedChild);
  if (!fromParent || fromParent.startsWith("..") || fromParent.includes(sep) && fromParent.split(sep).includes("..")) {
    throw new Error("Deployment path escaped its configured root.");
  }
  return resolvedChild;
}

async function atomicWriteJson(path, value) {
  const parent = dirname(path);
  const existing = await stat(path).catch((error) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  const tempPath = join(parent, `.nexus-${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      mode: existing ? existing.mode & 0o777 : 0o640,
      flag: "wx",
    });
    if (existing) {
      const old = await lstat(path);
      await chown(tempPath, old.uid, old.gid);
    }
    await rename(tempPath, path);
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function readRegistry(registryPath) {
  let registry;
  try {
    registry = JSON.parse(await readFile(registryPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read EpicGlobal projects.json: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
  if (
    !registry || typeof registry !== "object" || Array.isArray(registry)
    || !registry.projects || typeof registry.projects !== "object" || Array.isArray(registry.projects)
  ) {
    throw new Error("EpicGlobal projects.json has an unsupported format.");
  }
  return registry;
}

async function callRepair(apiBase, apiKey) {
  const response = await fetch(`${apiBase}/api/orchestrator/repair`, {
    method: "POST",
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) {
    throw new Error(typeof payload?.error === "string" ? payload.error : "EpicGlobal could not rebuild its Caddy routes.");
  }
  if (Array.isArray(payload.errors)) {
    const routeErrors = payload.errors.filter((message) => (
      typeof message === "string" && message.startsWith("caddy reload:")
    ));
    const otherErrors = payload.errors.filter((message) => (
      typeof message === "string" && !message.startsWith("caddy reload:")
    ));
    if (otherErrors.length > 0) writeLog(`EpicGlobal reported unrelated reconciliation warnings: ${otherErrors.join("; ")}`);
    if (routeErrors.length > 0) throw new Error(`EpicGlobal could not reload Caddy: ${routeErrors.join("; ")}`);
  }
}

async function checkPort(port) {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(port, "127.0.0.1", () => server.close((error) => (
      error ? rejectPort(error) : resolvePort()
    )));
  });
}

async function allocatePort(registry, currentProjectName) {
  const usedPorts = new Set(Object.entries(registry.projects)
    .filter(([name]) => name !== currentProjectName)
    .map(([, project]) => Number(project?.port))
    .filter((port) => Number.isInteger(port)));
  let candidate = Number.isInteger(registry.nextPort) ? Math.max(5100, registry.nextPort) : 5100;
  for (; candidate <= 60_000; candidate += 1) {
    if (usedPorts.has(candidate)) continue;
    try {
      await checkPort(candidate);
      return candidate;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") continue;
      throw error;
    }
  }
  throw new Error("EpicGlobal has no free port in the Nexus deployment range (5100-60000).");
}

async function ensureServiceUser(projectName) {
  const user = `nx_${createHash("sha256").update(projectName).digest("hex").slice(0, 20)}`;
  const usersRoot = "/var/lib/nexus-deploy-users";
  const home = safeChildPath(usersRoot, user);
  let accountRecord = null;
  try {
    accountRecord = await run("/usr/bin/getent", ["passwd", user], { timeoutMs: 5_000 });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("exit code 2")) throw error;
  }
  if (accountRecord) {
    const fields = accountRecord.trim().split(":");
    if (fields[0] !== user || fields[5] !== home || fields[6] !== "/usr/sbin/nologin") {
      throw new Error(`Refusing to use the existing ${user} account because it does not match Nexus service-account settings.`);
    }
  }
  await mkdir(usersRoot, { recursive: true, mode: 0o711 });
  await chmod(usersRoot, 0o711);
  await mkdir(home, { recursive: true, mode: 0o700 });
  if (!accountRecord) {
    await run("/usr/sbin/useradd", [
      "--system",
      "--user-group",
      "--home-dir", home,
      "--create-home",
      "--shell", "/usr/sbin/nologin",
      user,
    ], { timeoutMs: 10_000 });
    accountRecord = await run("/usr/bin/getent", ["passwd", user], { timeoutMs: 5_000 });
  }
  const fields = accountRecord.trim().split(":");
  if (fields[0] !== user || fields[5] !== home || fields[6] !== "/usr/sbin/nologin") {
    throw new Error("Could not verify the Nexus project service account.");
  }
  const uid = Number.parseInt(fields[2], 10);
  if (!Number.isSafeInteger(uid) || uid < 1) throw new Error("Could not create the project service account.");
  await chown(home, uid, uid);
  await chmod(home, 0o700);
  return { user, home, uid };
}

async function findNpm() {
  for (const candidate of ["/usr/bin/npm", "/usr/local/bin/npm"]) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error("Install system-wide Node.js and npm on the EpicGlobal Droplet (expected /usr/bin/npm).");
}

async function findPm2() {
  for (const candidate of ["/usr/bin/pm2", "/usr/local/bin/pm2"]) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error("Install PM2 system-wide for the EpicGlobal process user.");
}

async function runAsPm2User(config, args, options = {}) {
  const pm2Path = await findPm2();
  const home = config.pm2Home;
  if (config.pm2User === "root") {
    return run(pm2Path, args, {
      ...options,
      env: { ...process.env, HOME: home, PM2_HOME: join(home, ".pm2") },
    });
  }
  return run("/usr/sbin/runuser", [
    "-u", config.pm2User,
    "--",
    "/usr/bin/env",
    `HOME=${home}`,
    `PM2_HOME=${join(home, ".pm2")}`,
    pm2Path,
    ...args,
  ], options);
}

async function configurePm2Controller(config, projectName) {
  if (config.pm2User === "root") return;
  const sudoersPath = `/etc/sudoers.d/nexus-${projectName}`;
  const tempPath = `${sudoersPath}.tmp`;
  const command = `/usr/bin/node /usr/local/libexec/nexus-droplet-agent.mjs --restart-service ${projectName}`;
  await writeFile(tempPath, `${config.pm2User} ALL=(root) NOPASSWD: ${command}\n`, { mode: 0o440 });
  await chmod(tempPath, 0o440);
  try {
    await run("/usr/sbin/visudo", ["-cf", tempPath], { timeoutMs: 10_000 });
    await rename(tempPath, sudoersPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw new Error(`Could not configure the restricted PM2 service controller: ${error.message}`);
  }
}

async function removePm2Controller(config, projectName) {
  if (config.pm2User !== "root") {
    await rm(`/etc/sudoers.d/nexus-${projectName}`, { force: true });
  }
}

async function ensurePm2Supervisor(config, projectName) {
  await configurePm2Controller(config, projectName);
  let processes;
  try {
    processes = JSON.parse(await runAsPm2User(config, ["jlist"], { timeoutMs: 15_000 }) || "[]");
  } catch (error) {
    throw new Error(`Could not access EpicGlobal's PM2 process manager: ${error.message}`);
  }
  if (!Array.isArray(processes)) throw new Error("EpicGlobal PM2 returned an invalid process list.");
  const existing = processes.find((process) => process?.name === projectName);
  if (existing && !isNexusPm2Supervisor(existing, projectName)) {
    throw new Error(`EpicGlobal PM2 already has a non-Nexus process named ${projectName}.`);
  }
  if (existing) {
    await runAsPm2User(config, ["restart", projectName], { timeoutMs: 20_000 });
  } else {
    await runAsPm2User(config, [
      "start",
      PM2_SUPERVISOR_PATH,
      "--name", projectName,
      "--interpreter", "/usr/bin/node",
      "--max-memory-restart", "128M",
      "--",
      "--supervisor", projectName,
    ], { timeoutMs: 20_000 });
  }
  await runAsPm2User(config, ["save"], { timeoutMs: 20_000 });
  for (let attempt = 0; attempt < 35; attempt += 1) {
    const refreshed = JSON.parse(await runAsPm2User(config, ["jlist"], { timeoutMs: 15_000 }) || "[]");
    if (!Array.isArray(refreshed)) throw new Error("EpicGlobal PM2 returned an invalid process list.");
    const supervisor = refreshed.find((process) => process?.name === projectName);
    if (supervisor && !isNexusPm2Supervisor(supervisor, projectName)) {
      throw new Error(`EpicGlobal PM2 process ${projectName} is not the Nexus health supervisor.`);
    }
    if (supervisor?.pm2_env?.status === "online") return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  throw new Error(`EpicGlobal PM2 could not bring the health supervisor for ${projectName} online.`);
}

async function removePm2Supervisor(config, projectName) {
  const processes = JSON.parse(await runAsPm2User(config, ["jlist"], { timeoutMs: 15_000 }) || "[]");
  if (!Array.isArray(processes)) throw new Error("EpicGlobal PM2 returned an invalid process list.");
  const supervisor = processes.find((process) => process?.name === projectName);
  if (supervisor && !isNexusPm2Supervisor(supervisor, projectName)) {
    throw new Error(`Refusing to remove the unrelated EpicGlobal PM2 process named ${projectName}.`);
  }
  if (supervisor) {
    await runAsPm2User(config, ["delete", projectName], { timeoutMs: 20_000 });
    await runAsPm2User(config, ["save"], { timeoutMs: 20_000 });
  }
}

function isNexusPm2Supervisor(process, projectName) {
  const args = process?.pm2_env?.args;
  return process?.name === projectName
    && process.pm2_env?.pm_exec_path === PM2_SUPERVISOR_PATH
    && Array.isArray(args)
    && args.length === 2
    && args[0] === "--supervisor"
    && args[1] === projectName;
}

async function restartProjectService(projectName, config) {
  if (!PROJECT_PATTERN.test(projectName)) throw new Error("Invalid EpicGlobal project name.");
  const state = await readProjectState(config.stateRoot, projectName);
  if (
    !state
    || state.projectName !== projectName
    || typeof state.unitName !== "string"
    || !new RegExp(`^nexus-${projectName}-dep-[a-z0-9-]{36}\\.service$`).test(state.unitName)
  ) {
    throw new Error("No valid systemd deployment is registered for this project.");
  }
  if (!state.disabled) await run("/usr/bin/systemctl", ["restart", state.unitName], { timeoutMs: 30_000 });
}

async function runSupervisor(projectName) {
  if (!PROJECT_PATTERN.test(projectName)) throw new Error("Invalid EpicGlobal project name.");
  let stopped = false;
  let failures = 0;
  let busy = false;
  const restart = async () => {
    if (busy || stopped) return false;
    busy = true;
    try {
      if (process.getuid?.() === 0) {
        await restartProjectService(projectName, await loadConfig());
      } else {
        await run("/usr/bin/sudo", [
          "-n",
          "/usr/bin/node",
          "/usr/local/libexec/nexus-droplet-agent.mjs",
          "--restart-service",
          projectName,
        ], { timeoutMs: 35_000 });
      }
      failures = 0;
      return true;
    } catch (error) {
      writeLog(`Health supervisor could not restart ${projectName}: ${error.message}`);
      return false;
    } finally {
      busy = false;
    }
  };
  if (!await restart()) throw new Error(`Could not start the hosted service for ${projectName}.`);
  const timer = setInterval(async () => {
    if (stopped || busy) return;
    try {
      const response = await fetch(`https://${projectName}.epicglobal.app/`, {
        signal: AbortSignal.timeout(5_000),
      });
      await response.body?.cancel();
      failures = response.status < 500 ? 0 : failures + 1;
    } catch {
      failures += 1;
    }
    if (failures >= 2) await restart();
  }, 20_000);
  const shutdown = () => {
    stopped = true;
    clearInterval(timer);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function systemdUnitName(projectName, deploymentId) {
  return `nexus-${projectName}-${deploymentId}.service`;
}

function systemdUnitContent({ projectName, user, releasePath, environmentPath, npmPath, port }) {
  return [
    "[Unit]",
    `Description=Nexus hosted project ${projectName}`,
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${user}`,
    `Group=${user}`,
    `WorkingDirectory=${releasePath}`,
    `Environment=NODE_ENV=production`,
    `Environment=PORT=${port}`,
    "Environment=HOST=0.0.0.0",
    "Environment=PATH=/usr/local/bin:/usr/bin:/bin",
    `EnvironmentFile=${environmentPath}`,
    `ExecStart=${npmPath} run start`,
    "Restart=on-failure",
    "RestartSec=3",
    "MemoryMax=512M",
    "CPUQuota=100%",
    "TasksMax=128",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "PrivateDevices=true",
    "ProtectSystem=strict",
    "ProtectHome=true",
    "ProtectKernelTunables=true",
    "ProtectKernelModules=true",
    "ProtectControlGroups=true",
    "RestrictSUIDSGID=true",
    "LockPersonality=true",
    "CapabilityBoundingSet=",
    "ReadWritePaths=" + releasePath + " /tmp",
    "UMask=0027",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

async function startLimitedCommand(user, home, releasePath, port, unitId, command, args) {
  const environment = [
    `--setenv=HOME=${home}`,
    "--setenv=PATH=/usr/local/bin:/usr/bin:/bin",
    `--setenv=PORT=${port}`,
    "--setenv=CI=true",
  ];
  const systemdArgs = [
    "--quiet",
    "--wait",
    "--pipe",
    "--collect",
    `--unit=nexus-build-${unitId}`,
    `--uid=${user}`,
    `--property=WorkingDirectory=${releasePath}`,
    "--property=MemoryMax=1G",
    "--property=CPUQuota=100%",
    "--property=TasksMax=128",
    "--property=RuntimeMaxSec=480s",
    ...environment,
    command,
    ...args,
  ];
  await run("/usr/bin/systemd-run", systemdArgs, { timeoutMs: BUILD_TIMEOUT_MS, cwd: releasePath });
}

function validateZipEntries(archive) {
  if (archive.length < 22) throw new Error("Project archive is not a valid ZIP file.");
  let eocd = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_557); offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("Project archive is not a valid ZIP file.");
  const entryCount = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error("Project archive has an invalid directory entry.");
    const hostSystem = archive.readUInt16LE(offset + 4) >> 8;
    const fileNameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    if (hostSystem === 3) {
      const fileType = (externalAttributes >>> 16) & 0o170000;
      if (fileType && fileType !== 0o100000 && fileType !== 0o040000) {
        throw new Error("Project archive may not contain symbolic links or special files.");
      }
    }
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
}

async function normalizeExtractedTree(directory, uid) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
      throw new Error("Project archive may contain regular files and directories only.");
    }
    await chown(path, uid, uid);
    if (info.isDirectory()) {
      await chmod(path, 0o750);
      await normalizeExtractedTree(path, uid);
    } else {
      await chmod(path, 0o640);
    }
  }
}

async function validateAndExtractArchive(archive, archivePath, targetPath, uid) {
  validateZipEntries(archive);
  await writeFile(archivePath, archive, { mode: 0o600 });
  const listing = await run("/usr/bin/unzip", ["-Z1", archivePath], { timeoutMs: 15_000 });
  const entries = listing.split(/\r?\n/).filter(Boolean);
  if (entries.length > 20_000) throw new Error("Project archive contains too many files.");
  for (const entry of entries) {
    if (entry === "." || entry === "./") continue;
    const normalized = entry.replace(/^\.\//, "").replace(/\/$/, "");
    const segments = normalized.split("/");
    if (
      !normalized
      || normalized.startsWith("/")
      || normalized.includes("\\")
      || segments.some((segment) => !segment || segment === "." || segment === "..")
      || segments.some((segment) => /^\.env(?:$|\.(?!example$))/i.test(segment))
    ) {
      throw new Error("Project archive contains an unsafe or secret file path.");
    }
  }
  await mkdir(targetPath, { recursive: true, mode: 0o700 });
  await run("/usr/bin/unzip", ["-qq", archivePath, "-d", targetPath], { timeoutMs: 30_000 });
  await chown(targetPath, uid, uid);
  await chmod(targetPath, 0o750);
  await normalizeExtractedTree(targetPath, uid);
  const manifestPath = join(targetPath, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error("The uploaded project does not have a valid root package.json.");
  }
  if (typeof manifest?.scripts?.start !== "string" || !manifest.scripts.start.trim()) {
    throw new Error("Add a start script to package.json before deploying the full-stack app.");
  }
}

async function waitForHealthy(port, timeoutMs = 60_000) {
  const endAt = Date.now() + timeoutMs;
  let lastError = "The application did not start listening.";
  while (Date.now() < endAt) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (response.status < 500) {
        await response.body?.cancel();
        return;
      }
      lastError = `The application returned HTTP ${response.status}.`;
      await response.body?.cancel();
    } catch (error) {
      lastError = error instanceof Error ? error.message : "The application health check failed.";
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  throw new Error(`Application health check failed: ${lastError}`);
}

function projectStatePath(stateRoot, projectName) {
  return safeChildPath(stateRoot, `${projectName}.json`);
}

async function readProjectState(stateRoot, projectName) {
  try {
    return JSON.parse(await readFile(projectStatePath(stateRoot, projectName), "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw new Error(`Could not read existing Nexus deployment state: ${error instanceof Error ? error.message : "invalid file"}`);
  }
}

async function removeRelease(config, projectName, state) {
  if (!state) return;
  if (typeof state.unitName === "string" && /^[a-z0-9-]+\.service$/.test(state.unitName)) {
    await run("/usr/bin/systemctl", ["disable", "--now", state.unitName], { timeoutMs: 30_000 }).catch((error) => {
      writeLog(`Could not stop the previous service cleanly: ${error.message}`);
    });
    await rm(`/etc/systemd/system/${state.unitName}`, { force: true });
  }
  if (typeof state.releasePath === "string") {
    const expectedRoot = safeChildPath(config.deploymentRoot, projectName);
    const releasePath = resolve(state.releasePath);
    if (releasePath.startsWith(`${expectedRoot}${sep}`)) {
      await rm(releasePath, { recursive: true, force: true });
    }
  }
  if (typeof state.environmentPath === "string") {
    const environmentRoot = resolve(config.stateRoot, "environment");
    const environmentPath = resolve(state.environmentPath);
    if (environmentPath.startsWith(`${environmentRoot}${sep}`)) {
      await rm(environmentPath, { force: true });
    }
  }
}

function environmentFileContents(values) {
  return Object.entries(values)
    .map(([key, value]) => `${key}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)
    .join("\n") + (Object.keys(values).length ? "\n" : "");
}

async function deployProject(request, config) {
  await mkdir(config.deploymentRoot, { recursive: true, mode: 0o755 });
  await chmod(config.deploymentRoot, 0o755);
  await mkdir(config.stateRoot, { recursive: true, mode: 0o700 });
  await chmod(config.stateRoot, 0o700);
  const originalRegistry = await readRegistry(config.registryPath);
  const previousState = await readProjectState(config.stateRoot, request.projectName);
  if (!previousState && originalRegistry.projects[request.projectName]) {
    throw new Error("This EpicGlobal project name is already in use by a deployment Nexus does not manage.");
  }
  const previousProject = originalRegistry.projects[request.projectName] ?? null;
  const port = await allocatePort(originalRegistry, request.projectName);
  const serviceAccount = await ensureServiceUser(request.projectName);
  const projectRoot = safeChildPath(config.deploymentRoot, request.projectName);
  const releasesRoot = join(projectRoot, "releases");
  const releasePath = safeChildPath(releasesRoot, request.deploymentId);
  const unitName = systemdUnitName(request.projectName, request.deploymentId);
  const unitPath = `/etc/systemd/system/${unitName}`;
  const archivePath = join(config.stateRoot, `${request.deploymentId}.zip`);
  const environmentRoot = safeChildPath(config.stateRoot, "environment");
  const environmentPath = safeChildPath(environmentRoot, `${request.projectName}-${request.deploymentId}.env`);
  let candidateStarted = false;
  let registryChanged = false;
  let stateChanged = false;
  let supervisorTouched = false;
  try {
    await mkdir(releasesRoot, { recursive: true, mode: 0o755 });
    await mkdir(releasePath, { recursive: true, mode: 0o700 });
    await validateAndExtractArchive(request.archive, archivePath, releasePath, serviceAccount.uid);
    const npmPath = await findNpm();
    const lockPath = join(releasePath, "package-lock.json");
    const hasLock = await access(lockPath).then(() => true).catch(() => false);
    const installArgs = hasLock
      ? ["ci", "--no-audit", "--no-fund"]
      : ["install", "--no-audit", "--no-fund"];
    writeLog(`Installing dependencies for ${request.projectName}.`);
    await startLimitedCommand(
      serviceAccount.user,
      serviceAccount.home,
      releasePath,
      port,
      request.deploymentId,
      npmPath,
      installArgs,
    );
    await startLimitedCommand(
      serviceAccount.user,
      serviceAccount.home,
      releasePath,
      port,
      request.deploymentId,
      npmPath,
      ["run", "build", "--if-present"],
    );
    await startLimitedCommand(
      serviceAccount.user,
      serviceAccount.home,
      releasePath,
      port,
      request.deploymentId,
      npmPath,
      ["prune", "--omit=dev", "--no-audit", "--no-fund"],
    );
    if (await access(unitPath).then(() => true).catch(() => false)) {
      throw new Error("A systemd unit with this deployment id already exists.");
    }
    await mkdir(environmentRoot, { recursive: true, mode: 0o700 });
    await chmod(environmentRoot, 0o700);
    await writeFile(environmentPath, environmentFileContents(request.environment), { mode: 0o600, flag: "wx" });
    await writeFile(unitPath, systemdUnitContent({
      projectName: request.projectName,
      user: serviceAccount.user,
      releasePath,
      environmentPath,
      npmPath,
      port,
    }), { mode: 0o644, flag: "wx" });
    await run("/usr/bin/systemctl", ["daemon-reload"], { timeoutMs: 30_000 });
    await run("/usr/bin/systemctl", ["enable", "--now", unitName], { timeoutMs: 30_000 });
    candidateStarted = true;
    await waitForHealthy(port);

    const registry = await readRegistry(config.registryPath);
    const occupiedPort = Object.entries(registry.projects).some(([name, project]) => (
      name !== request.projectName && Number(project?.port) === port
    ));
    if (occupiedPort) throw new Error("The selected app port was allocated to another EpicGlobal project during this build. Retry the deployment.");
    registry.nextPort = Math.max(Number.isInteger(registry.nextPort) ? registry.nextPort : 5100, port + 1);
    registry.projects[request.projectName] = {
      name: request.projectName,
      repoUrl: null,
      deployType: "nexus",
      domain: null,
      port,
      health: { status: "online", memory: 0, cpu: 0, restarts: 0 },
      deployedAt: new Date().toISOString(),
    };
    await atomicWriteJson(config.registryPath, registry);
    registryChanged = true;
    await callRepair(request.apiBase, request.epicGlobalApiKey);
    const nextState = {
      projectName: request.projectName,
      deploymentId: request.deploymentId,
      revisionId: request.revisionId,
      unitName,
      releasePath,
      environmentPath,
      port,
      user: serviceAccount.user,
      deployedAt: new Date().toISOString(),
    };
    await atomicWriteJson(projectStatePath(config.stateRoot, request.projectName), nextState);
    stateChanged = true;
    supervisorTouched = true;
    await ensurePm2Supervisor(config, request.projectName);
    await callRepair(request.apiBase, request.epicGlobalApiKey);
    registryChanged = false;
    stateChanged = false;
    await removeRelease(config, request.projectName, previousState).catch((cleanupError) => {
      writeLog(`New release is live, but previous-release cleanup failed: ${cleanupError.message}`);
    });
    await rm(archivePath, { force: true }).catch((cleanupError) => {
      writeLog(`New release is live, but archive cleanup failed: ${cleanupError.message}`);
    });
    await run("/usr/bin/systemctl", ["daemon-reload"], { timeoutMs: 30_000 }).catch((error) => {
      writeLog(`Old release cleanup completed with a systemd warning: ${error.message}`);
    });
    writeLog(`Deployed ${request.projectName} on port ${port}.`);
    return {
      success: true,
      url: `https://${request.projectName}.epicglobal.app`,
    };
  } catch (error) {
    if (registryChanged) {
      try {
        const restoreRegistry = await readRegistry(config.registryPath);
        if (previousProject) restoreRegistry.projects[request.projectName] = previousProject;
        else delete restoreRegistry.projects[request.projectName];
        await atomicWriteJson(config.registryPath, restoreRegistry);
      } catch (restoreError) {
        writeLog(`CRITICAL: registry rollback failed: ${restoreError.message}`);
      }
    }
    if (stateChanged) {
      if (previousState) {
        await atomicWriteJson(projectStatePath(config.stateRoot, request.projectName), previousState).catch((restoreError) => {
          writeLog(`CRITICAL: previous project state restore failed: ${restoreError.message}`);
        });
      } else {
        await rm(projectStatePath(config.stateRoot, request.projectName), { force: true });
      }
    }
    if (registryChanged || stateChanged) {
      await callRepair(request.apiBase, request.epicGlobalApiKey).catch((repairError) => {
        writeLog(`Caddy rollback could not be confirmed: ${repairError.message}`);
      });
    }
    if (supervisorTouched) {
      if (previousState) {
        await ensurePm2Supervisor(config, request.projectName).catch((cleanupError) => {
          writeLog(`Could not restore the existing PM2 supervisor: ${cleanupError.message}`);
        });
      } else {
        await removePm2Supervisor(config, request.projectName).catch((cleanupError) => {
          writeLog(`Could not remove the failed PM2 supervisor: ${cleanupError.message}`);
        });
        await removePm2Controller(config, request.projectName).catch((cleanupError) => {
          writeLog(`Could not remove the failed PM2 service controller: ${cleanupError.message}`);
        });
      }
    }
    if (candidateStarted || await access(unitPath).then(() => true).catch(() => false)) {
      await run("/usr/bin/systemctl", ["disable", "--now", unitName], { timeoutMs: 30_000 }).catch((cleanupError) => {
        writeLog(`Could not stop failed candidate service: ${cleanupError.message}`);
      });
      await rm(unitPath, { force: true });
      await run("/usr/bin/systemctl", ["daemon-reload"], { timeoutMs: 30_000 }).catch((cleanupError) => {
        writeLog(`Could not reload systemd after failed deployment: ${cleanupError.message}`);
      });
    }
    await rm(releasePath, { recursive: true, force: true });
    await rm(archivePath, { force: true });
    await rm(environmentPath, { force: true });
    if (!previousState) {
      await run("/usr/sbin/userdel", ["--remove", serviceAccount.user], { timeoutMs: 30_000 }).catch((cleanupError) => {
        writeLog(`Failed-deployment account cleanup warning: ${cleanupError.message}`);
      });
    }
    throw error;
  }
}

async function deleteProject(request, config) {
  const state = await readProjectState(config.stateRoot, request.projectName);
  const originalRegistry = await readRegistry(config.registryPath);
  if (!state) throw new Error("This project is not managed by the Nexus deployment agent.");

  if (state) {
    await atomicWriteJson(projectStatePath(config.stateRoot, request.projectName), {
      ...state,
      disabled: true,
    });
    await run("/usr/bin/systemctl", ["stop", state.unitName], { timeoutMs: 30_000 }).catch((error) => {
      writeLog(`Could not stop the existing service cleanly: ${error.message}`);
    });
  }
  const previousEntry = originalRegistry.projects[request.projectName];
  try {
    delete originalRegistry.projects[request.projectName];
    await atomicWriteJson(config.registryPath, originalRegistry);
    await callRepair(request.apiBase, request.epicGlobalApiKey);
  } catch (error) {
    const restoreRegistry = await readRegistry(config.registryPath);
    restoreRegistry.projects[request.projectName] = previousEntry;
    await atomicWriteJson(config.registryPath, restoreRegistry).catch((restoreError) => {
      writeLog(`CRITICAL: registry rollback failed: ${restoreError.message}`);
    });
    await callRepair(request.apiBase, request.epicGlobalApiKey).catch((repairError) => {
      writeLog(`Caddy rollback could not be confirmed: ${repairError.message}`);
    });
    if (state) {
      await atomicWriteJson(projectStatePath(config.stateRoot, request.projectName), state).catch((restoreError) => {
        writeLog(`Could not restore project state after deletion failure: ${restoreError.message}`);
      });
      await run("/usr/bin/systemctl", ["start", state.unitName], { timeoutMs: 30_000 }).catch((restartError) => {
        writeLog(`Could not restart the previous service: ${restartError.message}`);
      });
      await ensurePm2Supervisor(config, request.projectName).catch((restartError) => {
        writeLog(`Could not restore the PM2 health supervisor: ${restartError.message}`);
      });
    }
    throw error;
  }

  await removePm2Supervisor(config, request.projectName);
  if (state) await removeRelease(config, request.projectName, state);
  const projectRoot = safeChildPath(config.deploymentRoot, request.projectName);
  await rm(projectRoot, { recursive: true, force: true });
  await rm(projectStatePath(config.stateRoot, request.projectName), { force: true });
  if (state?.user && /^nx_[a-z0-9_]{1,24}$/.test(state.user)) {
    await run("/usr/sbin/userdel", ["--remove", state.user], { timeoutMs: 30_000 }).catch((error) => {
      writeLog(`Project service account cleanup warning: ${error.message}`);
    });
  }
  await removePm2Controller(config, request.projectName);
  await run("/usr/bin/systemctl", ["daemon-reload"], { timeoutMs: 30_000 }).catch((error) => {
    writeLog(`Systemd cleanup warning: ${error.message}`);
  });
  return { success: true };
}

async function main() {
  if (process.argv[2] === "--supervisor") {
    if (process.argv.length !== 4) throw new Error("Invalid supervisor invocation.");
    await runSupervisor(process.argv[3]);
    return;
  }
  if (process.argv[2] === "--restart-service") {
    if (process.getuid?.() !== 0 || process.argv.length !== 4) {
      throw new Error("Invalid restricted service-controller invocation.");
    }
    const config = await loadConfig();
    await restartProjectService(process.argv[3], config);
    process.stdout.write("Service restart requested.\n");
    return;
  }
  if (process.getuid?.() !== 0) throw new Error("The restricted deploy agent must run through its root-owned sudo wrapper.");
  const request = await readRequest();
  const config = await loadConfig();
  let result;
  if (request.action === "deploy") {
    result = await deployProject(parseDeployRequest(request), config);
  } else if (request.action === "delete") {
    const deletion = parseDeleteRequest(request);
    result = await deleteProject(deletion, config);
  } else {
    throw new Error("Unsupported deploy-agent action.");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export {
  environmentFileContents,
  parseDeleteRequest,
  parseDeployRequest,
  safeChildPath,
  validateZipEntries,
};

const invokedScript = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (import.meta.url === invokedScript) {
  main().catch((error) => {
    writeLog(error instanceof Error ? error.message : "Deployment agent failed.");
    if (process.argv[2] !== "--supervisor") {
      process.stdout.write(`${JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Deployment agent failed.",
      })}\n`);
    }
    process.exitCode = 1;
  });
}
