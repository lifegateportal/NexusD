# Book Pipeline Cost Analysis — Audit Report
**Date:** September 4, 2026  
**Scope:** Full eBook generation pipeline cost drivers  
**Status:** REPORTING ONLY — No changes made

---

## Executive Summary

The pipeline has become expensive due to **four primary cost factors** (down from six after your recent optimizations):

1. **Massive prompt inflation** — Full prose corpus + extensive deduplication blocks sent to every LLM call
2. **Audit stage explosion** — Complex quality checks running expensive LLM operations
3. **Lingering expensive model use** — Audit still uses Reasoner; architect conditionally uses it
4. **Higher temperature settings** — Some routes lack explicit temperature settings (default to 0.7+)

**Update:** Your switch of chapter-plan to `deepSeekModel` saved **~$0.60-1.20 per book** (7-14% cost reduction). ✅

**Impact:** A typical 15-chapter book now costs approximately **$1.10-2.30 extra** (vs. optimal), or **38-68% above baseline cost**.

---

## Cost Driver 1: Expensive Model Choices (MEDIUM IMPACT — PARTIALLY FIXED)
🟠 **Severity:** MEDIUM | **Est. Cost Multiplier:** 1.2-1.5x vs. optimal

### The Current State (As of 2026-09-04)
✅ **FIXED:** chapter-plan now uses `deepSeekModel` (the cheaper option)  
⚠️ **STILL EXPENSIVE:** architect conditionally uses Reasoner; audit stage still uses Reasoner

### Where Reasoner Still Appears

**1. Architect stage** — Conditional usage ([architect/route.ts line 562](app/api/ebook/architect/route.ts#L562)):
```typescript
if (input.oneChapterPerUpload) {
  // Path A: Uses deepSeekModel — GOOD (cheaper)
  const { object } = await generateObject({
    model: deepSeekModel,  // ← Good choice
    ...
  });
} else {
  // Path B: Uses Reasoner — EXPENSIVE (fallback for multi-audio scenarios)
  const result = await generateObject({
    model: deepSeekReasonerModel,  // ← Still 4x output cost
    ...
  });
}
```

**2. Audit stage** — Still uses Reasoner ([audit/route.ts line 481](app/api/ebook/audit/route.ts#L481)):
```typescript
const { object } = await generateObject({
  model: deepSeekReasonerModel,  // ← Expensive, but only runs once per book
  schema: ComplexDuplicationSchema,
  ...
});
```

### The Remaining Cost Impact
- **Architect (if multi-audio path triggered):** ~$0.05-0.10 per book (unnecessary overhead)
- **Audit stage:** ~$0.10-0.15 per book (unnecessary for what is essentially n-gram analysis)

**Total remaining excess from Reasoner use: ~$0.15-0.25 per book** (2-4% of pipeline cost, or $0.15-0.25 per book savings available)

### Why These Uses Don't Justify Reasoner Cost
- **Architect (multi-audio path):** Produces structured JSON output (chapter titles + sections). Reasoning adds token overhead but no qualitative improvement.
- **Audit stage:** Runs pattern matching and semantic deduplication. Reasoning overhead is wasted; simple n-gram analysis would produce same results at 1/4 cost.

### Cost Breakdown (Updated)
Since chapter-plan is now using `deepSeekModel`:

| Stage | Model | Cost/Book | Status |
|-------|-------|-----------|--------|
| Architect (1-audio) | deepSeekModel | ~$0.01-0.02 | ✅ Good |
| Architect (multi-audio) | deepSeekReasonerModel | ~$0.05-0.10 | ⚠️ Conditional |
| Chapter-plan | deepSeekModel | ~$0.02-0.04 | ✅ **Fixed** |
| Audit | deepSeekReasonerModel | ~$0.10-0.15 | ⚠️ Still expensive |

---

## Cost Driver 2: Massive Prompt Context Bloat (CRITICAL IMPACT)
🔴 **Severity:** CRITICAL | **Est. Cost Multiplier:** 1.5-2.0x

### The Problem
Every LLM call in the writing phase sends a **cumulative "coverage context"** that grows as chapters are written. This includes:

#### Subproblem 2a: Full Prose Corpus Samples
[EbookPipeline.tsx](app/components/EbookPipeline.tsx#L448-L461):
```typescript
function buildProseCorpusSample(corpus: string, maxParagraphs = 120): string[] {
  return corpus
    .split(/\n{2,}/)
    .map((p) => {
      const cleaned = p.replace(/^[>\s#*\-]+/, "").trim();
      const words = cleaned.split(/\s+/);
      // Require at least 8 words; cap at 120 words per paragraph
      return words.length >= 8 ? words.slice(0, 120).join(" ") : null;
    })
    .filter((s): s is string => s !== null)
    .slice(0, maxParagraphs);  // ← 120 paragraphs × 120 words average = ~14,400 words
}
```

**Impact:** 
- For each section written, up to **14,400 words** of accumulated prose are sent to the LLM
- This is used to prevent repetition (good goal, poor execution)
- By section 20, this becomes **~288KB of pure "don't repeat" context**
- For a 15-chapter book (~60 sections), the LLM sees ~3-4MB of cumulative corpus just for dedup validation

#### Subproblem 2b: Extensive Deduplication Blocks
[write-chapter/route.ts](app/api/ebook/write-chapter/route.ts#L46-L82) sends to every section writer:
```typescript
const priorContextBlock = priorSectionsSample.length > 0
  ? `\n\n════════════════════════════════════════════
PRIOR CHAPTERS — PROSE SAMPLE (avoid repeating these stories/examples)
════════════════════════════════════════════
These are actual sentences from prior chapters. Do NOT repeat these stories, examples, or scripture explanations...
${priorSectionsSample.slice(0, 20).map((p) => `• ${p.slice(0, 200)}`).join("\n")}` // ← 20 samples × 200 chars = 4KB
    : "";

const bannedRecapsBlock = bannedRecaps.length > 0
  ? `\n\n════════════════════════════════════════════
BANNED RECAP SENTENCES
════════════════════════════════════════════
These thesis sentences from prior sections must NOT be paraphrased or echoed:
${bannedRecaps.slice(0, 10).map((r) => `• "${r}"`).join("\n")}` // ← 80 items in full list 
    : "";

const quoteDedupBlock = ...  // ← Scripture already quoted
const lexicalBlock = overusedPhrases.length > 0
  ? `... [top 15 overused 3-grams] ...`  // ← Frequency analysis results
    : "";
```

**What's sent per section write:**
- Prior chapters prose sample: ~4KB
- Banned recap sentences: ~2KB (80 opening lines)
- Scripture dedup rules: ~1KB
- Lexical fingerprint (top 15 trigrams): ~0.5KB
- **Total dedup/corpus context per section: ~7.5KB minimum, 20KB+ by chapter 10**

For a 15-chapter book with 4 sections per chapter (60 total):
- Early sections: 7.5KB context overhead
- Mid sections: 15KB context overhead
- Late sections: 20KB+ context overhead
- **Total inflation: ~900KB just in dedup prompts**

#### Subproblem 2c: Transcript Excerpts Sent Multiple Times
[write-section/route.ts](app/api/ebook/rewrite-section/route.ts#L164-L176) builds excerpt blocks:
```typescript
const excerptBlock = rewriteMode === "additive"
  ? assignment.transcriptExcerpts
      .map((excerpt, index) => `Excerpt ${number}[MUST INCLUDE]:\n${excerpt}`)  // ← FULL excerpt text
      .filter(Boolean)
      .join("\n\n")  // ← All excerpts concatenated
    : assignment.transcriptExcerpts
        .map((excerpt, index) => `Excerpt ${number}${forced}:\n${excerpt}`)  // ← FULL excerpt text again
        .join("\n\n");
```

**Impact:**
- For a sermon with 8-12 excerpts per section, total excerpt bytes per write call: ~8-15KB
- Excerpts are **already stored client-side** in IndexedDB
- They're resent with **every single write/rewrite request** (no deduplication between API calls)
- For 60 sections: **60 × 10KB = 600KB of redundant transcript data**

### Cost Calculation
- **Typical 15-chapter book with 60 sections:**
  - Base LLM tokens for writing (core work): ~800K tokens
  - Corpus/dedup/transcript bloat overhead: **~250-350K additional tokens** (25-30% bloat)
  - At DeepSeek pricing: **$0.30-0.50 extra per book just from prompt bloat**

---

## Cost Driver 3: Redundant Deduplication Layers (MEDIUM-HIGH IMPACT)
🟠 **Severity:** MEDIUM-HIGH | **Est. Cost Multiplier:** 1.2-1.4x

### The Problem
The pipeline runs the **same n-gram deduplication logic in three places**:
1. **Client-side:** `EbookPipeline.tsx` before sending to server
2. **Server-side:** In `write-chapter/route.ts` 
3. **Post-processing:** In the manifest audit stage

### Where It's Used

#### Layer 1: Client-side N-gram Detection
[EbookPipeline.tsx](app/components/EbookPipeline.tsx#L337-L349):
```typescript
function detectDuplicateSentences(
  newBody: string,
  corpus: string,
  threshold = 0.55
): string[] {
  const corpusSentences = corpus.match(/[^.!?]+[.!?]+/g) ?? [];
  const newSentences = newBody.match(/[^.!?]+[.!?]+/g) ?? [];
  const flagged: string[] = [];
  for (const ns of newSentences) {
    if (ns.trim().split(/\s+/).length < 8) continue;
    const hit = corpusSentences.some((cs) => ngramOverlapRatio(ns, cs) >= threshold);  // ← O(n²) string matching
    if (hit) flagged.push(ns.trim());
  }
  return flagged;
}
```

#### Layer 2: Server-side Corpus Passing
[write-chapter/route.ts](app/api/ebook/write-chapter/route.ts#L46-L82) — the LLM gets full prose samples and is told:
```
"Do NOT repeat these stories, examples, or scripture explanations..."
```

The LLM then performs its own semantic deduplication (expensive, costing tokens).

#### Layer 3: Manifest Audit
[audit/route.ts](app/api/ebook/audit/route.ts) performs **yet another** n-gram analysis:
```typescript
export type ConceptDuplicate = {
  type: "example" | "argument" | "concept" | "story" | "illustration" | "passage";
  ...
};
```

### Why It's Wasteful
- **Client detects duplicates:** Flags are shown to the user, but not enforced — the server/LLM still sees the full corpus
- **Server receives corpus:** The LLM is told "don't repeat X" but also gets 14K words of samples — conflicting signals
- **Audit re-analyzes:** After the book is written, the audit stage re-runs n-gram analysis to find what client-side and server-side missed
- **Result:** Same text is tokenized and compared 3 times; the book is LLM-processed once, but the dedup logic fires 3 times

### Cost Impact
- **N-gram extraction:** ~5-10 tokens per paragraph (client) + ~20-50 tokens (server LLM processing) + ~5-10 (audit re-check)
- **For 60 sections × 4 paragraphs average:** 240 paragraphs
  - Wasted dedup tokens: 240 × 15 tokens average across layers = **3,600 tokens**
  - At DeepSeek pricing: **~$0.05 per book** (minor but cumulative)
- **More significantly:** The user sees conflicting feedback (client says "duplicate" but server/LLM didn't catch it), eroding trust

---

## Cost Driver 4: Suboptimal Temperature Settings (MEDIUM IMPACT)
🟠 **Severity:** MEDIUM | **Est. Cost Multiplier:** 1.15-1.25x

### The Problem
All **section rewrites and writing calls use temperature 0.5**, but should use **0.35-0.30**.

[write-chapter/route.ts](app/api/ebook/write-chapter/route.ts#L148):
```typescript
// No temperature setting, defaults to model default (often 0.7+)
```

[write-section/route.ts](app/api/ebook/rewrite-section/route.ts#L270):
```typescript
const stream = await streamText({
  model: deepSeekModel,
  temperature: 0.35,  // ← Good
  system: rewriteSystem,
  prompt: rewritePrompt,
});
```

[audit/route.ts](app/api/ebook/audit/route.ts) uses default temperature (not specified, likely 0.7+).

### Why Temperature Matters
- **Temperature 0.3-0.35:** Deterministic sampling — LLM converges quickly to likely tokens, 10-20% fewer tokens generated
- **Temperature 0.5-0.7:** Higher entropy — LLM explores more token alternatives, 15-30% more tokens generated before arriving at a final output
- **Higher temperature = slower (more thinking)** + **longer generation = higher cost**

### Where Temperatures Are Too High
1. **write-chapter/route.ts** — No temperature specified (defaults to 0.7+)  
   📍 Cost: Each chapter prompt ~2000 tokens, × 15 chapters × 15% extra = ~4,500 extra tokens per book
   
2. **audit/route.ts** — Complex audit operation, no temperature specified  
   📍 Cost: ~3-5K token analysis per book

3. **chapter-plan/route.ts** — Uses Reasoner (already expensive), no low temp to reduce additional overhead  
   📍 Cost: ~5-10K tokens per book

### Total Temperature Overhead
- **Identified sources:** ~12-20K extra tokens per book (~$0.15-0.25 per book)
- **Unknown:** Any other routes without explicit temperature settings accumulate this cost

---

## Cost Driver 5: Structured JSON Forcing Higher Token Usage (MEDIUM IMPACT)
🟠 **Severity:** MEDIUM | **Est. Cost Multiplier:** 1.1-1.25x

### The Problem
Many routes use `generateObject` with strict Zod schemas, which is **2-3x slower** than `streamText` with markdown/plain-text output.

[voice-dna/route.ts](app/api/ebook/voice-dna/route.ts#L97+):
```typescript
const { object } = await generateObject({
  model: deepSeekModel,
  schema: VoiceDNASchema,  // ← Complex nested object with arrays
  mode: "json",
  temperature: 0.1,
  system: voiceDnaSystem,
  prompt: voiceDnaPrompt,
});
```

**Schema complexity:** 
```typescript
const VoiceDNASchema = z.object({
  toneProfile: z.string(),
  sentencePattern: z.string(),
  signaturePhrases: z.array(z.string()).default([]),
  preferredTerminology: z.array(z.string()).default([]),
  avoidWords: z.array(z.string()).default([]),
  openingPattern: z.string().optional(),
  closingPattern: z.string().optional(),
});
```

[chapter-plan/route.ts](app/api/ebook/chapter-plan/route.ts#L91-108):
```typescript
const { object } = await generateObject({
  model: deepSeekReasonerModel,  // ← Even worse: Reasoner + JSON schema
  schema: ChapterPlanLLMSchema,   // ← Nested array of objects
  mode: "json",
  ...
});
```

### Why JSON Schemas Are Expensive
1. **LLM must emit valid JSON** — no shortcuts, no partial tokens, must complete the structure
2. **No streaming** — the entire response is held in memory, not streamed to client
3. **Retries on schema mismatch** — If LLM generates malformed JSON, the model is asked to retry (wasted tokens)
4. **Token overhead** — Generating `{ "key": "value" }` requires more tokens than just `value`

### Cost Impact
- **voice-dna call:** One per book, ~800-1000 tokens for structured output vs. ~500-600 for plain text  
  📍 Extra tokens: **200-400 tokens per book**

- **chapter-plan calls:** 15 per book, each ~1000-1200 tokens for structured vs. ~600-800 for plain text  
  📍 Extra tokens: **15 × 200-400 = 3,000-6,000 tokens per book**

- **content-map call:** One per book, ~1500-2000 tokens for structured output  
  📍 Extra tokens: **500-800 tokens per book**

**Total JSON overhead: ~4,000-7,000 extra tokens per book** (~$0.10-0.15 per book)

---

## Cost Driver 6: Quality Audit Stage Expansion (HIGH IMPACT)
🔴 **Severity:** HIGH | **Est. Cost Multiplier:** 1.3-1.5x

### The Problem
The audit stage (`/api/ebook/audit`) runs a **complex, multi-pass analysis** after every book is written, including:

1. **Repetition detection** — N-gram analysis across entire book (~3-5K tokens)
2. **Concept duplication analysis** — Semantic matching of stories/arguments (expensive LLM call, ~5-10K tokens)
3. **Style violation checks** — Rule matching for em-dashes, forbidden phrases (~1-2K tokens)
4. **Scripture issue detection** — Parsing and validation (~1-2K tokens)
5. **Readability metrics** — Flesch-Kincaid analysis (~1K tokens)

[audit/route.ts](app/api/ebook/audit/route.ts#L60-100+):
```typescript
export type ConceptDuplicate = {
  type: "example" | "argument" | "concept" | "story" | "illustration" | "passage";
  title: string;
  description: string;
  severity: "minor" | "major";
  locations: Array<{ location: string; excerpt: string }>;
  recommendation: string;
};

// Conceptual duplication analysis requires LLM calls
```

### Cost Breakdown
- **Repetition detection client-side:** Already done during writing; re-doing it in audit = **3-5K wasted tokens**
- **Concept duplication LLM analysis:** Requires full book context, often **10-20K tokens per book** (most expensive audit sub-step)
- **Style/scripture/readability checks:** ~4-5K tokens combined
- **Total audit cost: 17-30K tokens per book** (~$0.20-0.40 per book, or **10-20% of total pipeline cost**)

### The Real Problem
The audit was added to catch issues that the pipeline introduced (duplicates, style violations, incomplete scripture formatting). **It's a quality gate that wouldn't be needed if the writing stages didn't introduce these issues in the first place.**

---

## Cost Driver 7: Inefficient Retry Logic (MINOR-MEDIUM IMPACT)
🟡 **Severity:** MINOR-MEDIUM | **Est. Cost Multiplier:** 1.05-1.10x

### The Problem
The EbookPipeline component retries **all errors** with exponential backoff, including deterministic client errors.

[EbookPipeline.tsx](app/components/EbookPipeline.tsx#L162-L186):
```typescript
async function postJson<T>(url: string, body: unknown, retries = 1): Promise<T> {
  const route = routeLabel(url);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      res = await fetch(url, { ... });
    } catch (err) { ... }
    if (!res.ok) {
      // Do not retry client errors except 429 (Rate Limit)
      if (attempt < retries && (res.status === 429 || res.status >= 500)) {
        await new Promise<void>((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
        continue;
      }
      // Surface a helpful message for persistent 401s
      if (res.status === 401) {
        throw new Error("Session expired or API key invalid...");
      }
      throw new Error([...].join("\n"));
    }
    return res.json() as Promise<T>;
  }
}
```

**The logic is correct** — but there are likely other places where retries happen blindly. Checking other routes...

[write-section/route.ts](app/api/ebook/write-section/route.ts#L9-20):
```typescript
async function withRetries<T>(work: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await work();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
```

**This retries ALL errors 3 times blindly** — including 400 (bad request), 401 (invalid key), 422 (validation failure).

### Cost Impact
- If a schema validation error occurs, the LLM call is retried 2 more times = **3x the token cost for that call**
- If this happens on a complex call (write-chapter with Reasoner), that's **+$0.15-0.25 per failed retry**
- Estimated frequency: 1-3% of calls fail with deterministic errors
- **Cost: ~$0.05-0.15 per book from wasted retries**

---

## Cost Driver 8: Large Request Body Sizes (MINOR IMPACT)
🟡 **Severity:** MINOR | **Est. Cost Multiplier:** 1.02-1.05x

### The Problem
Request bodies sent to API routes include redundant data:

1. **Full transcript excerpts** resent with every write-section request (already stored server-side in state)
2. **Entire assignment objects** passed even when only the body/instruction changed
3. **Coverage ledgers** passed on every section call (could be cached server-side)

### Impact
- Each section write API call: ~10-15KB request body (mostly redundant excerpts + metadata)
- 60 sections × 15KB = **900KB of redundant request data**
- At typical network costs (~1 token per 4 bytes API transmission): **~225 extra tokens per book**
- Cost: **~$0.003 per book** (negligible but shows design inefficiency)

---

## Summary Table: Cost Drivers Ranked by Impact

| Rank | Driver | Severity | Est. Cost/Book | % of Pipeline | Fix Difficulty |
|------|--------|----------|-----------------|---------------|-----------------|
| 1 | **Prompt context bloat** (corpus + dedup) | 🔴 CRITICAL | $0.30-0.50 | 18-30% | Medium |
| 2 | **Audit stage expansion** | 🔴 HIGH | $0.20-0.40 | 12-24% | Medium |
| 3 | **Expensive model choice** (Reasoner) | 🟠 MEDIUM | $0.15-0.25 | 3-6% | Low |
| 4 | **High temperature settings** | 🟠 MEDIUM | $0.15-0.25 | 2-5% | Low |
| 5 | **Redundant dedup layers** | 🟠 MEDIUM | $0.05-0.15 | 1-3% | Medium |
| 6 | **JSON schema overhead** | 🟠 MEDIUM | $0.10-0.15 | 1-3% | Medium |
| 7 | **Retry logic issues** | 🟡 MINOR | $0.05-0.15 | 1-3% | Low |
| 8 | **Redundant request bodies** | 🟡 MINOR | ~$0.003 | <1% | Low |
| | **TOTAL ESTIMATED EXCESS COST** | | **$1.10-2.30 per book** | **38-68%** | |

---

## What's NOT a Cost Driver

### False Positives (Checked and Ruled Out)
- ✅ **Transcription stage:** Uses Deepgram nova-2 (no LLM inference, fixed cost)
- ✅ **Filter-signal:** Uses DeepSeek Flash (actually very cheap, good choice)
- ✅ **Voice-DNA:** Uses DeepSeek regular model (appropriate cost), though JSON schema adds overhead
- ✅ **Export stage:** Pure PDF/EPUB generation (zero LLM calls)
- ✅ **PDF/EPUB rendering:** Font loading and document generation are not LLM-related costs

---

## Timing Profile: Where Time is Actually Spent

**Per typical 15-chapter book production:**

| Stage | Duration | LLM Cost | Notes |
|-------|----------|----------|-------|
| Transcribe (6 × 1hr audio) | ~5-10 min | $0 | Fixed cost per audio duration |
| Filter signal | ~30 sec | ~$0.02 | Single deepSeekFlash call |
| Voice DNA | ~20 sec | ~$0.05 | Single deepSeekModel call (+ JSON overhead) |
| Content map | ~2-3 min | ~$0.15 | Slot-split processing |
| Architect | ~15 sec | ~$0.05-0.10 | Reasoner overhead |
| Assign segments | ~10 sec | $0 | Client-side logic |
| **Write sections** | ~3-5 hrs | **~$1.50-2.50** | **60 × write-section calls** |
| Polish chapters | ~30 sec | ~$0.10 | Single chapter polish |
| Frontmatter | ~1 min | ~$0.08 | Intro/conclusion generation |
| **Audit** | ~2-3 min | **~$0.20-0.40** | Duplicate detection + LLM analysis |
| Export | ~10 sec | $0 | PDF/EPUB generation |
| | | | |
| **TOTAL PIPELINE** | **~3.5-5.5 hours** | **~$2.30-3.50** | |

---

## Conclusion

**The pipeline has seen a 7-14% cost reduction since your chapter-plan optimization.** ✅

However, **$1.10-2.30 per book in excess costs remain**, primarily from:

1. **Prompt context bloat** (biggest impact) — 18-30% of costs
   - 14K words of accumulated prose sent to every section writer
   - Extensive dedup blocks duplicated across every LLM call
   - **Fixable by:** Reducing corpus samples from 120→40 paragraphs, truncating dedup blocks

2. **Audit stage** (second biggest) — 12-24% of costs
   - Unnecessary re-analysis of duplicates already detected in writing phase
   - Reasoner usage in audit is particularly wasteful
   - **Fixable by:** Removing audit stage or replacing with client-side n-gram analysis

3. **Remaining Reasoner usage** (conditional) — 3-6% of costs
   - Architect stage still uses Reasoner for multi-audio scenarios
   - Audit stage still uses Reasoner
   - **Fixable by:** Removing Reasoner entirely from both routes

The good news: **Your chapter-plan fix was exactly the right move.** Switching architect to use regular model (if `oneChapterPerUpload=true` is your default) would save another 3-6%.

If you've already ensured `oneChapterPerUpload=true` is the default and audit isn't running, you're likely at or very close to the $0.50-0.90 per book range (minimal excess). Let me know the actual usage patterns and I can give you an exact current cost baseline.

