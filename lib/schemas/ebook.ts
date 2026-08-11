import { z } from "zod";

// ─── Quote / Scripture Reference ────────────────────────────────────────────

export const QuoteSchema = z.object({
  id: z.string(),
  text: z.string(),
  reference: z.string(),       // "John 3:16" | "Author Name, Book Title, Year" | ""
  translation: z.string(),     // "NIV" | "KJV" | "ESV" | "" for non-scripture
  type: z.enum(["scripture", "quote", "proverb"]),
  isBlockQuote: z.boolean(),   // true when 40+ words (Chicago Manual of Style)
});

// ─── Voice DNA ───────────────────────────────────────────────────────────────

export const VoiceDNASchema = z.object({
  // ── Core voice fingerprint ──────────────────────────────────────────────
  signaturePhrases: z.array(z.string()).default([]),        // exact repeated phrases, verbal stamps (max 8)
  preferredTerminology: z.array(z.string()).default([]),   // domain vocabulary the author uses consistently (max 10)
  toneProfile: z.string().default(""),                      // emotional/relational tone, e.g. "pastoral, direct, warm"
  sentencePattern: z.enum(["short-punchy", "long-explanatory", "mixed"]).default("mixed"),
  rhetoricalPatterns: z.array(z.string()).default([]),      // teaching devices e.g. "repeats key point three times" (max 6)
  teachingStyle: z.string().default(""),                    // how they open topics, develop arguments, and land points
  avoidWords: z.array(z.string()).default([]),              // forbidden words list incl. AI clichés (max 30)
  // ── Industry upgrade: 8 precision fields ───────────────────────────────
  /** Vocabulary register: granularity beyond tone */
  vocabularyLevel: z.enum(["conversational", "pastoral", "academic", "technical"]).default("conversational"),
  /** Rhythm / momentum signature, e.g. "slow build then rapid-fire landing" */
  pacingFingerprint: z.string().default(""),
  /** How the author structures stories, e.g. "opens mid-scene, extracts principle after" */
  narrativeDevice: z.string().default(""),
  /** Emotional modulation arc, e.g. "opens with challenge, builds conviction, releases into hope" */
  emotionalArc: z.string().default(""),
  /** Community-specific idioms that authenticate voice, must appear verbatim (max 10) */
  vernacularMarkers: z.array(z.string()).default([]),
  /** Forbidden sentence-level structural patterns, e.g. "never stacks 3 rhetorical questions" (max 10) */
  avoidStructures: z.array(z.string()).default([]),
  /** How the author launches new points, e.g. "poses question then answers it" */
  openingPattern: z.string().default(""),
  /** How the author lands points, e.g. "restates core with a twist, ends on imperative" */
  closingPattern: z.string().default(""),
});

// ─── Content Segment ─────────────────────────────────────────────────────────

export const ContentSegmentSchema = z.object({
  id: z.string(),
  sourceAudio: z.enum(["audio-1", "audio-2", "audio-3", "audio-4", "audio-5", "audio-6", "audio-7", "audio-8", "audio-9", "audio-10"]),
  topic: z.string(),
  rawText: z.string(),                          // the actual transcript excerpt
  keyPoints: z.array(z.string()).default([]),               // points explicitly made in this segment
  quotes: z.array(QuoteSchema).default([]),     // any scripture/quotes in this segment
  estimatedWordCount: z.number(),
});

// ─── Content Map ─────────────────────────────────────────────────────────────

export const ContentMapSchema = z.object({
  totalEstimatedWords: z.number(),
  overarchingThemes: z.array(z.string()).default([]),
  teachingArc: z.string().default(""),            // how the full teaching flows
  coreThesis: z.string().default(""),
  targetAudience: z.string().default(""),
  uniqueVocabulary: z.array(z.string()).default([]),
  toneMap: z.string().default(""),
  segments: z.array(ContentSegmentSchema),
  allQuotes: z.array(QuoteSchema).default([]), // full quote/scripture registry
});

// ─── Section Blueprint (from architect) ──────────────────────────────────────

export const SectionBlueprintSchema = z.object({
  sectionNumber: z.number(),
  heading: z.string(),
  sourceSegmentIds: z.array(z.string()),        // which ContentSegment IDs feed this section
  keyPoints: z.array(z.string()).default([]),               // from the actual content
  quotesInSection: z.array(QuoteSchema).default([]),
  targetWordCount: z.number(),                  // determined by available content
  // ── Upgrade 1: Arc role tag ────────────────────────────────────────────
  arcRole: z.enum(["hook", "context", "mechanism", "application", "untagged"]).default("untagged"),
});

// ─── Chapter Blueprint ────────────────────────────────────────────────────────

export const ChapterBlueprintSchema = z.object({
  number: z.number(),
  title: z.string(),                            // derived from the author's own words
  sourceSegmentIds: z.array(z.string()),
  sections: z.array(SectionBlueprintSchema),
  keyTheme: z.string(),
  quotesInChapter: z.array(QuoteSchema).default([]),
  // ── Upgrade 5: Chapter premise line ───────────────────────────────────
  chapterPremise: z.string().default(""),       // one-sentence north star written at blueprint time
  // ── Upgrade 1: Arc balance flags ──────────────────────────────────────
  arcFlags: z.array(z.string()).default([]),    // warnings when arc roles are missing or imbalanced
});

// ─── Series Arc Entry ─────────────────────────────────────────────────────────

export const SeriesArcEntrySchema = z.object({
  fromChapter: z.number(),
  toChapter: z.number(),
  bridgeConcept: z.string(),                   // the thematic thread that connects the two chapters
});

// ─── Book Architecture ────────────────────────────────────────────────────────

export const BookArchitectureSchema = z.object({
  bookTitle: z.string(),
  subtitle: z.string(),
  authorName: z.string(),                       // if mentioned in audio; else "the author"
  estimatedTotalWords: z.number(),
  chapters: z.array(ChapterBlueprintSchema),
  frontMatterNotes: z.string(),                 // what the author said in opening
  backMatterNotes: z.string(),                  // what the author said in closing
  // ── Upgrade 7: Series arc connective tissue map ────────────────────────
  seriesArc: z.array(SeriesArcEntrySchema).default([]),
  // ── Upgrade 6: Orphan segment log ─────────────────────────────────────
  droppedSegments: z.array(z.string()).default([]), // segment IDs too thin to assign (<150 words)
});

// ─── Section Assignment (input to write-section) ─────────────────────────────

export const SectionAssignmentSchema = z.object({
  chapterNumber: z.number(),
  chapterTitle: z.string(),
  sectionNumber: z.number(),
  heading: z.string(),
  transcriptExcerpts: z.array(z.string()).default([]),      // raw transcript text to write from
  quotes: z.array(QuoteSchema).default([]),
  keyPoints: z.array(z.string()).default([]),
  voiceDNA: VoiceDNASchema,
  previousSectionEnding: z.string(),           // last 2 paragraphs of previous section
  nextSectionHeading: z.string().optional(),   // heading of the next section for forward bridge
  targetWordCount: z.number(),
  alreadyCoveredPoints: z.array(z.string()).default([]), // key points covered in earlier sections — do NOT repeat
  alreadyQuotedRefs: z.array(z.string()).default([]),   // scripture/quote references already reproduced in full — reference only, do not quote again
  isLastSectionInChapter: z.boolean().optional(),       // true when this section closes the chapter — enables hard chapter boundary enforcement
  nextChapterTitle: z.string().optional(),              // title of the next chapter — writer must not begin developing its theme
  // ── Upgrade 1: Transcript segment locking ────────────────────────────────
  sourceSegmentIds: z.array(z.string()).default([]),    // content segment IDs that feed this section
  consumedSegmentIds: z.array(z.string()).default([]),  // segment IDs fully consumed by earlier sections — excerpts filtered before reaching LLM
  // ── Upgrade 5: Canonical concept ownership map ───────────────────────────
  conceptOwnershipMap: z.record(z.string(), z.number()).default({}), // concept label → chapter number that owns it
  // ── Upgrade 7: Tiered quote dedup ────────────────────────────────────────
  forbiddenVerseTexts: z.array(z.string()).default([]), // exact verse texts already quoted in full — hard ban on re-printing
  allowedInlineOnly: z.array(z.string()).default([]),   // refs where only a brief inline mention is allowed (no full re-quote)
  // ── S7: Chapter premise anchor ───────────────────────────────────────────
  chapterPremise: z.string().optional(),                // one-sentence north star; first paragraph should echo it
  // ── Upgrade 3: Book thesis threading ─────────────────────────────────────
  coreThesis: z.string().optional(),                    // book's central thesis from content map — thread through every section
  // ── Upgrade 4: Illustration / story dedup ────────────────────────────────
  usedIllustrations: z.array(z.string()).default([]),   // story/illustration titles already used in earlier sections
  // ── Scripture Amendment 4: Primary translation consistency ───────────────
  primaryTranslation: z.string().optional(),            // dominant Bible translation for this book (e.g. "NIV") — default for unspecified verses
  // ── 7-Amendment Anti-Duplication System ─────────────────────────────────
  /** Amendment 1 — Coverage ledger: heading + 1-sentence summary of every written section */
  coverageLedger: z.array(z.object({ heading: z.string(), summary: z.string() })).default([]),
  /** Amendment 4 — Banned recaps: opening thesis sentence from each prior section — must not be paraphrased */
  bannedRecaps: z.array(z.string()).default([]),
  /** Amendment 6 — Lexical fingerprint: top repeated 3-grams across the written corpus — find fresher language */
  overusedPhrases: z.array(z.string()).default([]),
  /** Amendment 7 — Section index within its chapter (0-based) — drives the diminishing novelty cap */
  sectionIndexInChapter: z.number().int().default(0),
  // ── 7-Amendment Speaker-Sequence System ──────────────────────────────────
  /** Seq-A3 — Argument pivot phrases extracted from the excerpts (e.g. "now watch this", "but here's the thing") */
  sequenceTurns: z.array(z.string()).default([]),
  /** Seq-A4 — Story setup → principle landing pairs extracted from excerpts so setup always precedes payoff */
  storyPayoffPairs: z.array(z.object({ setup: z.string(), principle: z.string() })).default([]),
  /** Seq-A5 — Scripture positions: which excerpt index (0-based) each reference first appears in */
  scripturePositions: z.array(z.object({ reference: z.string(), excerptIndex: z.number().int() })).default([]),
  /** Seq-A7 — Last 2 sentences of the final excerpt from the previous section — the argument was mid-flow here */
  priorExcerptTail: z.string().optional(),
  /** Prose dedup corpus — first sentence of every paragraph from all previously written sections.
   *  Used by filterConsumedExcerpts and the planner prune for prose-vs-prose n-gram comparison.
   *  This is the primary signal that the excerpt filter was missing: actual written text, not metadata. */
  priorSectionsSample: z.array(z.string()).default([]),
  /** Chapter-level pre-computed paragraph plan — produced by /api/ebook/chapter-plan before the
   *  writing loop starts. When present, write-section skips its own per-section planner entirely
   *  and uses this plan directly. This is the key dedup contract: the chapter planner assigns
   *  each concept to exactly one section, so two sections can never plan the same content. */
  assignedPlan: z.array(z.object({
    purpose: z.string().default(""),
    supportedExcerptNumbers: z.array(z.number().int().positive()).default([]),
    minExcerptNumber: z.number().int().positive().optional(),
  })).optional(),
});

// ─── Chapter Plan (input/output of /api/ebook/chapter-plan) ──────────────────

export const ChapterPlanSectionInputSchema = z.object({
  sectionNumber: z.number().int(),
  heading: z.string(),
  keyPoints: z.array(z.string()).default([]),
  transcriptExcerpts: z.array(z.string()).default([]),
  nextSectionHeading: z.string().optional(),
  isLastSectionInChapter: z.boolean().optional(),
});

export const ChapterPlanRequestSchema = z.object({
  chapterNumber: z.number().int(),
  chapterTitle: z.string(),
  nextChapterTitle: z.string().optional(),
  coreThesis: z.string().optional(),
  voiceDNA: VoiceDNASchema.optional(),
  alreadyCoveredPoints: z.array(z.string()).default([]),
  priorSectionsSample: z.array(z.string()).default([]),
  sections: z.array(ChapterPlanSectionInputSchema),
});

export const ChapterPlanResponseSchema = z.object({
  sectionPlans: z.array(z.object({
    sectionNumber: z.number().int(),
    paragraphPlan: z.array(z.object({
      purpose: z.string().default(""),
      supportedExcerptNumbers: z.array(z.number().int().positive()).default([]),
      minExcerptNumber: z.number().int().positive().optional(),
    })).default([]),
  })),
});

// ─── Section Draft (output of write-section) ─────────────────────────────────

export const SectionDraftSchema = z.object({
  chapterNumber: z.number().default(0),  // optional when nested inside a ChapterDraft
  sectionNumber: z.number().default(0),
  heading: z.string().default(""),
  body: z.string().default(""),
  wordCount: z.number().default(0),
  status: z.enum(["pending", "writing", "complete", "failed"]).default("pending"),
});

// ─── Chapter Polish Input ─────────────────────────────────────────────────────

export const ChapterPolishInputSchema = z.object({
  number: z.number(),
  title: z.string(),
  sections: z.array(SectionDraftSchema),
  chapterSegmentTexts: z.array(z.string()),     // raw transcript for this chapter
  voiceDNA: VoiceDNASchema,
  quotesInChapter: z.array(QuoteSchema).default([]),
  primaryTranslation: z.string().optional(),    // dominant Bible translation for this book — fallback when a quote candidate has no translation recorded
  previousChapterForwardQuestion: z.string().optional(), // forward question from the preceding chapter for arc connective tissue
  // ── Upgrade 5: Chapter premise line from architect ────────────────────────
  chapterPremise: z.string().optional(),         // one-sentence north star for this chapter's intro/conclusion
  // ── Upgrade 7: Series arc bridge concept ─────────────────────────────────
  seriesArcBridge: z.string().optional(),        // keyword thread this chapter picks up from the previous
  // ── Amendment 6: Next chapter title for forward question grounding ────────
  nextChapterTitle: z.string().optional(),       // title of the next chapter — forward question should anticipate it
});

// ─── Chapter Draft (output of polish) ────────────────────────────────────────

export const ChapterDraftSchema = z.object({
  number: z.number(),
  title: z.string().default(""),
  intro: z.string().default(""),          // consolidated opener: bold premise + provocative question (2 sentences)
  epigraph: z.string().default(""),        // opening scripture/quote set before body text
  sections: z.array(SectionDraftSchema),
  forwardQuestion: z.string().default(""),  // one-sentence preemptive question pointing to the next chapter
  keyTakeaways: z.array(z.string()).default([]),
  reflectionQuestions: z.array(z.string()).default([]),
  totalWordCount: z.number().default(0),
  status: z.enum(["pending", "polishing", "complete", "failed"]).default("pending"),
});

// ─── Front / Back Matter ──────────────────────────────────────────────────────

export const FrontBackMatterSchema = z.object({
  preface: z.string(),
  introduction: z.string(),
  conclusion: z.string(),
  aboutAuthor: z.string().nullable(),           // null if not mentioned in audio
  resourcesList: z.array(z.string()).default([]), // resources mentioned in the audio
  scriptureIndex: z.array(z.string()).default([]), // sorted list of all scripture references used
});

// ─── Back Matter (generated separately after manuscript is complete) ──────────

export const BackMatterSchema = z.object({
  scriptureIndex: z.array(z.object({
    reference: z.string(),
    translation: z.string(),
    chapters: z.array(z.number()),
  })).default([]),
  glossary: z.array(z.object({
    term: z.string(),
    definition: z.string(),
    firstAppearance: z.string(),
  })).default([]),
  readingGroupGuide: z.array(z.object({
    chapterNumber: z.number(),
    chapterTitle: z.string(),
    questions: z.array(z.string()),
  })).default([]),
  recommendedResources: z.array(z.string()).default([]),
});

export type BackMatter = z.infer<typeof BackMatterSchema>;

// ─── Full Ebook Manifest ──────────────────────────────────────────────────────

export const BOOK_TEMPLATE_IDS = [
  "classic-academic",
  "modern-business",
  "devotional",
  "popular-nonfiction",
  "premium-literary",
] as const;

export const BookTemplateEnum = z.enum(["classic-academic", "modern-business", "devotional", "popular-nonfiction", "premium-literary", "pastoral-ministry", "memoir-narrative", "study-reference", "charismatic-prophetic", "leadership-vision", "minimalist-wellness", "bold-magazine", "basel-swiss", "venetian-aldine", "bauhaus-functional", "nordic-whisper"]);

// ─── Print Specifications ─────────────────────────────────────────────────────

export const PrintSpecSchema = z.object({
  /** Physical trim size of the printed book */
  trimSize: z.enum(["6x9", "5.5x8.5", "5x8"]).default("6x9"),
  /** Whether to render running headers (book title verso / chapter title recto) and page numbers */
  runningHeaders: z.boolean().default(true),
  /** Expand page canvas by 9pt on each side for offset / print-on-demand bleed area */
  bleed: z.boolean().default(false),
  /** Draw printer crop marks at the bleed corners (requires bleed: true to take effect) */
  cropMarks: z.boolean().default(false),
  /**
   * editableProof — when true, generates a review-friendly PDF (PDF 1.7, no PDF/X-1a
   * restrictions, no bleed/crop marks) that can be text-edited in Adobe Acrobat Pro.
   * Send the standard export (editableProof: false) to the printing press.
   */
  editableProof: z.boolean().default(false),
  /**
   * Folio (page number) positioning style:
   * - "center": centered footer on all pages (default)
   * - "outside": verso left, recto right (Penguin/HarperCollins standard)
   * - "none-on-openers": no page numbers on chapter opener pages (Chicago Manual style)
   */
  folioStyle: z.enum(["center", "outside", "none-on-openers"]).default("center"),
  /**
   * Front matter numbering style:
   * - "arabic": 1, 2, 3 (continuous with body)
   * - "roman": i, ii, iii, iv (traditional academic style, body starts at 1)
   * - "none": no page numbers in front matter
   */
  frontMatterNumbering: z.enum(["arabic", "roman", "none"]).default("arabic"),
  /**
   * Section break ornament style:
   * - "rule": horizontal line (default)
   * - "fleuron": ❦ typographic flower ornament (traditional academic/literary)
   * - "asterism": ⁂ three asterisks (fiction/memoir standard)
   * - "dinkus": * * * three spaced asterisks (minimalist modern)
   * - "none": blank space only
   */
  sectionOrnament: z.enum(["rule", "fleuron", "asterism", "dinkus", "none"]).default("rule"),
  /**
   * Body text alignment override (overrides template default):
   * - "template": use the template's default bodyAlign setting (recommended)
   * - "left": ragged right edge (modern, scannable, conversational)
   * - "right": ragged left edge (rare, artistic layouts only)
   * - "center": centered text (special use: poetry, quotations)
   * - "justify": fill line edge-to-edge (traditional book typography)
   */
  bodyTextAlign: z.enum(["template", "left", "right", "center", "justify"]).default("template"),
  /**
   * Body font family override:
   * - "template": use the system's default font (Georgia with Times fallback)
   * - "georgia": Georgia (elegant, readable, modern serif)
   * - "times": Times New Roman (classic, traditional book font)
   * - "garamond": Garamond-like fallback (Renaissance, elegant)
   * - "palatino": Palatino (calligraphic, refined serif)
   * - "helvetica": Helvetica (Swiss, clean sans-serif)
   */
  bodyFontFamily: z.enum(["template", "georgia", "times", "garamond", "palatino", "helvetica"]).default("template"),
  /**
   * Font size multiplier (applies to all text sizes):
   * - 0.8 (80%) = Compact
   * - 0.9 (90%) = Small
   * - 1.0 (100%) = Template default (recommended)
   * - 1.1 (110%) = Large
   * - 1.2 (120%) = Extra Large
   */
  fontSizeScale: z.number().min(0.7).max(1.5).default(1.0),
});

export const EbookManifestSchema = z.object({
  jobId: z.string(),
  bookTitle: z.string(),
  subtitle: z.string(),
  authorName: z.string(),
  frontMatter: FrontBackMatterSchema,
  chapters: z.array(ChapterDraftSchema),
  totalWordCount: z.number(),
  allQuotes: z.array(QuoteSchema).default([]),
  generatedAt: z.string().datetime(),
  /** Which PDF/EPUB layout template to use at export time */
  selectedTemplate: BookTemplateEnum.default("devotional"),
  /** Print trim size and running-header preferences */
  printSpec: PrintSpecSchema.default({ trimSize: "6x9", runningHeaders: true }),
  /** Optional R2 public URL for the book cover image */
  coverImageUrl: z.string().url().optional().nullable(),
  /** Optional R2 public URL for the author's photo */
  authorImageUrl: z.string().url().optional().nullable(),
  /** Optional published narration map keyed by chapter/front-matter audio track id */
  narrationUrls: z.record(z.string().min(1), z.string().min(1)).optional(),
  /** Voice DNA captured during the pipeline — threaded into audit + apply-audit for voice fidelity */
  voiceDNA: VoiceDNASchema.optional().nullable(),
  /** Back matter: glossary, reading group guide, scripture index, recommended resources */
  backMatter: BackMatterSchema.optional().nullable(),
  /** Audit trail — rolling log of every assistant edit (max 50 entries, oldest dropped first) */
  changeLog: z.array(z.object({
    timestamp:   z.string().datetime(),
    instruction: z.string(),
    summary:     z.string(),
    model:       z.enum(["v3", "r1"]),
  })).max(50).optional(),
});

// ─── Job State (IndexedDB persistence) ───────────────────────────────────────

export const EbookJobStateSchema = z.object({
  jobId: z.string(),
  status: z.enum([
    "idle", "transcribing", "filtering", "analyzing", "mapping",
    "architecting", "assigning", "writing", "polishing",
    "frontmatter", "exporting", "complete", "failed",
  ]).default("idle"),
  audioFileNames: z.array(z.string()).default([]),
  transcripts: z.array(
    z.object({ label: z.string(), text: z.string() })
  ).default([]),
  masterTranscript: z.string().default(""),
  filteredTranscript: z.string().default(""), // teaching-only content after signal filter
  filterRemovedCount: z.number().default(0),  // number of non-teaching blocks removed
  voiceDNA: VoiceDNASchema.nullable().default(null),
  contentMap: ContentMapSchema.nullable().default(null),
  architecture: BookArchitectureSchema.nullable().default(null),
  sectionAssignments: z.array(SectionAssignmentSchema).default([]),
  sections: z.array(SectionDraftSchema).default([]),
  chapters: z.array(ChapterDraftSchema).default([]),
  frontMatter: FrontBackMatterSchema.nullable().default(null),
  backMatter: BackMatterSchema.nullable().default(null),
  exportUrls: z.object({ pdfUrl: z.string(), epubUrl: z.string(), docxUrl: z.string() }).partial().nullable().default(null),
  currentStage: z.string().default(""),
  progress: z.object({ total: z.number(), completed: z.number() }).default({ total: 0, completed: 0 }),
  errorLog: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

// ─── API request / response types ────────────────────────────────────────────

export const VoiceDNARequestSchema = z.object({
  masterTranscript: z.string().min(100),
});

export const ContentMapRequestSchema = z.object({
  masterTranscript: z.string().min(100),
  voiceDNA: VoiceDNASchema,
});

export const ArchitectRequestSchema = z.object({
  contentMap: ContentMapSchema,
  voiceDNA: VoiceDNASchema,
  /** When true, skip the LLM and map each uploaded audio file to exactly one chapter */
  oneChapterPerUpload: z.boolean().default(false),
});

export const AssignSegmentsRequestSchema = z.object({
  architecture: BookArchitectureSchema,
  contentMap: ContentMapSchema,
  voiceDNA: VoiceDNASchema,
});

export const AuthorConfigSchema = z.object({
  instructions: z.string().default(""),  // author's custom writing instructions
  targetAudience: z.string().default(""), // e.g. "Pentecostal believers aged 25–50"
});

export const WriteSectionRequestSchema = z.object({
  assignment: SectionAssignmentSchema,
  authorConfig: AuthorConfigSchema.optional(),
});

export const PolishChapterRequestSchema = z.object({
  input: ChapterPolishInputSchema,
  authorConfig: AuthorConfigSchema.optional(),
});

export const FrontMatterRequestSchema = z.object({
  masterTranscript: z.string().min(100),
  architecture: BookArchitectureSchema,
  voiceDNA: VoiceDNASchema,
  authorConfig: AuthorConfigSchema.optional(),
  alreadyQuotedRefs: z.array(z.string()).default([]),   // scripture references already reproduced in full inside the chapters/epigraphs
  forbiddenVerseTexts: z.array(z.string()).default([]), // exact verse texts already quoted in full — hard ban on re-printing in front/back matter
});

export const ExportRequestSchema = z.object({
  manifest: EbookManifestSchema,
  formats: z.object({ pdf: z.boolean(), epub: z.boolean(), docx: z.boolean() }).default({ pdf: true, epub: true, docx: true }),
  template: z.enum(["classic-academic", "modern-business", "devotional", "popular-nonfiction", "premium-literary", "pastoral-ministry", "memoir-narrative", "study-reference", "charismatic-prophetic", "leadership-vision", "minimalist-wellness", "bold-magazine", "basel-swiss", "venetian-aldine", "bauhaus-functional", "nordic-whisper"]).default("devotional"),
  printSpec: PrintSpecSchema.optional(),
});

// ─── Write-chapter (single-call chapter writer — Proposal 2) ────────────────

export const WriteChapterSectionInputSchema = z.object({
  sectionNumber: z.number().int(),
  heading: z.string(),
  transcriptExcerpts: z.array(z.string()).default([]),
  keyPoints: z.array(z.string()).default([]),
  quotes: z.array(QuoteSchema).default([]),
  targetWordCount: z.number().default(500),
  isLastSectionInChapter: z.boolean().default(false),
  assignedPlan: z.array(z.object({
    purpose: z.string().default(""),
    supportedExcerptNumbers: z.array(z.number().int().positive()).default([]),
  })).optional(),
});

export const WriteChapterRequestSchema = z.object({
  chapterNumber: z.number().int(),
  chapterTitle: z.string(),
  chapterPremise: z.string().optional(),
  nextChapterTitle: z.string().optional(),
  coreThesis: z.string().optional(),
  primaryTranslation: z.string().optional(),
  voiceDNA: VoiceDNASchema.optional(),
  authorConfig: AuthorConfigSchema.optional(),
  sections: z.array(WriteChapterSectionInputSchema),
  alreadyCoveredPoints: z.array(z.string()).default([]),
  priorSectionsSample: z.array(z.string()).default([]),
  bannedRecaps: z.array(z.string()).default([]),
  alreadyQuotedRefs: z.array(z.string()).default([]),
  forbiddenVerseTexts: z.array(z.string()).default([]),
  overusedPhrases: z.array(z.string()).default([]),
});

export const WriteChapterOutputSchema = z.object({
  sections: z.array(z.object({
    sectionNumber: z.number().int(),
    paragraphs: z.array(z.string()),
    claimLedger: z.array(z.object({ claim: z.string() })).default([]),
  })),
});

// ─── TypeScript exports ────────────────────────────────────────────────────────

export type Quote = z.infer<typeof QuoteSchema>;
export type VoiceDNA = z.infer<typeof VoiceDNASchema>;
export type PrintSpec = z.infer<typeof PrintSpecSchema>;
export type ContentSegment = z.infer<typeof ContentSegmentSchema>;
export type ContentMap = z.infer<typeof ContentMapSchema>;
export type SectionBlueprint = z.infer<typeof SectionBlueprintSchema>;
export type ChapterBlueprint = z.infer<typeof ChapterBlueprintSchema>;
export type BookArchitecture = z.infer<typeof BookArchitectureSchema>;
export type SectionAssignment = z.infer<typeof SectionAssignmentSchema>;
export type SectionDraft = z.infer<typeof SectionDraftSchema>;
export type ChapterPolishInput = z.infer<typeof ChapterPolishInputSchema>;
export type ChapterDraft = z.infer<typeof ChapterDraftSchema>;
export type FrontBackMatter = z.infer<typeof FrontBackMatterSchema>;
export type EbookManifest = z.infer<typeof EbookManifestSchema>;
export type EbookJobState = z.infer<typeof EbookJobStateSchema>;
export type AuthorConfig = z.infer<typeof AuthorConfigSchema>;
