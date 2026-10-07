import { z } from "zod";

export const NexusLMResponseLengthSchema = z.enum(["shorter", "default", "longer", "long-form"]);

export type NexusLMResponseLength = z.infer<typeof NexusLMResponseLengthSchema>;

export const NEXUSLM_RESPONSE_LENGTHS: Record<NexusLMResponseLength, {
  label: string;
  description: string;
  chatAskTokens: number;
  chatSocraticTokens: number;
  draftTokens: number;
  editTokens: number;
  instruction: string;
}> = {
  shorter: {
    label: "Shorter",
    description: "A focused answer with the essential points",
    chatAskTokens: 1800,
    chatSocraticTokens: 4500,
    draftTokens: 14000,
    editTokens: 10000,
    instruction: "Keep the response focused and concise. Include only the most important supported points.",
  },
  default: {
    label: "Default",
    description: "A balanced response for normal work",
    chatAskTokens: 3000,
    chatSocraticTokens: 7500,
    draftTokens: 24000,
    editTokens: 18000,
    instruction: "Give a balanced response with enough development to be useful without padding.",
  },
  longer: {
    label: "Longer",
    description: "More context, detail, and development",
    chatAskTokens: 5200,
    chatSocraticTokens: 12000,
    draftTokens: 32000,
    editTokens: 28000,
    instruction: "Develop the supported material fully. Do not omit relevant manuscript or transcript content merely to be brief.",
  },
  "long-form": {
    label: "Long-form chapter",
    description: "A complete chapter-sized response for manuscripts, essays, reports, and other substantial work",
    chatAskTokens: 24000,
    chatSocraticTokens: 16000,
    draftTokens: 32000,
    editTokens: 28000,
    instruction: "Write a complete, sustained long-form response when the user requests a chapter, manuscript, essay, report, or other substantial work. Develop the structure, transitions, examples, and conclusion fully. Do not substitute an outline, writing advice, refusal, or redirect for the requested draft. If the request is larger than one response, clearly label the part and continue the work in an orderly chapter-by-chapter sequence.",
  },
};

const INTERNAL_SOURCE_REFERENCE = /\[(?:SOURCE\s*:\s*[^\]]+|(?:M|T)(?:-[A-Za-z0-9_.]+)+|(?:[A-Z]+-)?Slot-[^\]]+|NON-TEACHING-SLOT-[^\]]+)\]/gi;
const INTERNAL_SLOT_TOKEN = /\b(?:T-)?Slot-\d+\b/gi;

export function sanitizeNexusLMText(value: string): string {
  return value
    .replace(INTERNAL_SOURCE_REFERENCE, "")
    .replace(INTERNAL_SLOT_TOKEN, "")
    .replace(/\[source-id\]/gi, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-+*]\s+/gm, "- ")
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/~~/g, "")
    .replace(/`{1,3}/g, "")
    .replace(/\*/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}