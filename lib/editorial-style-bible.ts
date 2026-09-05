export const READER_NORMALIZATION_RULES = `READER NORMALIZATION (book-first):
- Convert live-audience delivery to reader-facing prose.
- Never address a live audience anywhere in the book.
- Remove room-control cues and response prompts (e.g., "say amen", "look at your neighbor", applause cues, altar-response directives).
- Rewrite stage/location references ("in this room", "as you sit here today") into direct reader language.
- Preserve meaning, doctrine, and argument sequence exactly; only change delivery mode.`;

export const SOURCE_LOCK_RULES = `════════════════════════════════════════════
SOURCE-LOCK — THE MOST IMPORTANT RULE IN THIS PROMPT
════════════════════════════════════════════
This book contains ONLY what this preacher taught in this transcript. Nothing else.

THE GHOST-TEST: Before writing any sentence, ask: "Did this specific preacher say this specific thing in the provided excerpts?" If the answer is anything other than YES, that sentence must not exist.

WHAT IS FORBIDDEN — be precise about each category:

1. THEOLOGICAL EXTENSIONS: The preacher made point A. You know that point A logically implies point B. Point B is not in the transcript. → Do not write point B. It doesn't matter how obvious or correct point B is. The preacher didn't teach it here.

2. SUPPORTING SCRIPTURE YOU KNOW: The preacher quoted Psalm 91. You know of five other passages that reinforce the same theme. → Do not cite them. Only scripture the preacher explicitly quoted or referenced may appear.

3. DOCTRINAL BACKGROUND: You know the historical context, systematic theology category, Greek/Hebrew etymology, or church tradition behind what the preacher said. The preacher didn't mention any of it. → Do not include it. Your training data about theology is not source material.

4. LOGICAL COMPLETIONS: The preacher started an argument but didn't fully close it. You can see how it ends. → Do not complete it. Write what was said; leave the rest out.

5. CONSISTENT-SOUNDING CONTENT: An idea isn't in the transcript, but it "fits" the author's message, theology, or style. → Fitting is not the same as present. Do not include it.

6. APPLICATIONS AND IMPLICATIONS: The preacher taught a principle. You can derive practical applications from it. The preacher didn't state those applications. → Do not add them. Applications must come from the preacher's own words.

THE CORRECT RESPONSE TO THIN SOURCE MATERIAL: Write less. A section with three accurate, transcript-faithful paragraphs is better than five paragraphs where two were invented. Short and true beats long and padded. When the transcript runs out, the prose stops.

WHAT YOU MAY DO: Improve sentence structure, word choice, rhythm, and paragraph flow without changing the order of source ideas. Smooth transitions between ideas — using only the ideas present in the transcript. You own the presentation; the preacher owns every idea.`;

export const PROSE_MASTERY_RULES = `PROSE MASTERY — APPLY WITHOUT CHANGING SOURCE ORDER OR REINTRODUCING COVERED CONCEPTS:

PRECEDENCE — READ FIRST:
- Every anti-duplication instruction elsewhere in this prompt (coverage ledger, banned recaps, concept ownership map, overused phrases, already-covered points, used illustrations, forbidden verse texts) OUTRANKS every rule below.
- None of these prose techniques is a license to re-explain, re-illustrate, re-ground, or restate a concept, example, image, or claim that is already fully covered. When a technique below would require touching covered ground, apply it using ONLY new material from this section's own excerpts, or skip it and write less.

TRANSCRIPT ORDER IS ABSOLUTE — CHAPTER-WIDE, NOT JUST LOCAL:
- Preserve the exact order in which the speaker develops ideas across the entire chapter, not only within the current section's excerpts.
- Never move a later claim, image, example, scripture, pivot, or conclusion earlier, whether that reordering would happen inside one paragraph, across paragraphs in one section, or across sections in the chapter.
- Never merge separate transcript movements if doing so changes their order or boundaries.
- You may polish wording and sentence structure within one local movement only.
- If a prose improvement requires reordering source material at any scope, preserve the source order and write less.

HOLISTIC CHAPTER TREATMENT — NO REDUNDANCY ONCE A CONCEPT IS COVERED:
- Treat the chapter as one continuous piece even though it is written section by section. Before applying any technique below, check it against what the coverage ledger and concept ownership map say this chapter (and earlier chapters) already established.
- A concept, example, image, or argument fully covered earlier is owned by that earlier section. Later sections may reference it in one short clause at most; they may never redevelop, re-illustrate, or re-explain it.
- Prefer silence over repetition: if this section's own excerpts do not supply new ground for a technique, do not manufacture it from material already used elsewhere.

SPECIFICITY OVER ABSTRACTION:
- Every abstract claim must touch ground within two sentences through a name, number, place, action, or image actually present in THIS section's own excerpts.
- Never reuse a name, number, place, action, or image that was already used to ground a claim in an earlier section.
- If the transcript provides no new concrete anchor, make the claim and stop. Never invent an example and never borrow one from covered ground.

THE PARAGRAPH TURN:
- Shape each paragraph around the movement already present in the transcript: setup, turn, and landing.
- Preserve that local sequence. Never write a landing before its source setup.
- The final sentence should leave the reader somewhere new, not repeat the paragraph's opening and not repeat a landing already used in an earlier section.

IMAGERY DISCIPLINE:
- Prefer one fresh image the speaker actually used over several generic images.
- Do not mix metaphors. Carry one controlling image through the local paragraph, then release it.
- Never reuse an image, metaphor, or illustration that a prior section already carried through to its landing.

RESTRAINT:
- After a vivid image or landed point, cut the sentence that explains it.
- Trust the reader. Never use "This means that", "What this shows is", or "In other words" as explanatory padding.

VERBS CARRY THE WEIGHT:
- Prefer a precise active verb over a weak "to be" construction when the transcript supports it.
- Do not add an actor merely to make a sentence active. If the transcript supplies no actor, write less.

CADENCE:
- Read each paragraph internally for rhythm. Vary sentence length and grammatical shape with intent.
- Break mechanical runs without disturbing the order of source ideas.

STAKES:
- Let each section make the reader feel why the teaching matters now through a concrete consequence from THIS section's own new transcript material.
- Do not announce importance. Do not manufacture consequences the speaker did not state, and do not restate a stakes-moment already landed in an earlier section.`;

export const PREMIUM_BOOK_STYLE_RULES = `PREMIUM BOOK STYLE STANDARDS:

STYLISTIC LIBERTY — WHAT YOU OWN:
You have full creative authority over sentence structure, word choice, rhythm, rhetorical devices, and paragraph architecture. Use this freedom deliberately:
- Choose the most precise and vivid word available — not the first synonym that fits.
- Invert sentence structure for emphasis when it serves the idea.
- Use rhetorical questions, fragments for emphasis, and colons to land a point.
- Reorder sentences within a paragraph to build better logical momentum.
- The CONTENT (every idea, argument, story, claim, and fact) is locked to the transcript. The PRESENTATION is yours. These are separate decisions. Never confuse them.
- If a passage can be said in three ways and all three are accurate to the source, choose the one with the most force.

EM DASH BAN (absolute in prose — one sanctioned exception):
- Never use an em dash (—) for any purpose in prose sentences.
- Never use spaced em dashes ( — ), unspaced em dashes (—), or double hyphens (--) used as em dashes.
- Rewrite every sentence that would require an em dash: use a comma, colon, semicolon, or subordinate clause ("which," "who," "although," "because," "while," "since") instead. Only split into two sentences when both halves are genuinely strong standalone thoughts — not just because the em dash is gone.
- THE ONE EXCEPTION: the em dash preceding a scripture reference line ("— Book Chapter:Verse") is a bibliographic citation mark, not prose, and is required there. See SCRIPTURE FORMATTING rules.

PARAGRAPH CRAFT:
- No paragraph should exceed 5 sentences. Short paragraphs (1–2 sentences) are not weakness; they are emphasis.
- Vary opening words across consecutive paragraphs. Never start two adjacent paragraphs with the same word or phrase.
- End each paragraph with either a strong declarative statement or a forward-pulling question — never a flat summary restatement.
- Occasionally let a paragraph close on an incomplete thought. A fragment. It signals voice, not error.

SENTENCE RHYTHM & FLOW (global literary standards):
- Mix sentence lengths deliberately: long sentences build momentum and explain; short sentences land the blow. Never write five short sentences in a row — that reads like a bullet list, not prose.
- When a thought would have used an em dash, prefer a subordinate clause over a period. "She left. She was afraid." → "She left, afraid of what she might find." Use "although," "because," "while," "since," "which," and "who" to bind related ideas before reaching for a full stop.
- No three consecutive sentences should share the same approximate length or grammatical structure.
- Vary sentence openings: leading participial phrases ("Having set this foundation..."), inverted constructions ("What the disciples expected was power; what they received was a flame."), and sentences that open with a prepositional phrase or subordinate clause.
- Semicolons are encouraged: use them to join two closely related independent clauses that belong in the same breath of thought.
- Colons introduce conclusions and explanations — prefer them where an em dash would have appeared.
- Avoid passive constructions. Rewrite every "it was found that" and "there is a sense in which" into direct active claims.
- Use contractions where they occur naturally in prose (it's, you're, that's, don't, isn't, won't). They read human; stiff formal constructions read robotic.

PASSIVE VOICE — ZERO TOLERANCE (scan every sentence before returning):
Passive constructions drain authority from prose. Identify and rewrite every instance before finalizing output.

BANNED PASSIVE PATTERNS (rewrite all of these):
- "is/are/was/were + past participle": "is seen," "was found," "are called," "were given" → find the actor and make them the subject.
- "there is/there are/there was/there were": "There is a tendency to" → "Writers tend to"; "There was a moment when" → name the moment directly.
- "it is/it was + adjective/past participle": "It is important to note," "It was decided that," "It is believed that" → delete or recast.
- "God is known as," "Jesus is referred to as," "Paul is considered" → "God is," "Jesus serves as," "Paul functions as."
- "we are called to," "we are meant to," "believers are told to" → "the call is," "the imperative is," "the text commands."
- "can be seen," "can be found," "should be noted" → show it; do not narrate that it can be seen.

ACTIVE REWRITE METHOD: Ask "Who is doing what?" and make the doer the subject. If there is no clear doer from the transcript, delete the sentence rather than inventing one.

TENSE CONSISTENCY (enforce in every paragraph before returning):
- Use PRESENT TENSE for teaching, principles, theological claims, and application: "Faith works through love," not "Faith worked through love." "Paul argues," not "Paul argued."
- Use PAST TENSE only for historical narrative events and specific stories: "Moses parted the sea," "When Peter walked on water."
- Never mix tenses within the same paragraph when discussing the same subject. If you begin expounding a scripture in present tense, every sentence of that exposition stays present tense.
- Scripture exposition is always present tense: the text "says," "teaches," "commands," "warns" — never "said," "taught," "commanded."
- Consistency check: scan every paragraph for tense shifts before finalizing. A drift from present to past in the same paragraph is an error.

FORBIDDEN PHRASES (hard ban — delete or rewrite every instance):
"In conclusion" | "It's important to note" | "It is crucial to remember" | "Let's delve into" | "A tapestry of" | "Navigating the landscape" | "In today's fast-paced world" | "Furthermore" | "Moreover" | "It is worth noting" | "At the end of the day" | "Game-changer" | "Paradigm shift" | "Deep dive" | "Unpack" | "Moving forward" | "Robust" | "Leverage" | "Synergy" | "It goes without saying" | "The truth is," | "The fact of the matter is" | "Indeed," | "Certainly," | "Ultimately," | "At its core," | "In essence," | "Simply put," | "Not just...but" | "Not merely...but" | "This is not merely" | "profoundly" | "deeply meaningful" | "transformative" | "journey" (used metaphorically) | "vibrant" | "fostering" | "crucial" | "vital" (overused)

PAIRED INTENSIFIER BAN:
- Never join two adjectives with "and" when either alone would be stronger: "clear and compelling" → "compelling"; "rich and complex" → "complex"; "deep and meaningful" → choose one word.

OPENING SENTENCES:
- Never open a paragraph with a direct re-statement of the section heading just used.
- Never open with a generalization when a specific detail from the transcript is available.
- Avoid opening with "This chapter", "This section", or "In this passage" — drop the reader into the idea, not a table of contents.

TRANSITIONS:
- Transitions must create logical pull toward the next idea, not summarize what just happened.
- Mid-chapter summary transitions ("So, as we have seen...", "To summarize...") are forbidden.
- Never stack two rhetorical questions in back-to-back sentences.

HUMANIZATION RULES (anti-AI detection — enforce rigorously):
- Break perfect parallel structure. If a list of three things has matching grammatical form, make one of them slightly different in structure.
- Avoid "X is not just A; it is B" and "X is not merely A, it is B" sentence frames — these are AI signatures.
- Avoid the double-comma appositive: "Love, the foundation of all things, is..." — rewrite as a separate sentence.
- Never follow a big claim with "This means that..." or "What this tells us is..." — land the implication directly.
- Avoid ending three or more consecutive paragraphs with a question.
- Do not summarize what a scripture quote says immediately after quoting it. Trust the reader.

KEY TERM CONSISTENCY:
- Identify the author's preferred term for key concepts from the Voice DNA preferredTerminology. Use that exact term throughout — never swap in a synonym for variety.
- If the author says "agape love," every reference in the chapter uses "agape love," not "God's love," "divine love," or "unconditional love."
- Inconsistent terminology is a mark of unpolished writing. Standardize on the author's own words.

DIALOGUE AND CONVERSATION FORMATTING:
When the author recounts a conversation, exchange, or paraphrased dialogue (including conversations with God, prayers, or interpersonal exchanges from the transcript), apply these formatting rules:

- PARAPHRASED CONVERSATIONS: Keep them in flowing prose. Do not use theatrical dialogue tags or quotation marks for paraphrased speech. Instead, use indirect reported speech: "He told her it would be okay" not "He said, 'It will be okay.'"
- DIRECT QUOTES FROM SCRIPTURE OR A REAL SOURCE: Use standard quotation marks. Only use direct quotes when the transcript provides the verbatim wording.
- AVOID PLAY-SCRIPT FORMAT: Never format a conversation as "Person A: [text]" and "Person B: [text]" — this is a devotional book, not a transcript.
- AVOID REPEATED "SAID/TOLD" TAGS: Never stack multiple "I said… He said… I told him… She told me" structures in adjacent sentences. Vary with action beats, indirect speech, and narrative transitions.
- PRAYER CONVERSATIONS: When the author recounts praying or hearing from God, keep the voice intimate but avoid putting words in God's mouth unless the transcript contains the author's explicit phrasing.
`;

const AUDIENCE_PATTERNS = [
	/\blook at your neighbor\b/gi,
	/\bsay amen\b/gi,
	/\bclap your hands\b/gi,
	/\blift your hands\b/gi,
	/\btell them how good they look\b/gi,
	/\bas you sit here today\b/gi,
	/\bin this room today\b/gi,
	/\bright here in this place\b/gi,
	/\bthe person next to you\b/gi,
	/\byour neighbor\b/gi,
	/\bthis audience\b/gi,
	// Extended audience plurals and addressing
	/\b(y'all|you\s+all|everybody|somebody|someone|anybody|anybody\s+here)\b/gi,
	/,?\s*(church|saints|family|believers|church\s+family),?\s+/gi,
	/\b(look\s+around|shake\s+your\s+neighbor|wave\s+at|nod\s+if)\b/gi,
	// Worship/response language
	/\b(praise\s+god|thank\s+god|bless\s+the\s+lord|glory\s+to\s+god)\b/gi,
];

const NON_BOOK_PATTERNS = [
	/\bgood\s+(morning|afternoon|evening),?\s+(church|everyone|family|saints)\b/gi,
	/\bwelcome\s+(to\s+church|everyone|family)\b/gi,
	/\bi\s+(just\s+)?want\s+to\s+thank\s+(you|everyone|all\s+of\s+you)\b/gi,
	/\bthank\s+you\s+(everyone|all|so\s+much|for\s+coming|for\s+joining|for\s+being\s+here)\b/gi,
	/\bwe\s+thank\s+you\s+for\s+coming\b/gi,
	/\blet\s+us\s+appreciate\b/gi,
	/\bput\s+your\s+hands\s+together\b/gi,
	/\bgive\s+the\s+lord\s+a\s+hand\b/gi,
	/\byou\s+may\s+be\s+seated\b/gi,
	/\btoday,?\s+we\s+are\s+looking\s+at\b/gi,
	/\blet\s+me\s+start\s+with\s+the\s+big\s+one\s+first\b/gi,
	/\bwell,?\s+we\s+never\s+have\s+enough\s+time\s+to\s+share\b/gi,
	/\bi\s+advance\s+in\s+love\b/gi,
	// F3 — oral padding prefixes (strip the filler prefix, keep the content clause)
	/\bi\s+want\s+you\s+to\s+understand\s+that\s*/gi,
	/\bi\s+need\s+you\s+to\s+hear\s+this[,.]?\s*/gi,
	/\blet\s+me\s+say\s+this\s+again[,.]?\s*/gi,
	/\byou\s+know\s+what\s+i('m|\s+am)\s+saying[,?]?\s*/gi,
	/\bdo\s+you\s+understand\s+what\s+i('m|\s+am)\s+saying[?.]?\s*/gi,
	// Extended filler prefixes
	/\b(let\s+me\s+(tell|be|make|put|show)\s+you|i'm\s+telling\s+you|listen\s+to\s+me)\b/gi,
	/\b(you\s+know\s+what|think\s+about|picture\s+this|imagine\s+if|follow\s+me)\b/gi,
	/\b(i\s+feel\s+like|i\s+sense|sense\s+the\s+spirit|anointing|the\s+flow)\b/gi,
	/\b(give\s+a\s+(hand|shout)|take\s+your\s+neighbor|praise\s+break|testimony\s+time)\b/gi,
];

const NON_BOOK_SENTENCE_PATTERNS = [
	/\b(that\s+hand\s+clap\s+was\s+for\s+me|let'?s\s+do\s+it\s+for\s+jesus\s+christ|what\s+a\s+mighty\s+god\s+we\s+serve)\b/i,
	/\b(father,?\s+we\s+thank\s+you|thank\s+you,?\s+holy\s+spirit|blessed\s+be\s+the\s+name\s+of\s+the\s+lord|you\s+deserve\s+all\s+glory|you\s+deserve\s+all\s+adoration|we\s+bless\s+your\s+holy\s+name|great\s+is\s+your\s+faithfulness)\b/i,
	/\b(the\s+spirit\s+of\s+god\s+was\s+ministering\s+to\s+me|god\s+is\s+healing\s+you\s+today|that\s+issue\s+will\s+not\s+repeat\s+itself|he'?s\s+touching\s+you)\b/i,
	/\b(some\s+of\s+you\b|someone\s+here\b|the\s+lord\s+is\s+touching\s+someone\b)\b/i,
	// F3 — standalone oral padding sentences
	/^\s*are\s+you\s+following\s+me\??\s*$/i,
	/^\s*can\s+i\s+tell\s+you\s+something\??\s*$/i,
	/^\s*if\s+you\s+can\s+hear\s+me\s+(say|type)\s+amen\b.*$/i,
	/^\s*say\s+amen\s+if\s+you\s+(hear|receive|believe)\b.*$/i,
	/^\s*somebody\s+shout\b.*$/i,
	/^\s*give\s+god\s+a\s+(praise|shout|hand)\b.*$/i,
	// Extended testimony/story cues
	/\b(some\s+of\s+you\s+(got\s+a\s+story|can\s+testify)|somebody\s+can\s+testify|i'?m\s+preaching\s+to\s+somebody)\b/i,
	// Charismatic service language
	/\b(praise\s+break|worship\s+moment|before\s+we\s+pray|close\s+your\s+eyes|prayer\s+time|rededicate\s+your\s+life|renew\s+your\s+commitment)\b/i,
	// Rededication/invitation language
	/\b(been\s+running\s+from\s+god|tired\s+of\s+sin|worn\s+out|if\s+you'?re\s+serious\s+about|today\s+is\s+your\s+day)\b/i,
];

// F6 — altar call and salvation appeal sentences (mid-sermon or tail)
const ALTAR_CALL_PATTERNS: RegExp[] = [
	/\bif\s+you\s+want\s+to\s+accept\s+(jesus|christ|the\s+lord)\b/i,
	/\braise\s+your\s+hand\s+(right\s+now|if\s+you\b)/i,
	/\brepeat\s+after\s+me\b/i,
	/\bcome\s+to\s+the\s+(front|altar)\b/i,
	/\bsinner'?s\s+prayer\b/i,
	/\bgive\s+your\s+(life|heart)\s+to\s+(jesus|god|christ|the\s+lord)\b/i,
	/\baccept\s+(jesus|christ|the\s+lord)\s+(as\s+your|today)\b/i,
	/\byou\s+can\s+be\s+saved\s+today\b/i,
	/\bprayer\s+of\s+salvation\b/i,
	/\bif\s+you\s+(prayed|said)\s+that\s+prayer\b/i,
	/\bwelcome\s+(you\s+)?to\s+the\s+(family\s+of\s+god|kingdom)\b/i,
];

const RECAP_CUE_RE = /\b(this\s+month'?s\s+theme|our\s+monthly\s+theme|series\s+theme|theme\s+for\s+the\s+month|as\s+i\s+said\s+last\s+(week|message|time)|from\s+our\s+last\s+message|in\s+the\s+previous\s+message|continuing\s+this\s+series|part\s+\d+\s+of\s+this\s+series|welcome\s+back\s+to\s+this\s+series)\b/i;

export const NON_BOOK_CUE_RE = /\b(say amen|look at your neighbor|clap your hands|lift your hands|as you sit here today|in this room today|right here in this place|the person next to you|your neighbor|this audience|good\s+(morning|afternoon|evening),?\s+(church|everyone|family|saints)|welcome\s+(to\s+church|everyone|family)|i\s+(just\s+)?want\s+to\s+thank\s+(you|everyone|all\s+of\s+you)|thank\s+you\s+(everyone|all|so\s+much|for\s+coming|for\s+joining|for\s+being\s+here)|let\s+us\s+appreciate|put\s+your\s+hands\s+together|give\s+the\s+lord\s+a\s+hand|you\s+may\s+be\s+seated|that\s+hand\s+clap\s+was\s+for\s+me|let'?s\s+do\s+it\s+for\s+jesus\s+christ|what\s+a\s+mighty\s+god\s+we\s+serve|father,?\s+we\s+thank\s+you|thank\s+you,?\s+holy\s+spirit|blessed\s+be\s+the\s+name\s+of\s+the\s+lord|you\s+deserve\s+all\s+glory|you\s+deserve\s+all\s+adoration|we\s+bless\s+your\s+holy\s+name|great\s+is\s+your\s+faithfulness|the\s+spirit\s+of\s+god\s+was\s+ministering\s+to\s+me|god\s+is\s+healing\s+you\s+today|that\s+issue\s+will\s+not\s+repeat\s+itself|he'?s\s+touching\s+you|some\s+of\s+you|someone\s+here|today,?\s+we\s+are\s+looking\s+at|well,?\s+we\s+never\s+have\s+enough\s+time\s+to\s+share|i\s+advance\s+in\s+love)\b/gi;

// ── F7: Strip ASR/transcript artifacts before any other pass ─────────────────
function stripTranscriptArtifacts(input: string): string {
	return input
		// Timestamps: [00:12:34], (0:12), bare 0:12:34 at line start or standalone
		.replace(/\[?\(?\d{1,2}:\d{2}(?::\d{2})?\)?\]?\s*/g, "")
		// Speaker diarization labels: SPEAKER_01:  Speaker 1:  Host:  Pastor John:
		.replace(/^[A-Z][A-Za-z0-9 _-]{0,28}:\s*/gm, "")
		// ASR confidence/event tags: [inaudible] [crosstalk] [music] [applause] etc.
		.replace(/\[(inaudible|crosstalk|noise|laughter|music|applause|unclear|indistinct)\]/gi, "")
		// Numeric confidence scores: (0.92)
		.replace(/\(\d+\.\d+\)/g, "")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

// ── F2: Strip ASR filler words, stutters, and false-start repetitions ─────────
function stripASRNoise(input: string): string {
	return input
		// Standalone filler tokens: um, uh, er, hmm, erm (with optional comma)
		.replace(/\b(um|uh|er|hmm|hm|erm),?\s*/gi, "")
		// Word stutters: "the the the" → "the", "so so" → "so" (2–4 consecutive repeats)
		.replace(/\b(\w{2,})\s+(\1\s*){1,3}/gi, "$1 ")
		// False-start phrase repetitions: "what I mean is, what I mean is" → keep once
		.replace(/([^,.!?]{15,55}),\s*\1[,.]?/gi, "$1")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

// ── F5: Collapse consecutive near-duplicate sentences (>80% token overlap) ───
function collapseNearDuplicateSentences(input: string): string {
	const paragraphs = input.split(/\n{2,}/);
	const result = paragraphs.map((para) => {
		const sentences = para.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
		if (sentences.length <= 1) return para;
		const kept: string[] = [sentences[0]];
		for (let i = 1; i < sentences.length; i++) {
			const prev = kept[kept.length - 1];
			const curr = sentences[i];
			const prevTokens = new Set(
				prev.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 2)
			);
			const currTokens = curr.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 2);
			if (prevTokens.size === 0 || currTokens.length === 0) { kept.push(curr); continue; }
			let shared = 0;
			for (const w of currTokens) { if (prevTokens.has(w)) shared++; }
			const overlap = shared / Math.min(prevTokens.size, currTokens.length);
			if (overlap < 0.8) kept.push(curr);
			// else: ≥80% duplicate of the previous sentence — drop it
		}
		return kept.join(" ");
	});
	return result.filter(Boolean).join("\n\n");
}

// ── F6: Excise mid-sermon altar calls and salvation appeals ──────────────────
function exciseMidSermonAltarCalls(input: string): string {
	const paragraphs = input.split(/\n{2,}/);
	const result = paragraphs.map((para) => {
		const sentences = para.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
		const kept = sentences.filter((s) => !ALTAR_CALL_PATTERNS.some((p) => p.test(s)));
		return kept.join(" ");
	});
	return result.filter(Boolean).join("\n\n");
}

// ── F4: Tag slots where >70% of sentences are non-book language ───────────────
function tagNonTeachingSlots(input: string): string {
	// Split on [Slot-N] boundaries, keeping the header at the front of each block
	const blocks = input.split(/(?=\[Slot-\d+\])/);
	return blocks.map((block) => {
		if (!/^\[Slot-\d+\]/.test(block)) return block;
		const body = block.replace(/^\[Slot-\d+\]\s*/, "");
		const sentences = body.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
		if (sentences.length < 3) return block; // too short to classify reliably
		const nonBookCount = sentences.filter((s) =>
			NON_BOOK_SENTENCE_PATTERNS.some((p) => p.test(s)) ||
			AUDIENCE_PATTERNS.some((p) => p.test(s)) ||
			NON_BOOK_PATTERNS.some((p) => p.test(s)) ||
			ALTAR_CALL_PATTERNS.some((p) => p.test(s))
		).length;
		if (nonBookCount / sentences.length > 0.7) {
			return block.replace(/\[Slot-(\d+)\]/, "[NON-TEACHING-SLOT-$1]");
		}
		return block;
	}).join("");
}

function cleanBookText(input: string): string {
	return input
		.replace(/\b(Amen|hallelujah|praise the lord|my god)\b/gi, "")
		// Remove em dashes: replace with comma for mid-sentence, period+space before capital
		.replace(/\s*\u2014\s*([A-Z])/g, ". $1")
		.replace(/\s*\u2014\s*/g, ", ")
		// Clean up double commas or comma-period sequences left after em dash removal
		.replace(/,\s*,/g, ",")
		.replace(/\.\s*,/g, ".")
		.replace(/,\s*\./g, ".")
		.replace(/[ \t]{2,}/g, " ")  // Only collapse horizontal whitespace — never newlines
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n[ \t]+/g, "\n")
		.trim();
}

function pruneNonBookSentences(input: string): string {
	// Preserve paragraph boundaries — process each paragraph independently
	const paragraphs = input.split(/\n{2,}/);
	const cleaned = paragraphs.map((paragraph) => {
		const parts = paragraph
			.split(/(?<=[.!?])\s+/)
			.map((part) => part.trim())
			.filter(Boolean);
		const kept = parts.filter((part) => !NON_BOOK_SENTENCE_PATTERNS.some((pattern) => pattern.test(part)));
		return kept.join(" ");
	}).filter(Boolean);
	return cleanBookText(cleaned.join("\n\n"));
}

function normalizeForRecapMatch(input: string): string[] {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((token) => token.length > 2);
}

function jaccardSimilarity(a: string[], b: string[]): number {
	if (a.length === 0 || b.length === 0) return 0;
	const aSet = new Set(a);
	const bSet = new Set(b);
	let intersection = 0;
	for (const token of aSet) {
		if (bSet.has(token)) intersection += 1;
	}
	const union = aSet.size + bSet.size - intersection;
	return union > 0 ? intersection / union : 0;
}

export function pruneRedundantSeriesRecaps(input: string): string {
	// Preserve paragraph boundaries — process each paragraph independently
	const paragraphs = input.split(/\n{2,}/);
	const cleanedParagraphs = paragraphs.map((paragraph) => {
		const sentences = paragraph
			.split(/(?<=[.!?])\s+/)
			.map((sentence) => sentence.trim())
			.filter(Boolean);

		const kept: string[] = [];
		const recapSignatures: string[][] = [];

		for (const sentence of sentences) {
			if (!RECAP_CUE_RE.test(sentence)) {
				kept.push(sentence);
				continue;
			}
			const signature = normalizeForRecapMatch(sentence);
			const isDuplicate = recapSignatures.some((existing) => jaccardSimilarity(existing, signature) >= 0.7);
			if (!isDuplicate) {
				recapSignatures.push(signature);
				kept.push(sentence);
			}
		}
		return kept.join(" ");
	}).filter(Boolean);

	return cleanBookText(cleanedParagraphs.join("\n\n"));
}

export function stripNonBookLanguage(input: string): string {
	let output = pruneNonBookSentences(input);
	for (const pattern of AUDIENCE_PATTERNS) {
		output = output.replace(pattern, "");
	}
	for (const pattern of NON_BOOK_PATTERNS) {
		output = output.replace(pattern, "");
	}
	return pruneNonBookSentences(pruneRedundantSeriesRecaps(cleanBookText(output)));
}

export function stripAudienceLanguage(input: string): string {
	return stripNonBookLanguage(input);
}

/**
 * cleanTranscriptForBook — full 7-pass deterministic filter pipeline.
 * Run on each raw slot transcript before LLM stages touch the text.
 *
 * Pass order:
 *   F7 → strip ASR/timestamp artifacts
 *   F2 → strip filler words, stutters, false-start repetitions
 *   F6 → excise mid-sermon altar calls and salvation appeals
 *   F1/F3 → sentence-level and phrase-level non-book language removal
 *   F5 → collapse consecutive near-duplicate sentences
 *   F4 → tag slots where >70% of sentences are non-book
 *       (content-map skips [NON-TEACHING-SLOT-N] blocks automatically)
 *   existing → prune redundant series recaps + clean typography
 */
export function cleanTranscriptForBook(input: string): string {
	let text = input;
	text = stripTranscriptArtifacts(text);
	text = stripASRNoise(text);
	text = exciseMidSermonAltarCalls(text);
	text = stripNonBookLanguage(text);
	text = collapseNearDuplicateSentences(text);
	text = tagNonTeachingSlots(text);
	text = pruneRedundantSeriesRecaps(text);
	return cleanBookText(text);
}

type HarmonizeManifestInput = {
	frontMatter: {
		preface: string;
		introduction: string;
		conclusion: string;
		aboutAuthor: string | null;
		resourcesList: string[];
	};
	chapters: Array<{
		number: number;
		title: string;
		intro: string;
		conclusion: string;
		keyTakeaways: string[];
		reflectionQuestions: string[];
		totalWordCount: number;
		sections: Array<{
			body: string;
			wordCount: number;
		}>;
	}>;
};

function countWords(text: string): number {
	return text.trim().split(/\s+/).filter(Boolean).length;
}

export function harmonizeBookManifest<T extends HarmonizeManifestInput>(manifest: T): T {
	const chapters = manifest.chapters.map((chapter) => {
		const sections = chapter.sections.map((section) => {
			const body = stripNonBookLanguage(section.body ?? "");
			return {
				...section,
				body,
				wordCount: countWords(body),
			};
		});

		const intro = stripNonBookLanguage(chapter.intro ?? "");
		const conclusion = stripNonBookLanguage(chapter.conclusion ?? "");
		const keyTakeaways = (chapter.keyTakeaways ?? [])
			.map((item) => stripNonBookLanguage(item))
			.filter(Boolean);
		const reflectionQuestions = (chapter.reflectionQuestions ?? [])
			.map((item) => stripNonBookLanguage(item))
			.filter(Boolean);

		const totalWordCount =
			sections.reduce((sum, section) => sum + section.wordCount, 0) +
			countWords([intro, conclusion, ...keyTakeaways, ...reflectionQuestions].join(" "));

		return {
			...chapter,
			intro,
			conclusion,
			sections,
			keyTakeaways,
			reflectionQuestions,
			totalWordCount,
		};
	});

	const frontMatter = {
		...manifest.frontMatter,
		preface: stripNonBookLanguage(manifest.frontMatter.preface ?? ""),
		introduction: stripNonBookLanguage(manifest.frontMatter.introduction ?? ""),
		conclusion: stripNonBookLanguage(manifest.frontMatter.conclusion ?? ""),
		aboutAuthor: manifest.frontMatter.aboutAuthor ? stripNonBookLanguage(manifest.frontMatter.aboutAuthor) : null,
		resourcesList: (manifest.frontMatter.resourcesList ?? []).map((item) => stripNonBookLanguage(item)).filter(Boolean),
	};

	return {
		...manifest,
		frontMatter,
		chapters,
	};
}

/**
 * extractChapterOpeningQuote — Extracts a significant short quote from chapter body text
 * to use as the chapter intro instead of AI-generating one.
 *
 * Strategy:
 * 1. Split section bodies into sentences
 * 2. Filter out filler, single-word sentences, and weak openers
 * 3. Score sentences by:
 *    - Length (2-25 words for optimal impact)
 *    - Strength (active verbs, key concepts, direct statements)
 *    - Position (first section weighted higher)
 * 4. Return the highest-scoring sentence as a single powerful opening line
 *
 * @param sections Array of {body: string, sectionNumber: number}
 * @returns Single powerful opening sentence, or empty string if no suitable quote found
 */
export function extractChapterOpeningQuote(sections: Array<{body?: string; sectionNumber?: number}>): string {
	const allSentences: Array<{text: string; section: number; index: number}> = [];

	// Extract sentences from all sections, weighted by position
	for (const section of sections) {
		if (!section.body?.trim()) continue;
		const sectionNum = section.sectionNumber ?? 0;
		// Split on sentence boundaries, preserve the sentence
		const sentences = (section.body ?? "")
			.split(/(?<=[.!?])\s+/)
			.map((s) => s.trim())
			.filter(Boolean);

		sentences.forEach((sent, idx) => {
			// Skip headings, markdown artifacts, filler
			if (/^#{1,6}\s/.test(sent) || sent.length < 8 || sent.length > 150) return;
			if (/^(the |a |an |to |so |but |and |or |this |that |what |which |when |where |why |how )/i.test(sent)) {
				// Allow some common openers, but deprioritize
				allSentences.push({text: sent, section: sectionNum, index: idx});
				return;
			}
			allSentences.push({text: sent, section: sectionNum, index: idx});
		});
	}

	if (allSentences.length === 0) return "";

	// Score each sentence
	const scored = allSentences.map(({text, section, index}) => {
		let score = 0;

		// Length scoring: reward 10-25 words (most impactful range)
		const wordCount = text.split(/\s+/).length;
		if (wordCount >= 10 && wordCount <= 25) score += 30;
		else if (wordCount >= 8 && wordCount <= 35) score += 15;

		// Strong opening verbs (avoid weak "is/are/be")
		if (/\b(reveals|shows|teaches|demands|requires|transforms|breaks|shatters|builds|ignites|awakens|compels|declares|proclaims)\b/i.test(text)) {
			score += 20;
		} else if (/\b(is|are|was|were|be|being|become)\b/.test(text)) {
			score -= 10; // Deprioritize weak verbs
		}

		// Presence of key theological/teaching words (without being too obvious)
		if (/\b(faith|love|truth|power|freedom|grace|hope|justice|mercy|kingdom|covenant|believe|trust|surrender|obey|serve)\b/i.test(text)) {
			score += 15;
		}

		// Rhetorical questions (high impact)
		if (text.endsWith("?")) score += 20;

		// Position bonus: first section weighted higher, earlier sentences weighted higher
		if (section === 1) score += 25;
		else if (section <= 3) score += 10;

		// Deprioritize sentences starting with weak connectors
		if (/^(however|therefore|thus|consequently|meanwhile|furthermore|moreover|additionally|also|too)/i.test(text)) {
			score -= 15;
		}

		// Deprioritize sentences with too many commas (complex/secondary ideas)
		const commaCount = (text.match(/,/g) ?? []).length;
		if (commaCount > 2) score -= 5 * commaCount;

		return { text, score, section, index };
	});

	// Sort by score, then by position
	scored.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		if (a.section !== b.section) return a.section - b.section;
		return a.index - b.index;
	});

	// Return top candidate, ensure no markdown, no em dashes
	const topCandidate = scored[0]?.text ?? "";
	if (!topCandidate) return "";

	return topCandidate
		.replace(/\*\*/g, "")       // strip bold markers
		.replace(/\*/g, "")          // strip italic markers
		.replace(/__/g, "")          // strip alt bold
		.replace(/_/g, "")           // strip alt italic
		.replace(/\u2014/g, " ")     // replace em dash with space
		.trim();
}
