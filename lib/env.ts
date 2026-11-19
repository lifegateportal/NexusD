import { z } from "zod";

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1, "Missing Gemini API key").optional(),
  DEEPSEEK_API_KEY: z.string().min(1, "Missing DeepSeek API key"),
  ANTHROPIC_API_KEY: z.string().min(1, "Missing Anthropic API key").optional(),
  DEEPGRAM_API_KEY: z.string().optional(),
  YOUTUBE_API_KEY: z.string().optional().transform((value) => value?.trim() || undefined),
  PEXELS_API_KEY: z.string().optional().transform((value) => value?.trim() || undefined),
  JAMENDO_CLIENT_ID: z.string().optional().transform((value) => value?.trim() || undefined),
  JAMENDO_COMMERCIAL_USE_APPROVED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  GEMINI_MODEL: z.string().default("gemini-2.0-flash"),
  DEEPSEEK_MODEL: z.enum(["deepseek-chat", "deepseek-reasoner"]).default("deepseek-chat"),
  CLAUDE_MODEL: z.string().default("claude-haiku-4-5"),
  CURATOR_MODEL: z.string().default("claude-sonnet-4-5"),
  // Personal login gate — set both to enable password protection
  AUTH_PASSWORD:       z.string().min(1).optional(),
  AUTH_COOKIE_SECRET:  z.string().min(16).optional(),
  // Isolated runner for terminal and preview features; deployment uses EpicGlobal directly.
  CODING_RUNNER_URL:   z.string().url().optional(),
  CODING_RUNNER_TOKEN: z.string().min(1).optional(),
  CODING_FULLSTACK_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  EPICGLOBAL_API_URL: z.string().url().default("https://api.epicglobal.app"),
  EPICGLOBAL_ORCHESTRATOR_API_KEY: z.string().min(1).optional(),
  GITHUB_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  GITHUB_OAUTH_CALLBACK_URL: z.string().url().optional(),
  GITHUB_OAUTH_SESSION_SECRET: z.string().min(32).optional(),
  // Cloudflare R2 — optional, enables cloud video storage
  R2_ACCOUNT_ID:       z.string().optional(),
  R2_ACCESS_KEY_ID:    z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET_NAME:      z.string().optional(),
  R2_PUBLIC_URL:       z.string().optional(), // e.g. https://pub-xxxx.r2.dev
  SHORT_CAPTURE_JOB_DIR: z.string().optional(),
  SHORT_CAPTURE_R2_BUCKET: z.string().optional(),
  SHORT_CAPTURE_APP_ORIGIN: z.string().url().optional(),
  SHORT_CAPTURE_CHROMIUM_PATH: z.string().optional(),
  SHORT_CAPTURE_FFMPEG_PATH: z.string().optional(),
  SHORT_CAPTURE_XVFB_PATH: z.string().optional(),
  SHORT_CAPTURE_PULSE_SINK: z.string().optional(),
  SHORT_CAPTURE_DISPLAY: z.string().regex(/^:\d{1,3}$/).optional(),
  // RunPod Voice Cloning — optional, enables XTTS v2 audiobook narration
  RUNPOD_API_KEY:             z.string().optional(),
  RUNPOD_VOICE_ENDPOINT_ID:   z.string().optional(), // RunPod Serverless endpoint ID
  RUNPOD_ENDPOINT_ID:         z.string().optional(), // Backward-compatible alias
  EBOOK_STRICT_ARCHITECT_OVERLAP_GATE: z.enum(["true", "false"]).optional().transform((value) => value !== "false"),
});

const parsed = EnvironmentSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid environment configuration: ${issues}`);
}

export const env = parsed.data;
