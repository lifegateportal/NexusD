export type NexusVoiceRecognitionResult = {
  isFinal: boolean;
  transcript: string;
};

export type NexusVoiceRecognitionEvent = {
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

export type NexusVoiceRecognitionErrorEvent = Event & {
  error?: string;
  message?: string;
};

export interface NexusVoiceRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: NexusVoiceRecognitionEvent) => void) | null;
  onerror: ((event: NexusVoiceRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type NexusVoiceRecognitionConstructor = new () => NexusVoiceRecognition;

type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: NexusVoiceRecognitionConstructor;
  webkitSpeechRecognition?: NexusVoiceRecognitionConstructor;
};

export function createNexusVoiceRecognition(): NexusVoiceRecognition | null {
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

export function getNexusRecognitionText(event: NexusVoiceRecognitionEvent): NexusVoiceRecognitionResult {
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

export function extractNexusWakeCommand(transcript: string): string | null {
  const match = transcript.match(/\b(?:hey\s+|okay\s+|ok\s+)?nexus\b[\s,:;-]*/i);
  if (!match || match.index === undefined) return null;
  return transcript.slice(match.index + match[0].length).trim();
}

export function cleanNexusVoiceText(text: string): string {
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

export function splitNexusVoiceText(text: string, maxLength = 260): string[] {
  const normalized = cleanNexusVoiceText(text);
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
