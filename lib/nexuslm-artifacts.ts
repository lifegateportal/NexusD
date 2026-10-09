export type NexusLMArtifactFormat = "html" | "pdf" | "docx" | "txt" | "md" | "json" | "csv" | "xlsx";

export type NexusLMTable = string[][];

export function safeNexusLMFilename(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "nexuslm-artifact";
}

function decodeHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    "&nbsp;": " ",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": "\"",
    "&#39;": "'",
    "&apos;": "'",
  };
  const decodeCodePoint = (raw: string, radix: number, entity: string): string => {
    const codePoint = Number.parseInt(raw, radix);
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF
      ? String.fromCodePoint(codePoint)
      : entity;
  };
  return value
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39|apos);/gi, (entity) => namedEntities[entity.toLowerCase()] ?? entity)
    .replace(/&#x([0-9a-f]+);/gi, (entity, hex: string) => decodeCodePoint(hex, 16, entity))
    .replace(/&#(\d+);/g, (entity, decimal: string) => decodeCodePoint(decimal, 10, entity));
}

export function htmlToNexusLMDocumentText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level: string) => `\n${"#".repeat(Number(level))} `)
    .replace(/<blockquote\b[^>]*>/gi, "\n> ")
    .replace(/<\/blockquote>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|section|article|header|footer|main|aside|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/td>\s*<td\b[^>]*>/gi, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/\r\n?/g, "\n");

  return decodeHtmlEntities(text)
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function escapeNexusLMHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderNexusLMInlineHtml(value: string): string {
  const codeSpans: string[] = [];
  let rendered = escapeNexusLMHtml(value).replace(/`([^`\n]+)`/g, (_, code: string) => {
    const index = codeSpans.push(`<code>${code}</code>`) - 1;
    return `\u0000${index}\u0000`;
  });

  rendered = rendered
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?;:])/g, "$1<em>$2</em>");

  return rendered.replace(/\u0000(\d+)\u0000/g, (_, index: string) => codeSpans[Number(index)] ?? "");
}

function markdownTableCells(line: string): string[] | null {
  if (!line.includes("|")) return null;
  const cells = line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
  return cells.length > 1 ? cells : null;
}

function isMarkdownTableSeparator(line: string): boolean {
  return /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(line);
}

export function parseNexusLMTable(content: string): NexusLMTable {
  const lines = content
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const markdownLines = lines.filter((line) => line.includes("|"));
  if (markdownLines.length >= 2) {
    const rows = markdownLines
      .filter((line) => !/^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(line))
      .map((line) => line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
    if (rows.some((row) => row.length > 1)) return rows;
  }

  const delimitedLines = lines.filter((line) => /[,;\t]/.test(line));
  if (delimitedLines.length > 0) {
    const delimiter = delimitedLines.some((line) => line.includes("\t"))
      ? "\t"
      : delimitedLines.some((line) => line.includes(";")) ? ";" : ",";
    return delimitedLines.map((line) => parseDelimitedNexusLMRow(line, delimiter));
  }

  return lines.map((line) => [line]);
}

function parseDelimitedNexusLMRow(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\"") {
      if (quoted && line[index + 1] === "\"") {
        cell += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

const NEXUSLM_DOCUMENT_CSS = `
    @page { size: A4; margin: 0.75in; }
    :root { color-scheme: light; }
    body { color: #1f2937; font-family: Arial, sans-serif; font-size: 11pt; line-height: 1.55; margin: 0 auto; max-width: 52rem; padding: 2.5rem 1.5rem; }
    h1 { font-size: 22pt; margin: 0 0 18pt; } h2 { font-size: 18pt; margin-top: 18pt; } h3 { font-size: 15pt; margin-top: 14pt; }
    p { margin: 0 0 10pt; } strong { font-weight: 700; } em { font-style: italic; } del { text-decoration: line-through; }
    ul, ol { margin: 0 0 12pt; padding-left: 24pt; } li { margin: 0 0 5pt; }
    blockquote { margin: 12pt 0; padding: 4pt 12pt; border-left: 3pt solid #0891b2; color: #475569; }
    code { font-family: "Courier New", monospace; } pre { white-space: pre-wrap; background: #f3f4f6; padding: 10pt; border: 1px solid #d1d5db; overflow-x: auto; }
    hr, .nexus-horizontal-rule { margin: 18pt 0; border: 0; border-top: 1px solid #cbd5e1; }
    .nexus-horizontal-rule { height: 0; }
    table { width: 100%; border-collapse: collapse; margin: 12pt 0 16pt; } th, td { border: 1px solid #cbd5e1; padding: 6pt 8pt; text-align: left; vertical-align: top; } th { background: #e2e8f0; font-weight: 700; }
    .book-cover { border-bottom: 1px solid #cbd5e1; margin-bottom: 3rem; padding: 4rem 0 3rem; text-align: center; }
    .book-cover h1 { font-size: 32pt; margin: 0; } .book-subtitle { color: #475569; font-size: 14pt; margin: 1rem 0 0; } .book-author { color: #64748b; margin: 1.5rem 0 0; }
    .book-contents { border-bottom: 1px solid #e2e8f0; margin-bottom: 3rem; padding-bottom: 2rem; } .book-contents h2 { margin-top: 0; }
    .book-contents ol { list-style: none; padding-left: 0; } .book-contents li { margin-bottom: 0.65rem; }
    .book-contents a { color: #0e7490; text-decoration: none; } .chapter { break-before: page; } .chapter:first-of-type { break-before: auto; }
    .chapter-label { color: #0e7490; font-size: 10pt; font-weight: 700; letter-spacing: 0.16em; margin-bottom: 0.5rem; text-transform: uppercase; }
    .chapter-title { font-size: 26pt; margin: 0 0 1.5rem; }
    @media (max-width: 640px) { body { padding: 1.5rem 1rem; } .book-cover { padding: 2.5rem 0 2rem; } .book-cover h1 { font-size: 25pt; } .chapter-title { font-size: 22pt; } }
  `;

function renderNexusLMMarkdownBlocks(content: string, format: NexusLMArtifactFormat): string {
  const normalized = content.replace(/^\uFEFF/, "").trim();
  const lines = normalized ? normalized.split(/\r?\n/) : [];
  const body: string[] = [];
  let inCode = false;
  let codeLanguage = "";
  let codeLines: string[] = [];
  let listItems: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let paragraphLines: string[] = [];

  const flushList = () => {
    if (listItems.length === 0) return;
    const tag = listType ?? "ul";
    body.push(`<${tag}>${listItems.map((item) => `<li>${item}</li>`).join("")}</${tag}>`);
    listItems = [];
    listType = null;
  };
  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    body.push(`<p>${paragraphLines.map(renderNexusLMInlineHtml).join("<br>")}</p>`);
    paragraphLines = [];
  };
  const flushCode = () => {
    if (!inCode) return;
    const languageClass = codeLanguage.replace(/[^a-z0-9_-]/gi, "");
    body.push(`<pre><code${languageClass ? ` class="language-${languageClass}"` : ""}>${escapeNexusLMHtml(codeLines.join("\n"))}</code></pre>`);
    inCode = false;
    codeLanguage = "";
    codeLines = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^\s*```([\w-]*)\s*$/);
    if (fence) {
      if (inCode) {
        flushCode();
      }
      else {
        flushParagraph();
        flushList();
        inCode = true;
        codeLanguage = fence[1];
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const tableHeader = markdownTableCells(trimmed);
    if (tableHeader && index + 1 < lines.length && isMarkdownTableSeparator(lines[index + 1].trim())) {
      flushParagraph();
      flushList();
      const rows = [tableHeader];
      let rowIndex = index + 2;
      while (rowIndex < lines.length) {
        const row = markdownTableCells(lines[rowIndex].trim());
        if (!row) break;
        rows.push(row);
        rowIndex += 1;
      }
      index = rowIndex - 1;
      body.push(`<table><thead><tr>${rows[0].map((cell) => `<th>${renderNexusLMInlineHtml(cell)}</th>`).join("")}</tr></thead>${rows.length > 1
        ? `<tbody>${rows.slice(1).map((row) => `<tr>${row.map((cell) => `<td>${renderNexusLMInlineHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody>`
        : ""}</table>`);
      continue;
    }

    const heading = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = trimmed.match(/^#+/)?.[0].length ?? 1;
      body.push(`<h${level}>${renderNexusLMInlineHtml(heading[1])}</h${level}>`);
      continue;
    }
    if (/^[-*_]{3,}$/.test(trimmed)) {
      flushParagraph();
      flushList();
      body.push('<p class="nexus-horizontal-rule">&#8203;</p>');
      continue;
    }

    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      const quoteLines = [quote[1]];
      while (index + 1 < lines.length) {
        const nextQuote = lines[index + 1].trim().match(/^>\s?(.*)$/);
        if (!nextQuote) break;
        quoteLines.push(nextQuote[1]);
        index += 1;
      }
      body.push(`<blockquote><p>${quoteLines.map(renderNexusLMInlineHtml).join(" ")}</p></blockquote>`);
      continue;
    }

    const listItem = trimmed.match(/^([-*+]|\d+[.)])\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      const nextListType = /^\d/.test(listItem[1]) ? "ol" : "ul";
      if (listType && listType !== nextListType) flushList();
      listType = nextListType;
      listItems.push(renderNexusLMInlineHtml(listItem[2]));
      continue;
    }
    flushList();
    if (format === "json" || codeLanguage === "json") {
      flushParagraph();
      body.push(`<pre><code>${escapeNexusLMHtml(trimmed)}</code></pre>`);
    } else {
      paragraphLines.push(trimmed);
    }
  }
  flushParagraph();
  flushList();
  flushCode();

  return body.join("");
}

function nexusLMDocumentShell(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeNexusLMHtml(title)}</title><style>${NEXUSLM_DOCUMENT_CSS}</style></head><body>${body}</body></html>`;
}

export function nexusLMContentToHtml(content: string, title: string, format: NexusLMArtifactFormat): string {
  return nexusLMDocumentShell(title, `<h1>${escapeNexusLMHtml(title)}</h1>${renderNexusLMMarkdownBlocks(content, format)}`);
}

export type NexusLMBookHtmlChapter = {
  number: number;
  title: string;
  content: string;
};

export type NexusLMBookFrontMatter = {
  preface?: string;
  introduction?: string;
  conclusion?: string;
  aboutAuthor?: string | null;
  resourcesList?: string[];
};

export type NexusLMBookHtmlInput = {
  title: string;
  subtitle?: string;
  authorName?: string;
  templateHtml?: string;
  frontMatter?: NexusLMBookFrontMatter;
  chapters: NexusLMBookHtmlChapter[];
};

function removeDuplicateChapterHeading(chapter: NexusLMBookHtmlChapter): string {
  const lines = chapter.content.replace(/^\uFEFF/, "").split(/\r?\n/);
  const firstContentIndex = lines.findIndex((line) => line.trim());
  if (firstContentIndex < 0) return "";
  const firstHeading = lines[firstContentIndex].trim().match(/^#\s+(.+)$/);
  if (!firstHeading) return chapter.content;
  const headingText = firstHeading[1].replace(/[*_`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  const chapterTitle = chapter.title.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!/^chapter\b/i.test(headingText) && headingText !== chapterTitle) return chapter.content;
  lines.splice(firstContentIndex, 1);
  return lines.join("\n").trim();
}

function prepareNexusLMTemplate(template: string): {
  template: string;
  chapterMarker: RegExp;
  chapterClassName?: string;
} {
  const chapterMarker = /\{\{\s*(?:CHAPTERS|MANUSCRIPT|BOOK_CONTENT|CONTENT)\s*\}\}|<!--\s*NEXUSLM:(?:CHAPTERS|MANUSCRIPT|BOOK_CONTENT|CONTENT)\s*-->|<!--\s*(?:CHAPTERS|MANUSCRIPT|BOOK[\s-]*CONTENT)\s*(?:HERE)?\s*-->/i;
  const markerInPageShell = template.match(new RegExp(
    `<(article|section|div)\\b([^>]*\\b(?:class|id)\\s*=\\s*["'][^"']*(?:chapter|book-page|chapter-page|page)[^"']*["'][^>]*)>[\\s\\S]*?${chapterMarker.source}[\\s\\S]*?<\\/\\1>`,
    "i",
  ));
  if (markerInPageShell) {
    const chapterClassName = markerInPageShell[2].match(/\bclass\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();
    return {
      template: template.replace(markerInPageShell[0], "{{CHAPTERS}}"),
      chapterMarker,
      chapterClassName,
    };
  }
  if (chapterMarker.test(template)) return { template, chapterMarker };

  const namedContainer = /(<(?:main|section|article|div)\b[^>]*(?:id|class|data-[\w-]+)\s*=\s*["'][^"']*(?:chapters|manuscript|book[\s-]*content|content)[^"']*["'][^>]*>)(\s*)(<\/(?:main|section|article|div)>)/i;
  const withNamedContainer = template.replace(namedContainer, "$1{{CHAPTERS}}$3");
  if (withNamedContainer !== template) return { template: withNamedContainer, chapterMarker };

  const emptyMain = /(<main\b[^>]*>)(\s*)(<\/main>)/i;
  const withEmptyMain = template.replace(emptyMain, "$1{{CHAPTERS}}$3");
  if (withEmptyMain !== template) return { template: withEmptyMain, chapterMarker };

  const chapterBlocks = /<(article|section|div)\b([^>]*(?:id|class)\s*=\s*["'][^"']+["'][^>]*)>([\s\S]*?)<\/\1>/gi;
  let insertedChapterMarker = false;
  let chapterClassName: string | undefined;
  const withSampleChaptersRemoved = template.replace(chapterBlocks, (fullMatch: string, tag: string, attributes: string, body: string) => {
    const isChapterShell = /(?:chapter|chapters|chapter-page|book-page)/i.test(attributes)
      || /\b(?:chapter-label|chapter-title|chapter-content|chapter-body)\b/i.test(body);
    if (!isChapterShell) return fullMatch;
    if (insertedChapterMarker) return "";
    insertedChapterMarker = true;
    chapterClassName = attributes.match(/\bclass\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();
    return `{{CHAPTERS}}`;
  });
  if (insertedChapterMarker) return { template: withSampleChaptersRemoved, chapterMarker, chapterClassName };

  throw new Error("The HTML design needs a chapter insertion point: add {{CHAPTERS}} inside the book content area.");
}

function templatePageDimension(template: string, property: "width" | "height"): string | null {
  const pageSize = template.match(/@page[\s\S]{0,500}\bsize\s*:\s*[^;{}]*/i)?.[0] ?? "";
  const pageSizeMatch = pageSize.match(/\bsize\s*:\s*([\d.]+(?:in|cm|mm|px|pt))\s+([\d.]+(?:in|cm|mm|px|pt))/i);
  if (pageSizeMatch) return property === "width" ? pageSizeMatch[1] : pageSizeMatch[2];
  const declaration = template.match(new RegExp(`\\b(?:${property}|min-${property}|max-${property})\\s*:\\s*([\\d.]+(?:in|cm|mm|px|pt))`, "i"));
  return declaration?.[1] ?? null;
}

function compilationStyles(template: string): string {
  const width = templatePageDimension(template, "width") ?? "5.5in";
  const height = templatePageDimension(template, "height") ?? "8.5in";
  return `<style id="nexuslm-compiler-flow">
    html, body { overflow: visible !important; }
    .nexuslm-compiled-page { display: block !important; width: 100% !important; max-width: ${width}; min-height: ${height}; height: auto !important; max-height: none !important; margin-left: auto !important; margin-right: auto !important; box-sizing: border-box !important; overflow: visible !important; break-before: page; page-break-before: always; }
    .nexuslm-compiled-page:first-child { break-before: auto; page-break-before: auto; }
  </style>`;
}

export function nexusLMBookToHtml(input: NexusLMBookHtmlInput): string {
  const chapters = [...input.chapters].sort((a, b) => a.number - b.number);
  if (chapters.length === 0) throw new Error("At least one saved chapter is required to compile the book.");

  const title = escapeNexusLMHtml(input.title.trim() || "Untitled book");
  const subtitle = input.subtitle?.trim() ? `<p class="book-subtitle">${escapeNexusLMHtml(input.subtitle.trim())}</p>` : "";
  const author = input.authorName?.trim() ? `<p class="book-author">${escapeNexusLMHtml(input.authorName.trim())}</p>` : "";
  const frontMatter = input.frontMatter ?? {};
  const frontMatterSection = (heading: string, content: string | null | undefined): string => {
    const trimmed = content?.trim();
    return trimmed
      ? `<section class="book-front-matter"><h1>${escapeNexusLMHtml(heading)}</h1>${renderNexusLMMarkdownBlocks(trimmed, "html")}</section>`
      : "";
  };
  const frontMatterMarkup = [
    frontMatterSection("Preface", frontMatter.preface),
    frontMatterSection("Introduction", frontMatter.introduction),
  ].filter(Boolean).join("");
  const backMatterMarkup = [
    frontMatterSection("Conclusion", frontMatter.conclusion),
    frontMatterSection("About the Author", frontMatter.aboutAuthor),
    frontMatter.resourcesList?.length
      ? frontMatterSection("Resources", frontMatter.resourcesList.map((item) => `- ${item}`).join("\n"))
      : "",
  ].filter(Boolean).join("");
  const contents = chapters.map((chapter) => {
    const id = `chapter-${chapter.number}`;
    return `<li><a href="#${id}">Chapter ${chapter.number}: ${escapeNexusLMHtml(chapter.title)}</a></li>`;
  }).join("");
  const chapterMarkup = (chapterClassName = "") => chapters.map((chapter) => {
    const id = `chapter-${chapter.number}`;
    const content = renderNexusLMMarkdownBlocks(removeDuplicateChapterHeading(chapter), "html");
    const classes = ["chapter", "nexuslm-compiled-page", chapterClassName].filter(Boolean).join(" ");
    return `<article id="${id}" class="${classes}"><p class="chapter-label">Chapter ${chapter.number}</p><h1 class="chapter-title">${escapeNexusLMHtml(chapter.title)}</h1>${content}</article>`;
  }).join("");

  const customTemplate = input.templateHtml?.trim();
  if (customTemplate) {
    const preparedTemplate = prepareNexusLMTemplate(customTemplate);
    const chapterMarker = preparedTemplate.chapterMarker;
    const template = preparedTemplate.template;
    const renderedChapters = chapterMarkup(preparedTemplate.chapterClassName);
    const hasFrontMatterMarker = /\{\{\s*(?:FRONT_MATTER|PREFACE|INTRODUCTION)\s*\}\}/i.test(template);
    const hasBackMatterMarker = /\{\{\s*(?:BACK_MATTER|CONCLUSION|ABOUT_AUTHOR|RESOURCES)\s*\}\}/i.test(template);
    const chaptersWithFallbackMatter = `${hasFrontMatterMarker ? "" : frontMatterMarkup}${renderedChapters}${hasBackMatterMarker ? "" : backMatterMarkup}`;
    const compiledTemplate = template
      .replace(/\{\{\s*BOOK_TITLE\s*\}\}/gi, title)
      .replace(/\{\{\s*BOOK_SUBTITLE\s*\}\}/gi, subtitle.replace(/^<p class="book-subtitle">|<\/p>$/g, ""))
      .replace(/\{\{\s*AUTHOR_NAME\s*\}\}/gi, author.replace(/^<p class="book-author">|<\/p>$/g, ""))
      .replace(/\{\{\s*TOC\s*\}\}/gi, `<nav class="book-contents" aria-label="Table of contents"><h2>Contents</h2><ol>${contents}</ol></nav>`)
      .replace(/\{\{\s*FRONT_MATTER\s*\}\}/gi, frontMatterMarkup)
      .replace(/\{\{\s*PREFACE\s*\}\}/gi, frontMatterSection("Preface", frontMatter.preface))
      .replace(/\{\{\s*INTRODUCTION\s*\}\}/gi, frontMatterSection("Introduction", frontMatter.introduction))
      .replace(/\{\{\s*BACK_MATTER\s*\}\}/gi, backMatterMarkup)
      .replace(/\{\{\s*CONCLUSION\s*\}\}/gi, frontMatterSection("Conclusion", frontMatter.conclusion))
      .replace(/\{\{\s*ABOUT_AUTHOR\s*\}\}/gi, frontMatterSection("About the Author", frontMatter.aboutAuthor))
      .replace(/\{\{\s*RESOURCES\s*\}\}/gi, frontMatter.resourcesList?.length
        ? frontMatterSection("Resources", frontMatter.resourcesList.map((item) => `- ${item}`).join("\n"))
        : "")
      .replace(chapterMarker, chaptersWithFallbackMatter);
    const styles = compilationStyles(template);
    return /<\/head\s*>/i.test(compiledTemplate)
      ? compiledTemplate.replace(/<\/head\s*>/i, `${styles}</head>`)
      : /<body\b/i.test(compiledTemplate)
        ? compiledTemplate.replace(/<body\b/i, `${styles}<body`)
        : `${styles}${compiledTemplate}`;
  }

  const defaultChapterMarkup = chapterMarkup();
  return nexusLMDocumentShell(
    input.title.trim() || "Untitled book",
    `<header class="book-cover"><h1>${title}</h1>${subtitle}${author}</header><nav class="book-contents" aria-label="Table of contents"><h2>Contents</h2><ol>${contents}</ol></nav>${frontMatterMarkup}${defaultChapterMarkup}${backMatterMarkup}`,
  );
}
