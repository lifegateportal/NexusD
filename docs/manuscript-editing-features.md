# Ebook Manuscript Editing Features

This document outlines the manuscript tools that give you complete control over your ebook manuscript.

## 0. NexusLM Change Control ✅ COMPLETED

**Location:** Ebook workspace → NexusLM tab

NexusLM manuscript edits now use a **preview → approve → undo** workflow:

- Open the NexusLM tab and choose **Edit / Enrich**
- Ask NexusLM to make an edit in natural language
- Review the proposed fields before anything changes
- Toggle individual changes on or off
- Use **View diff** to compare before and after text
- Select **Apply selected**, **Apply all**, or **Reject**
- Use **Undo** to restore the previous approved manuscript
- Open **NexusLM change history** to review the assistant's saved edit timeline

The approval request uses optimistic version locking. If another tab changes the book while a proposal is open, the proposal is rejected and a fresh preview is required.

The previous manifest is saved in the current browser's ebook workspace storage, while the applied summary remains in the manifest's rolling `changeLog`. Manual manuscript saves and pipeline checkpoints continue to use the existing project persistence flow.

## General-purpose NexusLM chat ✅ COMPLETED

**Location:** Ebook workspace → NexusLM tab

NexusLM is not limited to book questions. Use the same composer for:

- General conversation, explanations, brainstorming, writing, rewriting, planning, analysis, translation, and coding guidance
- Markdown responses with headings, lists, links, quotes, and code blocks
- Text, Markdown, CSV, JSON, YAML, source-file, HTML, and PDF attachments (up to 8 files; text/HTML files up to 6 MB and PDFs up to 20 MB)
- Long-document processing with relevant-section retrieval by default and an explicit **Read every section** control for transcript-wide summaries, themes, reviews, and analysis
- In-app document previews for text/Markdown, sandboxed HTML, and extracted PDFs
- Saved chat workspaces in browser storage with **New chat**, chat switching, renaming, deletion, and persistent document context for follow-up questions
- Streaming responses with **Stop**, **Retry**, **Copy**, and Markdown/TXT/HTML export controls
- **Long-form chapter** responses for complete chapters, essays, reports, and other substantial work. Requests that clearly ask for a chapter or manuscript automatically use the larger response budget unless a shorter response is explicitly selected.
- A browser-persisted **Manuscript workspace** that can capture any assistant response as a chapter, preserve its raw Markdown/rich content, reorder or edit chapters, and assemble them into a direct-download PDF without opening Book Studio.
- Direct PDF generation through `/api/nexuslm/export`, with strict validation for title metadata, ordered chapters, templates, and payload size. A Generate PDF request can use the latest assistant response when no chapter has been saved yet.
- Generated HTML remains a first-class artifact: use **Preview** on an HTML code block to render it directly in the app. From the preview, download the original HTML, an exact browser-rendered PDF, or a **Visual DOCX**. The PDF preserves the original HTML/CSS layout, colors, typography, spacing, borders, backgrounds, and embedded data-URI images. Visual DOCX places those rendered pages into Word as page-sized images so the appearance is preserved; it is not ordinary editable Word text.
- The chat composer keeps **Context** and the **Nexus agent** in the active chat box, with persona, writing form, response length, mode, temperature, and response exports grouped under **Customize**. The side workspace is reserved for saved chats, previews, manuscript assembly, transcripts, and consulted sources.

Use the **Context** control to choose:

- **Auto:** use connected manuscript/transcript context when available; otherwise use general chat
- **General:** ignore the connected book and have a normal assistant conversation
- **Book:** use manuscript/transcript context and source-grounded book workflows when a book is connected

NexusLM uses only the configured **DeepSeek Chat** and **DeepSeek Reasoner** agents. Manuscript edits remain approval-gated through the preview, diff, version-lock, and undo workflow above. Web search, arbitrary code execution, and automatic external actions are not enabled by this chat surface.

General conversation accepts the user's instruction directly without requiring a NexusLM mode. Requests such as writing a chapter, drafting an article, revising text, creating HTML, or generating code are handled as ordinary assistant requests. If **Book** is selected without a connected manuscript or transcript, NexusLM falls back to general conversation instead of redirecting the user.

Book-mode Scripture is user-directed rather than locked to one sermon template. Ask for every passage in standalone blockquotes when that is the desired presentation; ask for inline citations, lists, devotional prose, or another form when that better fits the chapter. Scripture wording remains source-grounded, and unavailable-provider notices are never presented as Bible text.

### Long-form and format-preserving workflow

1. Choose **General** (or leave Context on **Auto** without a connected book).
2. Select **Long-form chapter**, or ask directly for a complete chapter/manuscript. NexusLM writes the requested work instead of replacing it with an outline or instructions.
3. Use **Add as chapter** on an assistant response, or use **Add latest response** in the Manuscript workspace.
4. Edit the title, author, chapter order, and raw chapter content in the workspace. The stored chapter content is not sanitized into a fixed prose template.
5. Choose **Generate PDF** for a traditional book proof assembled from the chapters.
6. If the response contains assistant-designed HTML/CSS, choose **Preview design** or the code block's **Preview** button. The preview renders the HTML directly and provides the original HTML, exact PDF, and Visual DOCX downloads. Use **Print / Save PDF (exact)** when the design depends on browser scripts or externally hosted assets; server exports intentionally disable scripts and external network requests for safe, deterministic rendering.

The export paths are intentional. Traditional chapter-based PDF/DOCX generation remains available for editable/readable manuscript content. HTML exports use the original design instead of converting it to plain text: the PDF is rendered by Chromium, while the Visual DOCX uses page images because Word cannot reproduce arbitrary browser CSS as editable document structure. HTML exports are limited to 2 MB per request and 120,000 CSS pixels of rendered height; split very long designs into multiple artifacts.

## 1. Audio Source Manager ✅ COMPLETED

**Location:** Pipeline → Review section → Audio Sources tab

**Capabilities:**
- View all 6 audio source slots with their transcription status
- Upload new transcript files (.txt, .md) to replace existing transcripts
- **Regenerate and restructure chapters** - automatically adjusts section count based on transcript content
- Manually edit transcript text for any source
- Remove audio sources from the pipeline
- Real-time word count tracking
- Status indicators (idle, transcribing, regenerating, complete, error)
- Section assignment counter shows how many sections use each source

**Usage:**
1. Complete the initial pipeline to generate your manuscript
2. Go to the review section and click "Audio Sources" tab
3. Select any audio slot to manage it
4. **Upload new transcript:** Upload a .txt or .md file and click "Regenerate"
5. **Regenerate & restructure:** Click "Regenerate & Restructure" to rebuild chapters with optimal section count
6. **Edit manually:** Directly edit the transcript text in the editor
7. **Remove:** Delete a source from the pipeline entirely
8. Changes take effect immediately after regeneration completes

**How It Works:**
- Each slot tracks its transcript, status, and assigned section count
- Regenerate creates a new content map from the filtered transcript
- Finds affected chapters and re-architects them with hybrid content (keeps other sources, replaces this source)
- **Automatically determines optimal section count** - may add sections if transcript has more content, or remove sections if less
- Only chapters using that source are restructured - other chapters remain unchanged
- The manuscript is updated in real-time without full pipeline rerun
- Manual transcript edits persist until regeneration is triggered

## 2. Manual Section/Chapter Insertion

**Location:** Edit Manuscript tab → Chapters section

**Capabilities:**
- Add new chapters at any position
- Add new sections within chapters
- Full control over section ordering
- Delete chapters or sections
- Each section has independent heading and body

**Usage:**
1. Go to "Edit Manuscript" tab
2. Select "Chapters" from the top menu
3. Click "+ Add Chapter" to insert a new chapter
4. Within a chapter, click "+ Add Section" to add sections
5. Edit heading and body for each section
6. Delete unwanted chapters/sections with the Delete button

## 3. Complete Manuscript Editor

**Location:** Edit Manuscript tab (new tab in ebook workspace)

**What's Editable:**

### Book Metadata
- Book Title
- Subtitle  
- Author Name

### Front Matter
- Preface
- Introduction
- Conclusion
- About the Author
- Resources List

### Chapters (for each chapter)
- Chapter Title
- Chapter Intro (opening statement)
- Epigraph (opening scripture/quote)
- All section headings and bodies
- Forward Question (bridge to next chapter)
- Key Takeaways (bullet list)
- Reflection Questions (bullet list)

### Back Matter
- Recommended Resources
- Glossary Terms
- Scripture Index (auto-generated, manual override available)

## How the Changes Flow to PDF

Every field edited in the Manuscript Editor directly maps to the PDF export:

| UI Field | PDF Location |
|----------|-------------|
| Book Title | Title page, headers, copyright page |
| Subtitle | Title page |
| Author Name | Title page, copyright page, "About the Author" |
| Preface | Preface section (recto-forced) |
| Introduction | Introduction section (recto-forced) |
| Chapter Title | Chapter opener page, running header |
| Chapter Intro | First paragraph(s) of chapter |
| Epigraph | Quote block before chapter body |
| Section Heading | Section subheadings within chapter |
| Section Body | Main chapter content |
| Forward Question | Chapter closing |
| Key Takeaways | Sidebar/callout box at chapter end |
| Reflection Questions | Discussion guide at chapter end |
| Conclusion | Conclusion section |
| About the Author | About the Author page |
| Resources List | Resources appendix |
| Glossary | Glossary appendix |

## Workflow

### Standard Editing Workflow
1. Run the pipeline to generate the initial manuscript
2. Review the generated content
3. Switch to "Edit Manuscript" tab
4. Make any needed corrections:
   - Fix book metadata
   - Refine front/back matter
   - Edit chapter content
   - Add/remove sections as needed
5. Click "Save" to persist changes to your project
6. Export to PDF/EPUB to see your edits

### Regenerate Workflow
1. Complete initial pipeline to generate manuscript
2. Go to Pipeline → Review → **Audio Sources** tab
3. Identify audio source that needs updating
4. Click the slot to open management controls
5. See section count badge showing how many sections use this source
6. **Option A:** Upload new transcript file (.txt, .md) → click "Regenerate"
7. **Option B:** Click "Regenerate & Restructure" to rebuild chapters using current transcript
8. **Option C:** Edit transcript text manually in the editor
9. Pipeline automatically:
   - Filters the transcript
   - Creates a content map from the new transcript
   - Finds affected chapters
   - Re-architects each chapter with hybrid content map
   - **Determines optimal section count** (may add or remove sections)
   - Writes all sections in the new structure
   - Updates the manifest in real-time
10. Review updated manuscript in Edit Manuscript tab

**Example:** Chapter 5 had 3 sections using Slot-2. After uploading a more detailed transcript, regeneration restructures Chapter 5 to have 6 sections with better content distribution.

## Key Benefits

1. **No More Full Pipeline Reruns**: Fix individual audio sources without reprocessing everything
2. **Manual Content Control**: Insert custom sections, testimonies, or commentary anywhere
3. **Every PDF Element is Editable**: Nothing in the final book is locked - you have complete control
4. **Non-Destructive Editing**: Original pipeline output is preserved, edits are tracked separately
5. **Fast Iterations**: Make quick fixes and re-export without waiting for full regeneration

## Technical Notes

### Audio Source Architecture
- 6 audio source slots (Slot-1 through Slot-6)
- Each slot can contain: audio file, transcript file, or both
- Transcripts stored in `sourceTranscripts` state array
- Section assignments link sections to source IDs via `sourceSegmentIds`
- Regeneration is targeted: only rewrites sections assigned to that source

### Regeneration Process
1. **Read transcript:** From uploaded file or existing state
2. **Filter:** Calls `/api/ebook/filter-signal` to clean transcript
3. **Content map:** Analyzes new transcript structure via `/api/ebook/content-map`
4. **Find affected chapters:** Searches for chapters using this source
5. **Re-architect:** For each chapter, calls `/api/ebook/architect` with hybrid content map
6. **Determine sections:** Architect decides optimal section count based on content
7. **Write sections:** Calls `/api/ebook/write-section` for each section in new structure
8. **Update manifest:** Replaces chapter structure with new sections
9. **Status tracking:** Updates from "regenerating" to "complete" or "error"

**Key Innovation:** The architect phase runs per-chapter with a hybrid content map that keeps segments from other sources but replaces segments from the regenerating source. This allows the chapter to be restructured with the right number of sections for the new content.

### Status States
- **idle:** No content assigned to this slot
- **transcribing:** Deepgram API call in progress (initial pipeline only)
- **regenerating:** Filtering and rewriting sections in progress
- **complete:** Transcript ready and sections up to date
- **error:** Transcription or regeneration failed

### Performance
- Regeneration avoids full pipeline rerun (saves time and API costs)
- Only affected sections are rewritten (preserves unrelated content)
- Manual edits persist until explicit regeneration

### Editing System
- All edits are stored in the EbookManifest structure
- Manifest is saved to IndexedDB when you save the project
- The PDF generator reads directly from the manifest, so all edits appear immediately in exports
- Undo/Redo is available at the section level in the Transcript Source Map Panel
- Chapter/section deletion includes confirmation prompts to prevent accidents

## Implementation Status

| Feature | Status | Location |
|---------|--------|----------|
| Audio Source Manager | ✅ Complete | Pipeline → Review → Audio Sources tab |
| Manual Section/Chapter Insertion | ✅ Complete | Edit Manuscript → Chapters |
| Complete Manuscript Editor | ✅ Complete | Edit Manuscript tab |

All three features are fully implemented and ready to use.
