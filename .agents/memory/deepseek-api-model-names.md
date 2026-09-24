---
name: DeepSeek API model names
description: Valid model name strings for the DeepSeek API and tool_choice constraint
---

## Valid model names (as of July 2026)

| Intent | Model string | Notes |
|---|---|---|
| Standard chat/generation | `deepseek-chat` | Used for all non-reasoning DeepSeek operations |
| R1 (reasoner) | `deepseek-reasoner` | Still valid — DO NOT change this |

**`deepseek-chat` and `deepseek-reasoner` are the only permitted DeepSeek model names.**

**`deepseek-reasoner` is valid and must stay as R1.** User confirmed it must not be changed.
The production backmatter error ("passed deepseek-reasoner") is a production deployment/API-key access issue — not a code issue.

## tool_choice constraint

Always use `mode: "json"` for any `generateObject` call targeting `deepSeekModel`.

**Why:** The API returns "Thinking mode does not support this tool_choice" when `mode: "tool"` is passed to structured output.

**How to apply:** Before any `generateObject` call using `deepSeekModel`, ensure `mode: "json"` not `mode: "tool"`.

## Route model assignments

| Route | Model | Reason |
|---|---|---|
| All non-reasoning DeepSeek routes | `deepSeekModel` (deepseek-chat) | Standard generation and extraction |
| architect (both passes), chapter-plan, audit, backmatter, frontmatter, ingest | `deepSeekReasonerModel` (deepseek-reasoner) | Deep reasoning |
