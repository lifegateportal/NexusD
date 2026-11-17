"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { ChapterDraft } from "@/lib/schemas/ebook";
import {
  getAudioPins, addAudioPin, removeAudioPin,
} from "@/lib/reader-store";
import type { AudioPin } from "@/lib/reader-store";
import {
  useAudioPlayer,
  RATES,
  NARRATOR_PERSONAS,
  type Segment,
  type SegmentType,
  type AudioChapterMeta,
} from "@/lib/audio-player-context";

// Re-export types so existing imports in ReaderClient don't break
export type { Segment, SegmentType };

// AudioState is used by the UI render below
type AudioState = "idle" | "playing" | "paused";

// ── Scripture reference expansion ────────────────────────────────────────────
// Must run BEFORE all other sanitization so "John 3:16" is never handed to the
// TTS engine as a bare "3:16" time token (which browsers read as "3 hours
// 16 minutes").  Handles full names, common abbreviations, numbered books, and
// optional verse ranges (e.g. John 3:16-17 or Rom 8:1-2:5).

const BIBLE_BOOKS = [
  // Old Testament — full names
  "Genesis","Exodus","Leviticus","Numbers","Deuteronomy","Joshua","Judges","Ruth",
  "Samuel","Kings","Chronicles","Ezra","Nehemiah","Esther","Job","Psalms","Psalm",
  "Proverbs","Ecclesiastes","Isaiah","Jeremiah","Lamentations","Ezekiel","Daniel",
  "Hosea","Joel","Amos","Obadiah","Jonah","Micah","Nahum","Habakkuk","Zephaniah",
  "Haggai","Zechariah","Malachi",
  // New Testament — full names
  "Matthew","Mark","Luke","John","Acts","Romans","Corinthians","Galatians",
  "Ephesians","Philippians","Colossians","Thessalonians","Timothy","Titus",
  "Philemon","Hebrews","James","Peter","Jude","Revelation",
  // Old Testament — abbreviations
  "Gen","Exod","Exo","Ex","Lev","Num","Deut","Deu","Josh","Judg","Sam",
  "Kgs","Chr","Neh","Est","Psa","Ps","Prov","Pro","Eccl","Ecc","Song",
  "Isa","Jer","Lam","Ezek","Eze","Dan","Hos","Obad","Jon","Mic","Nah",
  "Hab","Zeph","Hag","Zech","Zec","Mal",
  // New Testament — abbreviations
  "Matt","Mt","Mk","Lk","Jn","Rom","Gal","Eph","Phil","Col","Thess",
  "Tim","Tit","Philem","Phlm","Heb","Jas","Rev",
].join("|");

// Matches: [1/2/3 ]BookName chapter:verse[-verse|-chapter:verse]
const SCRIPTURE_RE = new RegExp(
  `\\b((?:[123]\\s+)?(?:${BIBLE_BOOKS}))\\s+(\\d{1,3}):(\\d{1,3})(?:\\s*[-\u2013]\\s*(\\d{1,3}(?::\\d{1,3})?))?`,
  "gi",
);

function expandScripture(
  _: string,
  rawBook: string,
  ch: string,
  v1: string,
  end?: string,
): string {
  const book = rawBook
    .replace(/^1\s+/i, "First ")
    .replace(/^2\s+/i, "Second ")
    .replace(/^3\s+/i, "Third ");
  if (!end) return `${book} chapter ${ch} verse ${v1}`;
  if (end.includes(":")) {
    const [ch2, v2] = end.split(":");
    return `${book} chapter ${ch} verse ${v1} through chapter ${ch2} verse ${v2}`;
  }
  return `${book} chapter ${ch} verses ${v1} to ${end}`;
}

// ── 1. Text pre-processing — clean abbreviations, punctuation, noise ──────────

function sanitizeForSpeech(text: string): string {
  return text
    // Scripture references must come first — before any colon or number handling
    .replace(SCRIPTURE_RE, expandScripture as Parameters<typeof String.prototype.replace>[1])
    // common abbreviations → full words (prevents "e dot g dot" robot reading)
    .replace(/\be\.g\./gi,   "for example")
    .replace(/\bi\.e\./gi,   "that is")
    .replace(/\betc\./gi,    "and so on")
    .replace(/\bvs\./gi,     "versus")
    .replace(/\bDr\./g,      "Doctor")
    .replace(/\bMr\./g,      "Mister")
    .replace(/\bMrs\./g,     "Missus")
    .replace(/\bMs\./g,      "Miss")
    .replace(/\bProf\./g,    "Professor")
    .replace(/\bSt\./g,      "Saint")
    // em-dash → comma pause (natural breathing)
    .replace(/\s*—\s*/g,     ", ")
    // ellipsis → sentence pause
    .replace(/…/g,           ". ")
    .replace(/\.\.\./g,      ". ")
    // backtick code → plain text
    .replace(/`([^`]+)`/g,   "$1")
    // URLs → silence
    .replace(/https?:\/\/\S+/g, "")
    // numeric citations [1], [2], footnote refs
    .replace(/\[\d+\]/g,     "")
    .replace(/\[citation[^\]]*\]/gi, "")
    // page refs like (pg. 12) or (p. 3)
    .replace(/\(p(?:g)?\.?\s*\d+\)/gi, "")
    // strip remaining markdown bold/italic
    .replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g,     "$1")
    .replace(/\*([^*]+)\*/g,          "$1")
    // Normalize question marks → period so TTS doesn't apply rising pitch
    // inflection. A narrator reads rhetorical and genuine questions with an
    // even, measured tone — the exaggerated upswing sounds robotic.
    .replace(/\?+/g, ".")
    .trim();
}

// ── 2. Sentence-level splitting — each sentence = one utterance ───────────────
//    Resets charIndex per sentence → more accurate word-boundary tracking.

function splitSentences(text: string): string[] {
  // Split after . ! ? when followed by whitespace + capital letter or quote
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z"'\u201C\u2018])/);
  return parts.map(s => s.trim()).filter(Boolean);
}

// ── Parse chapter into typed segments ─────────────────────────────────────────
// Also exported so ReaderClient can build a paraKey→segIdx map for click-to-start.

// ── Emphasis detection ───────────────────────────────────────────────────────
// Splits raw markdown text into alternating normal / emphasis spans BEFORE
// markdown is stripped.  Emphasis sources:
//   • ***bold-italic*** / **bold** / *italic*
//   • ALL-CAPS runs of 3+ characters (e.g. "GOD", "LOVE", "THE TRUTH")
// Returns an array of { text, emph } objects.  The caller creates "emphasis"
// segments for emph=true spans so the TTS engine pitches them higher.

// Only markdown markers are detected — no ALL-CAPS heuristic.
const EMPH_RE = /(\*{1,3}[^*\n]+?\*{1,3})/g;

function splitEmphasis(raw: string): { text: string; emph: boolean }[] {
  const parts: { text: string; emph: boolean }[] = [];
  let last = 0;
  for (const m of raw.matchAll(EMPH_RE)) {
    if (m.index! > last) parts.push({ text: raw.slice(last, m.index!), emph: false });
    // Strip surrounding asterisks to get the plain text
    const text = m[1].replace(/^\*{1,3}/, "").replace(/\*{1,3}$/, "");
    if (text.trim()) parts.push({ text, emph: true });
    last = m.index! + m[0].length;
  }
  if (last < raw.length) parts.push({ text: raw.slice(last), emph: false });
  return parts.filter((p) => p.text.trim().length > 0);
}

function estimateSegmentDuration(segment: Segment): number {
  const words = segment.text.split(/\s+/).filter(Boolean).length;
  const chars = segment.text.length;
  const commas = (segment.text.match(/,/g) ?? []).length;
  const semicolons = (segment.text.match(/[;:]/g) ?? []).length;
  const clauses = (segment.text.match(/[.!?]/g) ?? []).length;

  let seconds = Math.max(0.55, words * 0.28 + chars * 0.004);

  if (segment.type === "chapter-title") seconds *= 1.9;
  else if (segment.type === "heading") seconds *= 1.35;
  else if (segment.type === "quote") seconds *= 1.12;
  else if (segment.type === "emphasis") seconds *= 1.05;

  seconds += commas * 0.18 + semicolons * 0.24 + clauses * 0.12;
  if (words <= 4) seconds += 0.12;
  if (words >= 25) seconds += 0.4;

  return Math.max(0.45, seconds);
}

function buildRecordedTimeline(segments: Segment[], duration: number): Array<{
  start: number;
  end: number;
  paraKey: string;
  startWord: number;
  wordCount: number;
}> {
  if (!segments.length || !Number.isFinite(duration) || duration <= 0) return [];

  const estimated = segments.map((segment) => estimateSegmentDuration(segment));
  const totalEstimated = estimated.reduce((sum, value) => sum + value, 0) || 1;
  const scale = duration / totalEstimated;

  let cursor = 0;
  const wordOffsets = new Map<string, number>();
  return segments.map((segment, index) => {
    const segmentDuration = Math.max(0.45, estimated[index] * scale);
    const wordCount = segment.text.split(/\s+/).filter(Boolean).length;
    const startWord = wordOffsets.get(segment.paraKey) ?? 0;
    const entry = {
      start: cursor,
      end: cursor + segmentDuration,
      paraKey: segment.paraKey,
      startWord,
      wordCount,
    };
    cursor = entry.end;
    wordOffsets.set(segment.paraKey, startWord + wordCount);
    return entry;
  }).map((entry, index, timeline) => {
    if (index === timeline.length - 1) {
      return { ...entry, end: duration };
    }
    return entry;
  });
}

export function parseChapter(chapter: ChapterDraft): Segment[] {
  const segs: Segment[] = [];

  const stripMd = (s: string) =>
    s.replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
     .replace(/\*\*([^*]+)\*\*/g, "$1")
     .replace(/\*([^*]+)\*/g, "$1")
     .trim();

  const pushSentences = (type: SegmentType, raw: string, paraKey: string) => {
    if (type === "heading" || type === "chapter-title") {
      const clean = sanitizeForSpeech(stripMd(raw));
      if (clean) segs.push({ type, text: clean, paraKey });
      return;
    }
    // Split on emphasis markers/ALL-CAPS before stripping markdown so the
    // prosody treatment is preserved per span.
    const parts = splitEmphasis(raw);
    for (const { text, emph } of parts) {
      const clean = sanitizeForSpeech(stripMd(text));
      if (!clean.trim()) continue;
      const segType: SegmentType = emph ? "emphasis" : type;
      for (const sentence of splitSentences(clean)) {
        if (sentence.trim()) segs.push({ type: segType, text: sentence.trim(), paraKey });
      }
    }
  };

  // Mirrors the block-grouping logic in renderBody so paraKeys align between
  // AudioReader segments and data-pkey attributes on rendered DOM elements.
  const processBody = (text: string, prefix: string) => {
    const lines = text.split("\n");
    let blockIdx = 0;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      if (!line || /^---+$/.test(line)) { i++; continue; }
      const key = `${prefix}_b${blockIdx}`;
      if (/^#{1,3} /.test(line)) {
        pushSentences("heading", line.replace(/^#{1,3} /, ""), key);
        blockIdx++; i++; continue;
      }
      if (/^> /.test(line)) {
        // Group consecutive quote lines — same key, matching renderBody's <blockquote>
        while (i < lines.length && /^> /.test(lines[i].trim())) {
          pushSentences("quote", lines[i].trim().slice(2), key);
          i++;
        }
        blockIdx++; continue;
      }
      if (/^[*-] /.test(line)) {
        while (i < lines.length && /^[*-] /.test(lines[i].trim())) {
          pushSentences("body", lines[i].trim().slice(2), key);
          i++;
        }
        blockIdx++; continue;
      }
      if (/^\d+\. /.test(line)) {
        while (i < lines.length && /^\d+\. /.test(lines[i].trim())) {
          pushSentences("body", lines[i].trim().replace(/^\d+\. /, ""), key);
          i++;
        }
        blockIdx++; continue;
      }
      pushSentences("body", line, key);
      blockIdx++; i++;
    }
  };

  const chapterLead = chapter.number > 0
    ? `Chapter ${chapter.number}. ${chapter.title}.`
    : `${chapter.title}.`;
  pushSentences("chapter-title", chapterLead, "title");
  if (chapter.epigraph)      pushSentences("quote", chapter.epigraph, "epigraph");
  if (chapter.intro)         processBody(chapter.intro, "intro");

  for (let si = 0; si < chapter.sections.length; si++) {
    const section = chapter.sections[si];
    // Mirror ReaderClient: the first section heading is intentionally hidden
    // in the UI, so it should not be narrated as an apparent "extra subtitle".
    if (section.heading && si > 0) pushSentences("heading", section.heading, `s${si}_h`);
    processBody(section.body, `s${si}`);
  }
  if (chapter.forwardQuestion) pushSentences("body", chapter.forwardQuestion, "fwd");

  return segs.filter(s => s.text.length > 0);
}

// ── 5. Voice selection — prefers enhanced/neural voices ──────────────────────

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  chapter:    ChapterDraft;
  /** Book-level metadata forwarded to the global audio context. */
  bookTitle:  string;
  /** Absolute pathname back to this reader, e.g. /library/my-book/read */
  readerHref: string;
  /** Book slug — used to persist audio pins. */
  slug:       string;
  /** Generated chapter narration URL from Voice Studio local storage. */
  chapterAudioUrl?: string | null;
  /** External seek request for recorded audio (segment + word offset). */
  recordedSeekRequest?: { token: number; segIdx: number; wordIdx: number } | null;
  /** Emits active paragraph key while recorded audio plays. */
  onRecordedParaKeyChange?: (paraKey: string | null) => void;
  /** Emits the approximate active word position while recorded audio plays. */
  onRecordedWordPositionChange?: (position: { paraKey: string; wordIndex: number } | null) => void;
  theme: {
    muted:        string;
    accent:       string;
    chrome:       string;
    chromeBorder: string;
    text:         string;
    border:       string;
    bg:           string;
  };
  fontFamily: string;
  onClose:     () => void;
  /** Jump to this segment index (e.g. from a tap-to-start paragraph click). */
  startFrom?:  number;
}

export function AudioReader({
  chapter, bookTitle, readerHref, slug, chapterAudioUrl, recordedSeekRequest, onRecordedParaKeyChange, onRecordedWordPositionChange, theme, fontFamily,
  onClose, startFrom,
}: Props) {
  const {
    state, currentSeg, segIdx, segTotal,
    rateIdx, setChapter, play, pause, resume, stop, cycleRate, seekTo,
    setVolumeMultiplier, setPersona,
  } = useAudioPlayer();

  const prevStartFrom = useRef<number | undefined>(undefined);
  const recordedAudioRef = useRef<HTMLAudioElement | null>(null);
  const recordedTimelineRef = useRef<Array<{
    start: number;
    end: number;
    paraKey: string;
    startWord: number;
    wordCount: number;
  }>>([]);
  const [recordedPlaying, setRecordedPlaying] = useState(false);

  const hasRecordedAudio = Boolean(chapterAudioUrl);

  useEffect(() => {
    if (!hasRecordedAudio) return;
    const audioEl = recordedAudioRef.current;
    if (!audioEl) return;
    const syncPlaybackState = () => setRecordedPlaying(!audioEl.paused && !audioEl.ended);
    audioEl.addEventListener("play", syncPlaybackState);
    audioEl.addEventListener("pause", syncPlaybackState);
    audioEl.addEventListener("ended", syncPlaybackState);
    syncPlaybackState();
    return () => {
      audioEl.removeEventListener("play", syncPlaybackState);
      audioEl.removeEventListener("pause", syncPlaybackState);
      audioEl.removeEventListener("ended", syncPlaybackState);
    };
  }, [hasRecordedAudio, chapterAudioUrl]);

  // ── Narrator persona — persisted to localStorage ─────────────────────────
  // localPersonaIdx drives the UI; a useEffect syncs it into the engine.
  const [localPersonaIdx, setLocalPersonaIdx] = useState<number>(() => {
    if (typeof window === "undefined") return 0;
    const v = parseInt(localStorage.getItem("nd_narrator_persona") ?? "0", 10);
    return isNaN(v) ? 0 : Math.max(0, Math.min(NARRATOR_PERSONAS.length - 1, v));
  });

  // Sync to engine whenever the local value changes (includes initial mount)
  useEffect(() => {
    setPersona(localPersonaIdx);
  }, [localPersonaIdx, setPersona]);

  const handleCyclePersona = useCallback(() => {
    const next = (localPersonaIdx + 1) % NARRATOR_PERSONAS.length;
    setLocalPersonaIdx(next);
    localStorage.setItem("nd_narrator_persona", String(next));
  }, [localPersonaIdx]);

  // ── Sleep timer ────────────────────────────────────────────────────────
  const SLEEP_OPTIONS = [0, 10, 20, 30, 60] as const;
  type SleepMins = typeof SLEEP_OPTIONS[number];

  const [sleepMins,     setSleepMins]     = useState<SleepMins>(0);
  const [sleepSecsLeft, setSleepSecsLeft] = useState(0);
  const sleepIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cycle through sleep options
  const cycleSleep = useCallback(() => {
    setSleepMins((prev) => {
      const idx = SLEEP_OPTIONS.indexOf(prev);
      const next = SLEEP_OPTIONS[(idx + 1) % SLEEP_OPTIONS.length];
      if (next === 0) {
        setSleepSecsLeft(0);
        setVolumeMultiplier(1);
      } else {
        setSleepSecsLeft(next * 60);
      }
      return next;
    });
  }, [setVolumeMultiplier]);

  // Countdown tick
  useEffect(() => {
    if (sleepMins === 0) {
      if (sleepIntervalRef.current) { clearInterval(sleepIntervalRef.current); sleepIntervalRef.current = null; }
      return;
    }
    sleepIntervalRef.current = setInterval(() => {
      setSleepSecsLeft((prev) => {
        const next = prev - 1;
        if (next <= 0) {
          pause();
          setVolumeMultiplier(1);
          setSleepMins(0);
          return 0;
        }
        // Fade volume in last 90 seconds
        setVolumeMultiplier(next <= 90 ? next / 90 : 1);
        return next;
      });
    }, 1000);
    return () => { if (sleepIntervalRef.current) clearInterval(sleepIntervalRef.current); };
  // Only re-run when sleepMins changes (not on every re-render)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sleepMins]);

  // Sleep timer display label
  const sleepFading = sleepMins > 0 && sleepSecsLeft <= 90;
  const sleepLabel = sleepMins === 0
    ? null
    : sleepFading
      ? `${sleepSecsLeft}s`
      : `${Math.ceil(sleepSecsLeft / 60)}m`;

  // ── Audio pins ────────────────────────────────────────────────────────
  const chapterKey = `${slug}-ch-${chapter.number}`;

  const [pins, setPins] = useState<AudioPin[]>([]);

  // Load pins for this chapter
  useEffect(() => {
    setPins(getAudioPins(slug, chapterKey));
  }, [slug, chapterKey]);

  const isPinnedHere = pins.some((p) => p.segIdx === segIdx);

  const togglePin = useCallback(() => {
    const existing = pins.find((p) => p.segIdx === segIdx);
    if (existing) {
      removeAudioPin(slug, chapterKey, existing.id);
    } else {
      addAudioPin(slug, chapterKey, {
        id: crypto.randomUUID(),
        segIdx,
        label: currentSeg?.text?.slice(0, 60) ?? `Segment ${segIdx + 1}`,
        addedAt: new Date().toISOString(),
      });
    }
    setPins(getAudioPins(slug, chapterKey));
  }, [slug, chapterKey, segIdx, pins, currentSeg]);

  // Register chapter with the global engine when chapter changes
  useEffect(() => {
    if (hasRecordedAudio) return;
    const segs: Segment[] = parseChapter(chapter);
    const meta: AudioChapterMeta = {
      chapterKey: `${slug}-ch-${chapter.number}`,
      title:      chapter.title,
      number:     chapter.number,
      bookTitle,
      readerHref,
    };
    setChapter(segs, meta);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter, bookTitle, readerHref, slug, hasRecordedAudio]);

  // Jump to a specific segment when startFrom prop changes
  useEffect(() => {
    if (hasRecordedAudio) return;
    if (startFrom === undefined) return;
    if (startFrom === prevStartFrom.current) return;
    prevStartFrom.current = startFrom;
    seekTo(startFrom);
  }, [startFrom, seekTo, hasRecordedAudio]);

  useEffect(() => {
    if (!hasRecordedAudio) {
      recordedTimelineRef.current = [];
      onRecordedParaKeyChange?.(null);
      onRecordedWordPositionChange?.(null);
      return;
    }
    const audioEl = recordedAudioRef.current;
    if (!audioEl) return;
    audioEl.muted = false;
    audioEl.volume = 1;

    const syncTimeline = () => {
      const segs = parseChapter(chapter);
      recordedTimelineRef.current = buildRecordedTimeline(segs, audioEl.duration || 0);
    };

    audioEl.addEventListener("loadedmetadata", syncTimeline);
    if (audioEl.readyState >= 1) syncTimeline();
    return () => audioEl.removeEventListener("loadedmetadata", syncTimeline);
  }, [chapter, hasRecordedAudio, chapterAudioUrl, onRecordedParaKeyChange, onRecordedWordPositionChange]);

  useEffect(() => {
    if (!hasRecordedAudio) return;
    const audioEl = recordedAudioRef.current;
    if (!audioEl) return;

    const emitCurrentPara = () => {
      const timeline = recordedTimelineRef.current;
      if (!timeline.length) {
        onRecordedParaKeyChange?.(null);
        onRecordedWordPositionChange?.(null);
        return;
      }
      const t = audioEl.currentTime;
      const active = timeline.find((entry) => t >= entry.start && t < entry.end)
        ?? timeline[timeline.length - 1];
      onRecordedParaKeyChange?.(active?.paraKey ?? null);
      if (active) {
        const progress = Math.max(0, Math.min(1, (t - active.start) / Math.max(0.001, active.end - active.start)));
        const localWord = Math.min(active.wordCount - 1, Math.floor(progress * active.wordCount));
        onRecordedWordPositionChange?.({
          paraKey: active.paraKey,
          wordIndex: active.startWord + Math.max(0, localWord),
        });
      } else {
        onRecordedWordPositionChange?.(null);
      }
    };

    const clearPara = () => {
      onRecordedParaKeyChange?.(null);
      onRecordedWordPositionChange?.(null);
    };

    audioEl.addEventListener("timeupdate", emitCurrentPara);
    audioEl.addEventListener("seeked", emitCurrentPara);
    audioEl.addEventListener("play", emitCurrentPara);
    audioEl.addEventListener("ended", clearPara);

    emitCurrentPara();
    return () => {
      audioEl.removeEventListener("timeupdate", emitCurrentPara);
      audioEl.removeEventListener("seeked", emitCurrentPara);
      audioEl.removeEventListener("play", emitCurrentPara);
      audioEl.removeEventListener("ended", clearPara);
    };
  }, [hasRecordedAudio, onRecordedParaKeyChange, onRecordedWordPositionChange]);

  useEffect(() => {
    if (!hasRecordedAudio || !recordedSeekRequest) return;
    const audioEl = recordedAudioRef.current;
    const timeline = recordedTimelineRef.current;
    if (!audioEl || !timeline.length) return;

    const segmentWindow = timeline[recordedSeekRequest.segIdx];
    if (!segmentWindow) return;

    const segs = parseChapter(chapter);
    const tappedSeg = segs[recordedSeekRequest.segIdx];
    const words = tappedSeg?.text.split(/\s+/).filter(Boolean).length ?? 0;
    const ratio = words > 0 ? Math.min(1, Math.max(0, recordedSeekRequest.wordIdx / words)) : 0;
    const seekSeconds = segmentWindow.start + (segmentWindow.end - segmentWindow.start) * ratio;
    audioEl.currentTime = Math.max(0, seekSeconds);
    void audioEl.play().catch(() => {});
  }, [chapter, hasRecordedAudio, recordedSeekRequest]);

  const togglePlay = () => {
    if (hasRecordedAudio) {
      const audioEl = recordedAudioRef.current;
      if (!audioEl) return;
      if (audioEl.paused) {
        void audioEl.play().catch(() => {});
      } else {
        audioEl.pause();
      }
      return;
    }
    if (!window.speechSynthesis) return;
    if      (state === "idle")    play();
    else if (state === "playing") pause();
    else if (state === "paused")  resume();
  };

  return (
    <div style={{ flexShrink: 0 }}>
      {chapterAudioUrl && (
        <>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio
            ref={recordedAudioRef}
            src={chapterAudioUrl}
            preload="metadata"
            style={{ display: "none" }}
          />
        </>
      )}

      {hasRecordedAudio ? (
        <div style={{
          display: "flex", alignItems: "center", gap: "0.35rem",
          padding: "0 0.85rem 0 1.25rem",
          height: "3.5rem",
          background: theme.chrome,
          borderTop: `1px solid ${theme.chromeBorder}`,
          backdropFilter: "blur(28px)", WebkitBackdropFilter: "blur(28px)",
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{
              margin: 0, lineHeight: 1.25,
              fontSize: "0.72rem", fontFamily, fontWeight: 500,
              color: theme.text,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              Chapter {chapter.number}
            </p>
            <p style={{ margin: "0.12rem 0 0", lineHeight: 1.25, fontSize: "0.62rem", fontFamily, color: theme.muted }}>
              Recorded narration
            </p>
          </div>

          <button onClick={togglePlay} aria-label={recordedPlaying ? "Pause recorded narration" : "Play recorded narration"} style={{
            width: "2.5rem", height: "2.5rem", borderRadius: "50%",
            background: theme.accent,
            boxShadow: `0 2px 8px ${theme.accent}3a`,
            border: "none", cursor: "pointer",
            color: "#fff",
            display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0,
          }}>
            <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: "0.85rem", height: "0.85rem" }}>
              {recordedPlaying
                ? <><rect x="6" y="5" width="4" height="14" rx="1.5" /><rect x="14" y="5" width="4" height="14" rx="1.5" /></>
                : <path d="M8 5.14v14l11-7-11-7z" />}
            </svg>
          </button>

          <button onClick={onClose} aria-label="Close audio player bar" style={{
            width: "2.25rem", height: "2.25rem",
            background: "none", border: "none",
            borderRadius: "50%", cursor: "pointer",
            color: theme.muted,
            display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0,
          }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25}
              style={{ width: "0.85rem", height: "0.85rem" }}>
              <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      ) : (
      <>

      {/* ── Chapter progress bar + pin markers ── */}
      <div style={{ position: "relative", height: "4px", background: `${theme.accent}18` }}>
        {/* Fill bar */}
        <div style={{
          position: "absolute", top: 0, left: 0, height: "100%",
          width: segTotal > 0
            ? `${Math.round((segIdx / segTotal) * 100)}%`
            : "0%",
          background: `linear-gradient(to right, ${theme.accent}bb, ${theme.accent})`,
          transition: "width 0.5s ease",
        }} />
        {/* Pin markers — clickable amber diamonds */}
        {segTotal > 0 && pins.map((pin) => (
          <button
            key={pin.id}
            onClick={() => seekTo(pin.segIdx)}
            title={pin.label}
            aria-label={`Jump to: ${pin.label}`}
            style={{
              position: "absolute", top: "50%", transform: "translate(-50%, -50%) rotate(45deg)",
              left: `${Math.round((pin.segIdx / segTotal) * 100)}%`,
              width: 8, height: 8,
              background: "#f59e0b",
              border: "none", cursor: "pointer",
              borderRadius: "1px",
              zIndex: 2,
            }}
          />
        ))}
      </div>

      {/* ── Controls bar ── */}
      <div style={{
        display: "flex", alignItems: "center", gap: "0.35rem",
        padding: "0 0.85rem 0 1.25rem",
        height: "3.5rem",
        background: theme.chrome,
        borderTop: `1px solid ${theme.chromeBorder}`,
        backdropFilter: "blur(28px)", WebkitBackdropFilter: "blur(28px)",
      }}>

        {/* Track info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{
            margin: 0, lineHeight: 1.25,
            fontSize: "0.72rem", fontFamily, fontWeight: 500,
            color: theme.text,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            Chapter {chapter.number}
          </p>
          <p style={{ margin: "0.12rem 0 0", lineHeight: 1.25, fontSize: "0.62rem", fontFamily, color: theme.muted }}>
            {state === "playing" ? "Now reading…"
              : state === "paused" ? "Paused"
              : chapter.title}
          </p>
        </div>

        {/* Speed pill */}
        <button onClick={cycleRate} aria-label="Change speed" style={{
          fontSize: "0.68rem", fontFamily, fontWeight: 700,
          color: theme.accent,
          background: `${theme.accent}14`,
          border: `1px solid ${theme.accent}3a`,
          borderRadius: "999px", padding: "0.22rem 0.7rem",
          cursor: "pointer", minHeight: "2rem",
          transition: "background 0.15s ease",
          flexShrink: 0,
        }}>
          {RATES[rateIdx]}×
        </button>

        {/* Narrator persona — cycles Balanced → Storyteller → Preacher → Podcast */}
        <button
          onClick={handleCyclePersona}
          aria-label={`Narrator style: ${NARRATOR_PERSONAS[localPersonaIdx].name}`}
          title={NARRATOR_PERSONAS[localPersonaIdx].name}
          style={{
            position: "relative",
            width: "2.25rem", height: "2.25rem",
            background: localPersonaIdx > 0 ? `${theme.accent}18` : "none",
            border: `1px solid ${localPersonaIdx > 0 ? theme.accent : theme.border}`,
            borderRadius: "50%", cursor: "pointer",
            color: localPersonaIdx > 0 ? theme.accent : theme.muted,
            display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0,
            transition: "border-color 0.2s, background 0.2s, color 0.2s",
          }}
        >
          {/* Microphone icon */}
          <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: "0.8rem", height: "0.8rem" }}>
            <path d="M12 1a4 4 0 0 1 4 4v6a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4zm7 10a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V20H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.08A7 7 0 0 0 19 11z" />
          </svg>
          {/* Persona indicator dot — hidden when on default Balanced */}
          {localPersonaIdx > 0 && (
            <span style={{
              position: "absolute", top: 3, right: 3,
              width: 5, height: 5, borderRadius: "50%",
              background: theme.accent,
              pointerEvents: "none",
            }} />
          )}
        </button>

        {/* Sleep timer — moon button */}
        <button
          onClick={cycleSleep}
          aria-label={sleepMins === 0 ? "Set sleep timer" : `Sleep timer: ${sleepLabel}`}
          title={sleepMins === 0 ? "Sleep timer off" : `Sleep in ${sleepLabel}`}
          style={{
            minWidth: "2.25rem", height: "2.25rem",
            paddingInline: sleepLabel ? "0.5rem" : undefined,
            background: "none",
            border: `1px solid ${sleepMins > 0 ? (sleepFading ? "#f59e0b" : theme.accent) : theme.border}`,
            borderRadius: "999px", cursor: "pointer",
            color: sleepMins > 0 ? (sleepFading ? "#f59e0b" : theme.accent) : theme.muted,
            display: "flex", alignItems: "center", justifyContent: "center", gap: "0.2rem",
            fontSize: "0.65rem", fontFamily, fontWeight: 600,
            flexShrink: 0,
            transition: "border-color 0.2s, color 0.2s",
          }}
        >
          {/* Moon icon */}
          <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: "0.8rem", height: "0.8rem", flexShrink: 0 }}>
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
          {sleepLabel && <span>{sleepLabel}</span>}
        </button>

        {/* Pin / bookmark current position */}
        <button
          onClick={togglePin}
          aria-label={isPinnedHere ? "Remove audio pin" : "Pin current position"}
          title={isPinnedHere ? "Remove pin" : "Pin position"}
          style={{
            width: "2.25rem", height: "2.25rem",
            background: isPinnedHere ? `${theme.accent}20` : "none",
            border: `1px solid ${isPinnedHere ? theme.accent : theme.border}`,
            borderRadius: "50%", cursor: "pointer",
            color: isPinnedHere ? theme.accent : theme.muted,
            display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0,
            transition: "border-color 0.15s, background 0.15s, color 0.15s",
          }}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: "0.8rem", height: "0.8rem" }}>
            <path d="M17 4a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7.382l-1 .5V14h5v6l1 1 1-1v-6h5v-2.118l-1-.5V4z" />
          </svg>
        </button>

        {/* Stop */}
        {state !== "idle" && (
          <button onClick={stop} aria-label="Stop" style={{
            width: "2.25rem", height: "2.25rem",
            background: "none",
            border: `1px solid ${theme.border}`,
            borderRadius: "50%", cursor: "pointer",
            color: theme.muted,
            display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0,
            transition: "border-color 0.15s ease",
          }}>
            <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: "0.75rem", height: "0.75rem" }}>
              <rect x="5" y="5" width="14" height="14" rx="3" />
            </svg>
          </button>
        )}

        {/* Play / Pause */}
        <button onClick={togglePlay} aria-label={state === "playing" ? "Pause" : "Play"} style={{
          width: "2.5rem", height: "2.5rem", borderRadius: "50%",
          background: theme.accent,
          boxShadow: state === "playing"
            ? `0 0 0 4px ${theme.accent}28, 0 2px 10px ${theme.accent}50`
            : `0 2px 8px ${theme.accent}3a`,
          border: "none", cursor: "pointer",
          color: "#fff",
          display: "flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0,
          transition: "box-shadow 0.25s ease",
        }}>
          {state === "playing" ? (
            <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: "0.85rem", height: "0.85rem" }}>
              <rect x="6" y="5" width="4" height="14" rx="1.5" />
              <rect x="14" y="5" width="4" height="14" rx="1.5" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: "0.85rem", height: "0.85rem" }}>
              <path d="M8 5.14v14l11-7-11-7z" />
            </svg>
          )}
        </button>

        {/* Close — hides bar only; audio continues in GlobalMiniPlayer */}
        <button onClick={onClose} aria-label="Close audio player bar" style={{
          width: "2.25rem", height: "2.25rem",
          background: "none", border: "none",
          borderRadius: "50%", cursor: "pointer",
          color: theme.muted,
          display: "flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0,
        }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25}
            style={{ width: "0.85rem", height: "0.85rem" }}>
            <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      </>
      )}
    </div>
  );
}
