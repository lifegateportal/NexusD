import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  listShortCaptureJobs,
  readShortCaptureHeartbeat,
  readShortCaptureJob,
  writeShortCaptureHeartbeat,
  writeShortCaptureJob,
} from "../lib/short-capture-jobs.mjs";

const originalDirectory = process.env.SHORT_CAPTURE_JOB_DIR;
const testDirectory = await mkdtemp(join(tmpdir(), "nexus-short-capture-test-"));
process.env.SHORT_CAPTURE_JOB_DIR = testDirectory;

after(async () => {
  if (originalDirectory === undefined) delete process.env.SHORT_CAPTURE_JOB_DIR;
  else process.env.SHORT_CAPTURE_JOB_DIR = originalDirectory;
  await rm(testDirectory, { recursive: true, force: true });
});

test("persists validated jobs and worker heartbeat in the shared queue directory", async () => {
  const id = "550e8400-e29b-41d4-a716-446655440000";
  const timestamp = new Date().toISOString();
  const job = {
    id,
    slug: "test-short",
    title: "Test short",
    startSeconds: 10,
    endSeconds: 40,
    width: 720,
    height: 1280,
    projectJson: "{}",
    status: "queued",
    progress: 0,
    outputKey: `director/shorts/capture-exports/${id}.mp4`,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await writeShortCaptureJob(job);
  assert.deepEqual(await readShortCaptureJob(id), job);
  assert.deepEqual(await listShortCaptureJobs(), [job]);

  await writeShortCaptureHeartbeat();
  const heartbeat = await readShortCaptureHeartbeat();
  assert.ok(heartbeat);
  assert.ok(Number.isFinite(Date.parse(heartbeat.updatedAt)));
});

test("rejects malformed or non-strict capture job state", async () => {
  const id = "550e8400-e29b-41d4-a716-446655440001";
  const timestamp = new Date().toISOString();
  await assert.rejects(() => writeShortCaptureJob({
    id,
    slug: "test-short",
    title: "Test short",
    startSeconds: 10,
    endSeconds: 40,
    width: 720,
    height: 1280,
    projectJson: "{}",
    status: "queued",
    progress: 0,
    outputKey: `director/shorts/capture-exports/${id}.mp4`,
    createdAt: timestamp,
    updatedAt: timestamp,
    unexpected: true,
  }));
});
