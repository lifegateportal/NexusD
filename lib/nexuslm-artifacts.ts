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

export function nexusLMContentToHtml(content: string, title: string, format: NexusLMArtifactFormat): string {
  const safeTitle = escapeNexusLMHtml(title);
  const normalized = content.replace(/^\uFEFF/, "").trim();
  const lines = normalized.split(/\r?\n/);
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
      body.push(`<blockquote><p>${quoteLines.map(renderNexusLMInlineHtml).join("<br>")}</p></blockquote>`);
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

  return `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title><style>
    @page { size: A4; margin: 0.75in; }
    body { color: #1f2937; font-family: Arial, sans-serif; font-size: 11pt; line-height: 1.55; }
    h1 { font-size: 22pt; margin: 0 0 18pt; } h2 { font-size: 18pt; margin-top: 18pt; } h3 { font-size: 15pt; margin-top: 14pt; }
    p { margin: 0 0 10pt; } strong { font-weight: 700; } em { font-style: italic; } del { text-decoration: line-through; }
    ul, ol { margin: 0 0 12pt; padding-left: 24pt; } li { margin: 0 0 5pt; }
    blockquote { margin: 12pt 0; padding: 4pt 12pt; border-left: 3pt solid #0891b2; color: #475569; }
    code { font-family: "Courier New", monospace; } pre { white-space: pre-wrap; background: #f3f4f6; padding: 10pt; border: 1px solid #d1d5db; }
    .nexus-horizontal-rule { height: 0; margin: 18pt 0; border-top: 1px solid #cbd5e1; }
    table { width: 100%; border-collapse: collapse; margin: 12pt 0 16pt; } th, td { border: 1px solid #cbd5e1; padding: 6pt 8pt; text-align: left; vertical-align: top; } th { background: #e2e8f0; font-weight: 700; }
  </style></head><body><h1>${safeTitle}</h1>${body.join("")}</body></html>`;
}
