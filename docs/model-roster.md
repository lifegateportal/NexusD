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
| **sermon-assistant** | Provides deep structural guidance for sermon-to-book work |
| **ebook/assistant** *(structural ops)* | Handles complex structural questions in the ebook pipeline context |

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
| **assistant** *(Academy)* | Edits Academy content, presentation, and site configuration |
| **ebook/assistant** *(general ops)* | Handles standard questions in the ebook AI chat |
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

## Academy pipeline

The Academy pipeline is intentionally pinned to `deepseek-chat` (DeepSeek Chat v3)
for every AI stage, independent of the `DEEPSEEK_MODEL` override used by other
workspaces:

| Academy stage | Route |
|---|---|
| Ingest / blueprint | `/api/ingest` |
| Logic graph | `/api/generate-logic` |
| UI manifest | `/api/generate-ui` |
| Academy production | `/api/produce` |
| Director edits | `/api/assistant` |

Academy prompts provide the model with the complete available context and treat
delivery instructions as first-class creative direction. Schema validation and
server-side patch merging remain in place for reliable output handling.

## Coding pipeline

The dedicated `/coding` workspace is isolated from the Ebook and NexusLM
pipelines. It uses only the explicit DeepSeek models:

| Coding task | Model |
|---|---|
| Build, debug, review, explain, and ordinary implementation | `deepseek-chat` |
| User-selected difficult reasoning or architecture work | `deepseek-reasoner` |

The coding workspace defaults to `deepseek-chat`. Selecting R1 is an explicit
per-conversation choice and does not change the model policy of any other
workspace.

Coding workspaces keep their source tree in an isolated revision store under
the `coding-workspaces/` object prefix. Nexus Code applies generated file
changes automatically to a new revision so the trust-the-LLM workflow remains
fast, while every revision can be reverted from the coding workspace. Generated
code is never executed inside the Next.js web process. Execution requires the
optional isolated runner configured with `CODING_RUNNER_URL` and
`CODING_RUNNER_TOKEN`.

Nexus Code also supports targeted edits through exact `nexus-patch`
search/replace blocks. A patch must match one existing location; ambiguous or
missing matches fail visibly instead of silently changing the wrong code.

The runner implementation lives in [`coding-runner/`](../coding-runner/). It
accepts a revision, starts an ephemeral Docker sandbox with network disabled by
default, and returns a queued run for polling. Keep the runner on a dedicated
host or VM because access to `/var/run/docker.sock` is equivalent to host
administrative access.
