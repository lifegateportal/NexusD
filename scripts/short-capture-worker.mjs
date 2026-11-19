import { createReadStream } from "node:fs";
import { access, mkdir, stat, unlink } from "node:fs/promises";
import { createHmac, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { chromium } from "playwright-core";
import { z } from "zod";
import {
  listShortCaptureJobs,
  writeShortCaptureHeartbeat,
  writeShortCaptureJob,
} from "../lib/short-capture-jobs.mjs";

const WorkerEnvSchema = z.object({
  SHORT_CAPTURE_JOB_DIR: z.string().trim().min(1),
  SHORT_CAPTURE_R2_BUCKET: z.string().trim().min(1),
  SHORT_CAPTURE_APP_ORIGIN: z.string().url(),
  SHORT_CAPTURE_CHROMIUM_PATH: z.string().trim().min(1),
  SHORT_CAPTURE_FFMPEG_PATH: z.string().trim().min(1),
  SHORT_CAPTURE_XVFB_PATH: z.string().trim().min(1),
  SHORT_CAPTURE_PULSE_SINK: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  SHORT_CAPTURE_DISPLAY: z.string().regex(/^:\d{1,3}$/),
  R2_ACCOUNT_ID: z.string().trim().min(1),
  R2_ACCESS_KEY_ID: z.string().trim().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  AUTH_PASSWORD: z.string().min(1),
  AUTH_COOKIE_SECRET: z.string().min(16),
}).strict();

const WorkerEnv = WorkerEnvSchema.parse({
  SHORT_CAPTURE_JOB_DIR: process.env.SHORT_CAPTURE_JOB_DIR,
  SHORT_CAPTURE_R2_BUCKET: process.env.SHORT_CAPTURE_R2_BUCKET,
  SHORT_CAPTURE_APP_ORIGIN: process.env.SHORT_CAPTURE_APP_ORIGIN,
  SHORT_CAPTURE_CHROMIUM_PATH: process.env.SHORT_CAPTURE_CHROMIUM_PATH ?? "/usr/bin/chromium",
  SHORT_CAPTURE_FFMPEG_PATH: process.env.SHORT_CAPTURE_FFMPEG_PATH ?? "ffmpeg",
  SHORT_CAPTURE_XVFB_PATH: process.env.SHORT_CAPTURE_XVFB_PATH ?? "Xvfb",
  SHORT_CAPTURE_PULSE_SINK: process.env.SHORT_CAPTURE_PULSE_SINK ?? "nexus_capture",
  SHORT_CAPTURE_DISPLAY: process.env.SHORT_CAPTURE_DISPLAY ?? ":99",
  R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
  AUTH_PASSWORD: process.env.AUTH_PASSWORD,
  AUTH_COOKIE_SECRET: process.env.AUTH_COOKIE_SECRET,
});

const appUrl = new URL(WorkerEnv.SHORT_CAPTURE_APP_ORIGIN);
if (!["127.0.0.1", "localhost"].includes(appUrl.hostname)) {
  throw new Error("SHORT_CAPTURE_APP_ORIGIN must use localhost or 127.0.0.1.");
}

const captureClient = new S3Client({
  region: "auto",
  endpoint: `https://${WorkerEnv.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: WorkerEnv.R2_ACCESS_KEY_ID,
    secretAccessKey: WorkerEnv.R2_SECRET_ACCESS_KEY,
  },
});

const activeProcesses = new Set();
let stopping = false;
let xvfb;

function logError(message, error) {
  console.error(`[short-capture] ${message}`, error instanceof Error ? error.message : error);
}

function launchProcess(command, args, options = {}) {
  const child = spawn(command, args, options);
  activeProcesses.add(child);
  child.once("close", () => activeProcesses.delete(child));
  child.once("error", () => activeProcesses.delete(child));
  return child;
}

function runCommand(command, args, allowFailure = false) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = launchProcess(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), 15_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 && !allowFailure) {
        rejectPromise(new Error(`${command} failed: ${stderr.trim() || `exit ${code}`}`));
        return;
      }
      resolvePromise({ code, stdout, stderr });
    });
  });
}

async function startVirtualDisplay(width, height) {
  xvfb = launchProcess(WorkerEnv.SHORT_CAPTURE_XVFB_PATH, [
    WorkerEnv.SHORT_CAPTURE_DISPLAY,
    "-screen",
    "0",
    `${width}x${height}x24`,
    "-ac",
    "-nolisten",
    "tcp",
  ], { stdio: "ignore" });
  const displayNumber = WorkerEnv.SHORT_CAPTURE_DISPLAY.slice(1);
  const socketPath = `/tmp/.X11-unix/X${displayNumber}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (xvfb.exitCode !== null) throw new Error("Xvfb exited before its display became ready.");
    try {
      await access(socketPath);
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error("Xvfb did not create its display socket.");
}

async function stopVirtualDisplay() {
  if (!xvfb) return;
  const displayProcess = xvfb;
  xvfb = undefined;
  if (displayProcess.exitCode !== null) return;
  const closed = new Promise((resolvePromise) => displayProcess.once("close", resolvePromise));
  displayProcess.kill("SIGTERM");
  await Promise.race([
    closed,
    delay(5000).then(() => {
      if (displayProcess.exitCode === null) throw new Error("Xvfb did not stop after the capture.");
    }),
  ]);
}

async function startVirtualAudio() {
  const info = await runCommand("pactl", ["info"], true);
  if (info.code !== 0) {
    await runCommand("pulseaudio", ["--start", "--exit-idle-time=-1"]);
  }
  const sinks = await runCommand("pactl", ["list", "short", "sinks"]);
  if (!sinks.stdout.split("\n").some((line) => line.split(/\s+/)[1] === WorkerEnv.SHORT_CAPTURE_PULSE_SINK)) {
    await runCommand("pactl", [
      "load-module",
      "module-null-sink",
      `sink_name=${WorkerEnv.SHORT_CAPTURE_PULSE_SINK}`,
    ]);
  }
}

function sessionCookieValue() {
  return createHmac("sha256", WorkerEnv.AUTH_COOKIE_SECRET)
    .update(WorkerEnv.AUTH_PASSWORD)
    .digest("hex");
}

function startRecording(outputPath, durationSeconds, width, height) {
  const displayInput = `${WorkerEnv.SHORT_CAPTURE_DISPLAY}.0+0,0`;
  const child = launchProcess(WorkerEnv.SHORT_CAPTURE_FFMPEG_PATH, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "x11grab",
    "-framerate",
    "30",
    "-video_size",
    `${width}x${height}`,
    "-i",
    displayInput,
    "-f",
    "pulse",
    "-i",
    `${WorkerEnv.SHORT_CAPTURE_PULSE_SINK}.monitor`,
    "-t",
    String(durationSeconds + 30),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    outputPath,
  ], {
    env: {
      ...process.env,
      DISPLAY: WorkerEnv.SHORT_CAPTURE_DISPLAY,
      PULSE_SINK: WorkerEnv.SHORT_CAPTURE_PULSE_SINK,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-2000);
  });
  const started = new Promise((resolvePromise, rejectPromise) => {
    child.once("spawn", resolvePromise);
    child.once("error", rejectPromise);
  });
  const closed = new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => resolvePromise({ code, signal, stderr }));
  });
  closed.catch(() => {});
  return { child, started, closed };
}

async function stopRecording(recorder) {
  if (recorder.child.exitCode !== null) {
    const result = await recorder.closed;
    if (result.code !== 0) throw new Error(`FFmpeg failed: ${result.stderr.trim() || `exit ${result.code}`}`);
    return;
  }
  recorder.child.kill("SIGINT");
  const timeout = setTimeout(() => {
    if (recorder.child.exitCode === null) recorder.child.kill("SIGTERM");
  }, 10_000);
  let result;
  try {
    result = await recorder.closed;
  } finally {
    clearTimeout(timeout);
  }
  if (result.code !== 0 && result.code !== 255) {
    throw new Error(`FFmpeg failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
}

async function updateJob(job, patch) {
  const updated = {
    ...job,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await writeShortCaptureJob(updated);
  return updated;
}

async function processJob(job) {
  let browser;
  let recorder;
  const outputPath = join(tmpdir(), `nexus-short-capture-${job.id}-${randomUUID()}.mp4`);
  try {
    job = await updateJob(job, { status: "starting", progress: 0.02, error: undefined });
    await startVirtualDisplay(job.width, job.height);
    browser = await chromium.launch({
      headless: false,
      executablePath: WorkerEnv.SHORT_CAPTURE_CHROMIUM_PATH,
      args: [
        "--kiosk",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--autoplay-policy=no-user-gesture-required",
      ],
      env: {
        ...process.env,
        DISPLAY: WorkerEnv.SHORT_CAPTURE_DISPLAY,
        PULSE_SINK: WorkerEnv.SHORT_CAPTURE_PULSE_SINK,
      },
    });
    const context = await browser.newContext({
      viewport: { width: job.width, height: job.height },
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
    });
    await context.addCookies([{
      name: "nexus_session",
      value: sessionCookieValue(),
      url: WorkerEnv.SHORT_CAPTURE_APP_ORIGIN,
      httpOnly: true,
      sameSite: "Lax",
    }]);
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    await page.goto(
      `${WorkerEnv.SHORT_CAPTURE_APP_ORIGIN}/ebook/videos/capture/${job.id}`,
      { waitUntil: "domcontentloaded", timeout: 60_000 },
    );
    await page.waitForFunction(
      () => typeof window.__NEXUS_CAPTURE_TIME__ === "number",
      null,
      { timeout: 90_000 },
    );
    const playButton = page.getByRole("button", { name: `Play ${job.title}`, exact: true });
    await playButton.waitFor({ state: "visible", timeout: 30_000 });

    recorder = startRecording(outputPath, job.endSeconds - job.startSeconds, job.width, job.height);
    await recorder.started;
    await playButton.click();
    job = await updateJob(job, { status: "capturing", progress: 0.08 });

    const duration = job.endSeconds - job.startSeconds;
    const deadline = Date.now() + (duration + 120) * 1000;
    let lastTime = job.startSeconds;
    let lastAdvanceAt = Date.now();
    let lastStatusAt = Date.now();
    while (Date.now() < deadline && !stopping) {
      const currentTime = await page.evaluate(() => window.__NEXUS_CAPTURE_TIME__ ?? null);
      const errorCount = await page.locator('[role="alert"]').count();
      const pageError = errorCount > 0
        ? await page.locator('[role="alert"]').first().textContent()
        : null;
      if (pageError?.trim()) throw new Error(pageError.trim());
      if (typeof currentTime === "number" && Number.isFinite(currentTime)) {
        if (currentTime > lastTime + 0.05) {
          lastTime = currentTime;
          lastAdvanceAt = Date.now();
        }
        if (Date.now() - lastStatusAt >= 2000) {
          const progress = 0.08 + 0.8 * Math.min(1, Math.max(0, (currentTime - job.startSeconds) / duration));
          job = await updateJob(job, { status: "capturing", progress });
          lastStatusAt = Date.now();
        }
        if (currentTime >= job.endSeconds - 0.05) break;
      }
      if (Date.now() - lastAdvanceAt > 25_000) {
        throw new Error("YouTube playback stopped advancing. Check that the video can play in an embedded browser.");
      }
      await delay(300);
    }
    if (stopping) throw new Error("Capture worker is shutting down.");
    if (lastTime < job.endSeconds - 0.25) throw new Error("Capture timed out before the selected video segment finished.");

    await stopRecording(recorder);
    recorder = undefined;
    job = await updateJob(job, { status: "uploading", progress: 0.92 });
    const file = await stat(outputPath);
    if (file.size < 10_000) throw new Error("The capture produced an empty or incomplete MP4.");
    await captureClient.send(new PutObjectCommand({
      Bucket: WorkerEnv.SHORT_CAPTURE_R2_BUCKET,
      Key: job.outputKey,
      Body: createReadStream(outputPath),
      ContentLength: file.size,
      ContentType: "video/mp4",
      CacheControl: "private, no-store",
    }));
    await updateJob(job, { status: "completed", progress: 1 });
    console.info(`[short-capture] completed job ${job.id}`);
  } catch (error) {
    if (recorder?.child.exitCode === null) {
      try {
        await stopRecording(recorder);
      } catch (stopError) {
        logError(`could not stop FFmpeg for job ${job.id}:`, stopError);
      }
    }
    const message = (error instanceof Error ? error.message : "Capture failed.").slice(0, 500);
    await updateJob(job, { status: "failed", progress: 0, error: message });
    logError(`job ${job.id} failed:`, error);
  } finally {
    if (browser) await browser.close().catch((error) => logError("browser close failed:", error));
    await stopVirtualDisplay().catch((error) => logError("virtual display cleanup failed:", error));
    await unlink(outputPath).catch((error) => {
      if (error instanceof Error && "code" in error && error.code !== "ENOENT") logError("temp cleanup failed:", error);
    });
  }
}

async function markInterruptedJobs() {
  const jobs = await listShortCaptureJobs();
  for (const job of jobs) {
    if (["starting", "capturing", "uploading"].includes(job.status)) {
      await updateJob(job, {
        status: "failed",
        progress: 0,
        error: "The capture worker restarted before this job finished. Start the capture again.",
      });
    }
  }
}

async function main() {
  const directory = resolve(WorkerEnv.SHORT_CAPTURE_JOB_DIR);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await startVirtualAudio();
  await markInterruptedJobs();
  await writeShortCaptureHeartbeat();
  const heartbeatTimer = setInterval(() => {
    writeShortCaptureHeartbeat().catch((error) => logError("heartbeat update failed:", error));
  }, 5000);
  console.info("[short-capture] worker ready");

  try {
    while (!stopping) {
      const jobs = await listShortCaptureJobs();
      const nextJob = jobs.find((job) => job.status === "queued");
      if (nextJob) await processJob(nextJob);
      else await delay(1000);
    }
  } finally {
    clearInterval(heartbeatTimer);
    for (const child of activeProcesses) child.kill("SIGTERM");
    await stopVirtualDisplay().catch((error) => logError("virtual display cleanup failed:", error));
    await writeShortCaptureHeartbeat().catch((error) => logError("final heartbeat failed:", error));
  }
}

process.once("SIGTERM", () => { stopping = true; });
process.once("SIGINT", () => { stopping = true; });

main().catch((error) => {
  logError("worker failed to start:", error);
  process.exitCode = 1;
});
