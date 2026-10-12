import { createServer, request as httpRequest } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const PORT = positiveInteger(process.env.PORT, 8090);
const RUNNER_TOKEN = process.env.CODING_RUNNER_TOKEN?.trim();
const SANDBOX_IMAGE = process.env.CODING_RUNNER_IMAGE?.trim() || "nexus-coding-sandbox:local";
const WORK_ROOT = resolve(process.env.CODING_RUNNER_WORK_ROOT || "/var/lib/nexus-runner");
const HOST_WORK_ROOT = resolve(process.env.CODING_RUNNER_HOST_WORK_ROOT || WORK_ROOT);
const MAX_BODY_BYTES = positiveInteger(process.env.CODING_RUNNER_MAX_BODY_BYTES, 8_000_000);
const MAX_RUNS = positiveInteger(process.env.CODING_RUNNER_MAX_RUNS, 100);
const MAX_CONCURRENT_RUNS = positiveInteger(process.env.CODING_RUNNER_MAX_CONCURRENT, 2);
const RUN_TIMEOUT_MS = positiveInteger(process.env.CODING_RUNNER_TIMEOUT_MS, 120_000);
const MEMORY_LIMIT = process.env.CODING_RUNNER_MEMORY || "768m";
const CPU_LIMIT = process.env.CODING_RUNNER_CPUS || "2";
const PIDS_LIMIT = positiveInteger(process.env.CODING_RUNNER_PIDS_LIMIT, 256);
const MAX_LOG_BYTES = positiveInteger(process.env.CODING_RUNNER_MAX_LOG_BYTES, 1_000_000);
const RUN_RETENTION_MS = positiveInteger(process.env.CODING_RUNNER_RETENTION_MS, 3_600_000);
const PREVIEW_RETENTION_MS = positiveInteger(process.env.CODING_RUNNER_PREVIEW_RETENTION_MS, 1_800_000);
const MAX_PREVIEWS = positiveInteger(process.env.CODING_RUNNER_MAX_PREVIEWS, 4);
const PREVIEW_START_TIMEOUT_MS = positiveInteger(process.env.CODING_RUNNER_PREVIEW_START_TIMEOUT_MS, 30_000);

if (!RUNNER_TOKEN) {
  throw new Error("CODING_RUNNER_TOKEN must be configured.");
}

const jobs = new Map();
const previews = new Map();
const pending = [];
let activeRuns = 0;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function json(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function isAuthorized(request) {
  const supplied = request.headers.authorization;
  if (!supplied?.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(supplied.slice("Bearer ".length));
  const expected = Buffer.from(RUNNER_TOKEN);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function workspaceId(value) {
  if (typeof value !== "string" || !/^cw-[a-z0-9-]{8,80}$/.test(value)) {
    throw new Error("Invalid workspace id.");
  }
  return value;
}

function revisionId(value) {
  if (typeof value !== "string" || !/^cr-[a-z0-9-]{8,100}$/.test(value)) {
    throw new Error("Invalid revision id.");
  }
  return value;
}

function relativeFilePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 240 || value.includes("\0")) {
    throw new Error("Invalid coding file path.");
  }
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/")
    || normalized.includes("//")
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("Coding file paths must be relative and normalized.");
  }
  return segments.join("/");
}

function parseRunRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid coding run request.");
  }
  const input = value;
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (command.length === 0 || command.length > 500 || command.includes("\0")) {
    throw new Error("Coding commands must be between 1 and 500 characters.");
  }
  if (typeof input.network !== "boolean") {
    throw new Error("The network setting must be a boolean.");
  }
  if (!Array.isArray(input.files) || input.files.length > 200) {
    throw new Error("A coding run must contain no more than 200 files.");
  }

  const files = [];
  const names = new Set();
  let totalBytes = 0;
  for (const file of input.files) {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      throw new Error("Invalid coding file.");
    }
    const name = relativeFilePath(file.name);
    if (names.has(name)) throw new Error(`Duplicate coding file: ${name}`);
    names.add(name);
    if (typeof file.content !== "string" || file.content.length > 500_000) {
      throw new Error(`Coding file ${name} is too large.`);
    }
    totalBytes += Buffer.byteLength(file.content, "utf8");
    if (totalBytes > 4_000_000) {
      throw new Error("Coding files are too large. Keep the total under 4 million bytes.");
    }
    files.push({ name, content: file.content });
  }

  return {
    workspaceId: workspaceId(input.workspaceId),
    revisionId: revisionId(input.revisionId),
    command,
    network: input.network,
    files,
  };
}

async function readJson(request) {
  const declaredLength = Number.parseInt(request.headers["content-length"] || "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new Error("Coding run request is too large.");
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Coding run request is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Coding run request must be valid JSON.");
  }
}

function runPayload(job) {
  return {
    id: job.id,
    workspaceId: job.request.workspaceId,
    revisionId: job.request.revisionId,
    command: job.request.command,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    exitCode: job.exitCode,
    previewUrl: null,
  };
}

function previewPayload(preview) {
  return {
    id: preview.id,
    workspaceId: preview.request.workspaceId,
    revisionId: preview.request.revisionId,
    command: preview.request.command,
    port: preview.request.port,
    status: preview.status,
    createdAt: preview.createdAt,
    updatedAt: preview.updatedAt,
    previewUrl: preview.status === "running" ? `/previews/${preview.id}` : null,
  };
}

function appendLog(job, chunk) {
  const text = chunk.toString("utf8");
  if (job.logBytes >= MAX_LOG_BYTES) return;
  const remaining = MAX_LOG_BYTES - job.logBytes;
  const bounded = text.slice(0, remaining);
  job.logs += bounded;
  job.logBytes += Buffer.byteLength(bounded, "utf8");
  if (job.logBytes >= MAX_LOG_BYTES) job.logs += "\n[runner] log output truncated\n";
}

function dockerArguments(job, workspaceDirectory) {
  const relativeWorkspacePath = relative(WORK_ROOT, workspaceDirectory);
  if (!relativeWorkspacePath || relativeWorkspacePath.startsWith("..") || isAbsolute(relativeWorkspacePath)) {
    throw new Error("Runner workspace path escaped the configured work root.");
  }
  return [
    "run",
    "--rm",
    "--name", `nexus-coding-${job.id}`,
    "--workdir", "/workspace",
    "--user", "1000:1000",
    "--network", job.request.network ? "bridge" : "none",
    "--cpus", CPU_LIMIT,
    "--memory", MEMORY_LIMIT,
    "--pids-limit", String(PIDS_LIMIT),
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt", "no-new-privileges",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m",
    "--mount", `type=bind,src=${join(HOST_WORK_ROOT, relativeWorkspacePath)},dst=/workspace`,
    SANDBOX_IMAGE,
    "sh",
    "-lc",
    job.request.command,
  ];
}

function previewDockerArguments(preview, workspaceDirectory) {
  const relativeWorkspacePath = relative(WORK_ROOT, workspaceDirectory);
  if (!relativeWorkspacePath || relativeWorkspacePath.startsWith("..") || isAbsolute(relativeWorkspacePath)) {
    throw new Error("Runner workspace path escaped the configured work root.");
  }
  return [
    "run",
    "-d",
    "--rm",
    "--name", `nexus-preview-${preview.id}`,
    "--workdir", "/workspace",
    "--user", "1000:1000",
    "--network", preview.request.network ? "bridge" : "none",
    "--cpus", CPU_LIMIT,
    "--memory", MEMORY_LIMIT,
    "--pids-limit", String(PIDS_LIMIT),
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt", "no-new-privileges",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m",
    "--mount", `type=bind,src=${join(HOST_WORK_ROOT, relativeWorkspacePath)},dst=/workspace`,
    SANDBOX_IMAGE,
    "sh",
    "-lc",
    preview.request.command,
  ];
}

async function prepareWorkspace(files) {
  const directory = await mkdtemp(join(WORK_ROOT, "run-"));
  await chmod(directory, 0o777);
  await Promise.all(files.map(async (file) => {
    const target = join(directory, file.name);
    const parent = dirname(target);
    await mkdir(parent, { recursive: true });
    await chmod(parent, 0o777);
    await writeFile(target, file.content, { encoding: "utf8", mode: 0o666 });
  }));
  return directory;
}

function parsePreviewRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid coding preview request.");
  }
  const input = value;
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (command.length === 0 || command.length > 500 || command.includes("\0")) {
    throw new Error("Preview commands must be between 1 and 500 characters.");
  }
  if (typeof input.network !== "boolean") {
    throw new Error("The preview network setting must be a boolean.");
  }
  if (!input.network) {
    throw new Error("Live previews require explicit network access so the runner can proxy the preview port.");
  }
  const port = Number.isInteger(input.port) ? input.port : 3000;
  if (port < 1024 || port > 65535) throw new Error("Preview port must be between 1024 and 65535.");
  if (!Array.isArray(input.files) || input.files.length > 200) {
    throw new Error("A coding preview must contain no more than 200 files.");
  }
  const files = [];
  const names = new Set();
  let totalBytes = 0;
  for (const file of input.files) {
    if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("Invalid coding file.");
    const name = relativeFilePath(file.name);
    if (names.has(name)) throw new Error(`Duplicate coding file: ${name}`);
    names.add(name);
    if (typeof file.content !== "string" || file.content.length > 500_000) {
      throw new Error(`Coding file ${name} is too large.`);
    }
    totalBytes += Buffer.byteLength(file.content, "utf8");
    if (totalBytes > 4_000_000) throw new Error("Coding files are too large.");
    files.push({ name, content: file.content });
  }
  return {
    workspaceId: workspaceId(input.workspaceId),
    revisionId: revisionId(input.revisionId),
    command,
    port,
    network: input.network,
    files,
  };
}

async function killContainer(job) {
  await new Promise((resolveKill) => {
    const killer = spawn("docker", ["kill", `nexus-coding-${job.id}`], {
      stdio: "ignore",
    });
    killer.once("close", resolveKill);
    killer.once("error", resolveKill);
  });
}

async function stopPreview(preview) {
  if (preview.workspaceDirectory) {
    await new Promise((resolveStop) => {
      const killer = spawn("docker", ["rm", "-f", `nexus-preview-${preview.id}`], { stdio: "ignore" });
      killer.once("close", resolveStop);
      killer.once("error", resolveStop);
    });
    await rm(preview.workspaceDirectory, { recursive: true, force: true });
  }
  preview.workspaceDirectory = undefined;
  preview.status = "stopped";
  preview.updatedAt = new Date().toISOString();
}

async function startPreview(preview) {
  preview.workspaceDirectory = await prepareWorkspace(preview.request.files);
  const child = spawn("docker", previewDockerArguments(preview, preview.workspaceDirectory), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));
  const exitCode = await new Promise((resolveStart, rejectStart) => {
    const timer = setTimeout(() => rejectStart(new Error("Preview container did not start in time.")), PREVIEW_START_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectStart(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveStart(code);
    });
  });
  if (exitCode !== 0) throw new Error(output.join("").slice(-2000) || "Preview container failed to start.");
  const inspect = spawn("docker", ["inspect", "-f", "{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}", `nexus-preview-${preview.id}`]);
  let host = "";
  inspect.stdout.on("data", (chunk) => { host += chunk.toString("utf8"); });
  await new Promise((resolveInspect) => inspect.once("close", resolveInspect));
  preview.containerHost = host.trim();
  if (!preview.containerHost) throw new Error("Preview container address is unavailable.");
  const deadline = Date.now() + PREVIEW_START_TIMEOUT_MS;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await new Promise((resolveReady) => {
      const probe = httpRequest({
        hostname: preview.containerHost,
        port: preview.request.port,
        path: "/",
        method: "GET",
      }, (response) => {
        response.resume();
        response.once("end", () => resolveReady(true));
      });
      probe.setTimeout(1000, () => {
        probe.destroy();
        resolveReady(false);
      });
      probe.once("error", () => resolveReady(false));
      probe.end();
    });
    if (ready) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  if (!ready) throw new Error("Preview server did not become ready in time.");
  preview.status = "running";
  preview.updatedAt = new Date().toISOString();
}

async function execute(job) {
  activeRuns += 1;
  job.status = "running";
  job.updatedAt = new Date().toISOString();
  let workspaceDirectory;
  let timedOut = false;
  let timer;
  try {
    workspaceDirectory = await prepareWorkspace(job.request.files);
    const child = spawn("docker", dockerArguments(job, workspaceDirectory), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    job.process = child;
    child.stdout.on("data", (chunk) => appendLog(job, chunk));
    child.stderr.on("data", (chunk) => appendLog(job, chunk));

    timer = setTimeout(() => {
      timedOut = true;
      appendLog(job, `\n[runner] command exceeded ${RUN_TIMEOUT_MS}ms and was terminated\n`);
      void killContainer(job);
    }, RUN_TIMEOUT_MS);

    await new Promise((resolveRun, rejectRun) => {
      child.once("error", rejectRun);
      child.once("close", (code, signal) => {
        job.exitCode = typeof code === "number" ? code : 1;
        if (signal) appendLog(job, `\n[runner] terminated by ${signal}\n`);
        resolveRun();
      });
    });
    job.status = timedOut ? "failed" : job.exitCode === 0 ? "completed" : "failed";
  } catch (error) {
    job.exitCode = 1;
    job.status = "failed";
    appendLog(job, `\n[runner] ${error instanceof Error ? error.message : "Runner execution failed"}\n`);
  } finally {
    if (timer) clearTimeout(timer);
    if (workspaceDirectory) await rm(workspaceDirectory, { recursive: true, force: true });
    job.process = undefined;
    job.updatedAt = new Date().toISOString();
    activeRuns -= 1;
    drainQueue();
  }
}

function drainQueue() {
  while (activeRuns < MAX_CONCURRENT_RUNS && pending.length > 0) {
    const job = pending.shift();
    if (job) void execute(job);
  }
}

function pruneJobs() {
  const cutoff = Date.now() - RUN_RETENTION_MS;
  for (const [id, job] of jobs) {
    if (job.status !== "queued" && job.status !== "running" && Date.parse(job.updatedAt) < cutoff) {
      jobs.delete(id);
    }
  }
}

function prunePreviews() {
  const cutoff = Date.now() - PREVIEW_RETENTION_MS;
  for (const [id, preview] of previews) {
    if (Date.parse(preview.updatedAt) < cutoff) {
      previews.delete(id);
      void stopPreview(preview);
    }
  }
}

function proxyPreview(request, response, preview, path) {
  if (preview.status !== "running") return json(response, 409, { error: "Preview is not running." });
  const proxy = httpRequest({
    hostname: preview.containerHost,
    port: preview.request.port,
    path,
    method: request.method,
    headers: { ...request.headers, host: `${preview.containerHost}:${preview.request.port}` },
  }, (upstream) => {
    response.writeHead(upstream.statusCode || 502, upstream.headers);
    upstream.pipe(response);
  });
  proxy.once("error", () => {
    if (!response.headersSent) json(response, 502, { error: "Preview server is unavailable." });
    else response.end();
  });
  request.pipe(proxy);
}

async function handle(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (request.method === "GET" && url.pathname === "/healthz") {
    return json(response, 200, {
      ok: true,
      activeRuns,
      queuedRuns: pending.length,
      image: SANDBOX_IMAGE,
    });
  }
  if (!isAuthorized(request)) return json(response, 401, { error: "Runner authentication failed." });

  if (request.method === "POST" && url.pathname === "/runs") {
    if (jobs.size >= MAX_RUNS) {
      pruneJobs();
      if (jobs.size >= MAX_RUNS) return json(response, 429, { error: "The coding runner queue is full." });
    }
    let requestBody;
    try {
      requestBody = parseRunRequest(await readJson(request));
    } catch (error) {
      return json(response, 400, { error: error instanceof Error ? error.message : "Invalid coding run request." });
    }
    const now = new Date().toISOString();
    const job = {
      id: `run-${randomUUID()}`,
      request: requestBody,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      exitCode: null,
      logs: "",
      logBytes: 0,
      process: undefined,
    };
    jobs.set(job.id, job);
    pending.push(job);
    drainQueue();
    return json(response, 202, runPayload(job));
  }

  if (request.method === "POST" && url.pathname === "/previews") {
    prunePreviews();
    if (previews.size >= MAX_PREVIEWS) return json(response, 429, { error: "The preview capacity is full." });
    let requestBody;
    try {
      requestBody = parsePreviewRequest(await readJson(request));
    } catch (error) {
      return json(response, 400, { error: error instanceof Error ? error.message : "Invalid coding preview request." });
    }
    const now = new Date().toISOString();
    const preview = {
      id: `preview-${randomUUID()}`,
      request: requestBody,
      status: "starting",
      createdAt: now,
      updatedAt: now,
      workspaceDirectory: undefined,
      containerHost: null,
    };
    previews.set(preview.id, preview);
    void startPreview(preview).catch(async (error) => {
      preview.error = error instanceof Error ? error.message : "Preview failed to start.";
      if (preview.workspaceDirectory) await stopPreview(preview);
      preview.status = "failed";
      preview.updatedAt = new Date().toISOString();
    });
    return json(response, 202, previewPayload(preview));
  }

  const runMatch = url.pathname.match(/^\/runs\/(run-[a-z0-9-]+)$/);
  if (request.method === "GET" && runMatch) {
    const job = jobs.get(runMatch[1]);
    if (!job) return json(response, 404, { error: "Coding run not found." });
    return json(response, 200, { run: runPayload(job), logs: job.logs });
  }

  const previewMatch = url.pathname.match(/^\/previews\/(preview-[a-z0-9-]+)(\/.*)?$/);
  if (previewMatch) {
    const preview = previews.get(previewMatch[1]);
    if (!preview) return json(response, 404, { error: "Coding preview not found." });
    if (request.method === "GET" && previewMatch[2] === undefined) {
      return json(response, 200, { preview: previewPayload(preview), error: preview.error || null });
    }
    if (request.method === "DELETE" && previewMatch[2] === undefined) {
      await stopPreview(preview);
      return json(response, 200, { preview: previewPayload(preview) });
    }
    if (request.method === "GET" || request.method === "HEAD") {
      if (!preview.containerHost) {
        const inspect = spawn("docker", ["inspect", "-f", "{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}", `nexus-preview-${preview.id}`]);
        let output = "";
        inspect.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
        await new Promise((resolveInspect) => inspect.once("close", resolveInspect));
        preview.containerHost = output.trim();
      }
      if (!preview.containerHost) return json(response, 502, { error: "Preview container address is unavailable." });
      return proxyPreview(request, response, preview, previewMatch[2] || "/");
    }
  }

  return json(response, 404, { error: "Runner endpoint not found." });
}

await mkdir(WORK_ROOT, { recursive: true });
const server = createServer((request, response) => {
  handle(request, response).catch((error) => {
    console.error("[coding-runner] request failed", error);
    if (!response.headersSent) json(response, 500, { error: "Coding runner request failed." });
    else response.end();
  });
});

server.requestTimeout = 30_000;
server.headersTimeout = 35_000;
server.keepAliveTimeout = 5_000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[coding-runner] listening on ${PORT}`);
  console.log(`[coding-runner] sandbox image: ${SANDBOX_IMAGE}`);
});
