import { z } from "zod";

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1, "Missing Gemini API key"),
  DEEPSEEK_API_KEY: z.string().min(1, "Missing DeepSeek API key"),
  ANTHROPIC_API_KEY: z.string().min(1, "Missing Anthropic API key"),
  DEEPGRAM_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.0-flash"),
  DEEPSEEK_MODEL: z.string().default("deepseek-chat"),
  CLAUDE_MODEL: z.string().default("claude-haiku-4-5"),
  CURATOR_MODEL: z.string().default("claude-sonnet-4-5"),
  // Personal login gate — set both to enable password protection
  AUTH_PASSWORD:       z.string().min(1).optional(),
  AUTH_COOKIE_SECRET:  z.string().min(16).optional(),
  // Cloudflare R2 — optional, enables cloud video storage
  R2_ACCOUNT_ID:       z.string().optional(),
  R2_ACCESS_KEY_ID:    z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET_NAME:      z.string().optional(),
  R2_PUBLIC_URL:       z.string().optional(), // e.g. https://pub-xxxx.r2.dev
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
