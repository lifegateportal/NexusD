"use client";

import { Fragment, useState, useEffect, useRef, useCallback, useMemo } from "react";
import Link from "next/link";
import type { EbookManifest, ChapterDraft } from "@/lib/schemas/ebook";
import type { BackMatter } from "@/lib/schemas/ebook";
import {
  getReadingPosition,
  saveReadingPosition,
  getReaderSettings,
  saveReaderSettings,
  getBookmarks,
  addBookmark,
  removeBookmark,
} from "@/lib/reader-store";
import type { ReaderSettings, ReaderBookmark } from "@/lib/reader-store";
import { ChapterDrawer } from "./ChapterDrawer";
import type { TocItem } from "./ChapterDrawer";
import { ReaderSettingsPanel } from "./ReaderSettings";
import { ProgressBar } from "./ProgressBar";
import { AudioReader, parseChapter } from "./AudioReader";
import { AnnotationsPanel, saveAnnotation, loadAnnotations, ANNO_COLOR_MAP } from "./AnnotationsPanel";
import type { AnnotationColor, Annotation } from "./AnnotationsPanel";
import { useAudioPlayer } from "@/lib/audio-player-context";

// ── Reader theme palette ──────────────────────────────────────────────────────

const THEMES = {
  night: {
    bg:           "#1c1510",
    text:         "#e8dcc8",
    heading:      "#f5efe4",
    muted:        "#8a7d6e",
    accent:       "#c4933a",
    border:       "#2e2620",
    scriptureBar: "#c4933a",
    chrome:       "rgba(20,15,10,0.94)",
    chromeBorder: "rgba(255,255,255,0.07)",
  },
  parchment: {
    bg:           "#f4e9d0",
    text:         "#2c1a0e",
    heading:      "#160c04",
    muted:        "#7a5c3a",
    accent:       "#8b5e1a",
    border:       "#d9c8a8",
    scriptureBar: "#8b5e1a",
    chrome:       "rgba(239,228,204,0.96)",
    chromeBorder: "rgba(0,0,0,0.09)",
  },
  paper: {
    bg:           "#fafafa",
    text:         "#1a1a1a",
    heading:      "#0d0d0d",
    muted:        "#6b6b6b",
    accent:       "#333333",
    border:       "#e0e0e0",
    scriptureBar: "#555555",
    chrome:       "rgba(250,250,250,0.96)",
    chromeBorder: "rgba(0,0,0,0.09)",
  },
} as const;

type Theme = typeof THEMES[keyof typeof THEMES];

const FONT_SIZES   = [15, 16, 18, 20, 22] as const;
const LINE_HEIGHTS = [1.65, 1.85, 2.05] as const;
const FONT_FAMILIES = {
  serif: "Georgia, 'Times New Roman', Times, serif",
  sans:  "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
} as const;

const CHROME_H = "3.25rem";
const VOICE_STUDIO_STORAGE_PREFIX = "nexus_voice_studio_";

type WordTapHandler = (wordIndex: number) => void;

function renderWordSpans(
  text: string,
  renderWord: (word: string, wordIndex: number) => React.ReactNode,
): React.ReactNode[] {
  const tokens = text.split(/(\s+)/);
  let wordIndex = 0;
  return tokens.map((token, i) => {
    if (/^\s+$/.test(token) || token.length === 0) return <span key={i}>{token}</span>;
    const rendered = renderWord(token, wordIndex);
    wordIndex += 1;
    return <Fragment key={i}>{rendered}</Fragment>;
  });
}

// ── Bionic reading — bold fixation-point prefix of each word ─────────────────
// The first ~45% of each word is bolded; the rest rendered at normal weight.
// This guides the eye to the fixation point and increases reading speed.

function BionicText({ text, onWordTap }: { text: string; onWordTap?: WordTapHandler }) {
  return (
    <>
      {renderWordSpans(text, (tok, wordIndex) => {
        const clean = tok.replace(/\*+/g, "");
        const boldLen = Math.max(1, Math.ceil(clean.length * 0.45));
        return (
            <span
              onClick={onWordTap ? (e) => { e.stopPropagation(); onWordTap(wordIndex); } : undefined}
              data-word-index={onWordTap ? wordIndex : undefined}
              style={{ cursor: onWordTap ? "pointer" : undefined, touchAction: "manipulation" }}
            >
            <strong style={{ fontWeight: 750 }}>{clean.slice(0, boldLen)}</strong>
            <span style={{ fontWeight: 400, opacity: 0.8 }}>{clean.slice(boldLen)}</span>
          </span>
        );
      })}
    </>
  );
}

// ── Inline markdown renderer ──────────────────────────────────────────────────

// Detects a Bible reference at the start of a paragraph line, e.g.:
// "Colossians 1:12–14 puts it this way:", "1 Corinthians 13:4", "Psalm 23:1–6"
const BIBLE_REF_START = /^(?:\d\s+)?[A-Z][a-z]+(?:(?:\s+of\s+|\s+)[A-Z]?[a-z]+)?\s+\d+:\d+/;

function InlineText({ text, onWordTap }: { text: string; onWordTap?: WordTapHandler }) {
  const parts: { t: "text" | "bold" | "italic" | "bolditalic" | "strike"; v: string }[] = [];
  const re = /(\*\*\*([^*\n]+?)\*\*\*|\*\*([^*\n]+?)\*\*|\*([^*\n]+?)\*|~~([^~\n]+?)~~)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ t: "text", v: text.slice(last, m.index) });
    if      (m[0].startsWith("***")) parts.push({ t: "bolditalic", v: m[2] });
    else if (m[0].startsWith("**"))  parts.push({ t: "bold",       v: m[3] });
    else if (m[0].startsWith("~~"))  parts.push({ t: "strike",     v: m[5] });
    else                              parts.push({ t: "italic",     v: m[4] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ t: "text", v: text.slice(last) });

  return (
    <>
      {(() => {
        let wordOffset = 0;
        return parts.map((p, i) => {
          const textNodes = renderWordSpans(p.v, (word, wordIndex) => (
            <span
              onClick={onWordTap ? (e) => { e.stopPropagation(); onWordTap(wordOffset + wordIndex); } : undefined}
              data-word-index={onWordTap ? wordOffset + wordIndex : undefined}
              style={{ cursor: onWordTap ? "pointer" : undefined, touchAction: "manipulation" }}
            >
              {word}
            </span>
          ));
          const wordCount = p.v.split(/\s+/).filter(Boolean).length;
          const wrapped = p.t === "bolditalic" ? <strong key={i}><em>{textNodes}</em></strong> :
            p.t === "bold"       ? <strong key={i}>{textNodes}</strong> :
            p.t === "italic"     ? <em key={i}>{textNodes}</em> :
            p.t === "strike"     ? <s key={i}>{textNodes}</s> :
                                   <span key={i}>{textNodes}</span>;
          wordOffset += wordCount;
          return wrapped;
        });
      })()}
    </>
  );
}

// ── Annotation highlight renderer ───────────────────────────────────────────
// Matches annotation selectedText (plain) inside a raw markdown line,
// wraps matched spans in <mark> with the annotation colour.

function HighlightedLine({
  text,
  annotations,
  onWordTap,
}: {
  text: string;
  annotations: { selectedText: string; color: AnnotationColor }[];
  onWordTap?: WordTapHandler;
}) {
  // Derive plain text by stripping inline markdown
  const plain = text
    .replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1");

  type Range = { start: number; end: number; color: AnnotationColor };
  const ranges: Range[] = [];
  for (const anno of annotations) {
    if (!anno.selectedText || anno.selectedText.length < 3) continue;
    let idx = plain.indexOf(anno.selectedText);
    while (idx !== -1) {
      ranges.push({ start: idx, end: idx + anno.selectedText.length, color: anno.color });
      idx = plain.indexOf(anno.selectedText, idx + anno.selectedText.length);
    }
  }

  if (ranges.length === 0) return <InlineText text={text} onWordTap={onWordTap} />;

  // Sort and remove overlaps (keep first match's colour)
  ranges.sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start < last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const range of merged) {
    if (range.start > cursor) {
      nodes.push(<InlineText key={`t-${cursor}`} text={plain.slice(cursor, range.start)} onWordTap={onWordTap} />);
    }
    nodes.push(
      <mark
        key={`h-${range.start}`}
        style={{
          background: ANNO_COLOR_MAP[range.color].bg,
          color: "inherit",
          borderRadius: "0.15em",
          padding: "0.1em 0",
          boxDecorationBreak: "clone",
          WebkitBoxDecorationBreak: "clone",
        } as React.CSSProperties}
      >
        <InlineText text={plain.slice(range.start, range.end)} onWordTap={onWordTap} />
      </mark>,
    );
    cursor = range.end;
  }
  if (cursor < plain.length) {
    nodes.push(<InlineText key={`t-${cursor}`} text={plain.slice(cursor)} onWordTap={onWordTap} />);
  }
  return <>{nodes}</>;
}

function renderBody(
  text: string,
  theme: Theme,
  isFirstSection: boolean,
  annotations: { selectedText: string; color: AnnotationColor }[] = [],
  onWordTap?: WordTapHandler,
  paraKeyPrefix?: string,
  audioParaKey?: string | null,
  audioOpen?: boolean,
  bionicMode?: boolean,
): React.ReactNode[] {
  const lines = text.split("\n");
  const nodes: React.ReactNode[] = [];
  let i         = 0;
  let paraCount = 0;
  let blockIdx  = 0;

  const pkey  = () => paraKeyPrefix ? `${paraKeyPrefix}_b${blockIdx}` : undefined;
  const isAct = (k: string | undefined) => !!k && k === audioParaKey;
  const hlBg  = (k: string | undefined): React.CSSProperties => isAct(k)
    ? { background: `${theme.accent}1c`, borderRadius: "0.2rem", transition: "background 0.35s ease" }
    : { transition: "background 0.35s ease" };

  while (i < lines.length) {
    const raw  = lines[i];
    const line = raw.trim();
    if (!line) { i++; continue; }

    // Ornamental divider — no blockIdx increment (matches AudioReader processBody)
    if (/^---+$/.test(line)) {
      nodes.push(
        <div key={i} style={{ textAlign: "center", margin: "2.75em 0", color: theme.scriptureBar, letterSpacing: "0.5em", fontSize: "0.85em" }}>
          ✦ ✦ ✦
        </div>,
      );
      i++; continue;
    }

    // H1 / H2 / H3 — breakInside/breakAfter prevent orphaned headings at column boundary
    if (/^### /.test(line)) {
      const k = pkey();
      nodes.push(
        <h3 key={i} data-pkey={k} style={{ ...hlBg(k), color: theme.muted, fontSize: "0.68em", letterSpacing: "0.16em", textTransform: "uppercase" as const, marginTop: "2.5em", marginBottom: "0.5em", fontWeight: 700, breakInside: "avoid", breakAfter: "avoid", cursor: audioOpen ? "pointer" : undefined } as React.CSSProperties}>
          <InlineText text={line.slice(4)} onWordTap={onWordTap} />
        </h3>,
      );
      blockIdx++; i++; continue;
    }
    if (/^## /.test(line)) {
      const k = pkey();
      nodes.push(
        <h2 key={i} data-pkey={k} style={{ ...hlBg(k), color: theme.heading, fontSize: "1.15em", fontWeight: 700, marginTop: "2.5em", marginBottom: "0.85em", letterSpacing: "-0.01em", breakInside: "avoid", breakAfter: "avoid", cursor: audioOpen ? "pointer" : undefined } as React.CSSProperties}>
          <InlineText text={line.slice(3)} onWordTap={onWordTap} />
        </h2>,
      );
      blockIdx++; i++; continue;
    }
    if (/^# /.test(line)) {
      const k = pkey();
      nodes.push(
        <h2 key={i} data-pkey={k} style={{ ...hlBg(k), color: theme.heading, fontSize: "1.25em", fontWeight: 700, marginTop: "2.5em", marginBottom: "0.85em", breakInside: "avoid", breakAfter: "avoid", cursor: audioOpen ? "pointer" : undefined } as React.CSSProperties}>
          <InlineText text={line.slice(2)} onWordTap={onWordTap} />
        </h2>,
      );
      blockIdx++; i++; continue;
    }

    // Blockquote (scripture / pull quote)
    if (/^> /.test(line)) {
      const k = pkey();
      const qLines: string[] = [];
      while (i < lines.length && /^> /.test(lines[i].trim())) {
        qLines.push(lines[i].trim().slice(2));
        i++;
      }
      nodes.push(
        <blockquote
          key={`bq-${i}`}
          data-pkey={k}
          style={{
            ...hlBg(k),
            borderLeft:    `3px solid ${theme.scriptureBar}`,
            paddingLeft:   "1.25em",
            margin:        "2em 0",
            fontStyle:     "italic",
            color:         theme.muted,
            fontSize:      "0.97em",
            lineHeight:    1.75,
            breakInside:   "avoid",
            cursor:        audioOpen ? "pointer" : undefined,
          } as React.CSSProperties}
        >
          {qLines.map((ql, qi) => (
            <p key={qi} style={{ marginBottom: qi < qLines.length - 1 ? "0.4em" : 0 }}>
              <HighlightedLine text={ql} annotations={annotations} onWordTap={onWordTap} />
            </p>
          ))}
        </blockquote>,
      );
      blockIdx++; continue;
    }

    // Unordered list
    if (/^[*-] /.test(line)) {
      const k = pkey();
      const items: string[] = [];
      const s = i;
      while (i < lines.length && /^[*-] /.test(lines[i].trim())) {
        items.push(lines[i].trim().slice(2));
        i++;
      }
      nodes.push(
        <ul key={`ul-${s}`} data-pkey={k} style={{ ...hlBg(k), paddingLeft: "1.5em", margin: "1em 0", color: theme.text, cursor: audioOpen ? "pointer" : undefined } as React.CSSProperties}>
          {items.map((item, ii) => (
            <li key={ii} style={{ marginBottom: "0.4em", lineHeight: 1.7 }}>
              <HighlightedLine text={item} annotations={annotations} onWordTap={onWordTap} />
            </li>
          ))}
        </ul>,
      );
      blockIdx++; continue;
    }

    // Ordered list
    if (/^\d+\. /.test(line)) {
      const k = pkey();
      const items: string[] = [];
      const s = i;
      while (i < lines.length && /^\d+\. /.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\. /, ""));
        i++;
      }
      nodes.push(
        <ol key={`ol-${s}`} data-pkey={k} style={{ ...hlBg(k), paddingLeft: "1.5em", margin: "1em 0", color: theme.text, cursor: audioOpen ? "pointer" : undefined } as React.CSSProperties}>
          {items.map((item, ii) => (
            <li key={ii} style={{ marginBottom: "0.4em", lineHeight: 1.7 }}>
              <HighlightedLine text={item} annotations={annotations} onWordTap={onWordTap} />
            </li>
          ))}
        </ol>,
      );
      blockIdx++; continue;
    }

    // Scripture inline block
    const isInlineScripture =
      /^(?:\*{1,3}"[^"]{1,600}"\*{0,3}|\u201c[^\u201d]{1,600}\u201d|"[^"]{1,600}")\s*\([^)]+\d+:\d+[^)]*\)\s*$/.test(line);

    if (isInlineScripture) {
      const k = pkey();
      nodes.push(
        <blockquote
          key={`scr-${i}`}
          data-pkey={k}
          style={{
            ...hlBg(k),
            borderLeft:  `3px solid ${theme.scriptureBar}`,
            paddingLeft: "1.25em",
            margin:      "2em 0",
            fontStyle:   "italic",
            color:       theme.muted,
            fontSize:    "0.97em",
            lineHeight:  1.75,
            breakInside: "avoid",
            cursor:      audioOpen ? "pointer" : undefined,
          } as React.CSSProperties}
        >
          <p style={{ margin: 0 }}>
            <HighlightedLine text={line} annotations={annotations} onWordTap={onWordTap} />
          </p>
        </blockquote>,
      );
      blockIdx++; i++; continue;
    }

    // Paragraph
    paraCount++;
    const isDropCap = isFirstSection && paraCount === 1 && line.length > 1;
    const k = pkey();

    nodes.push(
      <p
        key={i}
        data-pkey={k}
        style={{
          ...hlBg(k),
          marginBottom: "1.4em",
          color:        theme.text,
          textIndent:   isDropCap ? undefined : "1.6em",
          textAlign:    "justify" as const,
          cursor:       audioOpen ? "pointer" : undefined,
        } as React.CSSProperties}
      >
        {isDropCap ? (
          <>
            <span
              style={{
                float:       "left",
                fontSize:    "3.5em",
                lineHeight:  0.8,
                paddingRight: "0.08em",
                paddingTop:  "0.06em",
                fontWeight:  700,
                color:       theme.heading,
                fontFamily:  "Georgia, serif",
              }}
            >
              {line.charAt(0)}
            </span>
            {bionicMode
              ? <BionicText text={line.slice(1)} onWordTap={onWordTap} />
              : <HighlightedLine text={line.slice(1)} annotations={annotations} onWordTap={onWordTap} />
            }
          </>
        ) : (
          bionicMode
            ? <BionicText text={line} onWordTap={onWordTap} />
            : <HighlightedLine text={line} annotations={annotations} onWordTap={onWordTap} />
        )}
      </p>,
    );
    blockIdx++; i++;
  }

  return nodes;
}

// ── Chapter content component ─────────────────────────────────────────────────

function ChapterView({
  chapter, theme, fontFamily, fontSize, lineHeight, annotations, onWordTap,
  audioParaKey, audioOpen, bionicMode,
}: {
  chapter:      ChapterDraft;
  theme:        Theme;
  fontFamily:   string;
  fontSize:     number;
  lineHeight:   number;
  annotations:  { selectedText: string; color: AnnotationColor }[];
  onWordTap?:   WordTapHandler;
  audioParaKey?: string | null;
  audioOpen?:   boolean;
  bionicMode?:  boolean;
}) {
  const [showExtras, setShowExtras] = useState(false);

  const baseStyle: React.CSSProperties = { fontFamily, fontSize: `${fontSize}px`, lineHeight, color: theme.text };
  const isAct = (k: string) => k === audioParaKey;
  const hlBg  = (k: string): React.CSSProperties => isAct(k)
    ? { background: `${theme.accent}1c`, borderRadius: "0.2rem", transition: "background 0.35s ease" }
    : { transition: "background 0.35s ease" };

  return (
    <article style={baseStyle}>
      {/* Chapter header */}
      <header style={{ textAlign: "center", marginBottom: "3.5em" }}>
        <p style={{ fontSize: "0.65em", letterSpacing: "0.3em", textTransform: "uppercase", color: theme.muted, marginBottom: "0.6em", fontFamily }}>
          Chapter {chapter.number}
        </p>
        <h1
          data-pkey="title"
          style={{
            ...hlBg("title"),
            fontSize: "1.9em", fontWeight: 700, color: theme.heading,
            lineHeight: 1.2, letterSpacing: "-0.02em", marginBottom: "0.5em",
            fontFamily: "Georgia, serif",
            cursor: audioOpen ? "pointer" : undefined,
          } as React.CSSProperties}
        >
          {chapter.title}
        </h1>
        <div style={{ width: "2.5em", height: "2px", background: theme.accent, margin: "1em auto 0", borderRadius: "1px" }} />
      </header>

      {/* Epigraph */}
      {chapter.epigraph && (
        <blockquote
          data-pkey="epigraph"
          style={{
            ...hlBg("epigraph"),
            textAlign:  "center",
            fontStyle:  "italic",
            color:      theme.muted,
            fontSize:   "0.93em",
            lineHeight: 1.75,
            margin:     "0 auto 3.5em",
            maxWidth:   "32em",
            padding:    "0 1em",
            cursor:     audioOpen ? "pointer" : undefined,
          } as React.CSSProperties}
        >
          {chapter.epigraph.split("\n").map((line, i, arr) => (
            <p key={i} style={{ marginBottom: i < arr.length - 1 ? "0.35em" : 0 }}>{line}</p>
          ))}
        </blockquote>
      )}

      {/* Chapter opener — consolidated premise + question, centered italic */}
      {chapter.intro && (
        <div
          data-pkey="intro"
          style={{
            ...hlBg("intro"),
            textAlign:    "center",
            fontStyle:    "italic",
            fontWeight:   600,
            color:        theme.heading,
            fontSize:     "1.05em",
            lineHeight:   1.8,
            marginBottom: "3em",
            cursor:       audioOpen ? "pointer" : undefined,
          } as React.CSSProperties}
        >
          {renderBody(chapter.intro, theme, false, annotations, onWordTap, "intro", audioParaKey, audioOpen, bionicMode)}
        </div>
      )}

      {/* Sections */}
      {chapter.sections.map((section, idx) => (
        <section key={section.sectionNumber} style={{ marginBottom: "0.5em" }}>
          {/* Never render the first section heading — it sits flush under the chapter title
               and reads as a subtitle. Chapter context is already set by the chapter title. */}
          {section.heading && idx > 0 && (
            <h2
              data-pkey={`s${idx}_h`}
              style={{
                ...hlBg(`s${idx}_h`),
                fontSize:      "0.65em",
                fontWeight:    700,
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                color:         theme.muted,
                marginTop:     "3.25em",
                marginBottom:  "1.75em",
                paddingBottom: "0.65em",
                borderBottom:  `1px solid ${theme.border}`,
                fontFamily,
                cursor:        audioOpen ? "pointer" : undefined,
              } as React.CSSProperties}
            >
              {section.heading}
            </h2>
          )}
          <div>{renderBody(section.body, theme, idx === 0, annotations, onWordTap, `s${idx}`, audioParaKey, audioOpen, bionicMode)}</div>
        </section>
      ))}

      {/* Forward question — teaser pointing to next chapter */}
      {chapter.forwardQuestion && (
        <section style={{ marginTop: "3em" }}>
          <div style={{ textAlign: "center", margin: "2.5em 0", color: theme.accent, letterSpacing: "0.5em", fontSize: "0.85em" }}>
            ✦ ✦ ✦
          </div>
          <p style={{ textAlign: "center", fontStyle: "italic", color: theme.muted, fontSize: "1.02em" }}>
            {chapter.forwardQuestion}
          </p>
        </section>
      )}

      {/* Reflection & takeaways (collapsible) */}
      {((chapter.reflectionQuestions?.length ?? 0) > 0 || (chapter.keyTakeaways?.length ?? 0) > 0) && (
        <div style={{ marginTop: "3.5em", borderTop: `1px solid ${theme.border}`, paddingTop: "2em" }}>
          <button
            onClick={() => setShowExtras((v) => !v)}
            style={{
              display:      "flex",
              alignItems:   "center",
              gap:          "0.5em",
              fontSize:     "0.65em",
              fontFamily,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color:        theme.muted,
              background:   "none",
              border:       "none",
              cursor:       "pointer",
              padding:      0,
              marginBottom: "1.5em",
              minHeight:    "2.75rem",
            }}
          >
            <span style={{ display: "inline-block", transform: showExtras ? "rotate(90deg)" : "none", transition: "transform 0.2s" }}>▶</span>
            {showExtras ? "Hide" : "Show"} Reflection &amp; Takeaways
          </button>

          {showExtras && (
            <div>
              {(chapter.keyTakeaways?.length ?? 0) > 0 && (
                <div style={{ marginBottom: "2.25em" }}>
                  <p style={{ fontSize: "0.65em", fontWeight: 700, letterSpacing: "0.18em", textTransform: "uppercase", color: theme.muted, marginBottom: "1em", fontFamily }}>
                    Key Takeaways
                  </p>
                  <ul style={{ paddingLeft: "1.6em", color: theme.text, listStyleType: "disc" }}>
                    {(chapter.keyTakeaways ?? []).map((item, idx2) => (
                      <li key={idx2} style={{ marginBottom: "0.65em", lineHeight: 1.7, display: "list-item" }}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}
              {(chapter.reflectionQuestions?.length ?? 0) > 0 && (
                <div>
                  <p style={{ fontSize: "0.65em", fontWeight: 700, letterSpacing: "0.18em", textTransform: "uppercase", color: theme.muted, marginBottom: "1em", fontFamily }}>
                    Reflection Questions
                  </p>
                  <ol style={{ paddingLeft: "1.6em", color: theme.text, listStyleType: "decimal" }}>
                    {(chapter.reflectionQuestions ?? []).map((q, qi) => (
                      <li key={qi} style={{ marginBottom: "0.65em", lineHeight: 1.7, display: "list-item" }}>{q}</li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

// ── Front / back matter section view ─────────────────────────────────────────

function FrontMatterView({
  title, body, theme, fontFamily, fontSize, lineHeight, annotations, onWordTap, audioParaKey, audioOpen,
}: {
  title:       string;
  body:        string;
  theme:       Theme;
  fontFamily:  string;
  fontSize:    number;
  lineHeight:  number;
  annotations: { selectedText: string; color: AnnotationColor }[];
  onWordTap?:  WordTapHandler;
  audioParaKey?: string | null;
  audioOpen?:  boolean;
}) {
  const baseStyle: React.CSSProperties = { fontFamily, fontSize: `${fontSize}px`, lineHeight, color: theme.text };
  const isAct = (k: string) => k === audioParaKey;
  const hlBg  = (k: string): React.CSSProperties => isAct(k)
    ? { background: `${theme.accent}1c`, borderRadius: "0.2rem", transition: "background 0.35s ease" }
    : { transition: "background 0.35s ease" };
  return (
    <article style={baseStyle}>
      <header style={{ textAlign: "center", marginBottom: "3.5em" }}>
        <h1
          data-pkey="title"
          style={{
            ...hlBg("title"),
            fontSize: "1.9em", fontWeight: 700, color: theme.heading,
            lineHeight: 1.2, letterSpacing: "-0.02em", marginBottom: "0.5em",
            fontFamily: "Georgia, serif",
            cursor: audioOpen ? "pointer" : undefined,
          }}
        >
          {title}
        </h1>
        <div style={{ width: "2.5em", height: "2px", background: theme.accent, margin: "1em auto 0", borderRadius: "1px" }} />
      </header>
      {renderBody(body, theme, true, annotations, onWordTap, "s0", audioParaKey, audioOpen)}
    </article>
  );
}

// ── Copyright page view ───────────────────────────────────────────────────────

function CopyrightView({
  bookTitle, authorName, year, theme, fontFamily, fontSize, lineHeight,
}: {
  bookTitle:  string;
  authorName: string;
  year:       string;
  theme:      Theme;
  fontFamily: string;
  fontSize:   number;
  lineHeight: number;
}) {
  return (
    <article style={{ fontFamily, fontSize: `${fontSize}px`, lineHeight, color: theme.text, display: "flex", flexDirection: "column", justifyContent: "flex-end", minHeight: "60vh" }}>
      <div style={{ borderTop: `1px solid ${theme.border}`, paddingTop: "2em" }}>
        <p style={{ fontFamily: "Georgia, serif", fontWeight: 700, fontSize: "1em", color: theme.heading, marginBottom: "0.5em" }}>{bookTitle}</p>
        <p style={{ fontSize: "0.85em", color: theme.muted, marginBottom: "1.5em" }}>Copyright © {year} {authorName}</p>
        <p style={{ fontSize: "0.78em", color: theme.muted, lineHeight: 1.75, marginBottom: "0.75em" }}>
          All rights reserved. No part of this publication may be reproduced, distributed, or transmitted in any form or by any means — including photocopying, recording, or other electronic or mechanical methods — without the prior written permission of the author.
        </p>
        <p style={{ fontSize: "0.78em", color: theme.muted, lineHeight: 1.75, marginBottom: "0.75em" }}>
          Scripture quotations are taken from various Bible translations as noted in the text.
        </p>
        <p style={{ fontSize: "0.72em", color: theme.muted, marginTop: "2em", letterSpacing: "0.08em" }}>
          Published via Nexus Director
        </p>
      </div>
    </article>
  );
}

// ── Back matter view ─────────────────────────────────────────────────────────

function BackMatterView({
  section, backMatter, theme, fontFamily, fontSize, lineHeight,
}: {
  section:    "glossary" | "guide" | "resources" | "scripture";
  backMatter: BackMatter;
  theme:      Theme;
  fontFamily: string;
  fontSize:   number;
  lineHeight: number;
}) {
  const t = theme;
  const titleStyle: React.CSSProperties = {
    fontSize: "1.9em", fontWeight: 700, color: t.heading,
    lineHeight: 1.2, letterSpacing: "-0.02em", marginBottom: "0.5em",
    fontFamily: "Georgia, serif", textAlign: "center",
  };
  const dividerStyle: React.CSSProperties = {
    width: "2.5em", height: "2px", background: t.accent, margin: "0.75em auto 3em", borderRadius: "1px",
  };
  const base: React.CSSProperties = { fontFamily, fontSize: `${fontSize}px`, lineHeight, color: t.text };

  if (section === "glossary") {
    return (
      <article style={base}>
        <header style={{ textAlign: "center", marginBottom: "3.5em" }}>
          <h1 style={titleStyle}>Glossary</h1>
          <div style={dividerStyle} />
        </header>
        {backMatter.glossary?.map((entry, i) => (
          <div key={i} style={{ marginBottom: "1.75em" }}>
            <p style={{ fontWeight: 700, color: t.heading, marginBottom: "0.25em" }}>{entry.term}</p>
            <p style={{ color: t.text, marginBottom: "0.25em" }}>{entry.definition}</p>
            {entry.firstAppearance && (
              <p style={{ fontSize: "0.78em", color: t.muted, fontStyle: "italic" }}>
                First appears: {entry.firstAppearance}
              </p>
            )}
          </div>
        ))}
      </article>
    );
  }

  if (section === "guide") {
    return (
      <article style={base}>
        <header style={{ textAlign: "center", marginBottom: "3.5em" }}>
          <h1 style={titleStyle}>Reading Group Guide</h1>
          <div style={dividerStyle} />
        </header>
        {backMatter.readingGroupGuide?.map((ch, i) => (
          <div key={i} style={{ marginBottom: "2.5em" }}>
            <h2 style={{
              fontSize: "0.65em", fontWeight: 700, letterSpacing: "0.18em",
              textTransform: "uppercase", color: t.muted,
              marginBottom: "1em", paddingBottom: "0.5em",
              borderBottom: `1px solid ${t.border}`,
              fontFamily,
            }}>
              Ch {ch.chapterNumber} · {ch.chapterTitle}
            </h2>
            <ol style={{ paddingLeft: "1.4em", margin: 0 }}>
              {ch.questions.map((q, qi) => (
                <li key={qi} style={{ marginBottom: "0.85em", lineHeight: 1.75 }}>{q}</li>
              ))}
            </ol>
          </div>
        ))}
      </article>
    );
  }

  if (section === "resources") {
    return (
      <article style={base}>
        <header style={{ textAlign: "center", marginBottom: "3.5em" }}>
          <h1 style={titleStyle}>Recommended Resources</h1>
          <div style={dividerStyle} />
        </header>
        <ul style={{ paddingLeft: "1.4em", margin: 0 }}>
          {backMatter.recommendedResources?.map((r, i) => (
            <li key={i} style={{ marginBottom: "0.85em", lineHeight: 1.75 }}>{r}</li>
          ))}
        </ul>
      </article>
    );
  }

  if (section === "scripture") {
    // Deduplicate: prefer named translation over "translation unspecified" for same base reference
    const baseRef = (r: string) => r.replace(/\s*\([^)]+\)\s*$/, "").trim().toLowerCase();
    const deduped = (backMatter.scriptureIndex ?? []).reduce<(typeof backMatter.scriptureIndex)[number][]>((acc, entry) => {
      const key = baseRef(entry.reference);
      const idx = acc.findIndex((e) => baseRef(e.reference) === key);
      if (idx === -1) return [...acc, entry];
      const isSpecific = entry.translation && entry.translation !== "translation unspecified";
      const existingIsGeneric = !acc[idx].translation || acc[idx].translation === "translation unspecified";
      if (isSpecific && existingIsGeneric) { const next = [...acc]; next[idx] = entry; return next; }
      return acc;
    }, []);

    type ScriptureEntry = { reference: string; translation: string };

    // Group by chapter; skip entries with no valid chapter — store full entry
    const byChapter = new Map<number, ScriptureEntry[]>();
    for (const entry of deduped) {
      const validChs = (entry.chapters ?? []).filter((c) => c > 0);
      for (const ch of validChs) {
        const g = byChapter.get(ch) ?? [];
        g.push({ reference: entry.reference, translation: entry.translation ?? "" });
        byChapter.set(ch, g);
      }
    }

    // Sort chapter keys numerically
    const chapterKeys = [...byChapter.keys()].sort((a, b) => a - b);

    const cleanRef = (r: string) =>
      r.replace(/\s*\([^)]+\)\s*$/, "").trim();
    const realTranslation = (t: string) =>
      t && t.toLowerCase() !== "translation unspecified" ? t : null;

    return (
      <article style={base}>
        <header style={{ textAlign: "center", marginBottom: "3.5em" }}>
          <h1 style={titleStyle}>Scripture Index</h1>
          <div style={dividerStyle} />
        </header>
        {chapterKeys.map((chKey) => {
          const entries = [...(byChapter.get(chKey) ?? [])].sort((a, b) =>
            a.reference.localeCompare(b.reference)
          );
          return (
            <div key={chKey} style={{ marginBottom: "2.25em" }}>
              <h2 style={{
                fontSize: "0.65em", fontWeight: 700, letterSpacing: "0.18em",
                textTransform: "uppercase", color: t.muted,
                marginBottom: "0.85em", paddingBottom: "0.5em",
                borderBottom: `1px solid ${t.border}`, fontFamily,
              }}>
                Chapter {chKey}
              </h2>
              {entries.map((entry, i) => {
                const translation = realTranslation(entry.translation);
                return (
                  <div key={i} style={{ marginBottom: "0.6em", display: "flex", alignItems: "baseline", gap: "0.6em" }}>
                    <span style={{ fontWeight: 600, color: t.heading }}>{cleanRef(entry.reference)}</span>
                    {translation && (
                      <span style={{ fontSize: "0.72em", fontWeight: 700, letterSpacing: "0.1em", color: t.accent }}>
                        {translation}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </article>
    );
  }

  return null;
}

// ── Selection popup — appears when user selects text in annotation mode ────────

const ANNO_SWATCHES: { key: AnnotationColor; dot: string }[] = [
  { key: "amber",   dot: "#f59e0b" },
  { key: "rose",    dot: "#f43f5e" },
  { key: "sky",     dot: "#0ea5e9" },
  { key: "emerald", dot: "#10b981" },
];

function SelectionPopup({
  selection, color, note, onColorChange, onNoteChange, onSave, onCancel, t, fontFamily,
}: {
  selection:     { text: string; rect: DOMRect };
  color:         AnnotationColor;
  note:          string;
  onColorChange: (c: AnnotationColor) => void;
  onNoteChange:  (n: string) => void;
  onSave:        () => void;
  onCancel:      () => void;
  t:             Theme;
  fontFamily:    string;
}) {
  const POPUP_W = 320;
  const POPUP_H = 220;
  const vw = typeof window !== "undefined" ? window.innerWidth  : 400;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;

  const rawTop  = selection.rect.top > POPUP_H + 16
    ? selection.rect.top - POPUP_H - 10
    : selection.rect.bottom + 10;
  const rawLeft = selection.rect.left + selection.rect.width / 2 - POPUP_W / 2;

  const top  = Math.max(8, Math.min(rawTop,  vh - POPUP_H - 8));
  const left = Math.max(8, Math.min(rawLeft, vw - POPUP_W - 8));

  return (
    <div
      // Block ALL pointer/touch/mouse events from reaching the document-level
      // selectionchange listener or the dismiss backdrop beneath this popup.
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      style={{
        position: "fixed", top, left, width: POPUP_W, zIndex: 62,
        background: t.chrome,
        border: `1px solid ${t.chromeBorder}`,
        borderRadius: "1rem",
        backdropFilter: "blur(28px)", WebkitBackdropFilter: "blur(28px)",
        padding: "1.1rem",
        boxShadow: "0 20px 60px rgba(0,0,0,0.55)",
      }}
    >
      {/* Selected text preview */}
      <p style={{
        fontSize: "0.82rem", fontFamily: "Georgia, serif", fontStyle: "italic",
        color: t.muted, lineHeight: 1.55, marginBottom: "0.9rem",
        overflow: "hidden", display: "-webkit-box",
        WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
        textOverflow: "ellipsis",
      } as React.CSSProperties}>
        "{selection.text.slice(0, 100)}{selection.text.length > 100 ? "…" : ""}"
      </p>

      {/* Color swatches */}
      <div style={{ display: "flex", gap: "0.6rem", marginBottom: "0.85rem", alignItems: "center" }}>
        <span style={{
          fontSize: "0.6rem", letterSpacing: "0.1em", textTransform: "uppercase",
          color: t.muted, fontFamily, marginRight: "0.1rem",
        }}>
          Color
        </span>
        {ANNO_SWATCHES.map(({ key, dot }) => (
          <button
            key={key}
            onClick={() => onColorChange(key)}
            aria-label={key}
            style={{
              width: "1.75rem", height: "1.75rem", borderRadius: "50%",
              background: dot, cursor: "pointer", flexShrink: 0,
              border: color === key ? `3px solid ${t.text}` : "3px solid transparent",
              outline: color === key ? `2px solid ${dot}` : "none",
              outlineOffset: "1px",
              transition: "border-color 0.15s, outline 0.15s",
            }}
          />
        ))}
      </div>

      {/* Note textarea — 16px font prevents iOS auto-zoom */}
      <textarea
        placeholder="Add a note (optional)…"
        value={note}
        onChange={(e) => onNoteChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onSave();
          if (e.key === "Escape") onCancel();
        }}
        rows={2}
        style={{
          width: "100%", fontSize: "1rem", fontFamily,
          background: "transparent",
          border: `1px solid ${t.border}`, borderRadius: "0.45rem",
          padding: "0.45rem 0.65rem", color: t.text,
          marginBottom: "0.8rem", outline: "none",
          resize: "none", lineHeight: 1.5,
          boxSizing: "border-box", display: "block",
        } as React.CSSProperties}
      />

      {/* Actions */}
      <div style={{ display: "flex", gap: "0.5rem", justifyContent: "space-between" }}>
        <button
          onClick={onCancel}
          style={{
            fontSize: "0.82rem", fontFamily, color: t.muted,
            background: "none", border: `1px solid ${t.border}`,
            borderRadius: "0.45rem", cursor: "pointer",
            minHeight: "2.5rem", padding: "0 1rem",
          }}
        >
          Cancel
        </button>
        <button
          onClick={onSave}
          style={{
            fontSize: "0.82rem", fontFamily, color: "#fff",
            background: t.accent, border: "none",
            borderRadius: "0.45rem", cursor: "pointer",
            minHeight: "2.5rem", padding: "0 1.25rem",
            fontWeight: 600,
          }}
        >
          Save highlight
        </button>
      </div>
    </div>
  );
}

// ── Main reader component ─────────────────────────────────────────────────────

type Props = { manifest: EbookManifest; slug: string; initialChapter?: number };

export function ReaderClient({ manifest, slug, initialChapter }: Props) {
  const [settings, setSettings] = useState<ReaderSettings>({
    theme: "paper", fontSize: 3, lineHeight: 2, fontFamily: "serif",
  });
  const [chapterIndex, setChapterIndex] = useState(initialChapter ?? 0);
  const [showChrome,   setShowChrome]   = useState(true);
  const [tocOpen,      setTocOpen]      = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ── Page-flip state ──────────────────────────────────────────────────────
  const [pageIndex,     setPageIndex]     = useState(0);
  const [totalPages,    setTotalPages]    = useState(1);
  const [containerW,    setContainerW]    = useState(0);
  const [containerH,    setContainerH]    = useState(0);
  const [isFlipping,    setIsFlipping]    = useState(false);

  // ── Annotation + audio state ────────────────────────────────────────────────────
  const [annotationMode, setAnnotationMode] = useState(false);
  const [audioOpen,      setAudioOpen]      = useState(false);
  const [audioParaKey,   setAudioParaKey]   = useState<string | null>(null);
  const [chapterAudioUrl, setChapterAudioUrl] = useState<string | null>(null);
  const [recordedSeekRequest, setRecordedSeekRequest] = useState<{ token: number; segIdx: number; wordIdx: number } | null>(null);
  const [annoPanelOpen,  setAnnoPanelOpen]  = useState(false);
  const [selection,      setSelection]      = useState<{ text: string; rect: DOMRect } | null>(null);
  const [annoColor,      setAnnoColor]      = useState<AnnotationColor>("amber");
  const [annoNote,       setAnnoNote]       = useState("");

  // ── Bookmark / dog-ear state ─────────────────────────────────────────────
  const [bookmarks,      setBookmarks]      = useState<ReaderBookmark[]>([]);

  // Load bookmarks for this slug whenever slug or chapter changes
  useEffect(() => {
    setBookmarks(getBookmarks(slug));
  }, [slug, chapterIndex]);

  // Inline highlights — reloaded whenever chapter or slug changes
  const [annotations,    setAnnotations]    = useState<Pick<Annotation, "selectedText" | "color">[]>([]);

  // Global audio context — seekTo for tap-to-start; currentSeg drives auto-flip
  const { seekTo: audioSeekTo, seekToWord: audioSeekToWord, currentSeg: audioCurrentSeg } = useAudioPlayer();

  const containerRef    = useRef<HTMLDivElement>(null);
  const columnTrackRef  = useRef<HTMLDivElement>(null);
  const sentinelRef     = useRef<HTMLDivElement>(null);
  const inactivityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flipTimer       = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioOpenRef    = useRef(audioOpen);
  const pageIndexRef    = useRef(pageIndex);
  const paraKeyMapRef      = useRef<Record<string, number>>({});
  const paraWordMapRef     = useRef<Record<string, Array<{ segIdx: number; startWord: number; endWord: number }>>>({});
  const seekTokenRef       = useRef(0);
  // When navigating back to a previous chapter, land on its last page
  const goToLastPageRef    = useRef(false);
  // True while the highlight popup is visible — blocks selectionchange from closing it
  const selectionLockRef   = useRef(false);

  // Touch / swipe tracking
  const touchStartX     = useRef(0);
  const touchStartY     = useRef(0);
  const touchStartTime  = useRef(0);

  // Refs so stable callbacks can read latest panel state
  const tocOpenRef      = useRef(tocOpen);
  const settingsOpenRef = useRef(settingsOpen);
  useEffect(() => { tocOpenRef.current      = tocOpen;      }, [tocOpen]);
  useEffect(() => { settingsOpenRef.current = settingsOpen; }, [settingsOpen]);
  useEffect(() => { audioOpenRef.current    = audioOpen;    }, [audioOpen]);
  useEffect(() => { pageIndexRef.current    = pageIndex;    }, [pageIndex]);

  // ── Reload annotation highlights when chapter / slug changes ─────────────
  const reloadAnnotations = useCallback(() => {
    setAnnotations(
      loadAnnotations(slug)
        .filter((a) => a.chapterIndex === chapterIndex)
        .map(({ selectedText, color }) => ({ selectedText, color })),
    );
  }, [slug, chapterIndex]);
  useEffect(() => { reloadAnnotations(); }, [reloadAnnotations]);

  // ── Lock page scroll while reader is mounted (prevents iOS rubber-band pan) ─
  useEffect(() => {
    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow              = "hidden";
    return () => {
      document.documentElement.style.overflow = prev;
      document.body.style.overflow             = "";
    };
  }, []);

  // ── Block native touchmove scroll — only when NOT in annotation mode ────────
  useEffect(() => {
    if (annotationMode) return; // browser handles touches for text selection
    const el = containerRef.current;
    if (!el) return;
    const block = (e: TouchEvent) => e.preventDefault();
    el.addEventListener("touchmove", block, { passive: false });
    return () => el.removeEventListener("touchmove", block);
  }, [annotationMode]);
  // ── Measure container dimensions via ResizeObserver ────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setContainerW(el.clientWidth);
      setContainerH(el.clientHeight);
    });
    ro.observe(el);
    setContainerW(el.clientWidth);
    setContainerH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // ── Count pages after render / chapter / settings change ────────────────
  // Sentinel div is placed after all chapter content. Its getBoundingClientRect()
  // left offset relative to the track tells us how many CSS columns were created.
  // Math.ceil handles the case where sentinel lands exactly at a column boundary.
  useEffect(() => {
    if (!containerW || !containerH) return;
    let raf1: number, raf2: number;
    const measure = () => {
      const track    = columnTrackRef.current;
      const sentinel = sentinelRef.current;
      if (!track || !sentinel) return;
      const trackLeft    = track.getBoundingClientRect().left;
      const sentinelLeft = sentinel.getBoundingClientRect().left;
      const pages = Math.max(1, Math.ceil((sentinelLeft - trackLeft) / containerW));
      setTotalPages(pages);
      if (goToLastPageRef.current) {
        goToLastPageRef.current = false;
        setPageIndex(pages - 1);
      } else {
        setPageIndex(0);
      }
    };
    raf1 = requestAnimationFrame(() => { raf2 = requestAnimationFrame(measure); });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, [chapterIndex, containerW, containerH, settings]);

  // ── Build virtual section list (copyright → preface → intro → chapters → conclusion → about → backmatter) ──
  type VirtualSection =
    | { kind: "copyright" }
    | { kind: "frontmatter"; key: "preface" | "introduction" | "conclusion" | "additional"; title: string; body: string }
    | { kind: "chapter"; chapter: ChapterDraft }
    | { kind: "about"; body: string }
    | { kind: "backmatter"; key: "glossary" | "guide" | "resources" | "scripture"; title: string }
    | { kind: "custom"; title: string; body: string };

  const virtualSections: VirtualSection[] = [];
  virtualSections.push({ kind: "copyright" });
  if (manifest.frontMatter.preface?.trim())
    virtualSections.push({ kind: "frontmatter", key: "preface", title: "Preface", body: manifest.frontMatter.preface });
  if (manifest.frontMatter.introduction?.trim())
    virtualSections.push({ kind: "frontmatter", key: "introduction", title: "Introduction", body: manifest.frontMatter.introduction });
  for (const section of manifest.frontMatter.additionalSections ?? [])
    virtualSections.push({ kind: "frontmatter", key: "additional", title: section.title, body: section.content });
  for (const ch of manifest.chapters)
    virtualSections.push({ kind: "chapter", chapter: ch });
  if (manifest.frontMatter.conclusion?.trim())
    virtualSections.push({ kind: "frontmatter", key: "conclusion", title: "Conclusion", body: manifest.frontMatter.conclusion });
  if (manifest.frontMatter.aboutAuthor?.trim())
    virtualSections.push({ kind: "about", body: manifest.frontMatter.aboutAuthor });
  if ((manifest.backMatter?.glossary?.length ?? 0) > 0)
    virtualSections.push({ kind: "backmatter", key: "glossary", title: "Glossary" });
  if ((manifest.backMatter?.readingGroupGuide?.length ?? 0) > 0)
    virtualSections.push({ kind: "backmatter", key: "guide", title: "Reading Group Guide" });
  if ((manifest.backMatter?.recommendedResources?.length ?? 0) > 0)
    virtualSections.push({ kind: "backmatter", key: "resources", title: "Recommended Resources" });
  if ((manifest.backMatter?.scriptureIndex?.length ?? 0) > 0)
    virtualSections.push({ kind: "backmatter", key: "scripture", title: "Scripture Index" });
  for (const section of manifest.backMatter?.additionalSections ?? [])
    virtualSections.push({ kind: "custom", title: section.title, body: section.content });

  const totalSections = virtualSections.length;
  const currentSection = virtualSections[chapterIndex] ?? virtualSections[0];
  const isNarratableFrontMatter =
    currentSection.kind === "frontmatter" &&
    (currentSection.key === "preface" || currentSection.key === "introduction" || currentSection.key === "conclusion");

  const currentAudioTrackId = useMemo(() => {
    if (currentSection.kind === "chapter") return `ch-${currentSection.chapter.number}`;
    if (currentSection.kind === "frontmatter" && currentSection.key === "preface") return "fm-preface";
    if (currentSection.kind === "frontmatter" && currentSection.key === "introduction") return "fm-introduction";
    if (currentSection.kind === "frontmatter" && currentSection.key === "conclusion") return "fm-conclusion";
    if (currentSection.kind === "about") return "fm-about-author";
    return null;
  }, [currentSection]);

  const currentAudioChapter = useMemo<ChapterDraft | null>(() => {
    if (currentSection.kind === "chapter") return currentSection.chapter;
    if (isNarratableFrontMatter) {
      return {
        number: 0,
        title: currentSection.title,
        intro: "",
        epigraph: "",
        sections: [{
          chapterNumber: 0,
          sectionNumber: 1,
          heading: "",
          body: currentSection.body,
          wordCount: 0,
          status: "complete",
        }],
        forwardQuestion: "",
        keyTakeaways: [],
        reflectionQuestions: [],
        totalWordCount: 0,
        status: "complete",
      };
    }
    if (currentSection.kind === "about") {
      return {
        number: 0,
        title: "About the Author",
        intro: "",
        epigraph: "",
        sections: [{
          chapterNumber: 0,
          sectionNumber: 1,
          heading: "",
          body: currentSection.body,
          wordCount: 0,
          status: "complete",
        }],
        forwardQuestion: "",
        keyTakeaways: [],
        reflectionQuestions: [],
        totalWordCount: 0,
        status: "complete",
      };
    }
    return null;
  }, [currentSection, isNarratableFrontMatter]);

  useEffect(() => {
    if (typeof window === "undefined" || !currentAudioTrackId) {
      setChapterAudioUrl(null);
      return;
    }

    const publishedAudioUrl = manifest.narrationUrls?.[currentAudioTrackId];
    if (typeof publishedAudioUrl === "string" && publishedAudioUrl.length > 0) {
      setChapterAudioUrl(publishedAudioUrl);
      return;
    }

    let cancelled = false;

    const storageKeys = [manifest.jobId, slug]
      .filter((value): value is string => Boolean(value))
      .map((value) => `${VOICE_STUDIO_STORAGE_PREFIX}${value}`);

    try {
      for (const storageKey of storageKeys) {
        const raw = localStorage.getItem(storageKey);
        if (!raw) continue;
        const saved = JSON.parse(raw) as { chapters?: Array<{ chapterId?: string; status?: string; audioUrl?: string | null }> };
        const savedChapter = saved.chapters?.find((chapter) =>
          chapter.chapterId === currentAudioTrackId &&
          chapter.status === "done" &&
          typeof chapter.audioUrl === "string" &&
          chapter.audioUrl.length > 0
        );
        if (savedChapter?.audioUrl) {
          setChapterAudioUrl(savedChapter.audioUrl);
          return;
        }
      }
    } catch {
      // Ignore malformed localStorage and fall back to synced reader only.
    }

    const lookupRemote = async () => {
      try {
        const qs = new URLSearchParams({
          chapterId: currentAudioTrackId,
          slug,
          jobId: manifest.jobId,
        });
        const res = await fetch(`/api/voice/library-audio?${qs.toString()}`);
        if (!res.ok) {
          if (!cancelled) setChapterAudioUrl(null);
          return;
        }
        const json = await res.json() as { audioUrl?: string | null };
        if (!cancelled) {
          setChapterAudioUrl(typeof json.audioUrl === "string" && json.audioUrl.length > 0 ? json.audioUrl : null);
        }
      } catch {
        if (!cancelled) setChapterAudioUrl(null);
      }
    };

    void lookupRemote();
    return () => {
      cancelled = true;
    };
  }, [manifest.jobId, manifest.narrationUrls, slug, currentAudioTrackId]);

  // ── Dog-ear bookmark helpers (depend on currentSection) ─────────────────
  const isBookmarked = bookmarks.some((b) => b.chapterIndex === chapterIndex);

  const toggleDogEar = useCallback(() => {
    const existing = bookmarks.find((b) => b.chapterIndex === chapterIndex);
    if (existing) {
      removeBookmark(slug, existing.id);
    } else {
      const label = currentSection.kind === "chapter"
        ? currentSection.chapter.title
        : `${manifest.bookTitle} · Part ${chapterIndex + 1}`;
      addBookmark(slug, {
        id: crypto.randomUUID(),
        chapterIndex,
        label,
        createdAt: new Date().toISOString(),
      });
    }
    setBookmarks(getBookmarks(slug));
  }, [slug, chapterIndex, bookmarks, currentSection, manifest.bookTitle]);

  // ── Build paraKey→segIdx map whenever audio opens for a chapter ──────────
  // (placed here because it depends on currentSection, declared above)
  useEffect(() => {
    if (!currentAudioChapter) { paraKeyMapRef.current = {}; paraWordMapRef.current = {}; return; }
    const segs = parseChapter(currentAudioChapter);
    const keyMap: Record<string, number> = {};
    const wordMap: Record<string, Array<{ segIdx: number; startWord: number; endWord: number }>> = {};
    const wordOffsetByKey = new Map<string, number>();

    segs.forEach((seg, idx) => {
      if (!(seg.paraKey in keyMap)) keyMap[seg.paraKey] = idx;
      const words = seg.text.split(/\s+/).filter(Boolean).length;
      const startWord = wordOffsetByKey.get(seg.paraKey) ?? 0;
      const endWord = startWord + Math.max(1, words);
      const list = wordMap[seg.paraKey] ?? [];
      list.push({ segIdx: idx, startWord, endWord });
      wordMap[seg.paraKey] = list;
      wordOffsetByKey.set(seg.paraKey, endWord);
    });

    paraKeyMapRef.current = keyMap;
    paraWordMapRef.current = wordMap;
  }, [audioOpen, currentAudioChapter]);

  const handleWordTap = useCallback((paraKey: string, wordIndex: number) => {
    const segments = paraWordMapRef.current[paraKey] ?? [];
    const target = segments.find((entry) => wordIndex >= entry.startWord && wordIndex < entry.endWord) ?? segments[segments.length - 1];
    if (!target) return;
    const localWordIndex = Math.max(0, wordIndex - target.startWord);
    setAudioOpen(true);
    if (chapterAudioUrl) {
      seekTokenRef.current += 1;
      setRecordedSeekRequest({ token: seekTokenRef.current, segIdx: target.segIdx, wordIdx: localWordIndex });
      return;
    }
    if (localWordIndex > 0) {
      audioSeekToWord(target.segIdx, localWordIndex);
    } else {
      audioSeekTo(target.segIdx);
    }
  }, [audioSeekTo, audioSeekToWord, chapterAudioUrl]);

  // ── Derive audioParaKey from the global audio context directly ─────────────
  // This is more reliable than the onProgress callback chain because it doesn't
  // depend on the callback being kept fresh across re-renders.
  useEffect(() => {
    if (chapterAudioUrl) return;
    if (!audioOpen) { setAudioParaKey(null); return; }
    if (!audioCurrentSeg) { setAudioParaKey(null); return; }
    setAudioParaKey(audioCurrentSeg.paraKey);
  }, [audioOpen, audioCurrentSeg, chapterAudioUrl]);
  useEffect(() => { if (!audioOpen) setAudioParaKey(null); }, [audioOpen]);
  useEffect(() => { setAudioParaKey(null); }, [chapterIndex]);

  // ── Auto-flip page when audio advances to a paragraph on another page ─────
  // Uses getBoundingClientRect() instead of offsetLeft because CSS multi-column
  // offsetLeft is unreliable in Safari/iOS — it returns the position within the
  // current column, not the absolute offset across the full column track.
  useEffect(() => {
    if (!audioParaKey || !columnTrackRef.current || !containerW) return;
    const raf = requestAnimationFrame(() => {
      const track = columnTrackRef.current;
      if (!track) return;
      const el = track.querySelector(`[data-pkey="${audioParaKey}"]`) as HTMLElement | null;
      if (!el) return;
      const trackLeft = track.getBoundingClientRect().left;
      const rects = Array.from(el.getClientRects());
      const occupiedPages = (rects.length > 0 ? rects : [el.getBoundingClientRect()])
        .map((rect) => {
          const naturalLeft = Math.max(0, rect.left - trackLeft);
          const naturalRight = Math.max(naturalLeft, rect.right - trackLeft - 1);
          return {
            startPage: Math.floor(naturalLeft / containerW),
            endPage: Math.floor(naturalRight / containerW),
          };
        });

      const startPage = Math.max(0, Math.min(...occupiedPages.map((page) => page.startPage)));
      const endPage = Math.max(...occupiedPages.map((page) => page.endPage));

      let targetPage = pageIndexRef.current;
      if (pageIndexRef.current < startPage) targetPage = startPage;
      else if (pageIndexRef.current > endPage) targetPage = endPage;
      else if (endPage > pageIndexRef.current) targetPage = endPage;

      if (targetPage !== pageIndexRef.current && targetPage >= 0) {
        setPageIndex(targetPage);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [audioParaKey, containerW]);

  // ── Restore settings + position ──────────────────────────────────────────
  useEffect(() => {
    const saved = getReaderSettings();
    setSettings(saved);
    if (initialChapter === undefined) {
      const pos = getReadingPosition(slug);
      if (pos) setChapterIndex(Math.min(pos.chapterIndex, totalSections - 1));
    }
  }, [slug, totalSections, initialChapter]);

  // Persist position whenever chapter or page changes
  useEffect(() => {
    saveReadingPosition(slug, { chapterIndex, scrollPercentage: pageIndex / Math.max(1, totalPages - 1) });
  }, [slug, chapterIndex, pageIndex, totalPages]);

  // ── Chrome auto-hide ──────────────────────────────────────────────────────
  const resetInactivity = useCallback(() => {
    // Functional update: if chrome is already visible, return same value so React
    // bails out without scheduling a re-render. This prevents selection handle drags
    // from being disrupted by spurious re-renders on every touchstart.
    setShowChrome((prev) => prev ? prev : true);
    if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    inactivityTimer.current = setTimeout(() => {
      if (!tocOpenRef.current && !settingsOpenRef.current) setShowChrome(false);
    }, 3500);
  }, []);

  useEffect(() => {
    resetInactivity();
    window.addEventListener("mousemove",  resetInactivity);
    window.addEventListener("touchstart", resetInactivity, { passive: true });
    window.addEventListener("keydown",    resetInactivity);
    return () => {
      window.removeEventListener("mousemove",  resetInactivity);
      window.removeEventListener("touchstart", resetInactivity);
      window.removeEventListener("keydown",    resetInactivity);
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    };
  }, [resetInactivity]);

  useEffect(() => {
    if (tocOpen || settingsOpen) {
      setShowChrome(true);
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    }
  }, [tocOpen, settingsOpen]);

  // ── Annotation text-selection detection ─────────────────────────────────────
  // Keep the lock ref in sync with selection state (runs on every render, no effect needed)
  selectionLockRef.current = selection !== null;

  useEffect(() => {
    if (!annotationMode) { setSelection(null); return; }
    let debounce: ReturnType<typeof setTimeout>;
    const detect = () => {
      // While the popup is visible, ignore selectionchange so typing a note
      // or tapping a color swatch doesn't dismiss the popup.
      if (selectionLockRef.current) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (selectionLockRef.current) return;
        const sel  = window.getSelection();
        const text = sel?.toString().trim() ?? "";
        // Cap at 600 chars: longer almost always means the selection accidentally
        // extended into a hidden CSS column ("whole page" selection on iOS).
        if (text.length >= 3 && text.length <= 600) {
          try {
            const range   = sel!.getRangeAt(0);
            const rect    = range.getBoundingClientRect();
            const cBounds = containerRef.current?.getBoundingClientRect();
            const pageH   = cBounds?.height ?? window.innerHeight;

            // Reject if the selection rect bleeds outside the visible viewport
            // width (selection jumped into a hidden next-page CSS column).
            if (cBounds && rect.right > cBounds.right + 24) {
              sel!.removeAllRanges();
              return;
            }
            // Reject if the selection is taller than 35% of the page height.
            // iOS "whole page" grabs produce a tall bounding rect even when
            // the selected text is short — this catches that case reliably.
            if (rect.height > pageH * 0.35) {
              sel!.removeAllRanges();
              return;
            }
            // Reject if getClientRects() returns more than 8 line fragments —
            // a normal sentence spans 1-4 lines; whole-page grabs span many more.
            if (range.getClientRects().length > 8) {
              sel!.removeAllRanges();
              return;
            }
            setSelection({ text, rect });
          } catch { /* range detached — ignore */ }
        } else {
          if (text.length > 600) sel?.removeAllRanges(); // clear runaway column selection
          setSelection(null);
        }
      }, 120); // debounce lets the selection stabilise (important on iOS)
    };
    document.addEventListener("selectionchange", detect);
    return () => {
      document.removeEventListener("selectionchange", detect);
      clearTimeout(debounce);
    };
  }, [annotationMode]);

  // ── Dismiss the iOS native "Copy / Look Up / Translate" callout ───────────
  // As soon as our custom popup opens (selection goes null → non-null), clear the
  // browser selection. At this point selectionLockRef.current is already true, so
  // the resulting selectionchange event returns early without closing the popup.
  useEffect(() => {
    if (selection !== null) {
      window.getSelection()?.removeAllRanges();
    }
  }, [selection]);

  // ── Page navigation — crossfade (no sliding body) ─────────────────────────
  // Phase 1: fade content out (160ms)
  // Phase 2: jump to new page instantly, fade back in
  const triggerFlip = useCallback((dir: "prev" | "next") => {
    if (isFlipping) return; // prevent double-tap during animation
    setIsFlipping(true);
    if (flipTimer.current) clearTimeout(flipTimer.current);
    flipTimer.current = setTimeout(() => {
      // Read pageIndex/chapterIndex directly from closure so we never nest
      // a setChapterIndex call inside a setPageIndex updater — React Strict
      // Mode double-invokes updaters in dev, which would skip every other chapter.
      if (dir === "prev") {
        if (pageIndex > 0) {
          setPageIndex((p) => p - 1);
        } else if (chapterIndex > 0) {
          goToLastPageRef.current = true;
          setChapterIndex((ci) => ci - 1);
          setPageIndex(0);
        }
      } else {
        if (pageIndex < totalPages - 1) {
          setPageIndex((p) => p + 1);
        } else {
          setChapterIndex((ci) => Math.min(totalSections - 1, ci + 1));
          setPageIndex(0);
        }
      }
      setIsFlipping(false); // fade back in
    }, 160);
  }, [isFlipping, pageIndex, chapterIndex, totalPages, totalSections]);

  // Chapter-level navigation (from ToC)
  const goToChapter = useCallback((i: number) => {
    setChapterIndex(i);
    setPageIndex(0);
  }, []);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "ArrowLeft"  || e.key === "ArrowUp")    triggerFlip("prev");
      if (e.key === "ArrowRight" || e.key === "ArrowDown")  triggerFlip("next");
      if (e.key === "t" || e.key === "T") setTocOpen((v) => !v);
      if (e.key === "Escape") { setTocOpen(false); setSettingsOpen(false); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [triggerFlip]);

  // ── Touch / swipe gestures ────────────────────────────────────────────────
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (annotationMode) return; // browser owns touch for text selection; don't record swipe coords
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  }, [annotationMode]);

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (annotationMode) return; // browser owns touch for text selection
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    const dy = e.changedTouches[0].clientY - touchStartY.current;
    // Only horizontal swipes wider than 40px and not mostly vertical
    if (Math.abs(dx) < 40 || Math.abs(dy) > Math.abs(dx) * 0.9) return;
    if (dx > 0) triggerFlip("prev"); else triggerFlip("next");
  }, [annotationMode, triggerFlip]);

  // ── Tap-zone page turn (left 30% = prev, right 30% = next) ───────────────
  const onAreaClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // Ignore clicks on interactive elements
    if ((e.target as HTMLElement).closest("button,a,select,input,textarea")) return;
    if (tocOpen || settingsOpen) { setTocOpen(false); setSettingsOpen(false); return; }
    // In annotation mode, let the browser manage taps for text selection
    if (annotationMode) { resetInactivity(); return; }
    // When audio is open, tapping a paragraph starts reading from that position
    if (audioOpenRef.current) {
      const pkey = (e.target as HTMLElement).closest("[data-pkey]")?.getAttribute("data-pkey");
      if (pkey) {
        const segIdx = paraKeyMapRef.current[pkey];
        if (segIdx !== undefined) {
          if (chapterAudioUrl) {
            seekTokenRef.current += 1;
            setRecordedSeekRequest({ token: seekTokenRef.current, segIdx, wordIdx: 0 });
            return;
          }
          audioSeekTo(segIdx);
          return;
        }
      }
    }
    const x = e.clientX;
    const w = e.currentTarget.clientWidth;
    if (x < w * 0.30) triggerFlip("prev");
    else if (x > w * 0.70) triggerFlip("next");
    else resetInactivity();
  }, [annotationMode, tocOpen, settingsOpen, triggerFlip, resetInactivity, chapterAudioUrl, audioSeekTo]);

  const updateSettings = (patch: Partial<ReaderSettings>) => {
    const next = { ...settings, ...patch } as ReaderSettings;
    setSettings(next);
    saveReaderSettings(next);
  };

  const theme      = THEMES[settings.theme];
  const fontSize   = FONT_SIZES[settings.fontSize - 1];
  const lineHeight = LINE_HEIGHTS[settings.lineHeight - 1];
  const fontFamily = FONT_FAMILIES[settings.fontFamily];

  // ToC items for ChapterDrawer
  const tocItems: TocItem[] = virtualSections.map((s, i) => {
    if (s.kind === "copyright")    return { label: "©",         title: "Copyright" };
    if (s.kind === "frontmatter")  return { label: s.title.slice(0, 5).toUpperCase(), title: s.title };
    if (s.kind === "about")        return { label: "ABOUT",     title: "About the Author" };
    if (s.kind === "backmatter")   return { label: s.title.slice(0, 4).toUpperCase(), title: s.title };
    if (s.kind === "custom")      return { label: s.title.slice(0, 5).toUpperCase(), title: s.title };
    // chapter
    const chNum = (s as { kind: "chapter"; chapter: ChapterDraft }).chapter.number;
    return { label: `Ch ${chNum}`, title: (s as { kind: "chapter"; chapter: ChapterDraft }).chapter.title };
  });

  // Label for top chrome
  const sectionLabel = (() => {
    if (currentSection.kind === "copyright")   return "Copyright";
    if (currentSection.kind === "frontmatter") return currentSection.title;
    if (currentSection.kind === "about")       return "About the Author";
    if (currentSection.kind === "backmatter")  return currentSection.title;
    if (currentSection.kind === "custom")      return currentSection.title;
    return `Ch ${currentSection.chapter.number} · ${currentSection.chapter.title}`;
  })();

  const publishYear = new Date(manifest.generatedAt).getFullYear().toString();
  const opacity    = showChrome ? 1 : 0.06;

  // Two-page spread: active only in landscape on wide-enough screens
  const isLandscape = containerW > 0 && containerH > 0 && containerW > containerH * 1.25 && containerW >= 900;
  const columnWidth = isLandscape ? Math.floor(containerW / 2) : containerW;

  // Global progress across all virtual sections
  const globalProgress = totalSections === 0 ? 0 :
    ((chapterIndex + (pageIndex + 1) / Math.max(1, totalPages)) / totalSections) * 100;

  const iconBtn = (label: string, onClick: () => void, children: React.ReactNode) => (
    <button
      onClick={onClick}
      aria-label={label}
      style={{
        minHeight: "2.75rem", minWidth: "2.75rem", display: "flex",
        alignItems: "center", justifyContent: "center",
        color: theme.muted, background: "none", border: "none",
        cursor: "pointer", borderRadius: "0.5rem",
      }}
    >
      {children}
    </button>
  );

  // Horizontal offset — each "page" is exactly one CSS column (containerW wide)
  const translateX = containerW > 0 ? -(pageIndex * containerW) : 0;

  return (
    <div
      style={{
        height: "100dvh", display: "flex", flexDirection: "column",
        overflow: "hidden", background: theme.bg, color: theme.text,
        position: "relative",
      }}
    >
      {/* Fine global progress line at very top */}
      <ProgressBar current={globalProgress} total={100} accent={theme.accent} />

      {/* ── Top chrome ── */}
      <header
        style={{
          flexShrink: 0, height: CHROME_H, display: "flex",
          alignItems: "center", justifyContent: "space-between",
          padding: "0 1rem", background: theme.chrome,
          borderBottom: `1px solid ${theme.chromeBorder}`,
          backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)",
          opacity, transition: "opacity 0.6s ease",
          position: "relative", zIndex: 10,
        }}
      >
        <Link
          href={`/library/${slug}`}
          style={{
            display: "flex", alignItems: "center", gap: "0.4rem",
            color: theme.muted, fontSize: "0.78rem", fontFamily,
            textDecoration: "none", minHeight: "2.75rem", padding: "0 0.25rem",
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ width: "0.95rem", height: "0.95rem" }}>
            <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Library
        </Link>

        <p style={{
          flex: 1, textAlign: "center", overflow: "hidden",
          textOverflow: "ellipsis", whiteSpace: "nowrap",
          padding: "0 0.75rem", color: theme.muted,
          fontSize: "0.78rem", fontFamily: "Georgia, serif",
        }}>
          {sectionLabel}        </p>

        <div style={{ display: "flex", alignItems: "center" }}>
          {/* Annotations panel */}
          {iconBtn("Annotations", () => { setAnnoPanelOpen((v) => !v); setTocOpen(false); setSettingsOpen(false); },
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ width: "1rem", height: "1rem" }}>
              <path d="M19 3H5a2 2 0 0 0-2 2v14l4-4h12a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>,
          )}
          {/* Annotate mode toggle */}
          <button
            onClick={() => { setAnnotationMode((v) => !v); setTocOpen(false); setSettingsOpen(false); }}
            aria-label={annotationMode ? "Exit annotate mode" : "Annotate"}
            style={{
              minHeight: "2.75rem", minWidth: "2.75rem", display: "flex",
              alignItems: "center", justifyContent: "center",
              color:      annotationMode ? theme.accent : theme.muted,
              background: annotationMode ? `${theme.accent}1a` : "none",
              border: "none", cursor: "pointer", borderRadius: "0.5rem",
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ width: "1rem", height: "1rem" }}>
              <path d="M12 20h9" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {/* Audio reader */}
          <button
            onClick={() => setAudioOpen((v) => !v)}
            aria-label={audioOpen ? "Close audio reader" : "Read aloud"}
            style={{
              minHeight: "2.75rem", minWidth: "2.75rem", display: "flex",
              alignItems: "center", justifyContent: "center",
              color:      audioOpen ? theme.accent : theme.muted,
              background: audioOpen ? `${theme.accent}1a` : "none",
              border: "none", cursor: "pointer", borderRadius: "0.5rem",
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ width: "1rem", height: "1rem" }}>
              <path d="M3 18v-6a9 9 0 0 1 18 0v6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {iconBtn("Settings", () => { setSettingsOpen((v) => !v); setTocOpen(false); },
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ width: "1rem", height: "1rem" }}>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>,
          )}
          {iconBtn("Contents", () => { setTocOpen((v) => !v); setSettingsOpen(false); },
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ width: "1rem", height: "1rem" }}>
              <line x1="8" y1="6"  x2="21" y2="6"  strokeLinecap="round" />
              <line x1="8" y1="12" x2="21" y2="12" strokeLinecap="round" />
              <line x1="8" y1="18" x2="21" y2="18" strokeLinecap="round" />
              <line x1="3" y1="6"  x2="3.01" y2="6"  strokeLinecap="round" strokeWidth={2} />
              <line x1="3" y1="12" x2="3.01" y2="12" strokeLinecap="round" strokeWidth={2} />
              <line x1="3" y1="18" x2="3.01" y2="18" strokeLinecap="round" strokeWidth={2} />
            </svg>,
          )}
        </div>
      </header>

      {/* ── Page viewport — clips to one page at a time ── */}
      <div
        ref={containerRef}
        style={{
          flex: 1, overflow: "hidden", position: "relative",
          // Annotation mode: allow text selection; reading mode: fully locked
          userSelect:  annotationMode ? "text" : "none",
          touchAction: annotationMode ? "auto" : "none",
        }}
        onClick={onAreaClick}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {/* Dog-ear bookmark corner ─────────────────────────────────────────── */}
        {/* 48×48 tap target; CSS triangle border trick */}
        <button
          onClick={(e) => { e.stopPropagation(); toggleDogEar(); }}
          aria-label={isBookmarked ? "Remove bookmark" : "Bookmark this chapter"}
          style={{
            position: "absolute", top: 0, right: 0, zIndex: 20,
            width: 48, height: 48,
            background: "none", border: "none", padding: 0,
            cursor: "pointer",
            // Inner triangle
            display: "flex", alignItems: "flex-start", justifyContent: "flex-end",
          }}
        >
          <span style={{
            display: "block",
            width: 0, height: 0,
            borderStyle: "solid",
            borderWidth: "0 36px 36px 0",
            borderColor: `transparent ${isBookmarked ? theme.accent : theme.border} transparent transparent`,
            opacity: isBookmarked ? 1 : 0.45,
            transition: "border-color 0.2s, opacity 0.2s",
          }} />
        </button>
        {/* Invisible tap-zone hints */}
        <div style={{ position: "absolute", inset: 0, display: "flex", pointerEvents: "none", zIndex: 2 }}>
          <div style={{ width: "30%", height: "100%" }} />
          <div style={{ flex: 1, height: "100%" }} />
          <div style={{ width: "30%", height: "100%" }} />
        </div>

        {/* Column track — CSS multi-column, one column = one page              */}
        {/* position:absolute breaks it free of containerW width constraint      */}
        {/* overflow:hidden on the column track keeps extra empty cols clipped   */}
        {/* translateX jumps INSTANTLY (no transition) — body never moves        */}
        {/* Fade on opacity gives the clean Kindle page-cut feel                 */}
        <div
          ref={columnTrackRef}
          style={{
            position:    "absolute",
            top:         0,
            left:        0,
            // Large fixed width so CSS can create up to ~200 columns
            width:       columnWidth > 0 ? `${columnWidth * 400}px` : "100%",
            height:      containerH > 0 ? `${containerH}px` : "100%",
            // CSS multi-column: each column = columnWidth × containerH = one page
            // In landscape, columnWidth = containerW/2 → two columns fill the viewport
            columnWidth: columnWidth > 0 ? `${columnWidth}px` : "auto",
            columnGap:   0,
            columnFill:  "auto",
            overflow:    "hidden",
            // Instant jump — no slide, body stays completely still
            transform:   `translateX(${translateX}px)`,
            // Crossfade: fade out on flip start, fade in on flip end
            opacity:     isFlipping ? 0 : 1,
            transition:  isFlipping
              ? "opacity 0.14s ease-out"
              : "opacity 0.22s ease-in",
            willChange:  "opacity",
          }}
        >
          {/* Padding wrapper with box-decoration-break:clone so EVERY page      */}
          {/* fragment (column) gets its own top/bottom/left/right padding        */}
          <div
            style={{
              padding:                  "2.5rem max(1.5rem, 6vw) 2rem",
              boxDecorationBreak:       "clone",
              WebkitBoxDecorationBreak: "clone",
              // Text cursor in annotation mode signals to the user they can select
              userSelect: annotationMode ? "text" : "none",
              cursor:     annotationMode ? "text" : "default",
            } as React.CSSProperties}
          >
            {currentSection.kind === "copyright" && (
              <CopyrightView
                bookTitle={manifest.bookTitle}
                authorName={manifest.authorName}
                year={publishYear}
                theme={theme}
                fontFamily={fontFamily}
                fontSize={fontSize}
                lineHeight={lineHeight}
              />
            )}
            {(currentSection.kind === "frontmatter" || currentSection.kind === "about" || currentSection.kind === "custom") && (
              <FrontMatterView
                title={currentSection.kind === "about" ? "About the Author" : currentSection.title}
                body={currentSection.body}
                theme={theme}
                fontFamily={fontFamily}
                fontSize={fontSize}
                lineHeight={lineHeight}
                annotations={annotations}
                onWordTap={handleWordTap}
                audioParaKey={audioOpen ? audioParaKey : null}
                audioOpen={audioOpen}
              />
            )}
            {currentSection.kind === "backmatter" && manifest.backMatter && (
              <BackMatterView
                section={currentSection.key}
                backMatter={manifest.backMatter}
                theme={theme}
                fontFamily={fontFamily}
                fontSize={fontSize}
                lineHeight={lineHeight}
              />
            )}
            {currentSection.kind === "chapter" && (
              <ChapterView
                chapter={currentSection.chapter}
                theme={theme}
                fontFamily={fontFamily}
                fontSize={fontSize}
                lineHeight={lineHeight}
                annotations={annotations}
                onWordTap={handleWordTap}
                audioParaKey={audioOpen ? audioParaKey : null}
                audioOpen={audioOpen}
                bionicMode={settings.bionicMode}
              />
            )}
            {/* Sentinel: measures how many columns content spans */}
            <div ref={sentinelRef} style={{ height: "1px", width: "1px", display: "block" }} />
          </div>
        </div>

        {/* Right-edge shadow — subtle visual page boundary */}
        <div style={{
          position:   "absolute", top: 0, right: 0, bottom: 0, width: "3px",
          background: `linear-gradient(to left, ${theme.border}88, transparent)`,
          pointerEvents: "none", zIndex: 1,
        }} />

        {/* Two-page book gutter — landscape only */}
        {isLandscape && (
          <>
            {/* Soft inner shadow on both sides of the spine */}
            <div style={{
              position: "absolute", top: 0, bottom: 0,
              left: "calc(50% - 18px)", width: "36px",
              background: `linear-gradient(to right,
                transparent,
                ${theme.border}50 35%,
                ${theme.border}70 50%,
                ${theme.border}50 65%,
                transparent)`,
              pointerEvents: "none", zIndex: 3,
            }} />
            {/* Hard 1px center line */}
            <div style={{
              position: "absolute", top: 0, bottom: 0,
              left: "50%", width: "1px",
              background: `linear-gradient(to bottom,
                transparent 0%,
                ${theme.border}90 8%,
                ${theme.border}90 92%,
                transparent 100%)`,
              pointerEvents: "none", zIndex: 4,
            }} />
          </>
        )}
      </div>

      {/* ── Audio reader bar (sits between viewport and footer in flex column) ── */}
      {audioOpen && currentAudioChapter && (
        <AudioReader
          chapter={currentAudioChapter}
          bookTitle={manifest.bookTitle}
          readerHref={`/library/${slug}/read`}
          slug={slug}
          chapterAudioUrl={chapterAudioUrl}
          recordedSeekRequest={recordedSeekRequest}
          onRecordedParaKeyChange={chapterAudioUrl ? setAudioParaKey : undefined}
          theme={theme}
          fontFamily={fontFamily}
          onClose={() => setAudioOpen(false)}
        />
      )}

      {/* ── Bottom chrome ── */}
      <footer
        style={{
          flexShrink: 0, minHeight: CHROME_H,
          paddingBottom: "env(safe-area-inset-bottom)",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "0 1.25rem", background: theme.chrome,
          borderTop: `1px solid ${theme.chromeBorder}`,
          backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)",
          opacity, transition: "opacity 0.6s ease",
        }}
      >
        {/* Prev page */}
        <button
          onClick={() => triggerFlip("prev")}
          disabled={chapterIndex === 0 && pageIndex === 0}
          aria-label="Previous page"
          style={{
            minHeight: "2.75rem", minWidth: "2.75rem", display: "flex",
            alignItems: "center", justifyContent: "center",
            color: (chapterIndex === 0 && pageIndex === 0) ? theme.border : theme.muted,
            background: "none", border: "none",
            cursor: (chapterIndex === 0 && pageIndex === 0) ? "default" : "pointer",
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ width: "1.1rem", height: "1.1rem" }}>
            <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {/* Page indicator */}
        <div style={{ flex: 1, margin: "0 1rem", display: "flex", flexDirection: "column", alignItems: "center", gap: "0.3rem" }}>
          <div style={{ width: "100%", height: "2px", background: theme.border, borderRadius: "1px" }}>
            <div style={{
              height: "100%", background: theme.accent, borderRadius: "1px",
              width: `${globalProgress}%`, transition: "width 0.45s ease",
            }} />
          </div>
          <p style={{ fontSize: "0.67rem", color: theme.muted, fontFamily }}>
            {isLandscape && totalPages > 1
              ? `Spread ${pageIndex + 1} of ${totalPages} · ${chapterIndex + 1}/${totalSections}`
              : totalPages > 1
              ? `Page ${pageIndex + 1} of ${totalPages} · ${chapterIndex + 1}/${totalSections}`
              : `${chapterIndex + 1} of ${totalSections}`}
            {" · "}
            {(() => {
              // Count words in current chapter from actual content
              const sec = currentSection;
              const chWordCount = sec.kind === "chapter"
                ? [sec.chapter.title, sec.chapter.intro ?? "", ...sec.chapter.sections.map(s => s.body)]
                    .join(" ").split(/\s+/).filter(Boolean).length
                : 0;
              if (chWordCount < 50) return null;
              const chPct = (pageIndex + 1) / Math.max(1, totalPages);
              const wordsLeft = Math.round(chWordCount * (1 - chPct));
              const minsLeft  = Math.ceil(wordsLeft / 200);
              return minsLeft <= 1 ? "< 1 min left" : `~${minsLeft} min left`;
            })()}
          </p>
        </div>

        <button
          onClick={() => triggerFlip("next")}
          disabled={chapterIndex >= totalSections - 1 && pageIndex >= totalPages - 1}
          aria-label="Next page"
          style={{
            minHeight: "2.75rem", minWidth: "2.75rem", display: "flex",
            alignItems: "center", justifyContent: "center",
            color: (chapterIndex >= totalSections - 1 && pageIndex >= totalPages - 1) ? theme.border : theme.muted,
            background: "none", border: "none",
            cursor: (chapterIndex >= totalSections - 1 && pageIndex >= totalPages - 1) ? "default" : "pointer",
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ width: "1.1rem", height: "1.1rem" }}>
            <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </footer>



      {/* ── Selection popup ── */}
      {annotationMode && selection && (
        <>
          {/* Full-screen backdrop: pointer down anywhere outside the popup cancels it */}
          <div
            style={{ position: "fixed", inset: 0, zIndex: 60 }}
            onPointerDown={(e) => {
              e.stopPropagation();
              setSelection(null);
              setAnnoNote("");
              window.getSelection()?.removeAllRanges();
            }}
          />
          <SelectionPopup
            selection={selection}
            color={annoColor}
            note={annoNote}
            onColorChange={setAnnoColor}
            onNoteChange={setAnnoNote}
            onSave={() => {
              saveAnnotation({
                id:           crypto.randomUUID(),
                slug,
                chapterIndex,
                chapterTitle: currentSection.kind === "chapter" ? currentSection.chapter.title : sectionLabel,
                selectedText: selection.text,
                note:         annoNote,
                color:        annoColor,
                createdAt:    Date.now(),
              });
              reloadAnnotations();
              setSelection(null);
              setAnnoNote("");
              window.getSelection()?.removeAllRanges();
            }}
            onCancel={() => {
              setSelection(null);
              setAnnoNote("");
              window.getSelection()?.removeAllRanges();
            }}
            t={theme}
            fontFamily={fontFamily}
          />
        </>
      )}

      {/* ── Overlays ── */}
      <ChapterDrawer
        items={tocItems}
        currentIndex={chapterIndex}
        open={tocOpen}
        onClose={() => setTocOpen(false)}
        onSelect={(i) => { goToChapter(i); setTocOpen(false); }}
        t={theme}
        fontFamily={fontFamily}
      />
      <ReaderSettingsPanel
        settings={settings}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onChange={updateSettings}
        t={theme}
        fontFamily={fontFamily}
      />
      <AnnotationsPanel
        slug={slug}
        open={annoPanelOpen}
        onClose={() => setAnnoPanelOpen(false)}
        t={theme}
        fontFamily={fontFamily}
      />
    </div>
  );
}
