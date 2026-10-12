import { NextRequest, NextResponse } from "next/server";
import { streamText } from "ai";
import { z } from "zod";
import { deepSeekChatModel, deepSeekReasonerModel } from "@/lib/ai-providers";
import {
  CodingChatRequestSchema,
  type CodingChatRequest,
  type CodingMode,
} from "@/lib/coding-chat";

export const runtime = "nodejs";
export const maxDuration = 300;

function modeInstruction(mode: CodingMode): string {
  switch (mode) {
    case "plan":
      return "Plan before implementation. Describe the affected files, data flow, risks, and verification steps. Do not claim that code was changed.";
    case "code":
      return "Implement the requested change with production-quality code. Infer whether the prompt requires building, debugging, refactoring, reviewing, testing, or explaining code. Prefer focused changes, preserve existing behavior, add validation and tests, and include all relevant files.";
    case "ask":
    default:
      return "Answer the request directly and infer whether the user wants an explanation, review, debugging help, test guidance, or an implementation. Do not force a code rewrite when the prompt only asks for information.";
  }
}

function formatFiles(files: CodingChatRequest["files"]): string {
  if (files.length === 0) return "No source files were attached.";
  return files
    .map((file) => `FILE: ${file.name}${file.language ? ` (${file.language})` : ""}\n${file.content}`)
    .join("\n\n==========\n\n");
}

function formatHistory(request: CodingChatRequest): string {
  if (request.history.length === 0) return "No earlier coding conversation.";
  return request.history
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join("\n\n");
}

function buildSystemPrompt(input: CodingChatRequest): string {
  const basePrompt = `You are Nexus Code, the dedicated software engineering assistant inside NexusD.

MODEL POLICY:
- The active model is ${input.agent}.
- Use only the supplied repository/file context and the user's request.
- Never claim to have read, edited, executed, tested, committed, or deployed files unless the user supplied the result in this conversation.
- This chat currently has no direct filesystem, terminal, browser, Git, or deployment access. Provide exact implementation guidance and code patches that another coding pipeline can execute.

CODING MODE:
${modeInstruction(input.mode)}

ENGINEERING RULES:
- Preserve existing project conventions and behavior.
- Prefer small, complete patches over broad rewrites.
- Use strict types and explicit error handling.
- Validate external input with the project's established schema approach.
- Include tests or concrete verification commands for implementation work.
- Call out assumptions and unresolved requirements.
- Return reader-facing Markdown with file headings and fenced code blocks when code is needed.`;
  return `${basePrompt}

WORKSPACE FILE PROTOCOL:
- For code or implementation work, emit every new or changed file in its own machine-readable fenced block:
\`\`\`nexus-file path="src/example.ts"
file contents
\`\`\`
- Keep the file path relative, use forward slashes, and place explanations outside these blocks.
- The Nexus Code client uses these blocks to build and update its browser-local project tree while the response streams.
- Do not emit nexus-file blocks for a pure explanation or plan unless the user explicitly requests implementation files.`;
}

function describeCodingStreamError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  console.error("[coding/chat] DeepSeek request failed", error);
  if (/401|403|authentication|api key|unauthorized/i.test(message)) {
    return "DeepSeek authentication failed. Update DEEPSEEK_API_KEY on the server.";
  }
  if (/429|rate limit|quota/i.test(message)) {
    return "DeepSeek rate limit or quota reached. Check the DeepSeek account and try again.";
  }
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET/i.test(message)) {
    return "DeepSeek did not respond in time. Check the server network connection and try again.";
  }
  return "DeepSeek could not complete the request. Check the server logs for the provider error.";
}

export async function POST(request: NextRequest) {
  let input: CodingChatRequest;
  try {
    input = CodingChatRequestSchema.parse(await request.json() as unknown);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof z.ZodError ? error.issues : "Invalid coding request." },
      { status: 400 },
    );
  }

  try {
    const model = input.agent === "deepseek-reasoner"
      ? deepSeekReasonerModel
      : deepSeekChatModel;
    const prompt = [
      `RECENT CODING CONVERSATION:\n${formatHistory(input)}`,
      `ATTACHED SOURCE FILES:\n${formatFiles(input.files)}`,
      `USER REQUEST:\n${input.query}`,
    ].join("\n\n==========\n\n");

    const result = streamText({
      model,
      temperature: input.agent === "deepseek-reasoner" ? 0.2 : 0.25,
      maxTokens: input.agent === "deepseek-reasoner" ? 8_000 : 6_000,
      maxRetries: 2,
      abortSignal: request.signal,
      system: buildSystemPrompt(input),
      prompt,
    });

    return result.toDataStreamResponse({
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
      getErrorMessage: describeCodingStreamError,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Nexus Code could not answer." },
      { status: 500 },
    );
  }
}
