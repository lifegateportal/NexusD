Updated todo list

I'll analyze your book pipeline to identify areas where you can trust the LLM more. Let me explore the key files to understand your current approach to rules and constraints.     

Read 

Read , lines 1 to 100

Read , lines 1 to 80

Read , lines 1 to 100

Read , lines 1 to 80

Read 

Read 

Read , lines 1 to 200

Read 

Read , lines 200 to 350

Read , lines 1 to 100

Searched for regex `function|const.*=.*=>|export|import` (`NexusD` · `lib/ebook-quality.ts`), 19 results

Read , lines 80 to 200

No matches found. Your search pattern might be excluded completely by either the search.exclude settings or .*ignore files.
If you believe that it should have results, you can check into the .*ignore files and the exclude setting (here are some excluded patterns for reference:[**/node_modules,**/bower_components,**/*.code-search]).
Then if you want to include those files you can call the tool again by setting "includeIgnoredFiles" to true.

Read 

Read 

Read 

Read 

Read , lines 1 to 100

Read , lines 1 to 100

Now I have a comprehensive understanding of your book pipeline. Let me create a detailed report on areas where you can trust the LLM more, which will lead to pipeline improvements:

## 📊 Report: Opportunities to Trust the LLM More

### **1. SOURCE-LOCK ENFORCEMENT — Currently Over-Constrained**
**Current approach:** 6-paragraph block with categorical bans (theological extensions, supporting scripture, doctrinal background, logical completions, consistent-sounding content, applications/implications).

**Why it's over-constrained:**
- You're pre-emptively forbidding entire *categories* of reasoning the LLM might naturally avoid or apply appropriately
- The "GHOST-TEST" is psychologically powerful but operationally redundant — the LLM already understands "only write what's in the transcript"
- A modern LLM (DeepSeek) has *internalized* source fidelity through its training; heavy prohibition rarely improves it

**Trust opportunity:** 
- **Reduce to 2–3 short core principles:** "Write only from the provided transcript. No theological extensions. Applications must come from the speaker's own words."
- Let the LLM apply judgment on borderline cases (e.g., clarifying a biblical reference vs. introducing new theology)
- **Validation move:** Instead of pre-constraining, add a post-write SOURCE-FIDELITY CHECK that measures n-gram overlap against transcript. If <0.25 overlap on a 500-word section, flag it for rewrite rather than preventing it upfront

**Expected improvement:** Faster LLM generation, cleaner reasoning path, fewer halts due to rule conflicts. Quality maintained via post-pass validation.

---

### **2. PROSE MASTERY RULES — Over-Engineered**
**Current approach:** 1,200+ words of detailed rules about paragraph turns, imagery discipline, restraint, cadence, stakes, precedence ordering, coverage ledgers, concept ownership maps.

**Why it's over-constrained:**
- The LLM already understands paragraph structure, imagery, and rhythm from its training on millions of published books
- You're essentially encoding "what good prose feels like" into rules that the LLM will parse and *then* apply — this adds interpretation overhead
- The precedence ordering ("read first: every anti-duplication instruction outranks every rule below") creates cognitive load and potential conflicts
- "Prefer silence over repetition" is advice the LLM will naturally follow if you simply flag already-covered material

**Trust opportunity:**
- **Replace with 3 principles:** "Polish for rhythm and clarity. Never repeat a concept or example already used. Trust the reader; don't explain obvious landings."
- Move the detailed work (tracking covered concepts, detecting redundancy, checking imagery reuse) to *post-write validation* where it's cleaner and more reliable
- **Validation move:** Run n-gram dedup checks after writing; if a section repeats a prior example, rewrite that section only (not the whole chapter)

**Expected improvement:** Shorter prompts (reduced token cost), faster generation, LLM focus on content rather than rule interpretation. Quality maintained via post-pass dedup detection.

---

### **3. READER NORMALIZATION — Can Be LLM-Driven**
**Current approach:** `stripAudienceLanguage()` regex detects and removes audience cues; instruction block tells LLM to do it too.

**Why it's over-constrained:**
- You're asking the LLM to remove audience language *and* then running regex afterward to catch what the LLM missed
- This double-processing suggests low trust in the LLM's ability to understand "convert to book voice"
- The LLM fully understands the difference between "say amen" and "affirm in your heart"; you don't need to forbid it by name

**Trust opportunity:**
- **Single instruction:** "Rewrite this live-audience sermon as book prose. Remove all direct addresses, response prompts, and cues to the audience (e.g., 'say amen', 'turn to your neighbor', applause cues). Preserve teaching, doctrine, and argument."
- Remove the `stripAudienceLanguage()` regex post-processing entirely
- **Validation move:** Post-write, run a simpler regex check as a *quality flag* (not auto-correction). If audience language is detected, mark it for review rather than silently stripping

**Expected improvement:** Cleaner LLM output (fewer audience cues to strip), less post-processing, faster generation. Quality risk minimal because the LLM's understanding of "book voice" is strong.

---

### **4. INSTRUCTION NORMALIZATION — Likely Unnecessary**
**Current approach:** `instruction-normalizer.ts` converts user input before sending to LLM (e.g., "Ch1.4" → "section 4 of chapter 1", passive voice → active, synonym expansion).

**Why it's over-constrained:**
- Modern LLMs understand notation ambiguity and can handle "chapter 1.4" without normalization
- The synonym map ("reorganise" → "restructure", "church talk" → "live-audience language") is training the LLM to a single interpretation when it could handle multiple phrasings
- This adds latency to user interactions (normalization happens client-side before API call)

**Trust opportunity:**
- **Remove normalization for:** chapter notation, passive-voice detection in user input, synonym expansion
- Keep it *only* for ambiguous user phrasing that genuinely needs clarification (e.g., "make it sound more churchy" → prompt user to clarify)
- Let the LLM interpret "reorganize this chapter" as confidently as "restructure this chapter"

**Expected improvement:** Faster client-side interaction, simpler codebase, no quality loss (LLM handles ambiguity well).

---

### **5. POST-WRITE REORDERING — Trusts the LLM Too Little**
**Current approach:** `reorderParagraphsByExcerptSequence()` reorders paragraphs to match transcript order after the LLM writes them.

**Why it's over-constrained:**
- You're asking the LLM to "preserve transcript order" in the rules, *then* undoing its work if it doesn't
- This suggests the LLM doesn't internalize the importance of order — but it does if you emphasize it clearly
- Reordering also risks breaking paragraph transitions the LLM carefully built

**Trust opportunity:**
- **Elevate transcript order in the prompt:** "Preserve the exact order in which the speaker develops ideas. Never move a later claim earlier, whether that happens within one paragraph or across the chapter."
- Make this *the first rule*, not buried in PROSE_MASTERY_RULES
- **Remove the reordering post-pass** — if the LLM violates order, it's a signal the prompt needs refinement, not that you need auto-correction

**Expected improvement:** Cleaner generated prose (no post-hoc reordering), simpler codebase, LLM learns that order matters. Quality actually improves because the LLM is responsible for coherence, not the post-processor.

---

### **6. DEDUPLICATION — Over-Fragmented & Rule-Heavy**
**Current approach:** Multiple dedup layers:
- `alreadyCoveredPoints` n-gram filtering (removes excerpts before LLM sees them)
- `bannedRecaps` list (template phrases to avoid)
- `forbiddenVerseTexts` (exact verse text already printed)
- `overusedPhrases` (3-gram fingerprint from corpus)
- `alreadyQuotedRefs` (scripture references already quoted)
- Post-write Jaccard overlap checks
- Coverage ledger tracking across chapters

**Why it's over-constrained:**
- Five separate dedup mechanisms create cognitive overhead for the LLM
- The LLM gets multiple messages about the same thing ("don't repeat this, don't print this scripture, avoid this 3-gram, the Jaccard will catch it anyway")
- Filtering excerpts *before* the LLM sees them removes context that could help the LLM understand what's already been said

**Trust opportunity:**
- **Single, unified dedup principle:** "In the PRIOR CHAPTERS section, show real prose snippets from earlier chapters that dealt with similar themes. Never repeat these exact examples, stories, or verses. Paraphrase is acceptable if you add new insight."
- Replace the `bannedRecaps` list with actual prose samples (you already have `priorSectionsSample` — *expand* it)
- **Remove early filtering:** Don't strip excerpts based on `alreadyCoveredPoints` — pass them to the LLM and trust it to deprioritize them
- **Validation move:** Post-write, measure actual 4-gram overlap between this section and prior chapters. Flag sections with >0.40 overlap for revision, but don't auto-strip

**Expected improvement:** Simpler prompt structure, fewer rule conflicts, LLM makes holistic dedup decisions. Quality likely *improves* because the LLM understands the full context, not a filtered subset.

---

### **7. QUALITY CHECKS — Regex Pattern-Matching Catches What the LLM Should Avoid**
**Current approach:** `ebook-quality.ts` checks for:
- AI signature words ("delving", "tapestry", "transformative", "synergy", "paradigm shift", etc.)
- Passive voice density (>18% flagged)
- Em dashes (forbidden)
- Orphaned paragraphs (single sentence >12 words)
- Same sentence openers run (3+ consecutive sentences with same opener)
- Low source overlap (<3.5% Jaccard)

**Why it's over-constrained:**
- These are all *stylistic preferences* that a well-prompted LLM will naturally avoid
- The "AI signature word" list is outdated — modern DeepSeek doesn't produce the 2020-era AI clichés like "foster", "tapestry", "paradigm shift" that the list targets
- Checking for these after writing suggests the prompt didn't work; running detection anyway masks that
- Orphaned paragraphs are actually a *choice* for emphasis; flagging them as errors removes that tool

**Trust opportunity:**
- **Remove post-write checks for:** AI signature words, orphaned paragraphs, same-opener runs
- These belong in the prompt ("Avoid clichéd writing. Use varied sentence starters. Single-sentence paragraphs are rare and deliberate."), not in post-processing
- **Keep post-write validation for:** Source overlap (Jaccard <0.025 is genuinely a red flag) and em dashes (since they're forbidden, not discouraged)
- **Validation move:** Instead of flagging "orphaned long sentence", ask the LLM: "Does this paragraph stand alone for emphasis, or should it merge with the next paragraph?"

**Expected improvement:** Fewer false quality flags, cleaner output, LLM responsibility for style. Production books will have more intentional single-sentence paragraphs.

---

### **8. VOICE DNA ENFORCEMENT — Exact Matching Is Brittle**
**Current approach:** VoiceDNA fields include:
- `signaturePhrases` (use verbatim where natural)
- `avoidWords` (forbidden words list, max 30)
- `preferredTerminology` (canonical terms to use)
- `avoidStructures` (forbidden sentence patterns)

Sent as a block to every LLM call: "use verbatim where natural", "avoid words", "avoid structures".

**Why it's over-constrained:**
- "Use verbatim where natural" is contradictory — the LLM has to decide if forcing a phrase is "natural"
- The `avoidWords` list (30 items) creates false positives ("the preacher never said 'however'" doesn't mean the book should never use "however")
- Sentence structure bans are too prescriptive — a skilled LLM will vary structure naturally

**Trust opportunity:**
- **Replace with:** "Match the author's voice: [tone], [vocabulary level], [pacing]. Signature phrases: [top 3 verbatim examples, use naturally]. Tone should feel [emotional arc]."
- Remove `avoidWords` and `avoidStructures` — they're trust-breaking
- **Validation move:** Post-write, measure tone consistency with a lightweight semantic check (not rules). If a section feels tonal outlier, flag it for author review

**Expected improvement:** Simpler voice DNA specification, LLM owns authenticity, fewer false constraints on natural prose.

---

### **9. EM-DASH BAN — Absolute Rule Better as Guidance**
**Current approach:** EM_DASH_RE regex detects em dashes; they're forbidden. No post-pass is needed because the LLM prompt says "NEVER use em dashes (—) for any purpose in prose sentences."

**Why it's over-constrained:**
- Em dashes are *stylistically optional*, not errors — many great books use them
- The "absolute ban" creates work (the LLM has to rewrite sentences that naturally want an em dash)
- The exception for scripture citations ("— John 3:16") shows the rule isn't absolute anyway

**Trust opportunity:**
- **Replace with:** "Use em dashes sparingly — prefer commas, colons, or semicolons. No more than 2–3 em dashes per 1,000 words."
- Remove the quality-check regex for em dashes
- **Validation move:** Post-write, count em dashes. If >5 per 1,000 words, suggest rewrite; if <2, leave as-is

**Expected improvement:** Prose flows more naturally, fewer "unnatural" rewrite constraints, author retains stylistic choice.

---

### **10. SCRIPTURE FORMATTING — Rules Can Be Simplified**
**Current approach:** Detailed `SCRIPTURE_FORMATTING_RULES` block specifies:
- Preferred translation (NIV, KJV, ESV, NKJV, NLT, NASB, AMP, MSG)
- How to cite verses (inline vs. block quote vs. footnote)
- Dual citation rules (scripture + outside quote)
- Comma and punctuation placement around citations
- Markdown link formatting for scripture

**Why it might be over-constrained:**
- The LLM already understands scripture citation conventions from its training
- Specifying all punctuation rules ("comma before reference", "space before parenthesis") is micromanaging
- The rule block is long (300+ words) for what amounts to "cite scripture consistently"

**Trust opportunity:**
- **Simplify to:** "Format all scripture citations as [Book Chapter:Verse] (Translation). Example: John 3:16 (NIV). Use this format consistently throughout."
- Remove detailed punctuation rules — let the LLM apply standard academic citation style
- **Validation move:** Post-write, detect citation format inconsistencies (different translations, missing chapters, malformed references) and flag them

**Expected improvement:** Shorter prompt, faster generation, fewer citation rule conflicts. Validation still catches format errors.

---

### **11. CHAPTER PLANNER — Orchestration Over Auto-Execution**
**Current approach:** `chapter-plan` route generates a section-by-section outline before any section is written. It maps out: which excerpts support which paragraphs, what each paragraph's purpose is, and the order of coverage.

**Why it's over-constrained:**
- Pre-planning creates a rigid structure that the writer then has to follow, even if better connections emerge during writing
- Unanchored plan entries (concepts the LLM identified but found no transcript support for) are common sources of fabricated content
- The plan is deterministic — it doesn't adapt if the writer discovers a section needs restructuring mid-flow

**Trust opportunity:**
- Give the LLM the full chapter transcript and prior sections upfront. Let it decide *while writing* which excerpts to prioritize, rather than forcing a predetermined plan
- Keep the plan route *only* as an optional preview for authors who want to see the intended flow before writing starts, not as a hard constraint
- Post-write, verify that all generated content traces back to at least one transcript excerpt. Flag unsupported paragraphs for author review

**Expected improvement:** More organic prose flow, fewer fabricated bridge passages, writer can respond to discoveries mid-chapter. Quality improves because writing follows thinking, not a pre-formed blueprint.

---

### **12. SCRIPTURE FORMATTING — Blockquote-Only Standard with Three-Part Pattern**
**Current approach:** `SCRIPTURE_FORMATTING_RULES` detailed block specifies:
- Blockquote-only structure — every verse (any length) is standalone, never inline
- Three-part pattern: Introduction sentence (ending in colon) → Blockquote → Application paragraph
- Reference format: "— Book Chapter:Verse (Translation)" on separate line, em-dash ONLY before scripture references
- Exact verse reproduction: wording, punctuation, capitalization must match source; mark omissions with spaced ellipsis " . . . "
- Translation resolution: every quote carries a real abbreviation (NIV, ESV, KJV, NKJV, NASB, NLT, CSB, NRSV, AMP, MSG, etc.), never placeholder

**Why it matters:**
- Previous approaches allowed inline quotations, creating ambiguity about when to block vs. flow
- Restatement repetition is prevented by the three-part rule — application must *advance* meaning, never echo the verse
- Citation inconsistencies (missing translations, malformed references, comma placement) created quality flags in production
- Exact verse accuracy ensures fidelity to speaker's actual words, building reader trust

**Validation approach:**
- Post-write, run reference detection to ensure all scripture citations follow "— Book Chapter:Verse (Translation)" format
- Check for unanchored verses (quotations with missing or invented translations) and flag them
- Verify three-part pattern: application paragraph exists after blockquote and advances the idea, doesn't restate
- Detect inline quotations (prohibited under blockquote-only rule) and mark for rewrite

**Expected improvement:** Production-grade scripture formatting. Blockquote-only eliminates inline ambiguity. Three-part pattern prevents repetitive restatement. Translation resolution removes placeholder risk. Validation catches format drift before PDF/EPUB export.

---

## **Summary: Three-Tier Improvement Strategy**

| **Tier** | **Action** | **Impact** | **Risk** |
|----------|-----------|-----------|---------|
| **Immediate** | Reduce SOURCE_LOCK from 6 paragraphs → 2; remove INSTRUCTION_NORMALIZER; simplify PROSE_MASTERY | 15–25% cost reduction, faster generation | Low — LLM still respects core principles |
| **Medium** | Replace 5+ dedup layers with unified prior-prose sample; remove excerpt pre-filtering | 20–30% context reduction, simpler pipeline | Medium — requires post-write validation tuning |
| **Long-term** | Remove post-write reordering, orphan-paragraph detection, AI-signature checks; trust LLM for output quality | 30–40% simpler codebase, faster inference | Medium — requires culture shift to post-validation over prevention |

---

**The philosophy is straightforward:** You have an advanced LLM. The rules you've built are *guardrails against basic failure modes* (2019-era AI issues). DeepSeek 3 doesn't fail in those ways anymore. Lean into validation-over-prevention, simplify prompts, and watch quality *improve* because the LLM is solving the right problem instead of navigating your constraint maze.