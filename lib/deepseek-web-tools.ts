import { isIP } from "node:net";
import { z } from "zod";
import { env } from "@/lib/env";

const DEEPSEEK_TOOLS_URL = "https://api.deepseek.com/v1/tools";
export const DeepSeekWebSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(128),
}).strict();
export const DeepSeekWebFetchInputSchema = z.object({
  url: z.string().trim().min(1).max(8192).url().refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }

    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return (url.protocol === "https:" || url.protocol === "http:")
      && !url.username
      && !url.password
      && !isIP(hostname)
      && hostname !== "localhost"
      && !hostname.endsWith(".localhost")
      && !hostname.endsWith(".local")
      && !hostname.endsWith(".internal");
  }, "Enter a public HTTP or HTTPS URL without credentials."),
}).strict();

const SearchResultSchema = z.object({
  rerank_score: z.number().optional(),
  title: z.string(),
  url: z.string().url(),
  snippet: z.string().optional(),
  summary: z.string().optional(),
  content: z.string().optional(),
  site_name: z.string().nullable().optional(),
  site_icon: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  authority: z.number().optional(),
}).strict();
const SearchResponseSchema = z.object({
  results: z.array(SearchResultSchema).max(50),
}).strict();
const FetchResponseSchema = z.object({
  title: z.string(),
  content: z.string(),
}).strict();

async function postDeepSeekTool<T>(
  toolName: "search" | "fetch",
  body: Record<string, unknown>,
  responseSchema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${DEEPSEEK_TOOLS_URL}/${toolName}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`DeepSeek web ${toolName} returned HTTP ${response.status}.`);
  }

  const payload: unknown = await response.json();
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`)
      .join("; ");
    throw new Error(`DeepSeek web ${toolName} returned an invalid response: ${details}`);
  }

  return parsed.data;
}

export async function searchDeepSeekWeb(query: string, signal?: AbortSignal) {
  const input = DeepSeekWebSearchInputSchema.parse({ query });
  return postDeepSeekTool(
    "search",
    { query: input.query, count: 5, need_content: false },
    SearchResponseSchema,
    signal,
  );
}

export async function fetchDeepSeekWebPage(url: string, signal?: AbortSignal) {
  const input = DeepSeekWebFetchInputSchema.parse({ url });
  return postDeepSeekTool("fetch", { url: input.url }, FetchResponseSchema, signal);
}
