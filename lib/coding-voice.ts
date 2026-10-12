export type CodingVoiceRecognitionResult = {
  isFinal: boolean;
  transcript: string;
};

export type CodingVoiceRecognitionEvent = {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      [index: number]: {
        transcript: string;
      };
    };
  };
};

export type CodingVoiceRecognitionErrorEvent = Event & {
  error?: string;
  message?: string;
};

export interface CodingVoiceRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: CodingVoiceRecognitionEvent) => void) | null;
  onerror: ((event: CodingVoiceRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type CodingVoiceRecognitionConstructor = new () => CodingVoiceRecognition;

type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: CodingVoiceRecognitionConstructor;
  webkitSpeechRecognition?: CodingVoiceRecognitionConstructor;
};

export function createCodingVoiceRecognition(): CodingVoiceRecognition | null {
  if (typeof window === "undefined") return null;
  const browserWindow = window as SpeechRecognitionWindow;
  const Recognition = browserWindow.SpeechRecognition ?? browserWindow.webkitSpeechRecognition;
  if (!Recognition) return null;
  try {
    return new Recognition();
  } catch {
    return null;
  }
}

export function getCodingRecognitionText(event: CodingVoiceRecognitionEvent): CodingVoiceRecognitionResult {
  let transcript = "";
  let isFinal = false;
  const startIndex = Math.max(0, event.resultIndex ?? 0);
  for (let index = startIndex; index < event.results.length; index += 1) {
    const result = event.results[index];
    const alternative = result?.[0];
    if (!alternative) continue;
    transcript += `${alternative.transcript} `;
    isFinal = isFinal || result.isFinal;
  }
  return { isFinal, transcript: transcript.replace(/\s+/g, " ").trim() };
}

export function extractCodingWakeCommand(transcript: string): string | null {
  const match = transcript.match(/\b(?:hey\s+|okay\s+|ok\s+)?nexus\b[\s,:;-]*/i);
  if (!match || match.index === undefined) return null;
  return transcript.slice(match.index + match[0].length).trim();
}

export function cleanCodingVoiceText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)\s]+\)/g, "$1")
    .replace(/\[[A-Z]+-\d+(?:-\d+)?\]/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isCodingGreeting(text: string): boolean {
  return /^(?:hi|hello|hey|yo|good\s+(?:morning|afternoon|evening)|thanks|thank\s+you)(?:[\s,!.?]+(?:there|nexus))?[\s!.?]*$/i.test(text.trim());
}

export function buildCodingGreetingResponse(text: string): string {
  return /^(?:thanks|thank\s+you)\b/i.test(text.trim())
    ? "You are welcome. What would you like to work on next?"
    : "Hi. I am ready to help. What would you like to work on?";
}

function firstSpokenSentences(text: string, maxSentences = 2, maxCharacters = 360): string {
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [text];
  const selected: string[] = [];
  for (const sentence of sentences) {
    const next = `${selected.join(" ")} ${sentence}`.trim();
    if (selected.length > 0 && next.length > maxCharacters) break;
    selected.push(sentence.trim());
    if (selected.length >= maxSentences) break;
  }
  return selected.join(" ").slice(0, maxCharacters).trim();
}

export function buildCodingSpokenResponse(response: string, request: string): string {
  const cleaned = cleanCodingVoiceText(response);
  if (/\b(?:build|write|create|generate|implement|make|develop|fix|update)\b/i.test(request)) {
    return "I completed the code and placed it in the workspace for you to review.";
  }
  if (/\`\`\`[\s\S]*\`\`\`/.test(response)) {
    const spokenLead = response.split(/```/)[0];
    const leadLooksLikeCode = /(?:^|\n)\s*(?:import|export|const|let|var|function|class|def |from |<!doctype|<html|SELECT\s|curl\s)/i.test(spokenLead);
    const preview = leadLooksLikeCode ? "" : firstSpokenSentences(cleanCodingVoiceText(spokenLead), 2, 300);
    return preview
      ? `${preview} The complete code is in the workspace.`
      : "I built the code and placed the complete result in the workspace.";
  }
  if (isCodingGreeting(request)) {
    const preview = firstSpokenSentences(cleaned, 2, 220);
    return preview || "Hi. I am ready to help.";
  }
  if (cleaned.length <= 700) return cleaned;
  const preview = firstSpokenSentences(cleaned);
  return preview
    ? `${preview} I put the full response in the workspace.`
    : "I completed the response and placed the full result in the workspace.";
}

export function splitCodingVoiceText(text: string, maxLength = 260): string[] {
  const normalized = cleanCodingVoiceText(text);
  if (!normalized) return [];
  const sentences = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [normalized];
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    const next = `${current} ${sentence}`.trim();
    if (current && next.length > maxLength) {
      chunks.push(current);
      current = sentence.trim();
      continue;
    }
    current = next;
  }
  if (current) chunks.push(current);
  return chunks;
}
