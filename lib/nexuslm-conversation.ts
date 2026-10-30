import { z } from "zod";

export const NexusLMConversationInstructionsSchema = z.array(
  z.string().trim().min(1).max(4_000),
).max(100).default([]).superRefine((instructions, context) => {
  const totalCharacters = instructions.reduce((total, instruction) => total + instruction.length, 0);
  if (totalCharacters > 80_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Conversation instructions are too large." });
  }
});

export function formatNexusLMConversationInstructions(instructions: string[]): string {
  if (instructions.length === 0) return "No prior user chat instructions were supplied.";
  return [
    "USER CHAT INSTRUCTIONS, OLDEST TO NEWEST:",
    "Apply relevant user preferences, formatting requirements, and corrections to this task. Newer instructions override older conflicting ones. Do not repeat earlier one-time tasks unless requested again.",
    ...instructions.map((instruction, index) => `${index + 1}. ${instruction}`),
  ].join("\n");
}
