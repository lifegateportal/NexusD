# Chapter Structure Quality — Root Cause Report & Fix

## Executive Summary

Your ebook pipeline has **three critical chapter/section quality issues**:

1. **Minimum sections: 3 instead of 5** — causing thin chapters with insufficient development
2. **Title/subtitle quality validation missing** — fallback to generic or poorly-formed titles
3. **Section heading validation not enforced** — warnings logged, but invalid headings pass through

All three issues are **fixable without breaking the pipeline flow**. The changes are backward-compatible and only improve structural output.

---

## Issue 1: Minimum Section Count Too Low (3 instead of 5)

### Location
[app/api/ebook/architect/route.ts](app/api/ebook/architect/route.ts) line **152**

### Current Code
```typescript
const minSections = Math.min(3, segs.length);
```

### The Problem
- **Fallback section grouper** produces 3–5 sections, defaulting to **minimum of 3**
- **LLM prompts** explicitly state "Each chapter: 3–5 sections" (not enforcing minimum)
- Chapters with only 3 sections lack depth — each section must do too much work
- Result: **Thin sections with bad headings** (can't develop distinct ideas)

### Why This Breaks Quality
- 3-section chapters force:
  - Section 1: "Introduction + Hook" (overloaded)
  - Section 2: "Everything in the middle" (bloated)
  - Section 3: "Conclusion + Application" (incomplete)
- Reader sees **poorly-organized section headings** because each section tries to cover too much
- Editor can't **dedup content** across sections (overlap is inevitable)

### The Fix
Change `minSections` from **3 to 5** in the fallback grouper, and update all LLM prompts to enforce **"exactly 5 sections minimum"** instead of a range.

---

## Issue 2: Title and Subtitle Quality (No Validation)

### Locations

#### Book Title
[app/api/ebook/architect/route.ts](app/api/ebook/architect/route.ts) line **545**
```typescript
const shortBookTitle = (
  input.contentMap.overarchingThemes[0] ||
  chapters[0]?.title ||
  input.contentMap.segments[0]?.topic ||
  "Untitled Teaching Manuscript"
).trim().split(".")[0].slice(0, 100);
```

#### Subtitle
[app/api/ebook/architect/route.ts](app/api/ebook/architect/route.ts) line **549**
```typescript
subtitle: input.contentMap.targetAudience || input.contentMap.teachingArc || "Drawn directly from the source teaching",
```

### The Problem
- **Book title**: Pulls from themes/chapter titles but applies no quality checks
  - May be fragment, truncated, or generic
  - No length validation (could be too long)
  - No grammar/style check
  
- **Subtitle**: Falls back to generic string
  - `"Drawn directly from the source teaching"` appears in many books
  - No validation that teachingArc is subtitle-quality

### Why This Breaks Quality
- Readers judge a book by its title/subtitle **before reading content**
- Generic subtitles signal low production value
- Poor titles make the architecture warnings harder to triage — editor doesn't know if title itself is the problem

### The Fix
Add post-generation validation:
1. Check title length (4–7 words, not >12)
2. Check title doesn't end in preposition or conjunction
3. Check subtitle is not generic filler text
4. If validation fails, **retain the best available candidate** with a warning logged

---

## Issue 3: Section Heading Validation Warnings Not Enforced

### Location
[app/api/ebook/architect/route.ts](app/api/ebook/architect/route.ts) line **418–426**

### Current Code
```typescript
const DANGLING_END_RE = /\b(to|our|the|in|for|on|and|but|or|let|a|an|its|their|them|it)$/i;

for (const chapter of targetChapters) {
  for (const section of chapter.sections) {
    const words = section.heading.trim().split(/\s+/);
    if (words.length > 8) {
      architectureWarnings.push(
        `Ch ${chapter.number} §${section.sectionNumber}: Heading too long (${words.length} words): "${section.heading}"`
      );
    }
    if (DANGLING_END_RE.test(section.heading.trim())) {
      architectureWarnings.push(
        `Ch ${chapter.number} §${section.sectionNumber}: Heading ends mid-thought: "${section.heading}"`
      );
    }
  }
}
```

### The Problem
- **Warnings are logged but headings are NOT fixed**
- Invalid headings pass through to the writer
- Writer then has to work around bad headings (or ignores them)
- Result: **Bad headings in final book**

### Why This Breaks Quality
- Section heading is the reader's first impression of that section's content
- Bad headings:
  - "Pray until you are no longer" (dangling — reader confused)
  - "When we open up our" (incomplete — unreadable)
  - "Prayer as a transformative encounter that reveals hidden glory and changes the prayer's internal state" (too long — doesn't fit in chapter)
- These headings destroy credibility and make the book look rushed

### The Fix
Add post-generation **heading correction logic**:
1. Detect invalid headings (dangling word, too long, empty, banned prefixes)
2. **Regenerate** using `deriveSectionHeading()` fallback logic
3. If regeneration doesn't work, **prompt the LLM to fix just that heading**
4. Log correction as informational (not warning)

---

## Pipeline Impact Assessment

### ✅ Safe to Implement
- All changes are **in the architect step** (before writing)
- No impact on write-section, chapter-plan, or polish steps
- Fallback mechanisms remain intact and functional
- Existing chapters are not affected (architect runs once per project)

### ✅ Backward Compatible
- Existing content structures not modified
- Only affects newly-created chapter architectures
- Can be applied incrementally to in-progress projects

### ✅ Reader-Facing Benefits
- Cleaner chapter structure (better organization)
- Stronger section headings (clearer navigation)
- Professional-quality titles (better first impression)
- More consistent section development (less thin sections)

---

## Implementation Checklist

- [ ] **Fix 1**: Change `minSections` from 3 to 5 (line 152)
- [ ] **Fix 2**: Update LLM prompt "3–5 sections" → "5 sections minimum" (line 570–595)
- [ ] **Fix 3**: Add heading validation + correction pass (after normalizeArchitecture)
- [ ] **Fix 4**: Add title/subtitle validation + fallback selection
- [ ] **Test**: Verify 5-section minimum enforced across oneChapterPerUpload + fallback paths
- [ ] **Verify**: Section headings meet standard (no dangling words, length 4–8 words)
- [ ] **Verify**: Titles are punchy, not generic, not truncated

---

## Expected Outcomes After Fix

### Before
- Chapters: 3–4 sections (thin development)
- Section headings: "Pray until you are", "When we open up", generic labels
- Titles: "Prayer", "Leadership", fallback to "Untitled Teaching Manuscript"
- Subtitles: Generic filler ("Drawn directly from the source teaching")

### After
- Chapters: Consistently **5+ sections** (full development)
- Section headings: "Prayer Transforms the Pray-er", "Righteous Living Powers Prayer", domain-specific and clear
- Titles: Punchy book titles like "When Prayer Changes You", not truncations
- Subtitles: Specific, audience-focused, not generic

---

## Code Changes Summary

| File | Line | Change | Rationale |
|------|------|--------|-----------|
| architect/route.ts | 152 | `minSections = 3` → `minSections = 5` | Enforce 5 sections minimum |
| architect/route.ts | 570 | Prompt: "3–5 sections" → "5 sections minimum" | LLM compliance |
| architect/route.ts | ~450 | Add heading validation fn | Detect/fix invalid headings |
| architect/route.ts | ~550 | Add title/subtitle validation fn | Ensure quality titles |
| architect/route.ts | ~600 | Call validation fns on normalized result | Enforce before return |

---

## Q&A

**Q: Will this slow down the pipeline?**
A: No. Validation runs on already-generated data (no new LLM calls unless regeneration needed, which is rare).

**Q: What if a chapter has <5 sections worth of content?**
A: The LLM will split thin sections or expand existing ones. If truly insufficient, a warning is logged (exceptional case).

**Q: Will existing chapters be re-architected?**
A: No. The architect runs once. To re-architect, you'd need to re-run the architect endpoint explicitly.

**Q: Does this change the writing prompt?**
A: No. Write-section receives the same section data; only the structure (section count) changes.

**Q: What about the subtitle falling back to "Drawn directly from..."?**
A: The fix adds logic to prefer `targetAudience` first, then `teachingArc`, then a more specific fallback. Generic fallback only used if no better option exists.

---

## Status
✅ **Root causes identified**
✅ **Impact assessed** (safe, backward-compatible)
✅ **Implementation plan detailed**
⏳ **Ready for code changes**

