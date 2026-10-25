import { deepSeekReasonerModel, deepSeekModel } from "@/lib/ai-providers";

export type SermonAssistantModelChoice = "deepseek" | "deepseek-chat";

/**
 * Get the outline-generation model (general generation, not reasoning).
 * Outline generation uses a simpler model for faster turnaround.
 */
export function getSermonOutlineModel(choice: SermonAssistantModelChoice) {
  return deepSeekModel;
}

/**
 * Get the command-processing model (reasoning for outline edits).
 * Command processing requires reasoning to understand edits and preserve structure.
 */
export function getSermonCommandModel(choice: SermonAssistantModelChoice) {
  return choice === "deepseek-chat" ? deepSeekModel : deepSeekReasonerModel;
}

/**
 * Get temperature for scripture suggestion (extraction task, low variability).
 */
export function getSermonTemperature(choice: SermonAssistantModelChoice, task: "outline" | "command" | "scripture"): number {
  // DeepSeek temperatures (original values)
  if (task === "outline") return 0.3;
  if (task === "command") return 0.25;
  return 0.1;
}
