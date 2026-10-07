export type NexusLMArtifactFormat = "html" | "pdf" | "docx";

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
