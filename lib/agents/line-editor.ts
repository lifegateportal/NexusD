import { generateText } from "ai";
import { deepSeekModel } from "@/lib/ai-providers";
import { PREMIUM_BOOK_STYLE_RULES } from "@/lib/editorial-style-bible";

export async function polishDraft(draft: string) {
  const { text } = await generateText({
    model: deepSeekModel,
    temperature: 0.4,
    system: `You are the Line Editor.
Your job is to enhance vocabulary, pacing, transition flow, and emotional resonance to hit the NYT bestseller standard WITHOUT altering facts.
Apply these style rules rigorously:
${PREMIUM_BOOK_STYLE_RULES}`,
    prompt: `Edit this draft for pacing, emotional resonance, and word choice:\n\n${draft}`
  });
  
  return text;
}
