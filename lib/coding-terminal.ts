import { z } from "zod";
import { env } from "@/lib/env";
import {
  CodingRevisionIdSchema,
  CodingRunRequestSchema,
  CodingRunSchema,
  CodingWorkspaceIdSchema,
  CodingWorkspaceFileSchema,
  type CodingWorkspaceFile,
} from "@/lib/coding-workspace";
import { isCodingStaticSensitivePath } from "@/lib/coding-static-policy";
import {
  CodingWorkspaceStorageError,
  getCodingWorkspace,
} from "@/lib/coding-workspace-storage";

const RUNNER_RUN_RESPONSE_SCHEMA = z.object({
  run: CodingRunSchema,
  logs: z.string().max(1_100_000),
}).strict();
const RUNNER_ERROR_SCHEMA = z.object({
  error: z.string().max(1_000).optional(),
}).passthrough();
const MAX_COMMAND_LOG_CHARACTERS = 12_000;
const MAX_COMMAND_WAIT_MS = 135_000;

export class CodingTerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodingTerminalError";
  }
}

export function codingTerminalToolAvailable(): boolean {
  return Boolean(
    env.AUTH_PASSWORD
    && env.AUTH_COOKIE_SECRET
    && env.CODING_RUNNER_URL
    && env.CODING_RUNNER_TOKEN,
  );
}

function runnerUrl(path: string): string {
  if (!env.CODING_RUNNER_URL || !env.CODING_RUNNER_TOKEN) {
    throw new CodingTerminalError("Configure the authenticated isolated coding runner before using terminal commands.");
  }
  return `${env.CODING_RUNNER_URL.replace(/\/$/, "")}${path}`;
}

async function runnerRequest(path: string, init: RequestInit = {}, timeoutMs = 25_000): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(runnerUrl(path), {
      ...init,
      headers: {
        Authorization: `Bearer ${env.CODING_RUNNER_TOKEN}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new CodingTerminalError(
      timedOut
        ? "The isolated coding runner timed out while handling the terminal command."
        : "Nexus could not reach the isolated coding runner. Check its URL and network access from the Nexus server.",
    );
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = RUNNER_ERROR_SCHEMA.safeParse(payload);
    throw new CodingTerminalError(
      failure.success && failure.data.error
        ? failure.data.error
        : "The isolated coding runner rejected the terminal command.",
    );
  }
  return payload;
}

export async function runCodingTerminalCommand(input: {
  workspaceId: string;
  revisionId: string;
  command: string;
  files: CodingWorkspaceFile[];
}): Promise<{
  command: string;
  status: "completed" | "failed";
  exitCode: number | null;
  output: string;
  outputTruncated: boolean;
  excludedSensitiveFiles: string[];
}> {
  if (!codingTerminalToolAvailable()) {
    throw new CodingTerminalError(
      "Terminal commands require Nexus login plus CODING_RUNNER_URL and CODING_RUNNER_TOKEN.",
    );
  }

  const workspaceId = CodingWorkspaceIdSchema.safeParse(input.workspaceId);
  const revisionId = CodingRevisionIdSchema.safeParse(input.revisionId);
  const command = z.string().trim().min(1).max(500).refine(
    (value) => !value.includes("\0"),
    "Commands cannot contain null characters.",
  ).safeParse(input.command);
  const runRequest = CodingRunRequestSchema.safeParse({
    command: command.success ? command.data : input.command,
    revisionId: revisionId.success ? revisionId.data : input.revisionId,
    network: false,
  });
  if (!workspaceId.success || !revisionId.success || !command.success || !runRequest.success) {
    throw new CodingTerminalError("The workspace, revision, or terminal command is invalid.");
  }

  let snapshot: Awaited<ReturnType<typeof getCodingWorkspace>>;
  try {
    snapshot = await getCodingWorkspace(workspaceId.data);
  } catch (error) {
    if (error instanceof CodingWorkspaceStorageError) {
      throw new CodingTerminalError(error.message);
    }
    throw error;
  }
  if (!snapshot) throw new CodingTerminalError("Coding workspace not found.");
  if (snapshot.workspace.currentRevisionId !== revisionId.data) {
    throw new CodingTerminalError("The workspace changed. Save or reload the current revision before running commands.");
  }

  const workspaceFiles = z.array(CodingWorkspaceFileSchema).max(200).safeParse(input.files);
  if (!workspaceFiles.success) {
    throw new CodingTerminalError("The current workspace files are invalid.");
  }
  const excludedSensitiveFiles = workspaceFiles.data
    .filter((file) => isCodingStaticSensitivePath(file.name))
    .map((file) => file.name);
  const files = workspaceFiles.data.filter((file) => !isCodingStaticSensitivePath(file.name));
  const workspaceBytes = files.reduce(
    (total, file) => total + new TextEncoder().encode(file.content).byteLength,
    0,
  );
  if (workspaceBytes > 4_000_000) {
    throw new CodingTerminalError("Workspace files are too large to run. Keep the total under 4 million bytes.");
  }

  const submitted = await runnerRequest("/runs", {
    method: "POST",
    body: JSON.stringify({
      workspaceId: workspaceId.data,
      revisionId: revisionId.data,
      command: runRequest.data.command,
      network: false,
      files,
    }),
  });
  const queuedRun = CodingRunSchema.safeParse(submitted);
  if (!queuedRun.success) {
    throw new CodingTerminalError("The isolated coding runner returned invalid run data.");
  }
  if (
    queuedRun.data.workspaceId !== workspaceId.data
    || queuedRun.data.revisionId !== revisionId.data
  ) {
    throw new CodingTerminalError("The isolated coding runner returned a run for a different workspace revision.");
  }

  const deadline = Date.now() + MAX_COMMAND_WAIT_MS;
  while (Date.now() < deadline) {
    const payload = await runnerRequest(`/runs/${encodeURIComponent(queuedRun.data.id)}`, {}, 10_000);
    const parsed = RUNNER_RUN_RESPONSE_SCHEMA.safeParse(payload);
    if (!parsed.success) {
      throw new CodingTerminalError("The isolated coding runner returned invalid command output.");
    }
    const { run, logs } = parsed.data;
    if (run.workspaceId !== workspaceId.data || run.revisionId !== revisionId.data) {
      throw new CodingTerminalError("The isolated coding runner returned output for a different workspace revision.");
    }
    if (run.status === "completed" || run.status === "failed") {
      return {
        command: runRequest.data.command,
        status: run.status,
        exitCode: run.exitCode,
        output: logs.slice(-MAX_COMMAND_LOG_CHARACTERS),
        outputTruncated: logs.length > MAX_COMMAND_LOG_CHARACTERS,
        excludedSensitiveFiles,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new CodingTerminalError(
    "The terminal command did not finish within 135 seconds. The isolated runner will stop it at its configured timeout.",
  );
}
