import { deepSeekReasonerModel, geminiModel } from "@/lib/ai-providers";

export type EbookModelChoice = "deepseek" | "gemini";

export function getEbookModel(choice: EbookModelChoice) {
  return choice === "gemini" ? geminiModel : deepSeekReasonerModel;
}

export function getEbookTemperature(choice: EbookModelChoice, task: "reasoning" | "extraction") {
  if (choice === "gemini") {
    // Gemini 2.0 Flash extended thinking temperatures
    return task === "reasoning" ? 0.35 : 0.2;
  }
  // DeepSeek default temperatures
  return task === "reasoning" ? 0.28 : 0.2;
}
