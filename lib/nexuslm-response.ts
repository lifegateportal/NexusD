import { z } from "zod";

export const NexusLMResponseLengthSchema = z.enum(["shorter", "default", "longer", "long-form"]);

export type NexusLMResponseLength = z.infer<typeof NexusLMResponseLengthSchema>;

const LONG_FORM_WRITING_VERBS = /\b(?:write|draft|compose|create|produce|develop|rewrite|turn|transform|build|design|implement|code|program)\b/i;
const LONG_FORM_OUTPUT_TYPES = /\b(?:chapter|essay|report|article|manuscript|book|section|sermon|story|paper|website|web[\s-]?page|web[\s-]?app(?:lication)?|site|landing\s+page|front[\s-]?end|user\s+interface|ui|html|css|javascript|typescript|react|next\.js|codebase|component|dashboard)\b/i;

export function isNexusLMLongFormRequest(query: string): boolean {
  return LONG_FORM_WRITING_VERBS.test(query) && LONG_FORM_OUTPUT_TYPES.test(query);
}

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
    label: "Long-form deliverable",
    description: "A complete response for manuscripts, essays, reports, websites, code, and other substantial work",
    chatAskTokens: 24000,
    chatSocraticTokens: 16000,
    draftTokens: 32000,
    editTokens: 28000,
    instruction: "Write a complete, sustained long-form response when the user requests a chapter, manuscript, essay, report, website, codebase, or other substantial work. Develop the structure, transitions, examples, implementation, and conclusion fully. Do not substitute an outline, writing advice, refusal, or redirect for the requested deliverable. Use the available budget to finish the requested work rather than announcing parts or stopping at an outline; if the generation limit interrupts the draft, continue directly without repeating completed material.",
  },
};

const INTERNAL_SOURCE_REFERENCE = /\[(?:SOURCE\s*:\s*[^\]]+|(?:M|T)(?:-[A-Za-z0-9_.]+)+|(?:[A-Z]+-)?Slot-[^\]]+|NON-TEACHING-SLOT-[^\]]+)\]/gi;
const INTERNAL_SLOT_TOKEN = /\b(?:T-)?Slot-\d+\b/gi;

export function sanitizeNexusLMText(value: string, options: { preserveSourceReferences?: boolean } = {}): string {
  const sourceSafeValue = options.preserveSourceReferences
    ? value
    : value.replace(INTERNAL_SOURCE_REFERENCE, "");
  return sourceSafeValue
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