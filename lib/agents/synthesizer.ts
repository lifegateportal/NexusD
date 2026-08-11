import { generateText } from "ai";
import { deepSeekModel } from "@/lib/ai-providers";
import { SOURCE_LOCK_RULES, PREMIUM_BOOK_STYLE_RULES } from "@/lib/editorial-style-bible";

export async function synthesizeChapter(assignedChunks: { id: string; text: string }[], styleGuidelines: string) {
  const context = assignedChunks.map(c => `[ANCHOR: ${c.id}]\n${c.text}`).join("\n\n");
  
  const { text } = await generateText({
    model: deepSeekModel,
    temperature: 0.6,
    system: `You are the Synthesizer (NYT-Bestselling Ghostwriter).
${SOURCE_LOCK_RULES}
${PREMIUM_BOOK_STYLE_RULES}
${styleGuidelines}

Draft the chapter using ONLY the allocated transcript chunks. DO NOT HALLUCINATE.`,
    prompt: `Draft this chapter. Context:\n\n${context}`
  });
  
  return text;
}
