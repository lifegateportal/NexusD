import { generateObject } from "ai";
import { deepSeekModel } from "@/lib/ai-providers";
import { BookArchitectureSchema } from "@/lib/schemas/ebook";

export async function generateBookBlueprint(transcriptPartitions: { id: string; text: string }[]) {
  const summary = transcriptPartitions.map(p => `[ID: ${p.id}]\n${p.text.slice(0, 300)}...`).join("\n\n");
  
  const { object } = await generateObject({
    model: deepSeekModel,
    schema: BookArchitectureSchema,
    mode: "json",
    temperature: 0.3,
    system: `You are the Master Architect mapping a sermon into a NYT bestseller. 
    Map specific transcript chunk IDs to specific chapters. 
    You must guarantee the AI has a restricted, highly relevant context window for each chapter (Zero Hallucination).`,
    prompt: `Analyze the global context and generate a comprehensive Book Blueprint: \n\n${summary}`
  });
  
  return object;
}
