import { z } from "zod";

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1, "Missing Gemini API key").optional(),
  DEEPSEEK_API_KEY: z.string().min(1, "Missing DeepSeek API key"),
  ANTHROPIC_API_KEY: z.string().min(1, "Missing Anthropic API key").optional(),
  DEEPGRAM_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.0-flash"),
  DEEPSEEK_MODEL: z.enum(["deepseek-chat", "deepseek-reasoner"]).default("deepseek-chat"),
  CLAUDE_MODEL: z.string().default("claude-haiku-4-5"),
  CURATOR_MODEL: z.string().default("claude-sonnet-4-5"),
  // Personal login gate — set both to enable password protection
  AUTH_PASSWORD:       z.string().min(1).optional(),
  AUTH_COOKIE_SECRET:  z.string().min(16).optional(),
  // Isolated Nexus Code runner — optional until the sidecar is deployed
  CODING_RUNNER_URL:   z.string().url().optional(),
  CODING_RUNNER_TOKEN: z.string().min(1).optional(),
  DIGITALOCEAN_API_TOKEN: z.string().min(1).optional(),
  DIGITALOCEAN_REGISTRY_NAME: z.string().regex(/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/).optional(),
  DIGITALOCEAN_REGION: z.string().regex(/^[a-z0-9-]{2,20}$/).default("nyc"),
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
