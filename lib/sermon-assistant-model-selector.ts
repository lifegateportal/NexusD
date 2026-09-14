import { deepSeekReasonerModel, deepSeekModel, geminiModel } from "@/lib/ai-providers";

export type SermonAssistantModelChoice = "deepseek" | "gemini";

/**
 * Get the outline-generation model (general generation, not reasoning).
 * Outline generation uses a simpler model for faster turnaround.
 */
export function getSermonOutlineModel(choice: SermonAssistantModelChoice) {
  return choice === "gemini" ? geminiModel : deepSeekModel;
}

/**
 * Get the command-processing model (reasoning for outline edits).
 * Command processing requires reasoning to understand edits and preserve structure.
 */
export function getSermonCommandModel(choice: SermonAssistantModelChoice) {
  return choice === "gemini" ? geminiModel : deepSeekReasonerModel;
}

/**
 * Get temperature for scripture suggestion (extraction task, low variability).
 */
export function getSermonTemperature(choice: SermonAssistantModelChoice, task: "outline" | "command" | "scripture"): number {
  if (choice === "gemini") {
    // Gemini extended thinking runs colder; warm it up to match DeepSeek behavior
    if (task === "outline") return 0.35;      // outline generation: DeepSeek 0.3 → Gemini 0.35
    if (task === "command") return 0.32;      // command reasoning: DeepSeek 0.25 → Gemini 0.32
    return 0.15;                               // scripture: DeepSeek 0.1 → Gemini 0.15
  }
  // DeepSeek temperatures (original values)
  if (task === "outline") return 0.3;
  if (task === "command") return 0.25;
  return 0.1;
}
