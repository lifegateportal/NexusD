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

  const flushList = () => {
    if (listItems.length === 0) return;
    body.push(`<ul>${listItems.map((item) => `<li>${item}</li>`).join("")}</ul>`);
    listItems = [];
  };
  const flushCode = () => {
    if (!inCode) return;
    body.push(`<pre><code>${escapeNexusLMHtml(codeLines.join("\n"))}</code></pre>`);
    inCode = false;
    codeLanguage = "";
    codeLines = [];
  };

  for (const line of lines) {
    const fence = line.match(/^```([\w-]*)\s*$/);
    if (fence) {
      if (inCode) flushCode();
      else {
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
      flushList();
      continue;
    }
    const heading = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      flushList();
      body.push(`<h${heading[0].indexOf(" ")}>${escapeNexusLMHtml(heading[1])}</h${heading[0].indexOf(" ")}>`);
      continue;
    }
    const listItem = trimmed.match(/^(?:[-*+]|\d+[.)])\s+(.+)$/);
    if (listItem) {
      listItems.push(escapeNexusLMHtml(listItem[1]));
      continue;
    }
    flushList();
    if (format === "json" || codeLanguage === "json") {
      body.push(`<pre><code>${escapeNexusLMHtml(trimmed)}</code></pre>`);
    } else {
      body.push(`<p>${escapeNexusLMHtml(trimmed)}</p>`);
    }
  }
  flushList();
  flushCode();

  return `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title><style>
    @page { size: A4; margin: 0.75in; }
    body { color: #1f2937; font-family: Arial, sans-serif; font-size: 11pt; line-height: 1.55; }
    h1 { font-size: 22pt; margin: 0 0 18pt; } h2 { font-size: 18pt; } h3 { font-size: 15pt; }
    p { margin: 0 0 10pt; } li { margin: 0 0 5pt; } pre { white-space: pre-wrap; background: #f3f4f6; padding: 10pt; border: 1px solid #d1d5db; }
  </style></head><body><h1>${safeTitle}</h1>${body.join("")}</body></html>`;
}
