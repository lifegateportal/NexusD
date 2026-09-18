"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";

type TabId = "raw" | "organized" | "assistant";

type ScriptureCard = {
  id: string;
  ref: string;
  text: string;
  source: "detected" | "suggested";
  confidence?: number;
  reason?: string;
};

type ChatEntry = {
  id: string;
  role: "user" | "assistant";
  markdown: string;
};

type CadencePoint = {
  tSec: number;
  wpm: number;
};

type SpeechLanguage = "auto" | "english" | "spanish" | "french" | "portuguese" | "german" | "swahili" | "twi" | "kikuyu";
type BibleTranslationCode = "web" | "kjv" | "asv" | "ylt" | "niv" | "nlt" | "nkjv" | "amp" | "msg";

type PulpitBlock = {
  kind: "paragraph" | "bullet" | "quote" | "subheading";
  text: string;
};

type PulpitSection = {
  title: string;
  body: string;
  blocks: PulpitBlock[];
  wordCount: number;
};

type SermonCloudSnapshot = {
  rawTranscript: string;
  organizedMarkdown: string;
  manualNotes: string;
  scriptureCards: ScriptureCard[];
};

type SermonProjectRecord = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  sermonAssistant: SermonCloudSnapshot;
};

type MonitorBackgroundId = "black" | "midnight" | "sunrise" | "ocean" | "charcoal" | "transparent";
type MonitorFontStyle = "serif" | "sans" | "display";
type LowerThirdSize = "compact" | "standard" | "large";

type MonitorDisplayPrefs = {
  layout: "center" | "lower-third";
  background: MonitorBackgroundId;
  fontStyle: MonitorFontStyle;
  lowerThirdBackground: "solid" | "glass" | "transparent";
  centerRefSize: number;
  centerVerseSize: number;
  lowerRefSize: number;
  lowerVerseSize: number;
  lowerThirdSize: LowerThirdSize;
};

const DEFAULT_MONITOR_DISPLAY_PREFS: MonitorDisplayPrefs = {
  layout: "center",
  background: "black",
  fontStyle: "serif",
  lowerThirdBackground: "solid",
  centerRefSize: 34,
  centerVerseSize: 72,
  lowerRefSize: 18,
  lowerVerseSize: 40,
  lowerThirdSize: "standard",
};

function normalizeSermonProjectRecord(input: unknown): SermonProjectRecord | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const rawSermon = record.sermonAssistant;
  if (!rawSermon) return null;

  const decoded = (() => {
    if (typeof rawSermon === "string") {
      try {
        return JSON.parse(rawSermon) as unknown;
      } catch {
        return null;
      }
    }
    return rawSermon;
  })();

  if (!decoded || typeof decoded !== "object") return null;
  const sermon = decoded as Record<string, unknown>;

  const scriptureCards = Array.isArray(sermon.scriptureCards)
    ? sermon.scriptureCards.filter((card): card is ScriptureCard => (
        !!card &&
        typeof card === "object" &&
        typeof (card as Record<string, unknown>).id === "string" &&
        typeof (card as Record<string, unknown>).ref === "string" &&
        typeof (card as Record<string, unknown>).text === "string" &&
        (((card as Record<string, unknown>).source === "detected") || ((card as Record<string, unknown>).source === "suggested"))
      ))
    : [];

  const id = typeof record.id === "string" && record.id.trim()
    ? record.id
    : `sermon-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const name = typeof record.name === "string" && record.name.trim() ? record.name : "Sermon";
  const createdAt = typeof record.createdAt === "string" && record.createdAt ? record.createdAt : new Date().toISOString();
  const updatedAt = typeof record.updatedAt === "string" && record.updatedAt ? record.updatedAt : createdAt;

  return {
    id,
    name,
    createdAt,
    updatedAt,
    sermonAssistant: {
      rawTranscript: typeof sermon.rawTranscript === "string" ? sermon.rawTranscript : "",
      organizedMarkdown: typeof sermon.organizedMarkdown === "string" ? sermon.organizedMarkdown : "",
      manualNotes: typeof sermon.manualNotes === "string" ? sermon.manualNotes : "",
      scriptureCards,
    },
  };
}

type SuggestionResponse = {
  suggestions: Array<{
    ref: string;
    text: string;
    reason?: string;
    confidence?: number;
  }>;
};

const STORAGE_KEYS = {
  raw: "nexus_sermon_raw",
  organized: "nexus_sermon_organized",
  notes: "nexus_sermon_manual_notes",
  projectId: "nexus_sermon_project_id",
  projectName: "nexus_sermon_project_name",
} as const;

const SCRIPTURE_DB = [
  { triggers: ["john 3 16", "john 316", "john three sixteen", "so loved the world", "gave his only son", "gave his only begotten son"], ref: "John 3:16", text: "For God so loved the world, that he gave his only Son, that whoever believes in him should not perish but have eternal life." },
  { triggers: ["ephesians 6", "armor of god", "armour of god", "whole armor", "put on the full armor"], ref: "Ephesians 6:11", text: "Put on the whole armor of God, that you may be able to stand against the schemes of the devil." },
  { triggers: ["psalm 23", "lord is my shepherd", "i shall not want", "he leadeth me"], ref: "Psalm 23:1", text: "The Lord is my shepherd; I shall not want." },
  { triggers: ["john 1 1", "in the beginning was the word", "word was god", "word was with god", "the word was god"], ref: "John 1:1", text: "In the beginning was the Word, and the Word was with God, and the Word was God." },
  { triggers: ["genesis chapter one", "genesis 1", "genesis one", "in the beginning god created", "in the beginning god", "god created the heavens", "created the heavens and the earth"], ref: "Genesis 1:1", text: "In the beginning, God created the heavens and the earth." },
  { triggers: ["romans 8 28", "all things work together", "all things work together for good", "work together for those who love god"], ref: "Romans 8:28", text: "And we know that for those who love God all things work together for good, for those who are called according to his purpose." },
  { triggers: ["philippians 4 13", "i can do all things", "all things through christ", "through christ who strengthens me"], ref: "Philippians 4:13", text: "I can do all things through him who strengthens me." },
  { triggers: ["jeremiah 29 11", "plans i have for you", "plans to prosper you", "plans for welfare and not evil"], ref: "Jeremiah 29:11", text: "For I know the plans I have for you, declares the Lord, plans for welfare and not for evil, to give you a future and a hope." },
  { triggers: ["joshua 1 9", "be strong and courageous", "be strong and of good courage", "do not be afraid or dismayed"], ref: "Joshua 1:9", text: "Be strong and courageous. Do not be frightened, and do not be dismayed, for the Lord your God is with you wherever you go." },
  { triggers: ["proverbs 3 5", "trust in the lord with all your heart", "lean not on your own understanding", "lean not unto thine own understanding"], ref: "Proverbs 3:5", text: "Trust in the Lord with all your heart, and do not lean on your own understanding." },
  { triggers: ["isaiah 40 31", "those who wait upon the lord", "they shall renew their strength", "mount up with wings as eagles", "wings like eagles"], ref: "Isaiah 40:31", text: "But they who wait for the Lord shall renew their strength; they shall mount up with wings like eagles; they shall run and not be weary." },
  { triggers: ["john 14 6", "i am the way the truth and the life", "the way the truth and the life", "i am the way"], ref: "John 14:6", text: "Jesus said to him, 'I am the way, and the truth, and the life. No one comes to the Father except through me.'" },
  { triggers: ["matthew 6 33", "seek first the kingdom", "seek ye first the kingdom", "seek first his kingdom and his righteousness"], ref: "Matthew 6:33", text: "But seek first the kingdom of God and his righteousness, and all these things will be added to you." },
  { triggers: ["2 chronicles 7 14", "second chronicles 7 14", "if my people who are called by my name", "humble themselves and pray", "turn from their wicked ways"], ref: "2 Chronicles 7:14", text: "If my people who are called by my name humble themselves, and pray and seek my face and turn from their wicked ways, then I will hear from heaven and will forgive their sin and heal their land." },
  { triggers: ["revelation 3 20", "behold i stand at the door and knock", "i stand at the door", "knock and i will open"], ref: "Revelation 3:20", text: "Behold, I stand at the door and knock. If anyone hears my voice and opens the door, I will come in to him and eat with him, and he with me." },
] as const;

const SCRIPTURE_REF_REGEX = /\b(?:[1-3]\s+)?[A-Za-z]+(?:\s+[A-Za-z]+)?\s+\d{1,3}:\d{1,3}(?:-\d{1,3})?\b/g;

const BIBLE_REF_REGEX = /\b(?:[1-3]\s+)?(?:[A-Z][a-z]+(?:\s+[A-Za-z]+){0,2})\s+\d{1,3}:\d{1,3}(?:-\d{1,3})?\b/g;

const READING_INTENT_REGEX = /\b(?:i(?:'m| am) (?:now )?reading|(?:let(?:'s| us)) (?:read|open to|turn to)|(?:our|today(?:'s)?|this) (?:text|scripture|passage) (?:is|comes from)|(?:open|turn) (?:your )?(?:bibles? )?to|reading (?:from|with me)|follow(?:ing)? along)\b/i;
const NEXT_VERSE_REGEX = /\bnext verse\b/i;
const VERSE_NUMBER_REGEX = /\bverse\s+(\d+)\b/i;

const BIBLE_BOOK_SUGGESTIONS = [
  "Genesis", "Exodus", "Leviticus", "Numbers", "Deuteronomy", "Joshua", "Judges", "Ruth",
  "1 Samuel", "2 Samuel", "1 Kings", "2 Kings", "1 Chronicles", "2 Chronicles", "Ezra", "Nehemiah", "Esther",
  "Job", "Psalms", "Proverbs", "Ecclesiastes", "Song of Solomon", "Isaiah", "Jeremiah", "Lamentations",
  "Ezekiel", "Daniel", "Hosea", "Joel", "Amos", "Obadiah", "Jonah", "Micah", "Nahum", "Habakkuk",
  "Zephaniah", "Haggai", "Zechariah", "Malachi", "Matthew", "Mark", "Luke", "John", "Acts", "Romans",
  "1 Corinthians", "2 Corinthians", "Galatians", "Ephesians", "Philippians", "Colossians", "1 Thessalonians",
  "2 Thessalonians", "1 Timothy", "2 Timothy", "Titus", "Philemon", "Hebrews", "James", "1 Peter", "2 Peter",
  "1 John", "2 John", "3 John", "Jude", "Revelation",
] as const;

const TRANSLATION_ALIASES: Array<{ pattern: RegExp; code: BibleTranslationCode }> = [
  { pattern: /\bnew\s+international\s+version\b|\bniv\b/i, code: "niv" },
  { pattern: /\bnew\s+living\s+translation\b|\bnlt\b/i, code: "nlt" },
  { pattern: /\bnew\s+king\s+james(?:\s+version)?\b|\bnkjv\b/i, code: "nkjv" },
  { pattern: /\bking\s+james(?:\s+version)?\b|\bkjv\b/i, code: "kjv" },
  { pattern: /\bamerican\s+standard\s+version\b|\basv\b/i, code: "asv" },
  { pattern: /\byoung'?s\s+literal\s+translation\b|\bylt\b/i, code: "ylt" },
  { pattern: /\bworld\s+english\s+bible\b|\bweb\b/i, code: "web" },
  { pattern: /\bamplified(?:\s+bible)?\b|\bamp\b/i, code: "amp" },
  { pattern: /\bthe\s+message\b|\bmsg\b/i, code: "msg" },
];

function detectTranslationFromSpeech(text: string): BibleTranslationCode | null {
  for (const alias of TRANSLATION_ALIASES) {
    if (alias.pattern.test(text)) return alias.code;
  }
  return null;
}

function splitReferenceAndTranslation(raw: string, fallback: BibleTranslationCode): { reference: string; translation: BibleTranslationCode } {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  for (const alias of TRANSLATION_ALIASES) {
    const match = trimmed.match(alias.pattern);
    if (!match) continue;
    const start = match.index ?? -1;
    const token = match[0];
    if (start < 0) continue;
    const cleaned = `${trimmed.slice(0, start)} ${trimmed.slice(start + token.length)}`.replace(/\s+/g, " ").trim();
    if (cleaned) return { reference: cleaned, translation: alias.code };
  }
  return { reference: trimmed, translation: fallback };
}

const NUM_WORDS: Record<string, number> = {
  one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,
  ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,
  sixteen:16,seventeen:17,eighteen:18,nineteen:19,
  twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90,
};

function wordsToDigits(s: string): string {
  return s
    .replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-]?(one|two|three|four|five|six|seven|eight|nine)\b/gi,
      (_, t: string, o: string) => String((NUM_WORDS[t.toLowerCase()] ?? 0) + (NUM_WORDS[o.toLowerCase()] ?? 0)))
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/gi,
      (w) => String(NUM_WORDS[w.toLowerCase()] ?? w));
}

function extractSpokenRefs(raw: string): string[] {
  let s = raw;
  s = s.replace(/\bfirst\s+([A-Z])/g, "1 $1").replace(/\bsecond\s+([A-Z])/g, "2 $1").replace(/\bthird\s+([A-Z])/g, "3 $1");
  s = wordsToDigits(s);
  s = s.replace(/\bchapter\s+(\d+)[,\s]+(?:and\s+)?verse\s+(\d+)/gi, "$1:$2");
  s = s.replace(/\b(\d+)\s+verse\s+(\d+)/gi, "$1:$2");
  const spaceRefs = s.match(/\b(?:[1-3]\s+)?[A-Za-z]+(?:\s+[A-Za-z]+)?\s+(\d{1,3})\s+(\d{1,3})\b/gi) ?? [];
  const spaceFixed = spaceRefs.map((r) => r.replace(/(\d+)\s+(\d+)$/, "$1:$2"));
  const standard = s.match(/\b(?:[1-3]\s+)?[A-Za-z]+(?:\s+[A-Za-z]+)?\s+\d{1,3}:\d{1,3}(?:-\d{1,3})?\b/gi) ?? [];
  return [...new Set([...standard, ...spaceFixed])];
}

function verseOverlap(verseText: string, spokenText: string): number {
  if (!verseText || !spokenText) return 0;
  const words = verseText.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  if (words.length === 0) return 0;
  const spoken = spokenText.toLowerCase();
  const matched = words.filter((w) => spoken.includes(w));
  return matched.length / words.length;
}

function nextSequentialRef(ref: string): string | null {
  const m = ref.match(/^((?:[1-3]\s+)?[A-Za-z]+(?:\s+[A-Za-z]+)?)\s+(\d+):(\d+)$/);
  if (!m) return null;
  return `${m[1]} ${m[2]}:${parseInt(m[3]) + 1}`;
}

function prevSequentialRef(ref: string): string | null {
  const m = ref.match(/^((?:[1-3]\s+)?[A-Za-z]+(?:\s+[A-Za-z]+)?)\s+(\d+):(\d+)$/);
  if (!m) return null;
  const prevVerse = parseInt(m[3]) - 1;
  if (prevVerse < 1) return null;
  return `${m[1]} ${m[2]}:${prevVerse}`;
}

const THEOLOGY_HINTS = [
  "god", "lord", "jesus", "christ", "holy spirit", "holy ghost",
  "scripture", "bible", "verse", "gospel", "word of god",
  "genesis", "exodus", "leviticus", "numbers", "deuteronomy",
  "joshua", "judges", "samuel", "kings", "chronicles", "psalms", "psalm",
  "proverbs", "isaiah", "jeremiah", "ezekiel", "daniel",
  "matthew", "mark", "luke", "john", "acts", "romans",
  "corinthians", "galatians", "ephesians", "philippians",
  "colossians", "thessalonians", "timothy", "revelation",
  "prophet", "covenant", "dry bones", "cross", "resurrection",
  "shepherd", "wilderness", "promise", "kingdom", "grace",
  "mercy", "faith", "israel", "paul", "moses", "david",
  "heaven", "salvation", "sin", "forgiveness", "prayer",
  "church", "spirit", "amen", "blessed", "glory",
] as const;


function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderMarkdown(md: string): string {
  const escaped = escapeHtml(md);
  let html = escaped.replace(/^### (.*$)/gim, '<h3 class="text-xl font-bold text-slate-100 mt-6 mb-2">$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h2 class="text-2xl font-bold text-cyan-300 border-b border-cyan-500/25 pb-2 mt-8 mb-3">$1</h2>');
  html = html.replace(/^# (.*$)/gim, '<h1 class="text-3xl font-black text-cyan-300 mb-5">$1</h1>');
  html = html.replace(/^\> (.*$)/gim, '<blockquote class="border-l-4 border-cyan-400/80 bg-cyan-500/10 rounded-r-xl px-4 py-3 text-slate-300 italic my-4">$1</blockquote>');
  html = html.replace(/^\-\s+(.*$)/gim, '<li class="ml-5 list-disc text-slate-200">$1</li>');
  html = html.replace(/\*\*(.*?)\*\*/gim, '<strong class="text-slate-100">$1</strong>');
  html = html.replace(/\*(.*?)\*/gim, "<em>$1</em>");
  html = html.replace(/\n/g, "<br />");
  return html;
}

function stripMarkdown(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/`/g, "")
    .trim();
}

function isMeaningfulSermonMarkdown(markdown: string): boolean {
  const normalized = markdown.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
  if (!normalized) return false;

  const words = normalized.match(/\b[\p{L}\p{N}][\p{L}\p{N}'-]*\b/gu) ?? [];
  if (words.length < 8) return false;

  const lettersAndDigits = normalized.match(/[\p{L}\p{N}]/gu) ?? [];
  return lettersAndDigits.length >= 24;
}

function normalizeForTriggers(text: string): string {
  return text.toLowerCase().replace(/[.,!?;:]/g, "");
}

function countWords(text: string): number {
  const clean = text.trim();
  if (!clean) return 0;
  return clean.split(/\s+/).filter(Boolean).length;
}

function chooseRecorderMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
  ];
  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return "";
}

function buildPulpitSections(markdown: string): PulpitSection[] {
  function linesToBlocks(bodyLines: string[]): PulpitBlock[] {
    const blocks: PulpitBlock[] = [];
    let paragraphBuffer: string[] = [];

    const flushParagraph = () => {
      const text = stripMarkdown(paragraphBuffer.join(" ")).trim();
      if (text) blocks.push({ kind: "paragraph", text });
      paragraphBuffer = [];
    };

    for (const rawLine of bodyLines) {
      const line = rawLine.trim();
      if (!line) {
        flushParagraph();
        continue;
      }

      if (line.startsWith("### ")) {
        flushParagraph();
        blocks.push({ kind: "subheading", text: stripMarkdown(line) });
        continue;
      }

      if (line.startsWith(">")) {
        flushParagraph();
        blocks.push({ kind: "quote", text: stripMarkdown(line) });
        continue;
      }

      if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
        flushParagraph();
        blocks.push({ kind: "bullet", text: stripMarkdown(line) });
        continue;
      }

      paragraphBuffer.push(line);
    }

    flushParagraph();
    return blocks;
  }

  const lines = markdown.split(/\r?\n/);
  const sections: PulpitSection[] = [];
  let currentTitle = "Sermon";
  let bodyLines: string[] = [];

  const pushSection = () => {
    const body = stripMarkdown(bodyLines.join("\n")).trim();
    if (!body) return;
    sections.push({
      title: currentTitle,
      body,
      blocks: linesToBlocks(bodyLines),
      wordCount: countWords(body),
    });
  };

  for (const line of lines) {
    const heading = line.match(/^(#{1,2})\s+(.+)$/);
    if (heading) {
      pushSection();
      currentTitle = heading[2].trim();
      bodyLines = [];
      continue;
    }
    bodyLines.push(line);
  }

  pushSection();

  if (sections.length === 0 && markdown.trim()) {
    const body = stripMarkdown(markdown);
    return [{ title: "Sermon", body, blocks: linesToBlocks(markdown.split(/\r?\n/)), wordCount: countWords(body) }];
  }

  return sections;
}

function formatClockTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (hh > 0) {
    return `${hh.toString().padStart(2, "0")}:${mm.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}`;
  }
  return `${mm.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}`;
}

function estimateSectionDuration(wordCount: number, wpm: number): string {
  const effectiveWpm = wpm >= 80 ? wpm : 130;
  const minutes = Math.max(1, Math.round((wordCount / effectiveWpm) * 60));
  return formatElapsed(minutes);
}

function looksTheological(text: string): boolean {
  const lowered = text.toLowerCase();
  return THEOLOGY_HINTS.some((hint) => lowered.includes(hint));
}

function normalizeRef(ref: string): string {
  return ref.replace(/\s+/g, " ").trim();
}

function normalizeBookToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function extractBookPrefixForSuggest(input: string): string {
  const trimmed = input.trimStart();
  if (!trimmed) return "";
  if (/[:]/.test(trimmed)) return "";
  const match = trimmed.match(/^([1-3]?\s*[A-Za-z\s]+)/);
  return match ? match[1].trim() : "";
}

function extractScriptureRefs(text: string): string[] {
  const matches = text.match(SCRIPTURE_REF_REGEX) ?? [];
  const unique = new Set<string>();
  for (const raw of matches) {
    const normalized = normalizeRef(raw);
    if (normalized.length >= 4) unique.add(normalized);
  }
  return [...unique];
}

function slugifyFileName(input: string): string {
  const normalized = input.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "sermon-notes";
}

function buildDocxParagraphs(markdown: string): Paragraph[] {
  const lines = markdown.split(/\r?\n/);
  const paragraphs: Paragraph[] = [];
  let skipNextSectionTitle = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      paragraphs.push(new Paragraph({ text: "" }));
      continue;
    }

    if (line.startsWith("### ")) {
      paragraphs.push(new Paragraph({ text: line.slice(4), heading: HeadingLevel.HEADING_3 }));
      continue;
    }

    if (line.startsWith("## ")) {
      if (skipNextSectionTitle) {
        skipNextSectionTitle = false;
        continue;
      }
      paragraphs.push(new Paragraph({ text: line.slice(3), heading: HeadingLevel.HEADING_2 }));
      continue;
    }

    if (line.startsWith("# ")) {
      paragraphs.push(new Paragraph({ text: line.slice(2), heading: HeadingLevel.HEADING_1 }));
      skipNextSectionTitle = true;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      paragraphs.push(new Paragraph({
        text: line.replace(/^[-*]\s+/, ""),
        bullet: { level: 0 },
      }));
      continue;
    }

    if (line.startsWith("> ")) {
      paragraphs.push(new Paragraph({
        children: [new TextRun({ text: line.slice(2), italics: true })],
      }));
      continue;
    }

    paragraphs.push(new Paragraph({ text: line }));
  }

  return paragraphs;
}

export function SermonAssistantPanel() {
  const [activeTab, setActiveTab] = useState<TabId>("raw");
  const [rawTranscript, setRawTranscript] = useState("");
  const [organizedMarkdown, setOrganizedMarkdown] = useState("");
  const [manualNotes, setManualNotes] = useState("");
  const [scriptureCards, setScriptureCards] = useState<ScriptureCard[]>([]);
  const [chatEntries, setChatEntries] = useState<ChatEntry[]>([]);
  const [assistantInput, setAssistantInput] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [interimText, setInterimText] = useState("");
  const [statusText, setStatusText] = useState("Ready");
  const [toast, setToast] = useState<{ text: string; type: "info" | "success" | "error" } | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isAssistantThinking, setIsAssistantThinking] = useState(false);
  const [currentProjectId, setCurrentProjectId] = useState("");
  const [projectName, setProjectName] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyItems, setHistoryItems] = useState<SermonProjectRecord[]>([]);
  const [isEditingOrganized, setIsEditingOrganized] = useState(false);
  const [isCompactLayout, setIsCompactLayout] = useState(false);
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);
  const [mobileRefsOpen, setMobileRefsOpen] = useState(false);
  const [mobileTelemetryOpen, setMobileTelemetryOpen] = useState(false);
  const [desktopTelemetryOpen, setDesktopTelemetryOpen] = useState(false);
  const [mobileOrganizedView, setMobileOrganizedView] = useState<"outline" | "manual">("outline");
  const [speechLanguage, setSpeechLanguage] = useState<SpeechLanguage>("auto");
  const [selectedSermonAssistantModel, setSelectedSermonAssistantModel] = useState<"deepseek" | "gemini">("deepseek");
  const [autoPushDisplay, setAutoPushDisplay] = useState(false);
  const [liveMode, setLiveMode] = useState(false);
  const [monitorDisplayPrefs, setMonitorDisplayPrefs] = useState<MonitorDisplayPrefs>(DEFAULT_MONITOR_DISPLAY_PREFS);
  const [desktopDisplayStyleOpen, setDesktopDisplayStyleOpen] = useState(false);
  const [mobileDisplayStyleOpen, setMobileDisplayStyleOpen] = useState(false);
  const [readingQueue, setReadingQueue] = useState<Array<{ ref: string; text: string }>>([]);
  const [readingQueueIndex, setReadingQueueIndex] = useState(0);
  const [bibleTranslation, setBibleTranslation] = useState<BibleTranslationCode>("kjv");
  const [lastDisplayRef, setLastDisplayRef] = useState("");
  const [manualRefInput, setManualRefInput] = useState("");
  const [manualVerseInput, setManualVerseInput] = useState("");
  const [manualCastBusy, setManualCastBusy] = useState(false);
  const [manualRefFocused, setManualRefFocused] = useState(false);

  const [refsPanelWidth, setRefsPanelWidth] = useState(300);
  const [isDraggingResize, setIsDraggingResize] = useState(false);
  const isDraggingResizeRef = useRef(false);
  const dragStartDataRef = useRef({ startX: 0, startWidth: 300 });
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [volumeLevel, setVolumeLevel] = useState(0);
  const [currentWpm, setCurrentWpm] = useState(0);
  const [avgWpm, setAvgWpm] = useState(0);
  const [cadencePoints, setCadencePoints] = useState<CadencePoint[]>([]);

  const [audioDownloadUrl, setAudioDownloadUrl] = useState<string | null>(null);
  const [audioFileName, setAudioFileName] = useState("sermon-session.webm");

  const [pulpitOpen, setPulpitOpen] = useState(false);
  const [pulpitIndex, setPulpitIndex] = useState(0);
  const [pulpitNow, setPulpitNow] = useState(() => Date.now());
  const [pulpitStartedAt, setPulpitStartedAt] = useState<number | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioMimeRef = useRef("audio/webm");

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const volumeFrameRef = useRef<number | null>(null);

  const recordingStartedAtRef = useRef<number | null>(null);
  const lastFinalAtRef = useRef<number | null>(null);
  const totalWordsRef = useRef(0);
  const totalSpeechSecondsRef = useRef(0);

  const semanticTimerRef = useRef<number | null>(null);
  const semanticInFlightRef = useRef(false);
  const scriptureCardsRef = useRef<ScriptureCard[]>([]);
  const rangeCastTimersRef = useRef<number[]>([]);

  const presentationWindowRef = useRef<Window | null>(null);
  const notesSlidesWindowRef = useRef<Window | null>(null);
  const pulpitTouchStartXRef = useRef<number | null>(null);
  const rangePlaybackTimeoutRef = useRef<number | null>(null);
  const monitorSyncUpdatedAtRef = useRef(0);
  const pulpitRangeRefRef = useRef<string>("");
  const pulpitRangeVersesRef = useRef<Array<{ ref: string; text: string }>>([]);
  const pulpitRangeIndexRef = useRef(0);
  const readingQueueRef = useRef<Array<{ ref: string; text: string }>>([]);
  const readingQueueIndexRef = useRef(0);
  const liveModeRef = useRef(false);
  const bibleTranslationRef = useRef<BibleTranslationCode>("kjv");
  const lastMonitorRefRef = useRef<string>("");
  const wordsSpokenForVerseRef = useRef<string>("");
  const tabOrder = isCompactLayout
    ? (["organized", "raw", "assistant"] as TabId[])
    : (["raw", "organized", "assistant"] as TabId[]);

  const getPreferredLandingTab = useCallback((organizedValue: string): TabId => {
    if (isCompactLayout && organizedValue.trim()) return "organized";
    return "raw";
  }, [isCompactLayout]);

  const mergeScriptureCards = useCallback((incoming: ScriptureCard[]) => {
    if (incoming.length === 0) return;
    setScriptureCards((prev) => {
      const existingRefs = new Set(prev.map((card) => card.ref.toLowerCase()));
      const additions = incoming.filter((card) => !existingRefs.has(card.ref.toLowerCase()));
      return additions.length === 0 ? prev : [...additions, ...prev];
    });
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)");
    const syncLayout = (event?: MediaQueryList | MediaQueryListEvent) => {
      setIsCompactLayout((event ?? media).matches);
    };

    syncLayout(media);
    const onChange = (event: MediaQueryListEvent) => {
      syncLayout(event);
    };

    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const storedRaw = localStorage.getItem(STORAGE_KEYS.raw) ?? "";
    const storedOrganized = localStorage.getItem(STORAGE_KEYS.organized) ?? "";
    setRawTranscript(storedRaw);
    setOrganizedMarkdown(storedOrganized);
    setManualNotes(localStorage.getItem(STORAGE_KEYS.notes) ?? "");
    setCurrentProjectId(localStorage.getItem(STORAGE_KEYS.projectId) ?? "");
    setProjectName(localStorage.getItem(STORAGE_KEYS.projectName) ?? "");
    setActiveTab(getPreferredLandingTab(storedOrganized));
  }, [getPreferredLandingTab]);

  useEffect(() => {
    if (!isCompactLayout || !organizedMarkdown.trim()) return;
    setActiveTab((current) => (current === "raw" ? "organized" : current));
  }, [isCompactLayout, organizedMarkdown]);

  useEffect(() => { scriptureCardsRef.current = scriptureCards; }, [scriptureCards]);
  useEffect(() => { readingQueueRef.current = readingQueue; }, [readingQueue]);
  useEffect(() => { readingQueueIndexRef.current = readingQueueIndex; }, [readingQueueIndex]);
  useEffect(() => { liveModeRef.current = liveMode; }, [liveMode]);
  useEffect(() => { bibleTranslationRef.current = bibleTranslation; }, [bibleTranslation]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/monitor/state");
        if (!res.ok) return;
        const data = await res.json() as { displayPrefs?: Partial<MonitorDisplayPrefs> };
        if (data.displayPrefs) {
          setMonitorDisplayPrefs((prev) => ({ ...prev, ...data.displayPrefs }));
        }
      } catch {
        // Ignore monitor settings fetch failures.
      }
    })();
  }, []);

  useEffect(() => {
    let active = true;

    const syncMonitorState = async () => {
      try {
        const res = await fetch("/api/monitor/state");
        if (!res.ok) return;
        const data = await res.json() as {
          ref?: string;
          text?: string;
          updatedAt?: number;
          cleared?: boolean;
        };
        if (!active) return;
        if (typeof data.updatedAt === "number") {
          if (data.updatedAt === monitorSyncUpdatedAtRef.current) return;
          monitorSyncUpdatedAtRef.current = data.updatedAt;
        }
        if (data.cleared) return;
        if (typeof data.ref === "string" && data.ref.trim()) {
          const ref = normalizeRef(data.ref);
          lastMonitorRefRef.current = ref;
          setLastDisplayRef(ref);
          if (typeof data.text === "string" && data.text.trim()) {
            mergeScriptureCards([{
              id: `${ref}-monitor-${Date.now()}`,
              ref,
              text: data.text.trim(),
              source: "detected",
              confidence: 1,
              reason: "Updated from media monitor",
            }]);
          }
        }
      } catch {
        // Ignore monitor sync failures.
      }
    };

    void syncMonitorState();
    const intervalId = window.setInterval(() => {
      void syncMonitorState();
    }, 2000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [mergeScriptureCards]);

  useEffect(() => {
    const applyDrag = (clientX: number) => {
      if (!isDraggingResizeRef.current) return;
      const dx = dragStartDataRef.current.startX - clientX;
      const newW = Math.max(220, Math.min(620, dragStartDataRef.current.startWidth + dx));
      setRefsPanelWidth(newW);
    };
    const onMove = (e: MouseEvent) => applyDrag(e.clientX);
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches[0]) applyDrag(e.touches[0].clientX);
    };
    const onUp = () => {
      if (!isDraggingResizeRef.current) return;
      isDraggingResizeRef.current = false;
      setIsDraggingResize(false);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onUp);
    };
  }, []);

  useEffect(() => {
    const refs = extractScriptureRefs(`${rawTranscript}\n${organizedMarkdown}`);
    if (refs.length === 0) return;

    const known = new Map<string, string>();
    for (const row of SCRIPTURE_DB) known.set(row.ref.toLowerCase(), row.text);

    const cards: ScriptureCard[] = refs.map((ref) => ({
      id: `${ref}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      ref,
      text: known.get(ref.toLowerCase()) ?? "Reference detected in your notes.",
      source: "detected",
      confidence: 1,
    }));

    mergeScriptureCards(cards);
  }, [mergeScriptureCards, organizedMarkdown, rawTranscript]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.raw, rawTranscript);
  }, [rawTranscript]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.organized, organizedMarkdown);
  }, [organizedMarkdown]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.notes, manualNotes);
  }, [manualNotes]);

  useEffect(() => {
    if (currentProjectId) localStorage.setItem(STORAGE_KEYS.projectId, currentProjectId);
  }, [currentProjectId]);

  useEffect(() => {
    if (projectName) localStorage.setItem(STORAGE_KEYS.projectName, projectName);
  }, [projectName]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chatEntries, isAssistantThinking]);

  useEffect(() => {
    const el = transcriptScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [rawTranscript, interimText]);

  const transcriptPreview = useMemo(() => {
    if (!rawTranscript.trim() && !interimText.trim()) return "";
    return `${rawTranscript}${interimText ? ` ${interimText}` : ""}`.trim();
  }, [interimText, rawTranscript]);

  const speechLanguageLabel = useMemo(() => {
    const labels: Record<SpeechLanguage, string> = {
      auto: "Auto",
      english: "English",
      spanish: "Spanish",
      french: "French",
      portuguese: "Portuguese",
      german: "German",
      swahili: "Swahili",
      twi: "Twi",
      kikuyu: "Kikuyu",
    };
    return labels[speechLanguage];
  }, [speechLanguage]);

  const pulpitSections = useMemo(() => buildPulpitSections(organizedMarkdown), [organizedMarkdown]);
  const manualBookSuggestions = useMemo(() => {
    const prefix = extractBookPrefixForSuggest(manualRefInput);
    const normalizedPrefix = normalizeBookToken(prefix);
    if (!normalizedPrefix) return [] as string[];
    return BIBLE_BOOK_SUGGESTIONS
      .filter((book) => normalizeBookToken(book).startsWith(normalizedPrefix))
      .slice(0, 8);
  }, [manualRefInput]);

  const elapsedPulpitSec = useMemo(() => {
    if (!pulpitStartedAt) return 0;
    return Math.floor((pulpitNow - pulpitStartedAt) / 1000);
  }, [pulpitNow, pulpitStartedAt]);

  useEffect(() => {
    if (!pulpitOpen) return;
    const id = window.setInterval(() => setPulpitNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [pulpitOpen]);

  useEffect(() => {
    if (!pulpitOpen) return;

    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") {
        event.preventDefault();
        setPulpitIndex((prev) => Math.min(pulpitSections.length - 1, prev + 1));
      }
      if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        setPulpitIndex((prev) => Math.max(0, prev - 1));
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setPulpitOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [pulpitOpen, pulpitSections.length]);

  useEffect(() => {
    return () => {
      for (const id of rangeCastTimersRef.current) {
        window.clearTimeout(id);
      }
      rangeCastTimersRef.current = [];
      if (volumeFrameRef.current) window.cancelAnimationFrame(volumeFrameRef.current);
      if (audioContextRef.current) void audioContextRef.current.close();
      if (semanticTimerRef.current) window.clearTimeout(semanticTimerRef.current);
      if (audioDownloadUrl) URL.revokeObjectURL(audioDownloadUrl);
      if (presentationWindowRef.current && !presentationWindowRef.current.closed) {
        presentationWindowRef.current.close();
      }
      if (notesSlidesWindowRef.current && !notesSlidesWindowRef.current.closed) {
        notesSlidesWindowRef.current.close();
      }
      if (rangePlaybackTimeoutRef.current !== null) {
        window.clearTimeout(rangePlaybackTimeoutRef.current);
      }
    };
  }, [audioDownloadUrl]);

  const pushToast = useCallback((text: string, type: "info" | "success" | "error" = "info") => {
    setToast({ text, type });
  }, []);

  const deriveProjectName = useCallback(() => {
    if (projectName.trim()) return projectName.trim();
    const heading = organizedMarkdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
    if (heading) return heading;
    const firstLine = rawTranscript.split(/\r?\n/).find((line) => line.trim())?.trim();
    if (firstLine) return firstLine.slice(0, 48);
    return `Sermon ${new Date().toLocaleDateString()}`;
  }, [organizedMarkdown, projectName, rawTranscript]);

  const closeAudioNodes = useCallback(() => {
    if (volumeFrameRef.current) {
      window.cancelAnimationFrame(volumeFrameRef.current);
      volumeFrameRef.current = null;
    }
    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    setVolumeLevel(0);
  }, []);

  const refreshAudioDownload = useCallback(() => {
    if (audioChunksRef.current.length === 0) return;
    if (audioDownloadUrl) URL.revokeObjectURL(audioDownloadUrl);

    const blob = new Blob(audioChunksRef.current, { type: audioMimeRef.current || "audio/webm" });
    const nextUrl = URL.createObjectURL(blob);
    setAudioDownloadUrl(nextUrl);

    const ext = audioMimeRef.current.includes("mp4") ? "m4a" : "webm";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    setAudioFileName(`sermon-session-${stamp}.${ext}`);
  }, [audioDownloadUrl]);

  const stopRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (socketRef.current) {
      try {
        socketRef.current.close();
      } catch {
        // ignore
      }
      socketRef.current = null;
    }

    closeAudioNodes();
    setInterimText("");
    setIsRecording(false);
    setStatusText("Paused");
    refreshAudioDownload();
  }, [closeAudioNodes, refreshAudioDownload]);

  const launchDisplay = useCallback(() => {
    const win = window.open("", "NexusScriptureDisplay", "width=1280,height=720,menubar=no,toolbar=no,location=no,status=no");
    if (!win) {
      pushToast("Pop-up blocked. Allow pop-ups for this site.", "error");
      return;
    }
    presentationWindowRef.current = win;
    win.document.write([
      '<!DOCTYPE html><html lang="en"><head>',
      '<meta charset="UTF-8"/>',
      '<meta name="viewport" content="width=device-width,initial-scale=1"/>',
      '<title>Scripture Display</title>',
      '<script src="https://cdn.tailwindcss.com"><' + '/script>',
      '<style>',
      'body{margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh;overflow:hidden;}',
      '#ref,#verse{transition:opacity 0.5s ease;}',
      '</style>',
      '</head>',
      '<body class="bg-black text-white">',
      '<div id="display" class="text-center px-16 max-w-5xl w-full">',
      '<p id="ref" class="text-3xl font-bold tracking-widest uppercase mb-8 text-yellow-300" style="opacity:0"></p>',
      '<p id="verse" class="text-6xl font-serif leading-tight text-white" style="opacity:0"></p>',
      '<p id="idle" class="text-slate-600 text-2xl tracking-widest uppercase">NEXUS DIRECTOR</p>',
      '</div>',
      '<script>',
      'window.addEventListener("message",function(e){',
      '  var ref=document.getElementById("ref");',
      '  var verse=document.getElementById("verse");',
      '  var idle=document.getElementById("idle");',
      '  if(e.data.type==="update"){',
      '    idle.style.opacity="0";',
      '    ref.textContent=e.data.ref;',
      '    verse.textContent=e.data.text;',
      '    ref.style.opacity="1";',
      '    verse.style.opacity="1";',
      '  } else if(e.data.type==="clear"){',
      '    ref.style.opacity="0";',
      '    verse.style.opacity="0";',
      '    setTimeout(function(){ref.textContent="";verse.textContent="";idle.style.opacity="1";},600);',
      '  }',
      '});',
      '<' + '/script>',
      '</body></html>',
    ].join(""));
    win.document.close();
    pushToast("Scripture display launched.", "success");
  }, [pushToast]);

  const launchTeachingSlides = useCallback(() => {
    if (!organizedMarkdown.trim()) {
      pushToast("Generate organized notes before launching teaching slides.", "error");
      return;
    }

    const splitForSlides = (text: string): string[] => {
      const normalized = text.replace(/\s+/g, " ").trim();
      if (!normalized) return [];

      const sentenceParts = normalized.split(/(?<=[.!?;:])\s+/).filter(Boolean);
      const words = normalized.split(/\s+/).filter(Boolean);
      const targetChunkCount = words.length > 42 ? 2 : 1;

      if (targetChunkCount === 1) {
        return [normalized];
      }

      const midpoint = Math.ceil(sentenceParts.length / 2);
      const firstHalf = sentenceParts.slice(0, midpoint).join(" ").trim();
      const secondHalf = sentenceParts.slice(midpoint).join(" ").trim();

      if (!firstHalf || !secondHalf) {
        const splitIndex = Math.ceil(words.length / 2);
        const first = words.slice(0, splitIndex).join(" ").trim();
        const second = words.slice(splitIndex).join(" ").trim();
        return second ? [first, second] : [normalized];
      }

      return [firstHalf, secondHalf];
    };

    const slideItems = pulpitSections.flatMap((section) => (
      section.blocks
        .map((block) => block.text.trim())
        .filter(Boolean)
        .map((rawText) => {
          const cues: string[] = [];
          let audienceText = rawText;

          audienceText = audienceText.replace(/\[(?:cue|speaker|note|transition):\s*([^\]]+)\]/gi, (_, cue: string) => {
            cues.push(cue.trim());
            return "";
          });
          audienceText = audienceText.replace(/\((?:cue|speaker|note|transition):\s*([^\)]+)\)/gi, (_, cue: string) => {
            cues.push(cue.trim());
            return "";
          });
          audienceText = audienceText.replace(/\{(?:cue|speaker|note|transition):\s*([^\}]+)\}/gi, (_, cue: string) => {
            cues.push(cue.trim());
            return "";
          });

          if (/^(?:cue|note|transition)\s*:/i.test(audienceText)) {
            cues.push(audienceText.replace(/^(?:cue|note|transition)\s*:/i, "").trim());
            audienceText = "";
          }

          audienceText = audienceText.replace(/\s+/g, " ").trim();
          const chunks = splitForSlides(audienceText);
          return chunks.map((chunk, idx) => ({
            section: chunks.length > 1 ? `${section.title} ${idx + 1}/${chunks.length}` : section.title,
            audienceText: chunk,
            speakerCues: idx === 0 ? cues : [],
          }));
        })
        .flat()
        .filter((slide) => slide.audienceText.length > 0)
    ));

    if (slideItems.length === 0) {
      pushToast("No notes available for slide presentation.", "error");
      return;
    }

    const win = window.open("", "NexusTeachingSlides", "width=1280,height=720,menubar=no,toolbar=no,location=no,status=no");
    if (!win) {
      pushToast("Pop-up blocked. Allow pop-ups for this site.", "error");
      return;
    }
    notesSlidesWindowRef.current = win;

    const payload = JSON.stringify(slideItems).replace(/</g, "\\u003c");
    win.document.write([
      "<!DOCTYPE html><html lang=\"en\"><head>",
      "<meta charset=\"UTF-8\"/>",
      "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\"/>",
      "<title>Teaching Slides</title>",
      "<style>",
      "*{margin:0;padding:0;box-sizing:border-box;}",
      "html,body{height:100dvh;width:100vw;background:#050507;color:#fff;font-family:Georgia,serif;overflow:hidden;}",
      "#app{height:100dvh;width:100vw;display:grid;grid-template-columns:1fr 340px;gap:1rem;padding:max(1.5rem,env(safe-area-inset-left)) max(1.5rem,env(safe-area-inset-right)) max(1.5rem,env(safe-area-inset-bottom)) max(1.5rem,env(safe-area-inset-top));box-sizing:border-box;background:radial-gradient(circle at 30% 20%, #12253b 0%, #07090e 55%, #000 100%);}",
      "#stage{min-width:0;min-height:0;display:flex;flex-direction:column;border:1px solid rgba(56,189,248,.2);border-radius:12px;padding:2rem;background:rgba(2,6,23,.4);clip-path:inset(0 0 0 0);}",
      "#section{font:700 .9rem/1.1 system-ui,sans-serif;letter-spacing:.18em;text-transform:uppercase;color:#fbbf24;margin-bottom:.5rem;}",
      "#counter{font:600 .8rem/1.1 system-ui,sans-serif;color:#94a3b8;margin-bottom:.8rem;}",
      "#point-wrap{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden;}",
      "#point{font:400 40px/1.14 Georgia,serif;text-align:center;color:#fff;opacity:0;transform:translateY(12px);text-shadow:0 2px 8px rgba(0,0,0,0.3);animation:slideIn 0.4s ease forwards;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:6;}",
      "@keyframes slideIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}",
      "#hint{font:600 .7rem/1.1 system-ui,sans-serif;color:#64748b;margin-top:1rem;letter-spacing:.1em;text-transform:uppercase;}",
      "#presenter{display:flex;flex-direction:column;gap:1rem;border:1px solid rgba(148,163,184,.25);border-radius:12px;padding:1.2rem;background:rgba(2,6,23,.9);min-height:0;}",
      "#presenter h3{margin:0;font-size:.75rem;letter-spacing:.15em;text-transform:uppercase;color:#93c5fd;}",
      "#notes{flex:1;min-height:0;overflow-y:auto;border:1px solid rgba(148,163,184,.15);border-radius:8px;padding:0.8rem;background:rgba(15,23,42,.5);font-size:.85rem;line-height:1.4;color:#e2e8f0;}",
      "#controls{display:grid;grid-template-columns:1fr 1fr;gap:.6rem;}",
      "button{min-height:40px;padding:.6rem;border-radius:8px;border:1px solid rgba(148,163,184,.4);background:rgba(15,23,42,.8);color:#e2e8f0;font-weight:700;cursor:pointer;font-size:.85rem;transition:all 0.2s;}",
      "button:hover{background:rgba(15,23,42,.95);}",
      "button:active{transform:scale(0.98);}",
      "#broadcast{grid-column:1 / -1;border-color:rgba(34,211,238,.4);}",
      "#broadcast.on{background:rgba(6,182,212,.2);border-color:rgba(34,211,238,.6);color:#67e8f9;}",
      "#monitor-status{font-size:.75rem;color:#94a3b8;line-height:1.2;}",
      "@media (max-width:1100px){#app{grid-template-columns:1fr;gap:0.8rem;padding:max(0.8rem,env(safe-area-inset-left)) max(0.8rem,env(safe-area-inset-right)) max(0.8rem,env(safe-area-inset-bottom)) max(0.8rem,env(safe-area-inset-top));}#presenter{order:-1;max-height:30vh;}}@media (max-width:600px){#app{padding:max(0.6rem,env(safe-area-inset-left)) max(0.6rem,env(safe-area-inset-right)) max(2rem,env(safe-area-inset-bottom)) max(0.6rem,env(safe-area-inset-top));}#point{font-size:32px;}#stage{padding:1.2rem;}button{min-height:44px;font-size:.8rem;}}",
      "</style></head><body>",
      "<div id=\"app\">",
      "<div id=\"stage\"><div id=\"section\"></div><div id=\"counter\"></div><div id=\"point-wrap\"><div id=\"point\"></div></div><div id=\"hint\">← → or Space to navigate • B to toggle broadcast</div></div>",
      "<div id=\"presenter\"><h3>Cues & Notes</h3><div id=\"notes\">No notes.</div><div id=\"monitor-status\">Broadcast: Off</div><div id=\"controls\"><button id=\"prev\">← Prev</button><button id=\"next\">Next →</button><button id=\"broadcast\">📡 Broadcast: Off</button></div></div>",
      "</div>",
      "<script>",
      `const slides=${payload};`,
      "let i=0,broadcast=false;",
      "const els={section:document.getElementById('section'),counter:document.getElementById('counter'),point:document.getElementById('point'),notes:document.getElementById('notes'),status:document.getElementById('monitor-status'),broadcast:document.getElementById('broadcast'),prev:document.getElementById('prev'),next:document.getElementById('next')};",
      "async function broadcastSlide(){",
      "  if(!broadcast||!slides[i]) return;",
      "  try{await fetch('/api/monitor/push',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ref:slides[i].section,text:slides[i].audienceText,source:'app'})});els.status.textContent='Broadcast: On ('+(i+1)+'/'+slides.length+')';}",
      "  catch{els.status.textContent='Broadcast: Failed';}",
      "}",
      "function render(){",
      "  const s=slides[i];",
      "  els.section.textContent=s.section;els.counter.textContent=(i+1)+' / '+slides.length;els.point.textContent=s.audienceText;els.notes.textContent=(s.speakerCues?.length)?s.speakerCues.join(' • '):'No notes.';",
      "  els.point.style.animation='none';void els.point.offsetHeight;els.point.style.animation='slideIn 0.4s ease forwards';",
      "  void broadcastSlide();",
      "}",
      "function next(){if(i<slides.length-1){i++;render();}}",
      "function prev(){if(i>0){i--;render();}}",
      "function toggleBroadcast(){broadcast=!broadcast;els.broadcast.classList.toggle('on',broadcast);els.broadcast.textContent='📡 Broadcast: '+(broadcast?'On':'Off');els.status.textContent=broadcast?'Broadcast: On':'Broadcast: Off';if(broadcast)void broadcastSlide();}",
      "els.next.addEventListener('click',next);els.prev.addEventListener('click',prev);els.broadcast.addEventListener('click',toggleBroadcast);",
      "document.addEventListener('keydown',(e)=>{if(e.key==='ArrowRight'||e.key===' ')e.preventDefault(),next();else if(e.key==='ArrowLeft')e.preventDefault(),prev();else if(e.key.toLowerCase()==='b')e.preventDefault(),toggleBroadcast();});",
      "document.getElementById('point-wrap').addEventListener('click',next);",
      "render();",
      "</script></body></html>",
    ].join(""));
    win.document.close();
    pushToast("Teaching slides launched.", "success");
  }, [organizedMarkdown, pulpitSections, pushToast]);

  const pushToMonitor = useCallback((ref: string, text: string) => {
    lastMonitorRefRef.current = ref;
    setLastDisplayRef(ref);
    // Always show cast verse in the reference panel
    mergeScriptureCards([{
      id: `${ref}-cast-${Date.now()}`,
      ref,
      text,
      source: "detected",
      confidence: 1,
    }]);
    const win = presentationWindowRef.current;
    if (win && !win.closed) {
      win.postMessage({ type: "update", ref, text }, "*");
    }
    void fetch("/api/monitor/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref, text, source: "app" }),
    });
  }, [mergeScriptureCards]);

  const clearMonitor = useCallback(() => {
    const win = presentationWindowRef.current;
    if (win && !win.closed) {
      win.postMessage({ type: "clear" }, "*");
    }
    void fetch("/api/monitor/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clear: true, source: "app" }),
    });
  }, []);

  const stopRangePlayback = useCallback(() => {
    if (rangePlaybackTimeoutRef.current !== null) {
      window.clearTimeout(rangePlaybackTimeoutRef.current);
      rangePlaybackTimeoutRef.current = null;
    }
  }, []);

  const updateMonitorDisplayPrefs = useCallback((patch: Partial<MonitorDisplayPrefs>) => {
    setMonitorDisplayPrefs((prev) => ({ ...prev, ...patch }));
    void fetch("/api/monitor/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setDisplayPrefs: patch, source: "app" }),
    });
  }, []);

  const handleManualCast = useCallback(async (options?: { closeMobile?: boolean }) => {
    const rawRef = manualRefInput.trim();
    const rawText = manualVerseInput.trim();
    if (!rawRef) {
      pushToast("Enter a scripture reference first.", "error");
      return;
    }

    setManualCastBusy(true);
    try {
      const parsed = splitReferenceAndTranslation(rawRef, bibleTranslationRef.current);
      let ref = parsed.reference;
      let text = rawText;
      bibleTranslationRef.current = parsed.translation;
      setBibleTranslation(parsed.translation);

      // If only the reference is provided, fetch verse text automatically.
      if (!text) {
        const res = await fetch("/api/bible-verse", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reference: ref, translation: parsed.translation }),
        });
        if (!res.ok) {
          pushToast("Could not fetch that scripture. Add verse text manually.", "error");
          return;
        }
        const data = await res.json() as { reference?: string; text?: string; error?: string };
        if (data.error || !data.text) {
          pushToast("Could not fetch that scripture. Add verse text manually.", "error");
          return;
        }
        ref = data.reference ?? ref;
        text = data.text.replace(/\n/g, " ").trim();
      }

      mergeScriptureCards([{ 
        id: `${ref}-manual-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        ref,
        text,
        source: "detected",
        confidence: 1,
        reason: "Manually added",
      }]);
      pushToMonitor(ref, text);
      setManualRefInput(ref);
      setManualVerseInput(text);
      if (options?.closeMobile) setMobileRefsOpen(false);
      pushToast(`Cast ${ref} to monitor.`, "success");
    } catch {
      pushToast("Manual cast failed. Try again.", "error");
    } finally {
      setManualCastBusy(false);
    }
  }, [manualRefInput, manualVerseInput, mergeScriptureCards, pushToast, pushToMonitor]);

  const fetchAndInjectScripture = useCallback(async (reference: string, translationOverride?: BibleTranslationCode) => {
    stopRangePlayback();
    try {
      const parsed = splitReferenceAndTranslation(reference, translationOverride ?? bibleTranslationRef.current);
      const translation = parsed.translation;
      const cleanReference = parsed.reference;
      const res = await fetch("/api/bible-verse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference: cleanReference, translation }),
      });
      if (!res.ok) return;
      const data = await res.json() as { reference?: string; text?: string; error?: string };
      if (data.error || !data.text) return;

      const ref = data.reference ?? cleanReference;
      const text = data.text.replace(/\n/g, " ").trim();

      const card: ScriptureCard = {
        id: `${ref}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        ref,
        text,
        source: "detected",
        confidence: 1,
      };
      mergeScriptureCards([card]);

      if (autoPushDisplay || liveModeRef.current) {
        pushToMonitor(ref, text);
      }
    } catch {
      // bible-api fetch should fail silently
    }
  }, [autoPushDisplay, mergeScriptureCards, pushToMonitor, stopRangePlayback]);

  const fetchReadingRange = useCallback(async (
    reference: string,
    options?: { autoPlay?: boolean; intervalMs?: number },
    translationOverride?: BibleTranslationCode,
  ) => {
    stopRangePlayback();
    try {
      const parsed = splitReferenceAndTranslation(reference, translationOverride ?? bibleTranslationRef.current);
      const translation = parsed.translation;
      const cleanReference = parsed.reference;
      const res = await fetch("/api/bible-verse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reference: cleanReference,
          translation,
          returnVerses: true,
        }),
      });
      if (!res.ok) return;
      const data = await res.json() as {
        reference?: string;
        verses?: Array<{ ref: string; text: string }>;
      };
      if (!data.verses || data.verses.length === 0) return;

      setReadingQueue(data.verses);
      setReadingQueueIndex(0);
      readingQueueRef.current = data.verses;
      readingQueueIndexRef.current = 0;

      const first = data.verses[0];
      pushToMonitor(first.ref, first.text);

      if (options?.autoPlay && data.verses.length > 1) {
        const intervalMs = Math.max(1800, options.intervalMs ?? 4500);
        let nextIndex = 1;

        const playNext = () => {
          const next = data.verses?.[nextIndex];
          if (!next) {
            rangePlaybackTimeoutRef.current = null;
            return;
          }
          setReadingQueueIndex(nextIndex);
          readingQueueIndexRef.current = nextIndex;
          pushToMonitor(next.ref, next.text);
          nextIndex += 1;
          rangePlaybackTimeoutRef.current = window.setTimeout(playNext, intervalMs);
        };

        rangePlaybackTimeoutRef.current = window.setTimeout(playNext, intervalMs);
      }

      const cards: ScriptureCard[] = data.verses.map((v) => ({
        id: `${v.ref}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        ref: v.ref,
        text: v.text,
        source: "detected",
        confidence: 1,
      }));
      mergeScriptureCards(cards);
    } catch {
      // fail silently
    }
  }, [mergeScriptureCards, pushToMonitor, stopRangePlayback]);

  const castReferenceFromPulpit = useCallback(async (reference: string) => {
    const isRange = /\b\d{1,3}:\d{1,3}\s*[-–—]\s*\d{1,3}\b/.test(reference);
    if (!isRange) {
      pulpitRangeRefRef.current = "";
      pulpitRangeVersesRef.current = [];
      pulpitRangeIndexRef.current = 0;
      // Always push to monitor on explicit pulpit cast — do not gate on autoPushDisplay/liveMode
      try {
        const res = await fetch("/api/bible-verse", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reference, translation: bibleTranslationRef.current }),
        });
        if (res.ok) {
          const data = await res.json() as { reference?: string; text?: string; error?: string };
          if (!data.error && data.text) {
            const ref = data.reference ?? reference;
            const text = data.text.replace(/\n/g, " ").trim();
            mergeScriptureCards([{ id: `${ref}-${Date.now()}`, ref, text, source: "detected", confidence: 1 }]);
            pushToMonitor(ref, text);
            return;
          }
        }
      } catch { /* fall through */ }
      void fetchAndInjectScripture(reference);
      return;
    }

    const normalizedRef = reference.replace(/\s+/g, " ").trim();
    if (pulpitRangeRefRef.current === normalizedRef && pulpitRangeVersesRef.current.length > 0) {
      const nextIndex = (pulpitRangeIndexRef.current + 1) % pulpitRangeVersesRef.current.length;
      pulpitRangeIndexRef.current = nextIndex;
      const next = pulpitRangeVersesRef.current[nextIndex];
      setReadingQueue(pulpitRangeVersesRef.current);
      setReadingQueueIndex(nextIndex);
      readingQueueRef.current = pulpitRangeVersesRef.current;
      readingQueueIndexRef.current = nextIndex;
      pushToMonitor(next.ref, next.text);
      return;
    }

    stopRangePlayback();
    try {
      const res = await fetch("/api/bible-verse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reference: normalizedRef,
          translation: bibleTranslationRef.current,
          returnVerses: true,
        }),
      });
      if (!res.ok) {
        void fetchAndInjectScripture(normalizedRef);
        return;
      }
      const data = await res.json() as { verses?: Array<{ ref: string; text: string }> };
      const verses = (data.verses ?? []).filter((v) => v.ref && v.text);
      if (verses.length === 0) {
        void fetchAndInjectScripture(normalizedRef);
        return;
      }

      pulpitRangeRefRef.current = normalizedRef;
      pulpitRangeVersesRef.current = verses;
      pulpitRangeIndexRef.current = 0;

      setReadingQueue(verses);
      setReadingQueueIndex(0);
      readingQueueRef.current = verses;
      readingQueueIndexRef.current = 0;

      const cards: ScriptureCard[] = verses.map((v) => ({
        id: `${v.ref}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        ref: v.ref,
        text: v.text,
        source: "detected",
        confidence: 1,
      }));
      mergeScriptureCards(cards);
      pushToMonitor(verses[0].ref, verses[0].text);
    } catch {
      void fetchAndInjectScripture(normalizedRef);
    }
  }, [fetchAndInjectScripture, mergeScriptureCards, pushToMonitor, stopRangePlayback]);

  const detectReadingIntent = useCallback((chunk: string) => {
    if (!READING_INTENT_REGEX.test(chunk)) return;
    const refs = extractScriptureRefs(chunk);
    if (refs.length === 0) return;
    void fetchReadingRange(refs[0]);
  }, [fetchReadingRange]);

  const advanceReadingQueue = useCallback((targetIndex?: number) => {
    stopRangePlayback();
    const queue = readingQueueRef.current;
    if (queue.length === 0) return;
    const nextIdx = targetIndex !== undefined ? targetIndex : readingQueueIndexRef.current + 1;
    if (nextIdx < 0 || nextIdx >= queue.length) return;
    setReadingQueueIndex(nextIdx);
    readingQueueIndexRef.current = nextIdx;
    wordsSpokenForVerseRef.current = "";
    pushToMonitor(queue[nextIdx].ref, queue[nextIdx].text);
  }, [pushToMonitor, stopRangePlayback]);

  const detectNextVerse = useCallback((chunk: string, fetchAndInject: (r: string) => void) => {
    const hasQueue = readingQueueRef.current.length > 0;
    const normalized = wordsToDigits(chunk.trim());

    // If an explicit scripture reference is present, do not run fallback verse-number logic.
    if (extractSpokenRefs(chunk).length > 0 || extractScriptureRefs(chunk).length > 0) return;

    if (NEXT_VERSE_REGEX.test(normalized)) {
      if (hasQueue) {
        advanceReadingQueue();
      } else {
        const next = nextSequentialRef(lastMonitorRefRef.current);
        if (next) fetchAndInject(next);
      }
      return;
    }

    // When reading a queue: "verse N" or short isolated number (e.g. saying "two" as you move to verse 2)
    const numMatchExplicit = VERSE_NUMBER_REGEX.exec(normalized);
    const numMatchBare = hasQueue ? /^(\d{1,2})\.?$/.exec(normalized) : null;
    const numMatch = numMatchExplicit ?? numMatchBare;
    if (numMatch) {
      const verseNum = parseInt(numMatch[1]);
      if (hasQueue) {
        const idx = readingQueueRef.current.findIndex((v) =>
          new RegExp(`:\\s*${verseNum}$`).test(v.ref),
        );
        if (idx >= 0) advanceReadingQueue(idx);
      } else if (lastMonitorRefRef.current) {
        const m = lastMonitorRefRef.current.match(/^((?:[1-3]\s+)?[A-Za-z]+(?:\s+[A-Za-z]+)?)\s+(\d+):/);
        if (m) fetchAndInject(`${m[1]} ${m[2]}:${verseNum}`);
      }
    }
  }, [advanceReadingQueue]);

  const handleNextVerse = useCallback(() => {
    if (readingQueueRef.current.length > 0 && readingQueueIndexRef.current < readingQueueRef.current.length - 1) {
      advanceReadingQueue();
    } else {
      const next = nextSequentialRef(lastMonitorRefRef.current);
      if (next) void fetchAndInjectScripture(next);
    }
  }, [advanceReadingQueue, fetchAndInjectScripture]);

  const handlePreviousVerse = useCallback(() => {
    if (readingQueueRef.current.length > 0 && readingQueueIndexRef.current > 0) {
      advanceReadingQueue(readingQueueIndexRef.current - 1);
    } else {
      const prev = prevSequentialRef(lastMonitorRefRef.current);
      if (prev) void fetchAndInjectScripture(prev);
    }
  }, [advanceReadingQueue, fetchAndInjectScripture]);

  const detectScripture = useCallback((chunk: string) => {
    const normalized = normalizeForTriggers(chunk);
    const hits = SCRIPTURE_DB.filter((entry) => entry.triggers.some((trigger) => normalized.includes(trigger)));
    const triggerCards: ScriptureCard[] = hits.map((hit) => ({
      id: `${hit.ref}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      ref: hit.ref,
      text: hit.text,
      source: "detected",
      confidence: 1,
    }));

    const explicitRefs = extractScriptureRefs(chunk);
    const explicitCards: ScriptureCard[] = explicitRefs.map((ref) => {
      const known = SCRIPTURE_DB.find((entry) => entry.ref.toLowerCase() === ref.toLowerCase());
      return {
        id: `${ref}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        ref,
        text: known?.text ?? "Reference detected in your transcript.",
        source: "detected",
        confidence: 1,
      };
    });

    if (triggerCards.length === 0 && explicitCards.length === 0) return;
    mergeScriptureCards([...triggerCards, ...explicitCards]);
  }, [mergeScriptureCards]);

  const scheduleSemanticSuggest = useCallback((contextText: string) => {
    if (contextText.length < 70 || !looksTheological(contextText)) return;

    if (semanticTimerRef.current) window.clearTimeout(semanticTimerRef.current);

    semanticTimerRef.current = window.setTimeout(async () => {
      if (semanticInFlightRef.current) return;
      semanticInFlightRef.current = true;
      try {
        const res = await fetch("/api/sermon-assistant/scripture-suggest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            context: contextText.slice(-1200),
            existingRefs: scriptureCardsRef.current.map((card) => card.ref),
            sermonAssistantModel: selectedSermonAssistantModel,
          }),
        });

        if (!res.ok) return;
        const data = await res.json() as SuggestionResponse;
        const cards: ScriptureCard[] = (data.suggestions ?? []).map((item) => ({
          id: `${item.ref}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          ref: item.ref,
          text: item.text,
          source: "suggested",
          confidence: item.confidence,
          reason: item.reason,
        }));
        mergeScriptureCards(cards);

        // In live mode, auto-cast the top high-confidence match (quoted without reference)
        if (liveModeRef.current) {
          const top = (data.suggestions ?? []).find((s) => (s.confidence ?? 0) >= 0.85);
          if (top) pushToMonitor(top.ref, top.text);
        }
      } catch {
        // background suggestion should fail silently
      } finally {
        semanticInFlightRef.current = false;
      }
    }, 1200);
}, [mergeScriptureCards, pushToMonitor, selectedSermonAssistantModel]);

  const appendTranscript = useCallback((text: string) => {
    setRawTranscript((prev) => {
      const merged = `${prev}${prev ? " " : ""}${text}`;
      scheduleSemanticSuggest(merged.slice(-1400));
      return merged;
    });
  }, [scheduleSemanticSuggest]);

  const startVolumeTelemetry = useCallback((stream: MediaStream) => {
    closeAudioNodes();
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    audioContextRef.current = context;
    analyserRef.current = analyser;

    const buffer = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      const node = analyserRef.current;
      if (!node) return;
      node.getByteTimeDomainData(buffer);

      let sum = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        const centered = (buffer[i] - 128) / 128;
        sum += centered * centered;
      }
      const rms = Math.sqrt(sum / buffer.length);
      setVolumeLevel(Math.max(0, Math.min(100, Math.round(rms * 180))));
      volumeFrameRef.current = window.requestAnimationFrame(tick);
    };

    volumeFrameRef.current = window.requestAnimationFrame(tick);
  }, [closeAudioNodes]);

  const toggleRecording = useCallback(async () => {
    if (isRecording) {
      stopRecording();
      return;
    }

    try {
      const tokenRes = await fetch("/api/transcribe-token", { method: "GET" });
      if (!tokenRes.ok) {
        pushToast("Deepgram key is not configured on the server.", "error");
        return;
      }

      const tokenData = await tokenRes.json() as { apiKey?: string };
      const apiKey = tokenData.apiKey?.trim();
      if (!apiKey) {
        pushToast("Deepgram key is unavailable.", "error");
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setStatusText("Connecting...");

      const manualLanguageCode: Record<Exclude<SpeechLanguage, "auto" | "twi" | "kikuyu">, string> = {
        english: "en",
        spanish: "es",
        french: "fr",
        portuguese: "pt",
        german: "de",
        swahili: "sw",
      };

      const isLimitedLanguage = speechLanguage === "twi" || speechLanguage === "kikuyu";
      if (isLimitedLanguage) {
        pushToast("Using Deepgram multilingual auto-detect for Twi/Kikuyu.", "info");
      }

      const primaryParams = new URLSearchParams({
        model: "nova-2",
        endpointing: "500",
        punctuate: "true",
        interim_results: "true",
        smart_format: "true",
      });

      if (speechLanguage === "auto" || isLimitedLanguage) {
        primaryParams.set("detect_language", "true");
      } else {
        primaryParams.set("language", manualLanguageCode[speechLanguage]);
      }

      const fallbackParams = new URLSearchParams({
        model: "nova-2",
        punctuate: "true",
        interim_results: "true",
      });

      const connectionAttempts = [
        { label: "protocol-primary", authMethod: "protocol" as const, params: primaryParams },
        { label: "protocol-fallback", authMethod: "protocol" as const, params: fallbackParams },
        { label: "query-fallback", authMethod: "query" as const, params: fallbackParams },
      ];

      const connectDeepgram = (attemptIndex: number) => {
        const attempt = connectionAttempts[attemptIndex];
        let opened = false;

        const wsUrl = `wss://api.deepgram.com/v1/listen?${attempt.params.toString()}${attempt.authMethod === "query" ? `&token=${encodeURIComponent(apiKey)}` : ""}`;
        const socket = attempt.authMethod === "query"
          ? new WebSocket(wsUrl)
          : new WebSocket(wsUrl, ["token", apiKey]);
        socketRef.current = socket;

        socket.onopen = () => {
          opened = true;
          const mimeType = chooseRecorderMimeType();
          const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
          recorderRef.current = recorder;
          audioMimeRef.current = recorder.mimeType || mimeType || "audio/webm";

          recorder.ondataavailable = (event) => {
            if (event.data.size <= 0) return;
            audioChunksRef.current.push(event.data);
            if (socket.readyState === WebSocket.OPEN) socket.send(event.data);
          };

          recorder.onstop = () => {
            refreshAudioDownload();
          };

          recorder.start(250);
          recordingStartedAtRef.current = performance.now();
          lastFinalAtRef.current = performance.now();
          startVolumeTelemetry(stream);
          setIsRecording(true);
          setStatusText("Listening");
        };

        socket.onmessage = (event) => {
        const payload = JSON.parse(event.data) as {
          type?: string;
          error?: string;
          is_final?: boolean;
          channel?: {
            detected_language?: string;
            alternatives?: Array<{ transcript?: string }>;
          };
        };

          if (payload.type === "Error") {
            pushToast(payload.error ?? "Deepgram rejected this transcription request.", "error");
            stopRecording();
            return;
          }

          const transcript = payload.channel?.alternatives?.[0]?.transcript?.trim() ?? "";
          const detectedLanguage = payload.channel?.detected_language?.trim();
          if (detectedLanguage) {
            setStatusText(`Listening (${detectedLanguage.toUpperCase()})`);
          }

          if (!transcript) return;

          if (payload.is_final) {
            setInterimText("");
            const spokenTranslation = detectTranslationFromSpeech(transcript);
            if (spokenTranslation && spokenTranslation !== bibleTranslationRef.current) {
              bibleTranslationRef.current = spokenTranslation;
              setBibleTranslation(spokenTranslation);
            }
            detectScripture(transcript);
            detectReadingIntent(transcript);

            // Spoken-ref detection: catches "Luke 4 2", "chapter 4 verse 2", word numbers, etc.
            const spokenRefs = extractSpokenRefs(transcript);
            if (spokenRefs.length > 0) {
              for (const r of spokenRefs) {
                const isRange = /-\d+/.test(r);
                if (isRange) {
                  void fetchReadingRange(r, undefined, spokenTranslation ?? undefined);
                } else {
                  void fetchAndInjectScripture(r.trim(), spokenTranslation ?? undefined);
                }
              }
            } else {
              detectNextVerse(transcript, (ref) => void fetchAndInjectScripture(ref));
            }

            // Auto-advance reading queue when enough of the current verse has been spoken
            if (readingQueueRef.current.length > 0) {
              wordsSpokenForVerseRef.current += " " + transcript;
              const currentVerse = readingQueueRef.current[readingQueueIndexRef.current];
              if (currentVerse && verseOverlap(currentVerse.text, wordsSpokenForVerseRef.current) >= 0.55) {
                wordsSpokenForVerseRef.current = "";
                advanceReadingQueue();
              }
            }

            const now = performance.now();
            const previous = lastFinalAtRef.current ?? now;
            const deltaSec = Math.max(0.3, (now - previous) / 1000);
            const words = countWords(transcript);
            const chunkWpm = Math.round((words / deltaSec) * 60);

            lastFinalAtRef.current = now;
            totalWordsRef.current += words;
            totalSpeechSecondsRef.current += deltaSec;
            setCurrentWpm(chunkWpm);

            const overall = totalSpeechSecondsRef.current > 0
              ? Math.round((totalWordsRef.current / totalSpeechSecondsRef.current) * 60)
              : 0;
            setAvgWpm(overall);

            const started = recordingStartedAtRef.current ?? now;
            const tSec = Math.max(0, Math.round((now - started) / 1000));
            setCadencePoints((prev) => {
              const next = [...prev, { tSec, wpm: chunkWpm }];
              return next.slice(-36);
            });

            appendTranscript(transcript);
          } else {
            setInterimText(transcript);
          }
        };

        socket.onerror = () => {
          if (!opened) {
            setStatusText("Connection issue, retrying...");
            return;
          }
          pushToast("Live transcription socket encountered an error.", "error");
        };

        socket.onclose = (event) => {
          if (!opened && attemptIndex < connectionAttempts.length - 1) {
            const next = connectionAttempts[attemptIndex + 1];
            setStatusText(`Retrying ${next.label}...`);
            connectDeepgram(attemptIndex + 1);
            return;
          }

          if (!opened && !event.wasClean) {
            const reason = event.reason ? ` ${event.reason}` : "";
            pushToast(`Deepgram closed connection (code ${event.code}).${reason}`, "error");
          }
          if (!opened && event.wasClean) {
            pushToast("Live transcription connection failed.", "error");
          }
          stopRecording();
        };
      };

      connectDeepgram(0);
    } catch {
      pushToast("Microphone access denied.", "error");
      stopRecording();
    }
  }, [appendTranscript, detectNextVerse, detectReadingIntent, detectScripture, fetchAndInjectScripture, isRecording, pushToast, refreshAudioDownload, speechLanguage, startVolumeTelemetry, stopRecording]);

  const generateOutline = useCallback(async () => {
    if (!rawTranscript.trim()) {
      pushToast("No transcript available yet.", "error");
      return;
    }
    setIsGenerating(true);
    try {
      const res = await fetch("/api/sermon-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "outline", rawTranscript, sermonAssistantModel: selectedSermonAssistantModel }),
      });
      const payload = await res.json().catch(() => ({})) as { markdown?: string; error?: string };
      if (!res.ok) {
        throw new Error(payload.error ?? `Outline generation failed (${res.status})`);
      }

      const markdown = typeof payload.markdown === "string" ? payload.markdown.trim() : "";
      if (!isMeaningfulSermonMarkdown(markdown)) {
        throw new Error("The model returned an empty or partial outline. Please retry.");
      }

      setOrganizedMarkdown(markdown);
      const outlineRefs = extractScriptureRefs(markdown);
      if (outlineRefs.length > 0) {
        const cards: ScriptureCard[] = outlineRefs.map((ref) => ({
          id: `${ref}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          ref,
          text: "Reference detected in your organized notes.",
          source: "detected",
          confidence: 1,
        }));
        mergeScriptureCards(cards);
      }
      setActiveTab("organized");
      pushToast("Outline generated.", "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Nexus Engine request failed.";
      pushToast(message, "error");
    } finally {
      setIsGenerating(false);
    }
  }, [mergeScriptureCards, pushToast, rawTranscript, selectedSermonAssistantModel]);

  const sendAssistantCommand = useCallback(async () => {
    const command = assistantInput.trim();
    if (!command) return;
    if (!rawTranscript.trim()) {
      pushToast("Record or upload a transcript first.", "error");
      return;
    }

    setAssistantInput("");
    setChatEntries((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, role: "user", markdown: command },
    ]);

    setIsAssistantThinking(true);
    try {
      const res = await fetch("/api/sermon-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "command",
          rawTranscript,
          organizedMarkdown,
          command,
          sermonAssistantModel: selectedSermonAssistantModel,
        }),
      });

      const payload = await res.json().catch(() => ({})) as { markdown?: string; error?: string };
      if (!res.ok) {
        throw new Error(payload.error ?? `Assistant command failed (${res.status})`);
      }

      const markdown = typeof payload.markdown === "string" ? payload.markdown.trim() : "";
      if (!isMeaningfulSermonMarkdown(markdown)) {
        throw new Error("The model returned empty output. Please resend the command.");
      }

      setChatEntries((prev) => [
        ...prev,
        { id: `a-${Date.now()}`, role: "assistant", markdown },
      ]);
      setOrganizedMarkdown(markdown);
      const responseRefs = extractScriptureRefs(markdown);
      if (responseRefs.length > 0) {
        const cards: ScriptureCard[] = responseRefs.map((ref) => ({
          id: `${ref}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          ref,
          text: "Reference detected in agent output.",
          source: "detected",
          confidence: 1,
        }));
        mergeScriptureCards(cards);
      }
      pushToast("Organized notes updated.", "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Assistant request failed.";
      setChatEntries((prev) => [
        ...prev,
        { id: `a-${Date.now()}`, role: "assistant", markdown: `Assistant error: ${message}` },
      ]);
      pushToast(message, "error");
    } finally {
      setIsAssistantThinking(false);
    }
  }, [assistantInput, mergeScriptureCards, organizedMarkdown, pushToast, rawTranscript, selectedSermonAssistantModel]);

  const onUploadTranscript = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setRawTranscript((prev) => {
      const next = `${prev}${prev ? " " : ""}${text.trim()}`.trim();
      scheduleSemanticSuggest(next.slice(-1400));
      return next;
    });
    pushToast("Transcript uploaded.", "success");
    event.target.value = "";
  }, [pushToast, scheduleSemanticSuggest]);

  const exportReferenceReport = useCallback(async () => {
    if (scriptureCards.length === 0) {
      pushToast("No scripture references to export.", "error");
      return;
    }
    const detected = scriptureCards.filter((c) => c.source === "detected");
    const suggested = scriptureCards.filter((c) => c.source === "suggested");
    const title = deriveProjectName();

    const heading = (text: string, level: typeof HeadingLevel[keyof typeof HeadingLevel]) =>
      new Paragraph({ text, heading: level, spacing: { after: 120 } });

    const refParagraph = (card: ScriptureCard) => [
      new Paragraph({
        children: [new TextRun({ text: card.ref, bold: true, size: 24 })],
        spacing: { before: 160, after: 40 },
      }),
      new Paragraph({
        children: [new TextRun({ text: `"${card.text}"`, italics: true, size: 22 })],
        spacing: { after: 80 },
        alignment: AlignmentType.LEFT,
      }),
      ...(card.reason ? [new Paragraph({
        children: [new TextRun({ text: card.reason, size: 18, color: "777777" })],
        spacing: { after: 40 },
      })] : []),
    ];

    const doc = new Document({
      sections: [{
        children: [
          heading(`Scripture References — ${title}`, HeadingLevel.HEADING_1),
          new Paragraph({ children: [new TextRun({ text: new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }), size: 20, color: "555555" })], spacing: { after: 300 } }),

          ...(detected.length > 0 ? [
            heading("Quoted / Detected", HeadingLevel.HEADING_2),
            ...detected.flatMap(refParagraph),
          ] : []),

          ...(suggested.length > 0 ? [
            new Paragraph({ spacing: { before: 300 } }),
            heading("AI Suggestions", HeadingLevel.HEADING_2),
            ...suggested.flatMap(refParagraph),
          ] : []),
        ],
      }],
    });

    const blob = await Packer.toBlob(doc);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${title.toLowerCase().replace(/\s+/g, "-")}-scripture-refs.docx`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    pushToast("Reference report downloaded.", "success");
  }, [deriveProjectName, pushToast, scriptureCards]);

  const saveToCloud = useCallback(async (mode: "update" | "new" = "update") => {
    if (!rawTranscript.trim() && !organizedMarkdown.trim()) {
      pushToast("Nothing to save.", "error");
      return;
    }

    const now = new Date().toISOString();
    const nextName = deriveProjectName();
    const id = mode === "new" || !currentProjectId ? `sermon-${Date.now()}` : currentProjectId;
    const project: SermonProjectRecord = {
      id,
      name: nextName,
      createdAt: now,
      updatedAt: now,
      sermonAssistant: {
        rawTranscript,
        organizedMarkdown,
        manualNotes,
        scriptureCards,
      },
    };

    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project }),
      });
      if (!res.ok) throw new Error("save failed");
      setCurrentProjectId(id);
      setProjectName(nextName);
      pushToast(mode === "new" ? "Saved as new sermon." : "Sermon updated in cloud.", "success");
    } catch {
      pushToast("Cloud save failed.", "error");
    }
  }, [currentProjectId, deriveProjectName, manualNotes, organizedMarkdown, pushToast, rawTranscript, scriptureCards]);

  const startNewBlankProject = useCallback(() => {
    if (isRecording) stopRecording();
    if (audioDownloadUrl) URL.revokeObjectURL(audioDownloadUrl);

    audioChunksRef.current = [];
    setAudioDownloadUrl(null);
    setAudioFileName("sermon-session.webm");

    setRawTranscript("");
    setOrganizedMarkdown("");
    setManualNotes("");
    setScriptureCards([]);
    setChatEntries([]);
    setAssistantInput("");
    setInterimText("");

    setCurrentProjectId("");
    setProjectName("");
    setSpeechLanguage("auto");
    setHistoryOpen(false);
    setIsEditingOrganized(false);
    setActiveTab("raw");
    setStatusText("Ready");

    setCurrentWpm(0);
    setAvgWpm(0);
    setCadencePoints([]);
    totalWordsRef.current = 0;
    totalSpeechSecondsRef.current = 0;
    recordingStartedAtRef.current = null;
    lastFinalAtRef.current = null;

    setMobileToolsOpen(false);
    setMobileTelemetryOpen(false);
    setDesktopTelemetryOpen(false);
    setMobileOrganizedView("outline");

    setPulpitOpen(false);
    setPulpitIndex(0);
    setPulpitStartedAt(null);

    localStorage.removeItem(STORAGE_KEYS.raw);
    localStorage.removeItem(STORAGE_KEYS.organized);
    localStorage.removeItem(STORAGE_KEYS.notes);
    localStorage.removeItem(STORAGE_KEYS.projectId);
    localStorage.removeItem(STORAGE_KEYS.projectName);

    pushToast("Started a new blank project.", "success");
  }, [audioDownloadUrl, isRecording, pushToast, stopRecording]);

  const openHistory = useCallback(async () => {
    setHistoryOpen(true);
    try {
      const res = await fetch("/api/projects?kind=sermon", { method: "GET" });
      if (!res.ok) throw new Error("load failed");
      const data = await res.json() as { projects?: Array<Record<string, unknown>> };
      const items = (data.projects ?? [])
        .map((project) => normalizeSermonProjectRecord(project))
        .filter((project): project is SermonProjectRecord => project !== null)
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

      // Fallback: include current local sermon state if cloud has no valid entries.
      if (items.length === 0 && (rawTranscript.trim() || organizedMarkdown.trim() || manualNotes.trim())) {
        items.push({
          id: currentProjectId || `local-sermon-${Date.now()}`,
          name: deriveProjectName(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          sermonAssistant: {
            rawTranscript,
            organizedMarkdown,
            manualNotes,
            scriptureCards,
          },
        });
      }
      setHistoryItems(items);
    } catch {
      const fallbackItems = (rawTranscript.trim() || organizedMarkdown.trim() || manualNotes.trim())
        ? [{
            id: currentProjectId || `local-sermon-${Date.now()}`,
            name: deriveProjectName(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            sermonAssistant: {
              rawTranscript,
              organizedMarkdown,
              manualNotes,
              scriptureCards,
            },
          }]
        : [];
      setHistoryItems(fallbackItems);
      pushToast("Cloud history failed — showing local sermon state.", "error");
    }
  }, [currentProjectId, deriveProjectName, manualNotes, organizedMarkdown, pushToast, rawTranscript, scriptureCards]);

  const loadHistoryItem = useCallback((item: SermonProjectRecord) => {
    setCurrentProjectId(item.id);
    setProjectName(item.name);
    setRawTranscript(item.sermonAssistant.rawTranscript ?? "");
    setOrganizedMarkdown(item.sermonAssistant.organizedMarkdown ?? "");
    setManualNotes(item.sermonAssistant.manualNotes ?? "");
    setScriptureCards(item.sermonAssistant.scriptureCards ?? []);
    setActiveTab(getPreferredLandingTab(item.sermonAssistant.organizedMarkdown ?? ""));
    setHistoryOpen(false);
    pushToast("Project loaded.", "success");
  }, [getPreferredLandingTab, pushToast]);

  const deleteHistoryItem = useCallback(async (id: string) => {
    try {
      const res = await fetch("/api/projects", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error("delete failed");
      setHistoryItems((prev) => prev.filter((item) => item.id !== id));
      if (currentProjectId === id) {
        setCurrentProjectId("");
        setProjectName("");
        localStorage.removeItem(STORAGE_KEYS.projectId);
        localStorage.removeItem(STORAGE_KEYS.projectName);
      }
      pushToast("Project deleted.", "success");
    } catch {
      pushToast("Delete failed.", "error");
    }
  }, [currentProjectId, pushToast]);

  const downloadAudio = useCallback(() => {
    if (!audioDownloadUrl) return;
    const anchor = document.createElement("a");
    anchor.href = audioDownloadUrl;
    anchor.download = audioFileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  }, [audioDownloadUrl, audioFileName]);

  const downloadSermonNotesDocx = useCallback(async () => {
    const sourceMarkdown = organizedMarkdown.trim() || rawTranscript.trim();
    if (!sourceMarkdown) {
      pushToast("No sermon notes available to download.", "error");
      return;
    }

    try {
      const title = deriveProjectName();
      const doc = new Document({
        creator: "Nexus Director",
        title,
        sections: [{
          children: [
            new Paragraph({
              text: title,
              heading: HeadingLevel.TITLE,
              alignment: AlignmentType.CENTER,
            }),
            new Paragraph({
              children: [new TextRun({ text: `Generated ${new Date().toLocaleString()}`, italics: true })],
              alignment: AlignmentType.CENTER,
            }),
            new Paragraph({ text: "" }),
            ...buildDocxParagraphs(sourceMarkdown),
          ],
        }],
      });

      const blob = await Packer.toBlob(doc);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${slugifyFileName(title)}-sermon-notes.docx`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      pushToast("Sermon notes downloaded as Word document.", "success");
    } catch {
      pushToast("Could not generate Word download.", "error");
    }
  }, [deriveProjectName, organizedMarkdown, pushToast, rawTranscript]);

  const openPulpitMode = useCallback(() => {
    if (!organizedMarkdown.trim()) {
      pushToast("Generate organized notes before pulpit mode.", "error");
      return;
    }
    setPulpitIndex(0);
    setPulpitStartedAt(Date.now());
    setPulpitNow(Date.now());
    setPulpitOpen(true);
  }, [organizedMarkdown, pushToast]);

  const closePulpitMode = useCallback(() => {
    setPulpitOpen(false);
  }, []);

  const goPulpitPrev = useCallback(() => {
    setPulpitIndex((prev) => Math.max(0, prev - 1));
  }, []);

  const goPulpitNext = useCallback(() => {
    setPulpitIndex((prev) => Math.min(pulpitSections.length - 1, prev + 1));
  }, [pulpitSections.length]);

  const onPulpitTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    pulpitTouchStartXRef.current = event.changedTouches[0]?.clientX ?? null;
  }, []);

  const onPulpitTouchEnd = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const startX = pulpitTouchStartXRef.current;
    const endX = event.changedTouches[0]?.clientX;
    pulpitTouchStartXRef.current = null;
    if (startX === null || typeof endX !== "number") return;

    const delta = endX - startX;
    if (Math.abs(delta) < 50) return;
    if (delta < 0) {
      goPulpitNext();
    } else {
      goPulpitPrev();
    }
  }, [goPulpitNext, goPulpitPrev]);

  const latestSection = pulpitSections[pulpitIndex] ?? null;
  const nextSection = pulpitSections[pulpitIndex + 1] ?? null;
  const pulpitProgressPct = pulpitSections.length > 1
    ? Math.round((pulpitIndex / (pulpitSections.length - 1)) * 100)
    : latestSection ? 100 : 0;

  const monitorDisplayControls = (compact: boolean) => {
    const isOpen = compact ? mobileDisplayStyleOpen : desktopDisplayStyleOpen;
    const toggleOpen = () => {
      if (compact) {
        setMobileDisplayStyleOpen((prev) => !prev);
      } else {
        setDesktopDisplayStyleOpen((prev) => !prev);
      }
    };

    return (
    <div className={`mt-2 rounded-lg border border-cyan-500/20 bg-cyan-500/5 px-2 py-2 ${compact ? "" : ""}`}>
      <button
        type="button"
        onClick={toggleOpen}
        className="flex min-h-10 w-full items-center justify-between rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 text-left"
        aria-expanded={isOpen}
      >
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-cyan-300">Display Style</p>
          <p className="text-[11px] font-semibold text-slate-300">
            {monitorDisplayPrefs.layout === "lower-third" ? "Lower Third" : "Center"} • {monitorDisplayPrefs.background} • {monitorDisplayPrefs.fontStyle}
          </p>
        </div>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} className={`h-4 w-4 text-cyan-300 transition-transform ${isOpen ? "rotate-180" : ""}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {isOpen && <>
      <div className="mt-2 grid grid-cols-2 gap-1">
        <button
          type="button"
          onClick={() => updateMonitorDisplayPrefs({ layout: "center" })}
          className={`min-h-10 rounded-md border px-2 text-xs font-bold ${monitorDisplayPrefs.layout === "center" ? "border-cyan-400/70 bg-cyan-500/20 text-cyan-200" : "border-slate-700/80 text-slate-300"}`}
        >
          Center
        </button>
        <button
          type="button"
          onClick={() => updateMonitorDisplayPrefs({ layout: "lower-third" })}
          className={`min-h-10 rounded-md border px-2 text-xs font-bold ${monitorDisplayPrefs.layout === "lower-third" ? "border-cyan-400/70 bg-cyan-500/20 text-cyan-200" : "border-slate-700/80 text-slate-300"}`}
        >
          Lower Third
        </button>
      </div>

      <div className={`mt-2 grid gap-2 ${compact ? "grid-cols-1" : "grid-cols-2"}`}>
        <select
          value={monitorDisplayPrefs.background}
          onChange={(e) => updateMonitorDisplayPrefs({ background: e.target.value as MonitorBackgroundId })}
          className="min-h-10 rounded-md border border-slate-700/80 bg-slate-900/80 px-2 text-base font-semibold text-slate-200"
          title="Monitor background"
        >
          <option value="black">Black</option>
          <option value="midnight">Midnight</option>
          <option value="sunrise">Sunrise</option>
          <option value="ocean">Ocean</option>
          <option value="charcoal">Charcoal</option>
          <option value="transparent">Transparent</option>
        </select>
        <select
          value={monitorDisplayPrefs.fontStyle}
          onChange={(e) => updateMonitorDisplayPrefs({ fontStyle: e.target.value as MonitorFontStyle })}
          className="min-h-10 rounded-md border border-slate-700/80 bg-slate-900/80 px-2 text-base font-semibold text-slate-200"
          title="Monitor font style"
        >
          <option value="serif">Serif</option>
          <option value="sans">Sans</option>
          <option value="display">Display</option>
        </select>
        <select
          value={monitorDisplayPrefs.lowerThirdBackground}
          onChange={(e) => updateMonitorDisplayPrefs({ lowerThirdBackground: e.target.value as MonitorDisplayPrefs["lowerThirdBackground"] })}
          className="min-h-10 rounded-md border border-slate-700/80 bg-slate-900/80 px-2 text-base font-semibold text-slate-200"
          title="Lower-third background mode"
        >
          <option value="solid">Lower Third: Solid</option>
          <option value="glass">Lower Third: Glass</option>
          <option value="transparent">Lower Third: Transparent</option>
        </select>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] font-semibold text-slate-300">
        <label className="block">
          C Ref {monitorDisplayPrefs.centerRefSize}px
          <input
            type="range"
            min={16}
            max={90}
            value={monitorDisplayPrefs.centerRefSize}
            onChange={(e) => updateMonitorDisplayPrefs({ centerRefSize: Number(e.target.value) })}
            className="mt-1 w-full"
          />
        </label>
        <label className="block">
          C Verse {monitorDisplayPrefs.centerVerseSize}px
          <input
            type="range"
            min={28}
            max={140}
            value={monitorDisplayPrefs.centerVerseSize}
            onChange={(e) => updateMonitorDisplayPrefs({ centerVerseSize: Number(e.target.value) })}
            className="mt-1 w-full"
          />
        </label>
        <label className="block">
          LT Ref {monitorDisplayPrefs.lowerRefSize}px
          <input
            type="range"
            min={12}
            max={56}
            value={monitorDisplayPrefs.lowerRefSize}
            onChange={(e) => updateMonitorDisplayPrefs({ lowerRefSize: Number(e.target.value) })}
            className="mt-1 w-full"
          />
        </label>
        <label className="block">
          LT Verse {monitorDisplayPrefs.lowerVerseSize}px
          <input
            type="range"
            min={20}
            max={96}
            value={monitorDisplayPrefs.lowerVerseSize}
            onChange={(e) => updateMonitorDisplayPrefs({ lowerVerseSize: Number(e.target.value) })}
            className="mt-1 w-full"
          />
        </label>
      </div>

      <div className="mt-2 flex items-center gap-1 rounded-md border border-slate-700/80 bg-slate-900/50 p-1">
        {(["compact", "standard", "large"] as const).map((size) => (
          <button
            key={size}
            type="button"
            onClick={() => updateMonitorDisplayPrefs({ lowerThirdSize: size })}
            className={`min-h-10 flex-1 rounded-md px-2 text-[11px] font-bold uppercase ${monitorDisplayPrefs.lowerThirdSize === size ? "bg-cyan-500/25 text-cyan-200" : "text-slate-400 hover:bg-slate-800"}`}
          >
            {size}
          </button>
        ))}
      </div>
      </>}
    </div>
    );
  };

  return (
    <>
      <section className="relative flex h-full flex-col overflow-hidden rounded-2xl border border-cyan-500/20 glass">
        <header className="flex shrink-0 flex-col gap-2 border-b border-cyan-500/20 px-3 py-3 sm:gap-3 sm:px-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-500/20 ring-1 ring-cyan-400/50">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-5 w-5 text-cyan-300">
                  <path d="M12 4a3 3 0 0 1 3 3v5a3 3 0 1 1-6 0V7a3 3 0 0 1 3-3Z" />
                  <path d="M6 11a6 6 0 0 0 12 0" />
                  <path d="M12 17v3" />
                  <path d="M9 20h6" />
                </svg>
              </div>
              <div className="min-w-0">
                <h2 className="truncate text-lg font-bold text-slate-100">Sermon Assistant</h2>
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{statusText}</p>
              </div>
            </div>

            <div className="hidden items-center gap-2 sm:flex">
              <button
                type="button"
                onClick={launchDisplay}
                title="Launch scripture monitor"
                className="focus-ring flex h-10 items-center gap-1.5 rounded-xl border border-violet-500/50 bg-violet-500/15 px-3 text-xs font-bold text-violet-300 transition hover:bg-violet-500/25"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-4 w-4"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>
                Monitor
              </button>
              <button
                type="button"
                onClick={clearMonitor}
                title="Clear scripture monitor"
                className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-slate-700/80 text-slate-400 transition hover:border-rose-500/50 hover:text-rose-300"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-4 w-4"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
              </button>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                title="Upload transcript"
                className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-slate-700/80 text-slate-300 transition hover:border-cyan-500/50 hover:text-cyan-300"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-4 w-4"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 20h16"/></svg>
              </button>
              <button
                type="button"
                onClick={openHistory}
                title="History"
                className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-slate-700/80 text-slate-300 transition hover:border-cyan-500/50 hover:text-cyan-300"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-4 w-4"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/><path d="M12 7v6l4 2"/></svg>
              </button>
              <button
                type="button"
                onClick={startNewBlankProject}
                title="Start new blank project"
                className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-slate-700/80 text-slate-300 transition hover:border-cyan-500/50 hover:text-cyan-300"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-4 w-4"><path d="M12 5v14"/><path d="M5 12h14"/><path d="M4 4h16v16H4z"/></svg>
              </button>
              <button
                type="button"
                onClick={() => void saveToCloud("update")}
                title="Save update"
                className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-500/50 bg-cyan-500/15 text-cyan-300 transition hover:bg-cyan-500/25"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-4 w-4"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></svg>
              </button>
              <button
                type="button"
                onClick={() => void saveToCloud("new")}
                title="Save as new"
                className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-emerald-500/50 bg-emerald-500/15 text-emerald-300 transition hover:bg-emerald-500/25"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-4 w-4"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
              </button>
            </div>

            <button
              type="button"
              onClick={() => setMobileToolsOpen((v) => !v)}
              className="focus-ring min-h-10 rounded-xl border border-slate-700/80 px-3 text-xs font-semibold uppercase tracking-[0.18em] text-slate-200 sm:hidden"
            >
              {mobileToolsOpen ? "Close" : "Tools"}
            </button>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_7.5rem_auto] items-center gap-2 rounded-xl border border-slate-700/80 bg-slate-950/70 px-2 py-2 sm:grid-cols-2 lg:grid-cols-[minmax(260px,1fr)_170px_auto]">
            <input
              type="text"
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder="Sermon title / save name"
              className="focus-ring h-11 min-w-0 rounded-xl border border-slate-700/80 bg-slate-950/70 px-3 text-base text-slate-100 placeholder:text-slate-500"
            />
            <select
              value={speechLanguage}
              onChange={(event) => setSpeechLanguage(event.target.value as SpeechLanguage)}
              className="focus-ring h-11 min-w-0 rounded-xl border border-slate-600/50 bg-slate-900 px-2 text-base font-semibold text-slate-200"
              aria-label="Spoken language"
            >
              <option value="auto">Auto</option>
              <option value="english">English</option>
              <option value="spanish">Spanish</option>
              <option value="french">French</option>
              <option value="portuguese">Portuguese</option>
              <option value="german">German</option>
              <option value="swahili">Swahili</option>
              <option value="twi">Twi</option>
              <option value="kikuyu">Kikuyu</option>
            </select>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="focus-ring h-11 whitespace-nowrap rounded-xl border border-slate-700/80 px-3 text-sm font-semibold text-slate-300"
              >
                <span className="sm:hidden">Upload</span>
                <span className="hidden sm:inline">Upload Transcript</span>
              </button>
            </div>
          </div>

          {mobileToolsOpen && (
            <div className="w-full max-w-full overflow-hidden pb-1 sm:hidden">
              <div className="grid grid-cols-5 gap-2">
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="focus-ring min-h-10 min-w-0 rounded-xl border border-slate-700/80 px-2 text-[11px] font-semibold text-slate-300"
                >
                  Upload
                </button>
                <button
                  type="button"
                  onClick={openHistory}
                  className="focus-ring min-h-10 min-w-0 rounded-xl border border-slate-700/80 px-2 text-[11px] font-semibold text-slate-300"
                >
                  History
                </button>
                <button
                  type="button"
                  onClick={startNewBlankProject}
                  className="focus-ring min-h-10 min-w-0 rounded-xl border border-slate-700/80 px-2 text-[11px] font-semibold text-slate-300"
                >
                  New
                </button>
                <button
                  type="button"
                  onClick={() => void saveToCloud("update")}
                  className="focus-ring min-h-10 min-w-0 rounded-xl border border-cyan-500/50 bg-cyan-500/15 px-2 text-[11px] font-semibold text-cyan-300"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => void saveToCloud("new")}
                  className="focus-ring min-h-10 min-w-0 rounded-xl border border-emerald-500/50 bg-emerald-500/15 px-2 text-[11px] font-semibold text-emerald-300"
                >
                  Save+
                </button>
              </div>
            </div>
          )}

          <input ref={fileRef} type="file" accept=".txt" className="hidden" onChange={onUploadTranscript} />
        </header>

        <div
          ref={containerRef}
          className={`flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row${isDraggingResize ? " cursor-col-resize select-none" : ""}`}
        >
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-cyan-500/20 bg-slate-950/55 m-2 lg:m-3 lg:mr-0 lg:min-w-0">
            <div className="flex shrink-0 gap-2 overflow-x-auto border-b border-cyan-500/20 px-2 py-2 lg:gap-0 lg:px-0 lg:py-0">
              {tabOrder.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onPointerDown={(e) => {
                    if (e.pointerType === "touch") { e.preventDefault(); setActiveTab(tab); }
                  }}
                  onClick={() => setActiveTab(tab)}
                  style={{ touchAction: "manipulation" }}
                  className={`focus-ring min-h-10 shrink-0 touch-manipulation whitespace-nowrap rounded-lg border px-3 text-xs font-bold uppercase tracking-[0.18em] lg:min-h-12 lg:flex-1 lg:rounded-none lg:border-x-0 lg:border-t-0 lg:border-b-2 lg:px-2 lg:text-sm lg:tracking-wide ${
                    activeTab === tab
                      ? "border-cyan-400/70 bg-cyan-500/10 text-cyan-300 lg:border-cyan-400"
                      : "border-slate-800 text-slate-400 hover:bg-slate-900/80 hover:text-slate-200 lg:border-transparent"
                  }`}
                >
                  <span className="sm:hidden">{tab === "raw" ? "Transcript" : tab === "organized" ? "Notes" : "Agent"}</span>
                  <span className="hidden sm:inline">{tab === "raw" ? "Raw Transcript" : tab === "organized" ? "Organized Notes" : "Nexus Agent"}</span>
                </button>
              ))}
              {/* Mobile-only: open references bottom sheet */}
              <button
                type="button"
                onPointerDown={(e) => { if (e.pointerType === "touch") { e.preventDefault(); setMobileRefsOpen(true); } }}
                onClick={() => setMobileRefsOpen(true)}
                style={{ touchAction: "manipulation" }}
                className={`focus-ring min-h-10 shrink-0 touch-manipulation whitespace-nowrap rounded-lg border px-3 text-xs font-bold uppercase tracking-[0.18em] lg:hidden ${
                  scriptureCards.length > 0
                    ? "border-cyan-400/70 bg-cyan-500/10 text-cyan-300"
                    : "border-slate-800 text-slate-400"
                }`}
              >
                <span className="flex items-center gap-1.5">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3.5 w-3.5 shrink-0">
                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  Refs{scriptureCards.length > 0 ? ` (${scriptureCards.length})` : ""}
                </span>
              </button>
            </div>

            {activeTab === "raw" && (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-cyan-500/10 px-4 py-3">
                  <p className="text-xs uppercase tracking-wider text-slate-500">Live Capture</p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setDesktopTelemetryOpen((v) => !v)}
                      className="focus-ring hidden h-10 rounded-xl border border-slate-700/70 px-3 text-xs font-semibold text-slate-200 sm:inline-flex sm:items-center"
                    >
                      {desktopTelemetryOpen ? "Hide Insights" : "Show Insights"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setMobileTelemetryOpen((v) => !v)}
                      className="focus-ring min-h-12 rounded-xl border border-slate-700/70 px-3 text-sm font-semibold text-slate-200 sm:hidden"
                    >
                      {mobileTelemetryOpen ? "Hide Insights" : "Show Insights"}
                    </button>
                    <button
                      type="button"
                      onClick={toggleRecording}
                      className={`focus-ring min-h-12 rounded-xl px-5 text-sm font-bold transition ${
                        isRecording
                          ? "border border-cyan-400/60 bg-cyan-500/20 text-cyan-300"
                          : "bg-cyan-400 text-slate-950 hover:bg-cyan-300"
                      }`}
                    >
                      {isRecording ? "Pause" : "Start"}
                    </button>
                    {audioDownloadUrl && !isRecording && (
                      <button
                        type="button"
                        onClick={downloadAudio}
                        className="focus-ring min-h-12 rounded-xl border border-cyan-500/50 bg-cyan-500/15 px-4 text-sm font-semibold text-cyan-300 transition hover:bg-cyan-500/25"
                      >
                        Download Audio
                      </button>
                    )}
                  </div>
                </div>

                <div className="hidden border-b border-cyan-500/10 p-2 sm:block">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded-lg border border-slate-700/70 bg-slate-900/70 px-2 py-1 text-cyan-200">Mic {volumeLevel}%</span>
                    <span className="rounded-lg border border-slate-700/70 bg-slate-900/70 px-2 py-1 text-slate-200">Now {currentWpm} WPM</span>
                    <span className="rounded-lg border border-slate-700/70 bg-slate-900/70 px-2 py-1 text-slate-200">Avg {avgWpm} WPM</span>
                  </div>
                  {desktopTelemetryOpen && (
                    <div className="mt-2 rounded-xl border border-slate-700/70 bg-slate-900/70 p-3">
                      <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Cadence Trend</p>
                      <div className="mt-2 flex h-14 items-end gap-1">
                        {cadencePoints.length === 0 ? (
                          <p className="text-xs text-slate-500">Begin speaking to generate cadence telemetry.</p>
                        ) : (
                          cadencePoints.map((point) => (
                            <span
                              key={`${point.tSec}-${point.wpm}`}
                              className="w-2 rounded-t bg-cyan-400/90"
                              title={`${point.wpm} WPM at ${point.tSec}s`}
                              style={{ height: `${Math.max(10, Math.min(100, Math.round((point.wpm / 220) * 100)))}%` }}
                            />
                          ))
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {mobileTelemetryOpen && (
                  <div className="grid gap-2 border-b border-cyan-500/10 p-3 sm:hidden">
                    <div className="rounded-xl border border-slate-700/70 bg-slate-900/70 p-3">
                      <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Mic Level</p>
                      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-800">
                        <div className="h-full rounded-full bg-cyan-400 transition-all" style={{ width: `${volumeLevel}%` }} />
                      </div>
                      <p className="mt-2 text-sm font-bold text-cyan-300">{volumeLevel}%</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-xl border border-slate-700/70 bg-slate-900/70 p-3">
                        <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Current WPM</p>
                        <p className="mt-2 text-2xl font-black text-slate-100">{currentWpm}</p>
                      </div>
                      <div className="rounded-xl border border-slate-700/70 bg-slate-900/70 p-3">
                        <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Average WPM</p>
                        <p className="mt-2 text-2xl font-black text-slate-100">{avgWpm}</p>
                      </div>
                    </div>
                  </div>
                )}

                <div ref={transcriptScrollRef} className="min-h-0 flex-1 overflow-y-auto p-4 text-base leading-relaxed text-slate-200">
                  {transcriptPreview ? (
                    <p className="whitespace-pre-wrap break-words">{transcriptPreview}</p>
                  ) : (
                    <div className="flex h-full items-center justify-center text-center text-slate-500">
                      <p>Click Start and begin speaking. Try paraphrasing passages too, semantic suggestions will auto-appear.</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeTab === "organized" && (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="hidden flex-wrap items-center justify-end gap-2 border-b border-cyan-500/10 px-4 py-3 sm:flex">
                  <div className="flex items-center gap-2">
                    <label className="text-sm font-semibold text-slate-300">LLM Model:</label>
                    <select
                      value={selectedSermonAssistantModel}
                      onChange={(e) => setSelectedSermonAssistantModel(e.target.value as "deepseek" | "gemini")}
                      disabled={isGenerating}
                      className="focus-ring rounded-xl border border-slate-700/60 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-500/40 disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      <option value="deepseek">DeepSeek (default)</option>
                      <option value="gemini">Gemini 2.0 Flash (beta)</option>
                    </select>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsEditingOrganized((value) => !value)}
                    className="focus-ring min-h-12 rounded-xl border border-slate-600/80 px-4 text-sm font-bold text-slate-200 transition hover:border-cyan-500/50 hover:text-cyan-300"
                  >
                    {isEditingOrganized ? "Preview Mode" : "Edit Notes"}
                  </button>
                  <button
                    type="button"
                    onClick={openPulpitMode}
                    className="focus-ring min-h-12 rounded-xl border border-amber-400/40 bg-amber-500/10 px-4 text-sm font-bold text-amber-300 transition hover:bg-amber-500/20"
                  >
                    Pulpit Mode
                  </button>
                  <button
                    type="button"
                    onClick={() => void downloadSermonNotesDocx()}
                    className="focus-ring min-h-12 rounded-xl border border-emerald-500/45 bg-emerald-500/10 px-4 text-sm font-bold text-emerald-300 transition hover:bg-emerald-500/20"
                  >
                    Download Word
                  </button>
                  <button
                    type="button"
                    onClick={generateOutline}
                    disabled={isGenerating}
                    className="focus-ring min-h-12 rounded-xl bg-cyan-400 px-5 text-sm font-bold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isGenerating ? "Processing..." : "Generate Outline"}
                  </button>
                </div>

                <div className="shrink-0 border-b border-cyan-500/10 px-2 py-2 sm:hidden">
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      type="button"
                      onClick={generateOutline}
                      disabled={isGenerating}
                      className="focus-ring min-h-10 min-w-0 rounded-xl bg-cyan-400 px-2 text-[11px] font-bold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isGenerating ? "Processing" : organizedMarkdown.trim() ? "Refresh" : "Generate"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setMobileOrganizedView("outline")}
                      className={`focus-ring min-h-10 min-w-0 rounded-xl border px-2 text-[11px] font-semibold ${mobileOrganizedView === "outline" ? "border-cyan-400 bg-cyan-500/15 text-cyan-200" : "border-slate-700 text-slate-300"}`}
                    >
                      Outline
                    </button>
                    <button
                      type="button"
                      onClick={() => setMobileOrganizedView("manual")}
                      className={`focus-ring min-h-10 min-w-0 rounded-xl border px-2 text-[11px] font-semibold ${mobileOrganizedView === "manual" ? "border-cyan-400 bg-cyan-500/15 text-cyan-200" : "border-slate-700 text-slate-300"}`}
                    >
                      Manual
                    </button>
                  </div>
                </div>

                <div className="grid min-h-0 flex-1 gap-2 p-2 sm:gap-3 sm:p-3 lg:grid-cols-[minmax(0,1.9fr)_minmax(260px,0.7fr)] xl:grid-cols-[minmax(0,2.15fr)_minmax(280px,0.65fr)]">
                  <div className={`min-h-0 overflow-hidden rounded-xl border border-cyan-500/15 bg-slate-950/70 sm:min-h-[35dvh] ${mobileOrganizedView === "manual" ? "hidden sm:block" : ""}`}>
                    {isEditingOrganized ? (
                      <textarea
                        value={organizedMarkdown}
                        onChange={(event) => setOrganizedMarkdown(event.target.value)}
                        placeholder="Generated sermon structure will appear here. You can manually rewrite, reorder, and add notes directly."
                        className="focus-ring h-full min-h-0 w-full resize-none border-0 bg-transparent p-4 text-base leading-relaxed text-slate-100 placeholder:text-slate-500 sm:min-h-[35dvh] sm:p-5"
                      />
                    ) : (
                      <div className="prose prose-invert h-full max-w-none overflow-y-auto p-4 sm:p-5">
                        {organizedMarkdown ? (
                          <div dangerouslySetInnerHTML={{ __html: renderMarkdown(organizedMarkdown) }} />
                        ) : (
                          <div className="flex h-full items-center justify-center text-center text-slate-500 not-prose">
                            <p>Your structured sermon will appear here.</p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <div className={`min-h-0 overflow-hidden rounded-xl border border-cyan-500/15 bg-slate-950/70 sm:min-h-[35dvh] ${mobileOrganizedView === "outline" ? "hidden sm:block" : ""}`}>
                    <div className="border-b border-cyan-500/10 px-4 py-3">
                      <p className="text-xs font-bold uppercase tracking-wider text-slate-400">Manual Notes</p>
                    </div>
                    <textarea
                      value={manualNotes}
                      onChange={(event) => setManualNotes(event.target.value)}
                      placeholder="Add transitions, illustrations, altar call notes, delivery cues, or anything you want to manually keep alongside the organized sermon."
                      className="focus-ring h-[calc(100%-49px)] min-h-0 w-full resize-none border-0 bg-transparent p-4 text-base leading-relaxed text-slate-100 placeholder:text-slate-500 sm:min-h-[calc(35dvh-49px)]"
                    />
                  </div>
                </div>

                <div className="shrink-0 border-t border-cyan-500/10 bg-slate-950/85 px-2 pt-2 pb-[max(env(safe-area-inset-bottom),1rem)] sm:hidden">
                  <div className="grid grid-cols-4 gap-2">
                    <button
                    type="button"
                    onClick={() => setIsEditingOrganized((value) => !value)}
                    className="focus-ring min-h-10 min-w-0 rounded-xl border border-slate-600/80 px-2 text-xs font-bold text-slate-200 transition hover:border-cyan-500/50 hover:text-cyan-300"
                  >
                    {isEditingOrganized ? "Preview" : "Edit"}
                  </button>
                  <button
                    type="button"
                    onClick={openPulpitMode}
                    className="focus-ring min-h-10 min-w-0 rounded-xl border border-amber-400/40 bg-amber-500/10 px-2 text-xs font-bold text-amber-300 transition hover:bg-amber-500/20"
                  >
                    Pulpit
                  </button>
                  <button
                    type="button"
                    onClick={() => void downloadSermonNotesDocx()}
                    className="focus-ring min-h-10 min-w-0 rounded-xl border border-emerald-500/45 bg-emerald-500/10 px-2 text-xs font-bold text-emerald-300 transition hover:bg-emerald-500/20"
                  >
                    Word
                  </button>
                  <button
                    type="button"
                    onClick={generateOutline}
                    disabled={isGenerating}
                    className="focus-ring min-h-10 min-w-0 rounded-xl border border-cyan-500/50 bg-cyan-500/15 px-2 text-xs font-bold text-cyan-300 transition hover:bg-cyan-500/25 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isGenerating ? "Processing" : "Again"}
                  </button>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "assistant" && (
              <div className="flex min-h-0 flex-1 flex-col">
                <div ref={chatScrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
                  {chatEntries.length === 0 && (
                    <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-4 text-sm text-slate-300">
                      Type a command like "Give me three opening hooks" or "Turn section 2 into a narrative."
                    </div>
                  )}
                  {chatEntries.map((entry) => (
                    <div key={entry.id} className={entry.role === "user" ? "flex justify-end" : "flex justify-start"}>
                      <div
                        className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                          entry.role === "user"
                            ? "bg-slate-800 text-slate-100"
                            : "border border-cyan-500/20 bg-slate-900 text-slate-200"
                        }`}
                      >
                        {entry.role === "user" ? entry.markdown : <div dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.markdown) }} />}
                      </div>
                    </div>
                  ))}
                  {isAssistantThinking && (
                    <div className="rounded-2xl border border-cyan-500/20 bg-slate-900 px-4 py-3 text-sm text-slate-400">
                      Nexus Agent is restructuring your sermon...
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 gap-2 border-t border-cyan-500/20 p-3 pb-8 lg:pb-3">
                  <input
                    type="text"
                    value={assistantInput}
                    onChange={(event) => setAssistantInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void sendAssistantCommand();
                    }}
                    placeholder="Command Nexus Agent..."
                    className="focus-ring min-h-12 flex-1 rounded-xl border border-slate-700/90 bg-slate-950/80 px-4 text-base text-slate-100 placeholder:text-slate-500"
                  />
                  <button
                    type="button"
                    onClick={() => void sendAssistantCommand()}
                    className="focus-ring min-h-12 min-w-12 rounded-xl bg-cyan-400 px-4 text-sm font-bold text-slate-950 hover:bg-cyan-300"
                  >
                    Send
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Resize handle — desktop only, touch-friendly 12px grab zone */}
          <div
            className="group hidden shrink-0 cursor-col-resize items-center justify-center lg:flex"
            style={{ width: 12 }}
            onMouseDown={(e) => {
              isDraggingResizeRef.current = true;
              setIsDraggingResize(true);
              dragStartDataRef.current = { startX: e.clientX, startWidth: refsPanelWidth };
              e.preventDefault();
            }}
            onTouchStart={(e) => {
              if (!e.touches[0]) return;
              isDraggingResizeRef.current = true;
              setIsDraggingResize(true);
              dragStartDataRef.current = { startX: e.touches[0].clientX, startWidth: refsPanelWidth };
            }}
          >
            <div className={`h-full w-0.5 rounded-full transition-colors ${isDraggingResize ? "bg-cyan-400" : "bg-slate-700/60 group-hover:bg-cyan-500/70"}`} />
          </div>

          <aside
            className={`hidden min-h-0 flex-col overflow-hidden rounded-xl border bg-slate-950/55 lg:flex lg:shrink-0 lg:mt-3 lg:mb-3 lg:ml-0 lg:mr-0 ${liveMode ? "border-rose-500/40" : "border-cyan-500/20"}`}
            style={{ width: refsPanelWidth }}
          >
            {/* Panel header */}
            <div className={`shrink-0 border-b px-3 py-2 ${liveMode ? "border-rose-500/30 bg-rose-950/30" : "border-cyan-500/20"}`}>

              {/* Row 1: title badge + Live + Auto toggles */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {liveMode && <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-rose-400" />}
                  <p className={`text-[11px] font-bold uppercase tracking-wider ${liveMode ? "text-rose-300" : "text-slate-400"}`}>
                    {liveMode ? "Live" : "References"}
                  </p>
                  {readingQueue.length > 0 && (
                    <span className="rounded-full bg-cyan-500/20 px-1.5 py-0.5 text-[10px] font-bold text-cyan-300">
                      {readingQueueIndex + 1}/{readingQueue.length}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  {/* Mic / transcription toggle — independent of Live cast mode */}
                  <button
                    type="button"
                    title={isRecording ? "Stop transcription (scriptures still cast)" : "Start transcription"}
                    onClick={() => void toggleRecording()}
                    className={`flex h-6 w-6 items-center justify-center rounded-full border transition ${
                      isRecording
                        ? "border-rose-400/70 bg-rose-500/20 text-rose-300"
                        : "border-slate-600 bg-slate-800 text-slate-500 hover:text-slate-200"
                    }`}
                  >
                    {isRecording ? (
                      <svg viewBox="0 0 24 24" fill="currentColor" className="h-3 w-3"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3 w-3"><path d="M12 4a3 3 0 0 1 3 3v5a3 3 0 1 1-6 0V7a3 3 0 0 1 3-3Z"/><path d="M6 11a6 6 0 0 0 12 0"/><path d="M12 17v3"/></svg>
                    )}
                  </button>
                  <label className="flex cursor-pointer items-center gap-1" title="Live mode — auto-push quoted refs to monitor">
                    <span className={`text-[10px] font-bold uppercase ${liveMode ? "text-rose-400" : "text-slate-500"}`}>Live</span>
                    <span className={`relative inline-flex h-4 w-8 shrink-0 rounded-full border transition-colors ${liveMode ? "border-rose-500 bg-rose-500/60" : "border-slate-600 bg-slate-800"}`}>
                      <input type="checkbox" checked={liveMode} onChange={(e) => setLiveMode(e.target.checked)} className="sr-only" />
                      <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${liveMode ? "translate-x-4" : "translate-x-0"}`} />
                    </span>
                  </label>
                  <label className="flex cursor-pointer items-center gap-1" title="Auto-push every detected scripture to monitor">
                    <span className="text-[10px] font-bold uppercase text-slate-500">Auto</span>
                    <span className={`relative inline-flex h-4 w-8 shrink-0 rounded-full border transition-colors ${autoPushDisplay ? "border-violet-400 bg-violet-500/60" : "border-slate-600 bg-slate-800"}`}>
                      <input type="checkbox" checked={autoPushDisplay} onChange={(e) => setAutoPushDisplay(e.target.checked)} className="sr-only" />
                      <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${autoPushDisplay ? "translate-x-4" : "translate-x-0"}`} />
                    </span>
                  </label>
                </div>
              </div>

              {/* Row 2: translation selector + Share + Report */}
              <div className="mt-2 flex items-center gap-2">
                <select
                  value={bibleTranslation}
                  onChange={(e) => setBibleTranslation(e.target.value as typeof bibleTranslation)}
                  className="flex-1 rounded-md border border-slate-700/60 bg-slate-900/80 px-2 py-1 text-[11px] font-bold text-slate-300 outline-none focus:border-cyan-500/60"
                >
                  <option value="amp">Amplified (AMP)</option>
                  <option value="niv">NIV</option>
                  <option value="nlt">NLT</option>
                  <option value="kjv">KJV</option>
                  <option value="asv">ASV</option>
                  <option value="nkjv">NKJV</option>
                  <option value="msg">The Message</option>
                  <option value="web">WEB (Modern)</option>
                </select>
                <button
                  type="button"
                  title="Copy monitor link for media team"
                  onClick={() => {
                    const url = `${window.location.origin}/monitor`;
                    void navigator.clipboard.writeText(url).then(() => pushToast("Monitor link copied!", "success"));
                  }}
                  className="focus-ring flex h-7 items-center gap-1 rounded-md border border-cyan-500/40 bg-cyan-500/10 px-2 text-[10px] font-bold uppercase tracking-wider text-cyan-400 transition hover:bg-cyan-500/20"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3 w-3"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                  Share
                </button>
                <button
                  type="button"
                  title="Copy streaming monitor link"
                  onClick={() => {
                    const url = `${window.location.origin}/monitor?displayOnly=1&channel=stream`;
                    void navigator.clipboard.writeText(url).then(() => pushToast("Streaming monitor link copied!", "success"));
                  }}
                  className="focus-ring flex h-7 items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 text-[10px] font-bold uppercase tracking-wider text-emerald-300 transition hover:bg-emerald-500/20"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3 w-3"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                  Stream
                </button>
                <button
                  type="button"
                  title="Download scripture reference report (.docx)"
                  onClick={() => void exportReferenceReport()}
                  className="focus-ring flex h-7 items-center gap-1 rounded-md border border-slate-600/60 bg-slate-800/50 px-2 text-[10px] font-bold uppercase tracking-wider text-slate-400 transition hover:bg-slate-700/70 hover:text-slate-200"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3 w-3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  Report
                </button>
              </div>

              <div className="mt-2 rounded-lg border border-violet-500/25 bg-violet-500/5 p-2">
                <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-violet-300">Manual Cast</p>
                <div className="grid grid-cols-1 gap-2">
                  <div className="relative">
                    <input
                      type="text"
                      value={manualRefInput}
                      onChange={(e) => setManualRefInput(e.target.value)}
                      onFocus={() => setManualRefFocused(true)}
                      onBlur={() => window.setTimeout(() => setManualRefFocused(false), 100)}
                      placeholder="Reference (e.g. Romans 8:28)"
                      className="focus-ring min-h-12 w-full rounded-md border border-slate-700/70 bg-slate-950/70 px-3 text-base text-slate-100 placeholder:text-slate-500"
                    />
                    {manualRefFocused && manualBookSuggestions.length > 0 && (
                      <div className="absolute left-0 right-0 top-[calc(100%+0.35rem)] z-20 overflow-hidden rounded-md border border-slate-700/80 bg-slate-950 shadow-2xl">
                        {manualBookSuggestions.map((book) => (
                          <button
                            key={book}
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              const suffix = manualRefInput.match(/\s+\d.*$/)?.[0] ?? "";
                              setManualRefInput(`${book}${suffix}`.trim());
                              setManualRefFocused(false);
                            }}
                            className="flex min-h-[40px] w-full items-center px-3 text-left text-sm text-slate-200 hover:bg-slate-800"
                          >
                            {book}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <textarea
                    value={manualVerseInput}
                    onChange={(e) => setManualVerseInput(e.target.value)}
                    rows={2}
                    placeholder="Optional verse text. Leave blank to auto-fetch."
                    className="focus-ring rounded-md border border-slate-700/70 bg-slate-950/70 px-3 py-2 text-base text-slate-100 placeholder:text-slate-500"
                  />
                  <button
                    type="button"
                    onClick={() => void handleManualCast()}
                    disabled={manualCastBusy || !manualRefInput.trim()}
                    className="focus-ring min-h-12 rounded-md border border-violet-400/60 bg-violet-500/20 px-3 text-xs font-bold uppercase tracking-wider text-violet-200 transition hover:bg-violet-500/30 disabled:opacity-40"
                  >
                    {manualCastBusy ? "Casting..." : "Cast Manual Scripture"}
                  </button>
                </div>
              </div>

              {monitorDisplayControls(false)}

              {/* Row 3 (conditional): reading queue nav */}
              {readingQueue.length > 0 && (
                <div className="mt-2 flex items-center gap-1 rounded-lg border border-cyan-500/20 bg-cyan-500/5 px-2 py-1">
                  <button
                    type="button"
                    onClick={() => advanceReadingQueue(readingQueueIndex - 1)}
                    disabled={readingQueueIndex === 0}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-slate-400 hover:bg-slate-700 disabled:opacity-30"
                    title="Previous verse"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3.5 w-3.5"><polyline points="15 18 9 12 15 6"/></svg>
                  </button>
                  <span className="flex-1 text-center text-[11px] font-semibold text-cyan-300">
                    {readingQueue[readingQueueIndex]?.ref ?? "—"}
                  </span>
                  <button
                    type="button"
                    onClick={() => advanceReadingQueue()}
                    disabled={readingQueueIndex >= readingQueue.length - 1}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-slate-400 hover:bg-slate-700 disabled:opacity-30"
                    title="Next verse"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3.5 w-3.5"><polyline points="9 18 15 12 9 6"/></svg>
                  </button>
                </div>
              )}

              <div className="mt-1.5 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={handlePreviousVerse}
                  disabled={
                    (readingQueue.length > 0 && readingQueueIndex === 0) ||
                    (readingQueue.length === 0 && !prevSequentialRef(lastDisplayRef))
                  }
                  className="flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-2 text-[10px] font-bold uppercase tracking-wider text-cyan-300 transition hover:bg-cyan-500/20 active:scale-95 disabled:pointer-events-none disabled:opacity-25"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="h-3.5 w-3.5"><polyline points="15 18 9 12 15 6"/></svg>
                  {readingQueue.length > 0 && readingQueueIndex > 0
                    ? `Prev — ${readingQueue[readingQueueIndex - 1]?.ref ?? "Verse"}`
                    : lastDisplayRef
                      ? `Prev — ${prevSequentialRef(lastDisplayRef) ?? "Verse"}`
                      : "Prev Verse"}
                </button>
                <button
                  type="button"
                  onClick={handleNextVerse}
                  disabled={!lastDisplayRef && readingQueue.length === 0}
                  className="flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-cyan-500/50 bg-cyan-500/15 px-2 text-[10px] font-bold uppercase tracking-wider text-cyan-300 transition hover:bg-cyan-500/25 active:scale-95 disabled:pointer-events-none disabled:opacity-25"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="h-3.5 w-3.5"><polyline points="9 18 15 12 9 6"/></svg>
                  {readingQueue.length > 0 && readingQueueIndex < readingQueue.length - 1
                    ? `Next — ${readingQueue[readingQueueIndex + 1]?.ref ?? "Verse"}`
                    : lastDisplayRef
                      ? `Next — ${nextSequentialRef(lastDisplayRef) ?? "Verse"}`
                      : "Next Verse"}
                </button>
              </div>
            </div>

            {/* Card list */}
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {(() => {
                const detected = scriptureCards.filter((c) => c.source === "detected");
                const suggested = scriptureCards.filter((c) => c.source === "suggested");
                const visibleDetected = detected;
                const showSuggested = suggested.length > 0;

                if (scriptureCards.length === 0) {
                  return (
                    <div className="flex h-full items-center justify-center text-center text-sm text-slate-500">
                      <p>{liveMode ? "Quoted scriptures will appear here during the sermon." : "Detected and suggested scriptures will appear here."}</p>
                    </div>
                  );
                }

                const renderCard = (card: typeof scriptureCards[0], live: boolean) => (
                  <article
                    key={card.id}
                    className={`rounded-xl px-4 py-3 ${live ? "border-l-4 border-rose-400 bg-rose-950/40" : card.source === "suggested" ? "border-l-4 border-amber-400/60 bg-slate-900/60" : "border-l-4 border-cyan-400 bg-slate-900/80"}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <h3 className={`text-sm font-bold ${live ? "text-rose-200" : card.source === "suggested" ? "text-amber-300" : "text-cyan-300"}`}>{card.ref}</h3>
                      <button
                        type="button"
                        onClick={() => pushToMonitor(card.ref, card.text)}
                        title="Cast to scripture monitor"
                        className="focus-ring flex h-6 items-center gap-1 rounded-md border border-violet-500/50 bg-violet-500/15 px-2 text-[10px] font-bold uppercase tracking-wider text-violet-300 transition hover:bg-violet-500/30"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3 w-3"><path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/><path d="M2 12a9 9 0 0 1 8 8"/><path d="M2 16a5 5 0 0 1 4 4"/><circle cx="3" cy="20" r="1"/></svg>
                        Cast
                      </button>
                    </div>
                    <p className="mt-1 text-sm italic text-slate-300">&quot;{card.text}&quot;</p>
                    {!live && card.reason && <p className="mt-1 text-xs text-slate-500">{card.reason}</p>}
                  </article>
                );

                return (
                  <div className="space-y-3">
                    {/* Quoted / Detected section */}
                    {visibleDetected.length > 0 && (
                      <>
                        {!liveMode && (
                          <p className="px-1 text-[10px] font-bold uppercase tracking-widest text-cyan-500/70">Quoted</p>
                        )}
                        {visibleDetected.map((card) => renderCard(card, liveMode))}
                      </>
                    )}

                    {/* Divider + AI Suggestions section */}
                    {showSuggested && (
                      <>
                        <div className="flex items-center gap-2 py-1">
                          <div className="h-px flex-1 bg-slate-700/60" />
                          <p className="text-[10px] font-bold uppercase tracking-widest text-amber-500/60">AI Suggestions</p>
                          <div className="h-px flex-1 bg-slate-700/60" />
                        </div>
                        {suggested.map((card) => renderCard(card, false))}
                      </>
                    )}
                  </div>
                );
              })()}
            </div>
          </aside>
        </div>

        {/* ── Mobile References Bottom Sheet ─────────────────────── */}
        <div
          className={`fixed inset-x-0 bottom-0 z-[60] flex flex-col rounded-t-2xl border-t border-cyan-500/20 bg-slate-950 lg:hidden transition-transform duration-300 ease-out ${mobileRefsOpen ? "translate-y-0" : "translate-y-full"}`}
          style={{ maxHeight: "88dvh", paddingBottom: "max(env(safe-area-inset-bottom), 12px)" }}
          aria-hidden={!mobileRefsOpen}
        >
          {/* Pull handle + close */}
          <div className="flex shrink-0 items-center justify-between px-4 pt-3 pb-2">
            <div className="h-1 w-10 rounded-full bg-slate-600 mx-auto" />
          </div>

          {/* Header row */}
          <div className={`shrink-0 border-b px-4 pb-3 ${liveMode ? "border-rose-500/30 bg-rose-950/30" : "border-cyan-500/20"}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {liveMode && <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-rose-400" />}
                <p className={`text-sm font-bold uppercase tracking-wider ${liveMode ? "text-rose-300" : "text-slate-200"}`}>
                  References{scriptureCards.length > 0 ? ` · ${scriptureCards.length}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {/* Mic toggle */}
                <button
                  type="button"
                  title={isRecording ? "Stop transcription" : "Start transcription"}
                  onClick={() => void toggleRecording()}
                  className={`flex h-8 w-8 items-center justify-center rounded-full border transition ${
                    isRecording
                      ? "border-rose-400/70 bg-rose-500/20 text-rose-300"
                      : "border-slate-600 bg-slate-800 text-slate-500 hover:text-slate-200"
                  }`}
                >
                  {isRecording ? (
                    <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3.5 w-3.5"><path d="M12 4a3 3 0 0 1 3 3v5a3 3 0 1 1-6 0V7a3 3 0 0 1 3-3Z"/><path d="M6 11a6 6 0 0 0 12 0"/><path d="M12 17v3"/></svg>
                  )}
                </button>
                <label className="flex cursor-pointer items-center gap-1">
                  <span className={`text-[10px] font-bold uppercase ${liveMode ? "text-rose-400" : "text-slate-500"}`}>Live</span>
                  <span className={`relative inline-flex h-4 w-8 shrink-0 rounded-full border transition-colors ${liveMode ? "border-rose-500 bg-rose-500/60" : "border-slate-600 bg-slate-800"}`}>
                    <input type="checkbox" checked={liveMode} onChange={(e) => setLiveMode(e.target.checked)} className="sr-only" />
                    <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${liveMode ? "translate-x-4" : "translate-x-0"}`} />
                  </span>
                </label>
                <label className="flex cursor-pointer items-center gap-1">
                  <span className="text-[10px] font-bold uppercase text-slate-500">Auto</span>
                  <span className={`relative inline-flex h-4 w-8 shrink-0 rounded-full border transition-colors ${autoPushDisplay ? "border-violet-400 bg-violet-500/60" : "border-slate-600 bg-slate-800"}`}>
                    <input type="checkbox" checked={autoPushDisplay} onChange={(e) => setAutoPushDisplay(e.target.checked)} className="sr-only" />
                    <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${autoPushDisplay ? "translate-x-4" : "translate-x-0"}`} />
                  </span>
                </label>
                <button
                  type="button"
                  onPointerDown={(e) => { e.preventDefault(); setMobileRefsOpen(false); }}
                  onClick={() => setMobileRefsOpen(false)}
                  style={{ touchAction: "manipulation" }}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 active:bg-slate-800"
                  aria-label="Close references"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="h-4 w-4">
                    <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round"/>
                  </svg>
                </button>
              </div>
            </div>

            {/* Translation + Share */}
            <div className="mt-2 flex items-center gap-2">
              <select
                value={bibleTranslation}
                onChange={(e) => setBibleTranslation(e.target.value as typeof bibleTranslation)}
                className="flex-1 rounded-md border border-slate-700/60 bg-slate-900/80 px-2 py-1.5 text-sm font-bold text-slate-300 outline-none focus:border-cyan-500/60"
              >
                <option value="amp">Amplified (AMP)</option>
                <option value="niv">NIV</option>
                <option value="nlt">NLT</option>
                <option value="kjv">KJV</option>
                <option value="asv">ASV</option>
                <option value="nkjv">NKJV</option>
                <option value="msg">The Message</option>
                <option value="web">WEB (Modern)</option>
              </select>
              <button
                type="button"
                onClick={() => {
                  const url = `${window.location.origin}/monitor`;
                  void navigator.clipboard.writeText(url).then(() => pushToast("Monitor link copied!", "success"));
                }}
                className="flex h-9 items-center gap-1 rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 text-xs font-bold uppercase tracking-wider text-cyan-400"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3.5 w-3.5"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                Share
              </button>
              <button
                type="button"
                onClick={() => {
                  const url = `${window.location.origin}/monitor?displayOnly=1&channel=stream`;
                  void navigator.clipboard.writeText(url).then(() => pushToast("Streaming monitor link copied!", "success"));
                }}
                className="flex h-9 items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 text-xs font-bold uppercase tracking-wider text-emerald-300"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3.5 w-3.5"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                Stream
              </button>
            </div>

            <div className="mt-2 rounded-lg border border-violet-500/25 bg-violet-500/5 p-2">
              <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-violet-300">Manual Cast</p>
              <div className="grid grid-cols-1 gap-2">
                <div className="relative">
                  <input
                    type="text"
                    value={manualRefInput}
                    onChange={(e) => setManualRefInput(e.target.value)}
                    onFocus={() => setManualRefFocused(true)}
                    onBlur={() => window.setTimeout(() => setManualRefFocused(false), 100)}
                    placeholder="Reference (e.g. Romans 8:28)"
                    className="focus-ring min-h-12 w-full rounded-md border border-slate-700/70 bg-slate-950/70 px-3 text-base text-slate-100 placeholder:text-slate-500"
                  />
                  {manualRefFocused && manualBookSuggestions.length > 0 && (
                    <div className="absolute left-0 right-0 top-[calc(100%+0.35rem)] z-20 overflow-hidden rounded-md border border-slate-700/80 bg-slate-950 shadow-2xl">
                      {manualBookSuggestions.map((book) => (
                        <button
                          key={book}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            const suffix = manualRefInput.match(/\s+\d.*$/)?.[0] ?? "";
                            setManualRefInput(`${book}${suffix}`.trim());
                            setManualRefFocused(false);
                          }}
                          className="flex min-h-[44px] w-full items-center px-3 text-left text-sm text-slate-200 active:bg-slate-800"
                        >
                          {book}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <textarea
                  value={manualVerseInput}
                  onChange={(e) => setManualVerseInput(e.target.value)}
                  rows={2}
                  placeholder="Optional verse text. Leave blank to auto-fetch."
                  className="focus-ring rounded-md border border-slate-700/70 bg-slate-950/70 px-3 py-2 text-base text-slate-100 placeholder:text-slate-500"
                />
                <button
                  type="button"
                  onClick={() => void handleManualCast({ closeMobile: true })}
                  disabled={manualCastBusy || !manualRefInput.trim()}
                  className="focus-ring min-h-12 rounded-md border border-violet-400/60 bg-violet-500/20 px-3 text-xs font-bold uppercase tracking-wider text-violet-200 transition active:bg-violet-500/30 disabled:opacity-40"
                >
                  {manualCastBusy ? "Casting..." : "Cast Manual Scripture"}
                </button>
              </div>
            </div>

            {monitorDisplayControls(true)}

            {/* Reading queue nav */}
            {readingQueue.length > 0 && (
              <div className="mt-2 flex items-center gap-1 rounded-lg border border-cyan-500/20 bg-cyan-500/5 px-2 py-1">
                <button type="button" onClick={() => advanceReadingQueue(readingQueueIndex - 1)} disabled={readingQueueIndex === 0} className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-700 disabled:opacity-30">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4"><polyline points="15 18 9 12 15 6"/></svg>
                </button>
                <span className="flex-1 text-center text-xs font-semibold text-cyan-300">{readingQueue[readingQueueIndex]?.ref ?? "—"}</span>
                <button type="button" onClick={() => advanceReadingQueue()} disabled={readingQueueIndex >= readingQueue.length - 1} className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-700 disabled:opacity-30">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4"><polyline points="9 18 15 12 9 6"/></svg>
                </button>
              </div>
            )}

            <div className="mt-2 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={handlePreviousVerse}
                disabled={
                  (readingQueue.length > 0 && readingQueueIndex === 0) ||
                  (readingQueue.length === 0 && !prevSequentialRef(lastDisplayRef))
                }
                className="flex min-h-[48px] items-center justify-center gap-2 rounded-lg border border-cyan-500/40 bg-cyan-500/10 py-2.5 text-xs font-bold uppercase tracking-wider text-cyan-300 active:bg-cyan-500/20 disabled:pointer-events-none disabled:opacity-25"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="h-4 w-4"><polyline points="15 18 9 12 15 6"/></svg>
                {readingQueue.length > 0 && readingQueueIndex > 0
                  ? `Prev — ${readingQueue[readingQueueIndex - 1]?.ref ?? "Verse"}`
                  : lastDisplayRef
                    ? `Prev — ${prevSequentialRef(lastDisplayRef) ?? "Verse"}`
                    : "Prev Verse"}
              </button>
              <button
                type="button"
                onClick={handleNextVerse}
                disabled={!lastDisplayRef && readingQueue.length === 0}
                className="flex min-h-[48px] items-center justify-center gap-2 rounded-lg border border-cyan-500/50 bg-cyan-500/15 py-2.5 text-xs font-bold uppercase tracking-wider text-cyan-300 active:bg-cyan-500/25 disabled:pointer-events-none disabled:opacity-25"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="h-4 w-4"><polyline points="9 18 15 12 9 6"/></svg>
                {readingQueue.length > 0 && readingQueueIndex < readingQueue.length - 1
                  ? `Next — ${readingQueue[readingQueueIndex + 1]?.ref ?? "Verse"}`
                  : lastDisplayRef
                    ? `Next — ${nextSequentialRef(lastDisplayRef) ?? "Verse"}`
                    : "Next Verse"}
              </button>
            </div>
          </div>

          {/* Scripture cards */}
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {scriptureCards.length === 0 ? (
              <div className="flex h-full items-center justify-center text-center text-sm text-slate-500">
                <p>{liveMode ? "Quoted scriptures will appear here during the sermon." : "Detected and suggested scriptures will appear here."}</p>
              </div>
            ) : (
              <div className="space-y-3">
                {(() => {
                  const detected = scriptureCards.filter((c) => c.source === "detected");
                  const suggested = scriptureCards.filter((c) => c.source === "suggested");
                  const renderCard = (card: typeof scriptureCards[0], live: boolean) => (
                    <article
                      key={card.id}
                      className={`rounded-xl px-4 py-3 ${live ? "border-l-4 border-rose-400 bg-rose-950/40" : card.source === "suggested" ? "border-l-4 border-amber-400/60 bg-slate-900/60" : "border-l-4 border-cyan-400 bg-slate-900/80"}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <h3 className={`text-sm font-bold ${live ? "text-rose-200" : card.source === "suggested" ? "text-amber-300" : "text-cyan-300"}`}>{card.ref}</h3>
                        <button
                          type="button"
                          onClick={() => { pushToMonitor(card.ref, card.text); setMobileRefsOpen(false); }}
                          className="flex h-7 items-center gap-1 rounded-md border border-violet-500/50 bg-violet-500/15 px-2 text-[10px] font-bold uppercase tracking-wider text-violet-300 active:bg-violet-500/30"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3 w-3"><path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/><path d="M2 12a9 9 0 0 1 8 8"/><path d="M2 16a5 5 0 0 1 4 4"/><circle cx="3" cy="20" r="1"/></svg>
                          Cast
                        </button>
                      </div>
                      <p className="mt-1.5 text-sm italic text-slate-300">&quot;{card.text}&quot;</p>
                      {!live && card.reason && <p className="mt-1 text-xs text-slate-500">{card.reason}</p>}
                    </article>
                  );
                  return (
                    <>
                      {detected.length > 0 && (
                        <>
                          {!liveMode && <p className="px-1 text-[10px] font-bold uppercase tracking-widest text-cyan-500/70">Quoted</p>}
                          {detected.map((c) => renderCard(c, liveMode))}
                        </>
                      )}
                      {suggested.length > 0 && (
                        <>
                          <div className="flex items-center gap-2 py-1">
                            <div className="h-px flex-1 bg-slate-700/60" />
                            <p className="text-[10px] font-bold uppercase tracking-widest text-amber-500/60">AI Suggestions</p>
                            <div className="h-px flex-1 bg-slate-700/60" />
                          </div>
                          {suggested.map((c) => renderCard(c, false))}
                        </>
                      )}
                    </>
                  );
                })()}
              </div>
            )}
          </div>
        </div>

        {/* Backdrop for mobile refs sheet */}
        <div
          className={`fixed inset-0 z-[59] lg:hidden transition-opacity duration-300 ${mobileRefsOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}
          style={{ background: "rgba(0,0,0,0.65)" }}
          onPointerDown={() => setMobileRefsOpen(false)}
          aria-hidden
        />

        {historyOpen && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
            <div className="flex max-h-[80dvh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-cyan-500/30 bg-slate-900">
              <div className="flex items-center justify-between border-b border-cyan-500/20 px-4 py-3">
                <h3 className="text-base font-bold text-slate-100">Sermon History</h3>
                <button
                  type="button"
                  onClick={() => setHistoryOpen(false)}
                  className="focus-ring min-h-10 rounded-lg px-3 text-sm text-slate-400 hover:text-slate-100"
                >
                  Close
                </button>
              </div>
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
                {historyItems.length === 0 ? (
                  <p className="p-4 text-sm text-slate-500">No cloud projects found.</p>
                ) : (
                  historyItems.map((item) => (
                    <div key={item.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-700/70 bg-slate-950/70 px-3 py-3">
                      <button
                        type="button"
                        onClick={() => loadHistoryItem(item)}
                        className="focus-ring min-h-12 flex-1 text-left"
                      >
                        <p className="text-sm font-semibold text-slate-100">{item.name}</p>
                        <p className="text-xs text-slate-500">{new Date(item.updatedAt).toLocaleString()}</p>
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteHistoryItem(item.id)}
                        className="focus-ring min-h-12 rounded-lg border border-rose-500/40 px-3 text-xs font-semibold text-rose-300 hover:bg-rose-500/15"
                      >
                        Delete
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {toast && (
          <div className="pointer-events-none absolute bottom-5 left-1/2 z-20 -translate-x-1/2">
            <div
              className={`rounded-xl border px-4 py-2 text-sm font-semibold shadow-lg ${
                toast.type === "error"
                  ? "border-rose-400/70 bg-rose-500/90 text-white"
                  : toast.type === "success"
                    ? "border-cyan-400/70 bg-cyan-400 text-slate-950"
                    : "border-slate-600 bg-slate-800 text-slate-100"
              }`}
            >
              {toast.text}
            </div>
          </div>
        )}
      </section>

      {pulpitOpen && latestSection && (
        <div className="fixed inset-0 z-[90] flex flex-col bg-black text-white">
          <div className="flex shrink-0 items-center justify-between border-b border-amber-400/30 px-4 py-3">
            <div className="flex items-center gap-6">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-amber-300">Current Time</p>
                <p className="animate-pulse text-3xl font-black text-amber-200">{formatClockTime(new Date(pulpitNow))}</p>
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-cyan-300">Elapsed</p>
                <p className="animate-pulse text-3xl font-black text-cyan-200">{formatElapsed(elapsedPulpitSec)}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={launchTeachingSlides}
                className="focus-ring min-h-12 rounded-xl border border-cyan-400/40 px-4 text-sm font-bold text-cyan-200 hover:bg-cyan-500/20"
              >
                Teaching Slides
              </button>
              <button
                type="button"
                onClick={closePulpitMode}
                className="focus-ring min-h-12 rounded-xl border border-rose-400/40 px-4 text-sm font-bold text-rose-200 hover:bg-rose-500/20"
              >
                Exit
              </button>
            </div>
          </div>

          <div className="border-b border-cyan-500/20 bg-slate-950/70 px-4 py-3">
            <div className="mb-3 h-2 w-full overflow-hidden rounded-full bg-slate-800">
              <div className="h-full rounded-full bg-gradient-to-r from-amber-300 via-cyan-300 to-cyan-500 transition-all" style={{ width: `${pulpitProgressPct}%` }} />
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {pulpitSections.map((section, index) => (
                <button
                  key={`${section.title}-${index}`}
                  type="button"
                  onClick={() => setPulpitIndex(index)}
                  className={`focus-ring min-h-12 whitespace-nowrap rounded-xl border px-3 text-left text-sm transition ${
                    index === pulpitIndex
                      ? "border-cyan-300 bg-cyan-400/15 text-cyan-100"
                      : "border-slate-700 bg-slate-900/80 text-slate-400"
                  }`}
                >
                  <span className="block text-[10px] font-bold uppercase tracking-[0.22em] text-slate-500">{index + 1}</span>
                  <span className="block font-semibold">{section.title}</span>
                </button>
              ))}
            </div>
          </div>

          <div
            className="min-h-0 flex-1 overflow-y-auto px-5 py-6 lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-6"
            onTouchStart={onPulpitTouchStart}
            onTouchEnd={onPulpitTouchEnd}
          >
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-xs font-bold uppercase tracking-[0.22em] text-slate-400">
                  Section {pulpitIndex + 1} of {pulpitSections.length}
                </p>
                <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 text-xs font-bold uppercase tracking-widest text-amber-200">
                  {latestSection.wordCount} words
                </span>
                <span className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3 py-1 text-xs font-bold uppercase tracking-widest text-cyan-200">
                  Est. {estimateSectionDuration(latestSection.wordCount, avgWpm)}
                </span>
              </div>

              <h2 className="mt-3 text-4xl font-black text-amber-200 sm:text-5xl">{latestSection.title}</h2>

              <div className="mt-6 space-y-5">
                {latestSection.blocks.map((block, index) => {
                  if (block.kind === "subheading") {
                    return (
                      <h3 key={`${block.kind}-${index}`} className="text-2xl font-black text-cyan-200 sm:text-3xl">
                        {block.text}
                      </h3>
                    );
                  }

                  if (block.kind === "quote") {
                    return (
                      <blockquote key={`${block.kind}-${index}`} className="rounded-2xl border-l-4 border-amber-300 bg-amber-300/10 px-5 py-4 text-2xl font-semibold leading-[1.7] text-amber-50 sm:text-3xl">
                        {block.text}
                      </blockquote>
                    );
                  }

                  if (block.kind === "bullet") {
                    return (
                      <div key={`${block.kind}-${index}`} className="flex gap-4 rounded-2xl border border-cyan-400/20 bg-cyan-400/8 px-4 py-4">
                        <span className="mt-2 h-3 w-3 flex-shrink-0 rounded-full bg-cyan-300" />
                        <p className="text-2xl font-semibold leading-[1.6] text-slate-100 sm:text-3xl">{block.text}</p>
                      </div>
                    );
                  }

                  return (
                    <p key={`${block.kind}-${index}`} className="text-2xl font-medium leading-[1.7] text-slate-100 sm:text-3xl">
                      {block.text}
                    </p>
                  );
                })}
              </div>
            </div>

            <aside className="mt-8 space-y-4 lg:mt-0">
              <div className="rounded-2xl border border-slate-700 bg-slate-950/80 p-4">
                <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-slate-500">Current Section</p>
                <p className="mt-2 text-xl font-bold text-white">{latestSection.title}</p>
              </div>
              <div className="rounded-2xl border border-slate-700 bg-slate-950/80 p-4">
                <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-slate-500">Next Up</p>
                <p className="mt-2 text-lg font-semibold text-slate-200">{nextSection?.title ?? "Final section"}</p>
              </div>

              {/* ── Cast to Monitor panel ─────────────────────────────── */}
              {(() => {
                const sectionText = latestSection.blocks.map((b) => b.text).join(" ");
                const refs = extractScriptureRefs(sectionText);
                const quotes = latestSection.blocks.filter((b) => b.kind === "quote");
                const hasCastable = refs.length > 0 || quotes.length > 0;
                if (!hasCastable) return null;
                return (
                  <div className="rounded-2xl border border-violet-500/30 bg-violet-950/40 p-4">
                    <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-violet-300">Cast to Monitor</p>
                    {refs.length > 0 && (
                      <div className="mt-3 space-y-2">
                        <p className="text-[10px] uppercase tracking-wider text-slate-500">Scripture References</p>
                        {refs.map((ref) => (
                          <button
                            key={ref}
                            type="button"
                            onClick={() => castReferenceFromPulpit(ref)}
                            style={{ touchAction: "manipulation" }}
                            className="flex min-h-14 w-full items-center justify-between gap-3 rounded-xl border border-violet-500/50 bg-violet-500/15 px-4 py-3 text-left text-sm font-bold text-violet-200 active:bg-violet-500/30"
                          >
                            <span>{ref}</span>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4 shrink-0 text-violet-300"><path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/><path d="M2 12a9 9 0 0 1 8 8"/><path d="M2 16a5 5 0 0 1 4 4"/><circle cx="3" cy="20" r="1"/></svg>
                          </button>
                        ))}
                      </div>
                    )}
                    {quotes.length > 0 && (
                      <div className="mt-3 space-y-2">
                        <p className="text-[10px] uppercase tracking-wider text-slate-500">Quotes / Notes</p>
                        {quotes.map((block, i) => (
                          <button
                            key={i}
                            type="button"
                            onClick={() => pushToMonitor(latestSection.title, block.text)}
                            className="flex min-h-12 w-full items-start justify-between gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-left text-sm font-medium italic text-amber-100 active:bg-amber-500/20"
                          >
                            <span className="line-clamp-2 leading-snug">{block.text}</span>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="mt-0.5 h-4 w-4 shrink-0 text-amber-300"><path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/><path d="M2 12a9 9 0 0 1 8 8"/><path d="M2 16a5 5 0 0 1 4 4"/><circle cx="3" cy="20" r="1"/></svg>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}

              <div className="rounded-2xl border border-slate-700 bg-slate-950/80 p-4">
                <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-slate-500">Controls</p>
                <div className="mt-3 space-y-2 text-sm text-slate-300">
                  <p>Swipe left/right to change sections.</p>
                  <p>Keyboard: Left/Right arrows or Page Up/Page Down.</p>
                  <p>Press Escape to exit.</p>
                </div>
              </div>
            </aside>
          </div>

          {/* ── Mobile: Cast to monitor strip (scriptures in current section) ─── */}
          {(() => {
            const sectionText = latestSection.blocks.map((b) => b.text).join(" ");
            const refs = extractScriptureRefs(sectionText);
            const quotes = latestSection.blocks.filter((b) => b.kind === "quote");
            if (refs.length === 0 && quotes.length === 0) return null;
            return (
              <div className="shrink-0 border-t border-violet-500/20 bg-violet-950/30 px-4 py-2 lg:hidden">
                <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-violet-300">Cast to Monitor</p>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {refs.map((ref) => (
                    <button
                      key={ref}
                      type="button"
                      onClick={() => castReferenceFromPulpit(ref)}
                      style={{ touchAction: "manipulation" }}
                      className="flex min-h-14 shrink-0 items-center gap-1.5 rounded-xl border border-violet-500/50 bg-violet-500/15 px-3 py-3 text-sm font-bold text-violet-200 active:bg-violet-500/30"
                    >
                      {ref}
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3.5 w-3.5 text-violet-300"><path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/><path d="M2 12a9 9 0 0 1 8 8"/><path d="M2 16a5 5 0 0 1 4 4"/><circle cx="3" cy="20" r="1"/></svg>
                    </button>
                  ))}
                  {quotes.map((block, i) => (
                    <button
                      key={`q-${i}`}
                      type="button"
                      onClick={() => pushToMonitor(latestSection.title, block.text)}
                      className="flex min-h-12 shrink-0 items-center gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 text-sm font-medium italic text-amber-100 active:bg-amber-500/20"
                    >
                      <span className="max-w-[160px] truncate">{block.text}</span>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3.5 w-3.5 shrink-0 text-amber-300"><path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/><path d="M2 12a9 9 0 0 1 8 8"/><path d="M2 16a5 5 0 0 1 4 4"/><circle cx="3" cy="20" r="1"/></svg>
                    </button>
                  ))}
                </div>
              </div>
            );
          })()}

          <div className="grid shrink-0 grid-cols-2 gap-3 border-t border-amber-400/30 p-4 pb-8 lg:pb-4">
            <button
              type="button"
              onClick={goPulpitPrev}
              disabled={pulpitIndex === 0}
              className="focus-ring min-h-12 rounded-xl border border-slate-600 px-4 text-lg font-bold text-slate-100 disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={goPulpitNext}
              disabled={pulpitIndex >= pulpitSections.length - 1}
              className="focus-ring min-h-12 rounded-xl border border-cyan-500/60 bg-cyan-500/15 px-4 text-lg font-bold text-cyan-200 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </>
  );
}
