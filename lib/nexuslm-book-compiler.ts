import type { EbookManifest } from "@/lib/schemas/ebook";
import type {
  NexusLMBookHtmlChapter,
  NexusLMBookHtmlInput,
  NexusLMBookFrontMatter,
} from "@/lib/nexuslm-artifacts";

export type NexusLMCompileSource = "ebook-studio" | "chat";
export type NexusLMCompileMode = "local" | "ai-template" | "ai-reprint";

export type NexusLMCompileRequest = {
  source: NexusLMCompileSource | null;
  useLatestDesign: boolean;
  mode: NexusLMCompileMode;
};

export type NexusLMCompileMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

function cleanText(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function chapterTitleFromLine(line: string): { number: number | null; title: string } | null {
  const cleaned = line
    .trim()
    .replace(/^#{1,3}\s+/, "")
    .replace(/^\*\*(.+)\*\*$/, "$1")
    .replace(/^__(.+)__$/, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;

  const chapter = cleaned.match(/^chapter\s+(\d+|[ivxlcdm]+)(?:\s*[:.-]\s*|\s+)(.+)$/i);
  if (chapter) {
    const parsedNumber = Number.parseInt(chapter[1], 10);
    return {
      number: Number.isFinite(parsedNumber) ? parsedNumber : null,
      title: chapter[2].trim().slice(0, 300) || cleaned.slice(0, 300),
    };
  }
  if (/^chapter\s+(\d+|[ivxlcdm]+)$/i.test(cleaned)) {
    return { number: null, title: cleaned.slice(0, 300) };
  }
  return null;
}

function firstNonEmptyLines(content: string, limit = 8): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function chapterTitleFromContent(content: string): { number: number | null; title: string } | null {
  for (const line of firstNonEmptyLines(content)) {
    const heading = chapterTitleFromLine(line);
    if (heading) return heading;
    const markdownHeading = line.match(/^#{1,2}\s+(.+)$/);
    if (markdownHeading && !/^(?:preface|introduction|intro|conclusion|about the author|resources)$/i.test(markdownHeading[1].trim())) {
      return { number: null, title: markdownHeading[1].trim().slice(0, 300) };
    }
  }
  return null;
}

function frontMatterHeading(content: string): "preface" | "introduction" | null {
  const firstLine = firstNonEmptyLines(content, 3)[0] ?? "";
  const heading = firstLine
    .replace(/^#{1,3}\s+/, "")
    .replace(/^\*\*(.+)\*\*$/, "$1")
    .trim()
    .toLowerCase();
  if (heading === "preface") return "preface";
  if (heading === "introduction" || heading === "intro") return "introduction";
  return null;
}

function isGeneratedChapter(message: NexusLMCompileMessage, previousUserMessage: string): boolean {
  const content = cleanText(message.content);
  if (!content || /<!doctype\s+html|<html\b/i.test(content)) return false;
  if (chapterTitleFromContent(content)) return true;
  if (/^\s*#{1,2}\s+\S+/m.test(content) && content.length >= 600) return true;
  return /\b(?:write|draft|compose|create|generate|develop)\b[\s\S]{0,60}\bchapter\b/i.test(previousUserMessage)
    && content.length >= 300;
}

export function parseNexusLMCompileInstruction(instruction: string): NexusLMCompileRequest | null {
  const text = instruction.trim();
  if (!text) return null;
  const compileVerb = /\b(?:compile|assemble|reassemble|build|put\s+together|typeset|render|reprint)\b/i;
  const isNegated = /\b(?:don't|do\s+not|never|without|avoid|before|until)\b[\s\S]{0,50}\b(?:compile|assemble|reassemble|build|typeset|render|reprint)\b/i.test(text)
    || /\b(?:compile|assemble|reassemble|build|typeset|render|reprint)\b[\s\S]{0,24}\b(?:yet|now|for\s+now)\b/i.test(text);
  const isExplanatoryRequest = /\b(?:explain|describe|what\s+(?:is|does)|how\s+(?:does|do\s+i|can\s+i)|why\s+(?:does|should)|when\s+should)\b[\s\S]{0,80}\b(?:compile|assemble|reassemble|build|typeset|render|reprint)\b/i.test(text);
  const isExplicitCommand = /^(?:please\s+)?(?:use|compile|assemble|reassemble|build|put\s+together|typeset|render|reprint)\b/i.test(text)
    || /\b(?:please|can\s+you|could\s+you|would\s+you|have\s+NexusLM|i\s+(?:want|need)\s+you\s+to|help\s+me)\b[\s\S]{0,50}\b(?:compile|assemble|reassemble|build|typeset|render|reprint)\b/i.test(text)
    || /\b(?:ai|agent|nexuslm|deepseek)\b[\s\S]{0,30}\b(?:compile|typeset|render|reprint)\b/i.test(text)
    || /\b(?:use|from|using)\b[\s\S]{0,80}\b(?:compile|assemble|reassemble|build|typeset|render|reprint)\b/i.test(text);
  const isCompileRequest = !isNegated
    && !isExplanatoryRequest
    && isExplicitCommand
    && compileVerb.test(text)
    && (/\b(?:book|manuscript|chapters?|html|ebook|template|design|layout|font|typograph|print\s+spec)\b/i.test(text)
      || /<!doctype\s+html|<html\b/i.test(text));
  if (!isCompileRequest) return null;

  const fromChat = /\b(?:generated\s+chapters?|chapters?)\b[\s\S]{0,80}\b(?:chat|chatbox|conversation)\b|\b(?:chat|chatbox|conversation)\b[\s\S]{0,80}\b(?:generated\s+chapters?|chapters?)\b|\bfrom\s+(?:this|the)\s+(?:chat|chatbox|conversation)\b/i.test(text);
  const fromEbookStudio = /\bebook\s*studio\b|\bebook\s+manuscript\b|\b(?:saved|complete|full)\s+manuscript\b|\bmanuscript\s+(?:workspace|chapters?)\b|\b(?:compile|assemble|build)\s+(?:my\s+)?(?:full\s+)?book\b/i.test(text);
  const source = fromChat ? "chat" : fromEbookStudio ? "ebook-studio" : null;
  const requestsAi = /\b(?:ai|agent|nexuslm|deepseek|intelligent|smart|typeset|typograph|proof|reprint|regenerate|rewrite)\b/i.test(text)
    && !/\b(?:without|don't|do\s+not|never)\b[\s\S]{0,40}\b(?:ai|agent|typeset|reprint|rewrite|regenerate)\b/i.test(text);
  const requestsReprint = /\b(?:reprint|rewrite|regenerate|recreate|reproduce|full\s+html|complete\s+html)\b/i.test(text);

  return {
    source,
    useLatestDesign: /\b(?:generated|latest|current|new|this|custom|saved)\b[\s\S]{0,50}\b(?:design|layout|template|style|html)\b|\b(?:redesign|layout|template|style)\b|\btemplate\s+i\s+(?:generated|created|pasted)\b/i.test(text),
    mode: requestsAi ? (requestsReprint ? "ai-reprint" : "ai-template") : "local",
  };
}

function chapterDraftToContent(chapter: EbookManifest["chapters"][number]): string {
  const blocks: string[] = [];
  if (cleanText(chapter.intro)) blocks.push(chapter.intro.trim());
  if (cleanText(chapter.epigraph)) blocks.push(`> ${chapter.epigraph.trim().replace(/\r?\n/g, "\n> ")}`);
  for (const section of chapter.sections) {
    const heading = cleanText(section.heading);
    blocks.push(`${heading ? `## ${heading}\n\n` : ""}${section.body.trim()}`);
  }
  if (cleanText(chapter.forwardQuestion)) blocks.push(`## Looking Ahead\n\n${chapter.forwardQuestion.trim()}`);
  if (chapter.keyTakeaways.length > 0) {
    blocks.push(`## Key Takeaways\n\n${chapter.keyTakeaways.map((item) => `- ${item}`).join("\n")}`);
  }
  if (chapter.reflectionQuestions.length > 0) {
    blocks.push(`## Reflection Questions\n\n${chapter.reflectionQuestions.map((item) => `- ${item}`).join("\n")}`);
  }
  return blocks.filter(Boolean).join("\n\n").trim();
}

export function ebookStudioManifestToBookInput(manifest: EbookManifest): NexusLMBookHtmlInput {
  const chapters: NexusLMBookHtmlChapter[] = manifest.chapters
    .slice()
    .sort((left, right) => left.number - right.number)
    .map((chapter) => ({
      number: chapter.number,
      title: chapter.title.trim() || `Chapter ${chapter.number}`,
      content: chapterDraftToContent(chapter),
    }));

  const frontMatter: NexusLMBookFrontMatter = {
    preface: manifest.frontMatter.preface,
    introduction: manifest.frontMatter.introduction,
    conclusion: manifest.frontMatter.conclusion,
    aboutAuthor: manifest.frontMatter.aboutAuthor,
    resourcesList: manifest.frontMatter.resourcesList,
  };

  return {
    title: manifest.bookTitle,
    subtitle: manifest.subtitle,
    authorName: manifest.authorName,
    printSpec: manifest.printSpec,
    frontMatter,
    chapters,
  };
}

export function chatMessagesToBookInput(
  messages: NexusLMCompileMessage[],
  metadata: Pick<NexusLMBookHtmlInput, "title" | "subtitle" | "authorName" | "printSpec">,
): NexusLMBookHtmlInput {
  const chapters: Array<NexusLMBookHtmlChapter & { order: number; explicitNumber: boolean }> = [];
  const frontMatter: NexusLMBookFrontMatter = {};
  let generatedChapterNumber = 1;

  messages.forEach((message, index) => {
    if (message.role !== "assistant") return;
    const content = cleanText(message.content);
    const previousUserMessage = messages
      .slice(0, index)
      .reverse()
      .find((candidate) => candidate.role === "user")?.content ?? "";
    if (frontMatterHeading(content)) {
      const section = frontMatterHeading(content);
      if (section) frontMatter[section] = content;
      return;
    }
    if (!isGeneratedChapter(message, previousUserMessage)) return;

    const heading = chapterTitleFromContent(content);
    const explicitNumber = heading?.number !== null && heading?.number !== undefined;
    const number = explicitNumber ? heading?.number ?? generatedChapterNumber : generatedChapterNumber;
    chapters.push({
      number,
      title: heading?.title ?? `Chapter ${number}`,
      content,
      order: index,
      explicitNumber,
    });
    generatedChapterNumber = Math.max(generatedChapterNumber, number + 1);
  });

  const usedNumbers = new Set<number>();
  const normalizedChapters = chapters
    .sort((left, right) => left.order - right.order)
    .map((chapter) => {
      let number = chapter.number;
      if (usedNumbers.has(number)) {
        number = Math.max(...usedNumbers, 0) + 1;
      }
      usedNumbers.add(number);
      return { number, title: chapter.title, content: chapter.content };
    })
    .sort((left, right) => left.number - right.number);

  return {
    ...metadata,
    frontMatter,
    chapters: normalizedChapters,
  };
}
