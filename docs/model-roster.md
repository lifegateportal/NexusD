# Nexus Director — AI Model Roster

> **Last updated:** July 25, 2026  
> All models are served through the DeepSeek API (`https://api.deepseek.com/v1`).

---

## `deepseek-reasoner` — R1 (Deep Reasoning)

Used where the task requires structural thinking, multi-step planning, or editorial judgment across a full manuscript. Slower, but produces architecturally sound decisions.

| Route | What it does |
|---|---|
| **architect** | Designs the full book structure — chapters, sections, thematic arc |
| **chapter-plan** | Assigns transcript excerpts to each section of a chapter |
| **apply-audit** | Applies editorial corrections across the manuscript |
| **audit** | Reviews the full manuscript for quality, consistency, and gaps |
| **backmatter** | Generates notes, bibliography, acknowledgments |
| **frontmatter** | Writes the preface, introduction, and about-the-author |
| **ingest** | Processes raw transcript uploads into structured data |
| **produce** | Orchestrates the final compilation of the completed book |
| **sermon-assistant** | Provides deep structural guidance for sermon-to-book work |
| **assistant** *(structural ops)* | Handles complex structural questions in the AI chat |
| **ebook/assistant** *(structural ops)* | Same, scoped to the ebook pipeline context |

---

## `deepseek-chat` — Standard Generation

Used for creative writing, formatting, editorial tasks, and other standard DeepSeek operations.

| Route | What it does |
|---|---|
| **write-section** | Writes each individual section of a chapter from transcript excerpts |
| **write-chapter** | Drafts a full chapter in single-pass mode |
| **content-map** | Maps themes and content across the entire book |
| **format** | Applies professional typographic formatting to finished prose |
| **polish** | Adds chapter intros, key takeaways, reflection questions, and section transitions |
| **coherence** | Checks and improves logical flow between chapters |
| **rewrite-section** | Rewrites a specific section based on user feedback |
| **heading-review** | Reviews and tightens all section headings |
| **scripture-suggest** | Recommends relevant Bible passages based on chapter themes |
| **generate-ui** | Generates UI component specs |
| **generate-logic** | Generates business logic from descriptions |
| **assistant** *(general ops)* | Handles standard questions in the AI chat |
| **ebook/assistant** *(general ops)* | Same, scoped to ebook context |

---

## `deepseek-chat` — Lightweight Extraction

Used for fast, high-volume extraction tasks that don't need the full V3 model.

| Route | What it does |
|---|---|
| **filter-signal** | Strips filler words, crosstalk, and non-teaching content from raw transcripts |
| **voice-dna** | Extracts the author's voice fingerprint — signature phrases, tone, preferred terms |

---

## Defined but not active in any route

| Variable | Model string | Notes |
|---|---|---|
| `geminiModel` | `gemini-2.0-flash` | Available if needed |
| `claudeModel` | `claude-haiku-4-5` | Available if needed |
| `curatorModel` | `claude-sonnet-4-5` | Available if needed |

---

## Quick rule of thumb

| Task type | Model to use |
|---|---|
| Planning, architecture, audit, reasoning | `deepseek-reasoner` (R1) |
| Writing, formatting, editing, generating | `deepseek-chat` |
| Fast extraction, filtering, classification | `deepseek-chat` |
