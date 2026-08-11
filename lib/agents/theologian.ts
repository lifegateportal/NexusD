import { generateObject } from "ai";
import { deepSeekModel } from "@/lib/ai-providers";
import { z } from "zod";

const CritiqueSchema = z.object({
  approved: z.boolean(),
  hallucinations: z.array(z.string()).describe("List of exact concepts that do not exist in the source transcript chunks."),
  theologicalShifts: z.array(z.string()).describe("List of core theological messages that shifted from the source."),
  rewritesRequired: z.string().optional()
});

export async function checkFidelity(draft: string, originalChunks: { id: string; text: string }[]) {
  const context = originalChunks.map(c => `[ANCHOR: ${c.id}]\n${c.text}`).join("\n\n");
  
  const { object } = await generateObject({
    model: deepSeekModel,
    schema: CritiqueSchema,
    mode: "json",
    temperature: 0.1,
    system: `You are The Theologian and Fidelity Checker.
Your ONLY job is to compare the new draft against the original transcript chunks. 
If the core theological message shifted, or if an illustration was hallucinated, you MUST reject the draft. Zero tolerance for hallucination or altering the facts.`,
    prompt: `Original Transcript Context:\n${context}\n\nGenerated Draft:\n${draft}`
  });
  
  return object;
}
