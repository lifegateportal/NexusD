import { deepSeekModel, deepSeekReasonerModel } from "@/lib/ai-providers";

export type EbookModelChoice = "deepseek" | "gemini";

export function getEbookModel(choice: EbookModelChoice) {
  return choice === "gemini" ? deepSeekModel : deepSeekReasonerModel;
}

export function getEbookTemperature(choice: EbookModelChoice, task: "reasoning" | "extraction") {
  if (choice === "gemini") {
    // Nexus-Chat uses DeepSeek Chat for fast generation.
    return task === "reasoning" ? 0.35 : 0.2;
  }
  // DeepSeek default temperatures
  return task === "reasoning" ? 0.28 : 0.2;
}
