import chromium from "@sparticuz/chromium";
import { chromium as playwrightChromium, type Page } from "playwright-core";
import {
  AlignmentType,
  BorderStyle,
  Document as DocxDocument,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from "docx";

const CSS_PX_PER_INCH = 96;
const DEFAULT_PAGE_SIZE = { widthInches: 8.27, heightInches: 11.69 };
const DEFAULT_VIEWPORT = {
  width: Math.round(DEFAULT_PAGE_SIZE.widthInches * CSS_PX_PER_INCH),
  height: Math.round(DEFAULT_PAGE_SIZE.heightInches * CSS_PX_PER_INCH),
};
const RENDER_TIMEOUT_MS = 30_000;

type PageSize = {
  widthInches: number;
  heightInches: number;
};

type PageMargins = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

type InlineModel = {
  text: string;
  href: string | null;
  fontFamily: string;
  fontSizePt: number;
  color: string | null;
  backgroundColor: string | null;
  bold: boolean;
  italics: boolean;
  underline: boolean;
  strike: boolean;
};

type ParagraphModel = {
  kind: "paragraph";
  heading: number;
  runs: InlineModel[];
  alignment: "left" | "center" | "right" | "justify";
  beforeTwips: number;
  afterTwips: number;
  lineTwips: number | null;
  leftTwips: number;
  rightTwips: number;
  backgroundColor: string | null;
  borderColor: string | null;
  borderWidth: number;
  pageBreakBefore: boolean;
  list: "bullet" | "number" | null;
};

type TableCellModel = {
  runs: InlineModel[];
  backgroundColor: string | null;
  widthTwips: number | null;
};

type TableModel = {
  kind: "table";
  rows: TableCellModel[][];
  widthTwips: number | null;
};

type DocumentModel = {
  blocks: Array<ParagraphModel | TableModel>;
  pageSize: PageSize;
  margins: PageMargins;
};

const KNOWN_PAGE_SIZES: Record<string, PageSize> = {
  a4: { widthInches: 8.27, heightInches: 11.69 },
  letter: { widthInches: 8.5, heightInches: 11 },
  legal: { widthInches: 8.5, heightInches: 14 },
};

function parseLength(value: string): number | null {
  const match = value.trim().match(/^([\d.]+)\s*(in|cm|mm|px|pt)$/i);
  if (!match) return null;
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  switch (match[2].toLowerCase()) {
    case "in": return amount;
    case "cm": return amount / 2.54;
    case "mm": return amount / 25.4;
    case "pt": return amount / 72;
    case "px": return amount / CSS_PX_PER_INCH;
    default: return null;
  }
}

function pageRuleFromHtml(html: string): string {
  return html.match(/@page\b[^{}]*\{([\s\S]*?)\}/i)?.[1] ?? "";
}

function pageSizeFromHtml(html: string): PageSize {
  const sizeDeclaration = pageRuleFromHtml(html).match(/\bsize\s*:\s*([^;]+)/i)?.[1]?.trim();
  if (!sizeDeclaration) return DEFAULT_PAGE_SIZE;
  const normalized = sizeDeclaration.toLowerCase().replace(/\s+/g, " ");
  const named = KNOWN_PAGE_SIZES[normalized];
  if (named) return named;
  const oriented = normalized.match(/^(a4|letter|legal)\s+(portrait|landscape)$/);
  if (oriented) {
    const base = KNOWN_PAGE_SIZES[oriented[1]];
    return oriented[2] === "landscape"
      ? { widthInches: base.heightInches, heightInches: base.widthInches }
      : base;
  }
  const lengths = normalized.split(" ").map(parseLength).filter((value): value is number => value !== null);
  return lengths.length >= 2
    ? { widthInches: lengths[0], heightInches: lengths[1] }
    : DEFAULT_PAGE_SIZE;
}

function pageMarginsFromHtml(html: string): PageMargins {
  const declaration = pageRuleFromHtml(html).match(/\bmargin\s*:\s*([^;]+)/i)?.[1]?.trim();
  const values = declaration
    ? declaration.split(/\s+/).map(parseLength).filter((value): value is number => value !== null)
    : [];
  const [top, right = top, bottom = top, left = right] = values.length === 1
    ? [values[0], values[0], values[0], values[0]]
    : values.length === 2
      ? [values[0], values[1], values[0], values[1]]
      : values.length === 3
        ? [values[0], values[1], values[2], values[1]]
        : values.length >= 4
          ? values
          : [0, 0, 0, 0];
  const toTwips = (inches: number) => Math.round(inches * 1440);
  return { top: toTwips(top), right: toTwips(right), bottom: toTwips(bottom), left: toTwips(left) };
}

function setupHtml(html: string): string {
  const setup = `<style id="nexuslm-docx-renderer">*, *::before, *::after { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }</style>`;
  const withoutScripts = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  return /<\/head\s*>/i.test(withoutScripts)
    ? withoutScripts.replace(/<\/head\s*>/i, `${setup}</head>`)
    : `${setup}${withoutScripts}`;
}

async function waitForAssets(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts?.ready;
    await Promise.all(Array.from(document.images).map((image) => image.complete
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
        image.addEventListener("load", () => resolve(), { once: true });
        image.addEventListener("error", () => resolve(), { once: true });
      })));
  });
}

async function extractDocumentModel(html: string): Promise<DocumentModel> {
  const executablePath = await chromium.executablePath();
  const browser = await playwrightChromium.launch({
    args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
    executablePath,
    headless: true,
  });

  try {
    const context = await browser.newContext({
      viewport: DEFAULT_VIEWPORT,
      deviceScaleFactor: 1,
      javaScriptEnabled: false,
      colorScheme: "light",
    });
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:blank")) {
        await route.continue();
      } else {
        await route.abort();
      }
    });
    await page.setContent(setupHtml(html), { timeout: RENDER_TIMEOUT_MS, waitUntil: "load" });
    await waitForAssets(page);
    const model = await page.evaluate(function () {
      const blockTags = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "LI"]);
      const containerTags = new Set(["DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "ASIDE"]);
      function toHex(value: string): string | null {
        if (!value || value === "transparent" || /^rgba\([^)]*,\s*0\)$/i.test(value)) return null;
        const channels = value.match(/\d+(?:\.\d+)?/g);
        if (!channels || channels.length < 3) return null;
        return channels.slice(0, 3).map((channel) => Number(channel).toString(16).padStart(2, "0")).join("").toUpperCase();
      }
      function px(value: string): number {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : 0;
      }
      function twips(value: string): number { return Math.round(px(value) * 15); }
      function styleFor(element: Element) {
        const style = window.getComputedStyle(element);
        const fontSizePx = px(style.fontSize) || 16;
        const lineHeightPx = style.lineHeight === "normal" ? 0 : px(style.lineHeight);
        const fontFamily = style.fontFamily.split(",")[0].trim().replace(/^['"]|['"]$/g, "") || "Arial";
        return {
          fontFamily,
          fontSizePt: Math.max(1, Math.round(fontSizePx * 0.75 * 2) / 2),
          color: toHex(style.color),
          backgroundColor: toHex(style.backgroundColor),
          bold: style.fontWeight === "bold" || Number(style.fontWeight) >= 600,
          italics: style.fontStyle.includes("italic"),
          underline: style.textDecorationLine.includes("underline"),
          strike: style.textDecorationLine.includes("line-through"),
          alignment: ["left", "center", "right", "justify"].includes(style.textAlign)
            ? style.textAlign as "left" | "center" | "right" | "justify"
            : "left",
          beforeTwips: twips(style.marginTop),
          afterTwips: twips(style.marginBottom),
          lineTwips: lineHeightPx > 0 ? Math.round((lineHeightPx / fontSizePx) * 240) : null,
          leftTwips: twips(style.marginLeft),
          rightTwips: twips(style.marginRight),
          borderColor: toHex(style.borderBottomColor),
          borderWidth: Math.max(0, Math.round(px(style.borderBottomWidth) * 8)),
          pageBreakBefore: style.breakBefore === "page" || style.pageBreakBefore === "always",
        };
      }
      function isBlock(element: Element): boolean {
        return blockTags.has(element.tagName)
          || element.tagName === "TABLE"
          || containerTags.has(element.tagName)
          || element.tagName === "UL"
          || element.tagName === "OL";
      }
      function runsFor(root: Element, preserveWhitespace = false): InlineModel[] {
        const runs: InlineModel[] = [];
        function visit(node: Node, link: string | null): void {
          if (node.nodeType === Node.TEXT_NODE) {
            const raw = node.textContent ?? "";
            const text = preserveWhitespace ? raw : raw.replace(/\s+/g, " ");
            if (!text) return;
            const parent = node.parentElement ?? root;
            const style = styleFor(parent);
            runs.push({
              text,
              href: link,
              fontFamily: style.fontFamily,
              fontSizePt: style.fontSizePt,
              color: style.color,
              backgroundColor: style.backgroundColor,
              bold: style.bold,
              italics: style.italics,
              underline: style.underline,
              strike: style.strike,
            });
            return;
          }
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          const element = node as Element;
          if (["SCRIPT", "STYLE", "SVG", "IMG", "UL", "OL", "TABLE"].includes(element.tagName)) return;
          if (element.tagName === "BR") {
            const style = styleFor(element.parentElement ?? root);
            runs.push({ text: "\n", href: link, ...style });
            return;
          }
          const nextLink = element.tagName === "A" ? element.getAttribute("href") : link;
          for (const child of Array.from(element.childNodes)) visit(child, nextLink);
        }
        for (const child of Array.from(root.childNodes)) visit(child, root.closest("a")?.href ?? null);
        return runs;
      }
      function paragraphFor(element: Element, list: "bullet" | "number" | null = null): ParagraphModel {
        const style = styleFor(element);
        const heading = /^H([1-6])$/.test(element.tagName) ? Number(element.tagName.slice(1)) : 0;
        const parentList = element.closest("ol,ul");
        const listKind = list ?? (parentList?.tagName === "OL" ? "number" : parentList?.tagName === "UL" ? "bullet" : null);
        return {
          kind: "paragraph",
          heading,
          runs: runsFor(element, element.tagName === "PRE"),
          alignment: style.alignment,
          beforeTwips: style.beforeTwips,
          afterTwips: style.afterTwips,
          lineTwips: style.lineTwips,
          leftTwips: style.leftTwips,
          rightTwips: style.rightTwips,
          backgroundColor: style.backgroundColor,
          borderColor: style.borderColor,
          borderWidth: style.borderWidth,
          pageBreakBefore: style.pageBreakBefore,
          list: listKind,
        };
      }
      function tableFor(table: HTMLTableElement): TableModel {
        return {
          kind: "table",
          widthTwips: table.getBoundingClientRect().width > 0 ? Math.round(table.getBoundingClientRect().width * 15) : null,
          rows: Array.from(table.rows).map((row) => Array.from(row.cells).map((cell) => {
            const style = styleFor(cell);
            return {
              runs: runsFor(cell),
              backgroundColor: style.backgroundColor,
              widthTwips: cell.getBoundingClientRect().width > 0 ? Math.round(cell.getBoundingClientRect().width * 15) : null,
            };
          })),
        };
      }
      const blocks: Array<ParagraphModel | TableModel> = [];
      function collect(container: Element): void {
        for (const child of Array.from(container.children)) {
          if (child.tagName === "TABLE") {
            blocks.push(tableFor(child as HTMLTableElement));
          } else if (blockTags.has(child.tagName)) {
            blocks.push(paragraphFor(child));
          } else if (child.tagName === "UL" || child.tagName === "OL") {
            for (const item of Array.from(child.children).filter((element) => element.tagName === "LI")) {
              blocks.push(paragraphFor(item, child.tagName === "OL" ? "number" : "bullet"));
            }
          } else if (containerTags.has(child.tagName)) {
            const hasBlockChild = Array.from(child.children).some(isBlock);
            if (hasBlockChild) collect(child);
            else if (child.textContent?.trim()) blocks.push(paragraphFor(child));
          } else if (child.textContent?.trim()) {
            blocks.push(paragraphFor(child));
          }
        }
      }
      collect(document.body ?? document.documentElement);
      return { blocks };
    }) as { blocks: Array<ParagraphModel | TableModel> };
    await context.close();
    return { ...model, pageSize: pageSizeFromHtml(html), margins: pageMarginsFromHtml(html) };
  } finally {
    await browser.close();
  }
}

function alignment(value: ParagraphModel["alignment"]): (typeof AlignmentType)[keyof typeof AlignmentType] {
  return value === "center" ? AlignmentType.CENTER
    : value === "right" ? AlignmentType.RIGHT
      : value === "justify" ? AlignmentType.JUSTIFIED : AlignmentType.LEFT;
}

function runFor(model: InlineModel): TextRun | ExternalHyperlink {
  const text = new TextRun({
    text: model.text,
    bold: model.bold,
    italics: model.italics,
    strike: model.strike,
    underline: model.underline ? {} : undefined,
    color: model.color ?? undefined,
    font: model.fontFamily,
    size: Math.max(2, Math.round(model.fontSizePt * 2)),
    shading: model.backgroundColor ? { type: ShadingType.SOLID, fill: model.backgroundColor } : undefined,
  });
  return model.href && /^https?:\/\//i.test(model.href)
    ? new ExternalHyperlink({ link: model.href, children: [text] })
    : text;
}

function paragraphFor(model: ParagraphModel): Paragraph {
  const options = {
    children: model.runs.length > 0 ? model.runs.map(runFor) : [new TextRun({ text: "" })],
    alignment: alignment(model.alignment),
    spacing: {
      before: model.beforeTwips,
      after: model.afterTwips,
      ...(model.lineTwips ? { line: model.lineTwips } : {}),
    },
    indent: model.leftTwips || model.rightTwips
      ? { left: model.leftTwips || undefined, right: model.rightTwips || undefined }
      : undefined,
    shading: model.backgroundColor ? { type: ShadingType.SOLID, fill: model.backgroundColor } : undefined,
    border: model.borderColor && model.borderWidth > 0
      ? { bottom: { style: BorderStyle.SINGLE, size: model.borderWidth, color: model.borderColor, space: 1 } }
      : undefined,
    pageBreakBefore: model.pageBreakBefore,
    ...(model.heading > 0 ? { heading: [
      HeadingLevel.HEADING_1,
      HeadingLevel.HEADING_2,
      HeadingLevel.HEADING_3,
      HeadingLevel.HEADING_4,
      HeadingLevel.HEADING_5,
      HeadingLevel.HEADING_6,
    ][model.heading - 1] } : {}),
    ...(model.list === "bullet" ? { numbering: { reference: "nexus-html-bullets", level: 0 } } : {}),
    ...(model.list === "number" ? { numbering: { reference: "nexus-html-numbers", level: 0 } } : {}),
  };
  return new Paragraph(options);
}

function tableFor(model: TableModel): Table {
  const rows = model.rows.map((row) => new TableRow({
    children: row.map((cell) => new TableCell({
      children: [new Paragraph({
        children: cell.runs.length > 0 ? cell.runs.map(runFor) : [new TextRun({ text: "" })],
        spacing: { after: 0 },
      })],
      verticalAlign: VerticalAlign.CENTER,
      width: cell.widthTwips ? { size: cell.widthTwips, type: WidthType.DXA } : undefined,
      shading: cell.backgroundColor ? { type: ShadingType.SOLID, fill: cell.backgroundColor } : undefined,
    })),
  }));
  return new Table({
    rows,
    width: model.widthTwips ? { size: model.widthTwips, type: WidthType.DXA } : { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.AUTOFIT,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: "B7C3D0" },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: "B7C3D0" },
      left: { style: BorderStyle.SINGLE, size: 4, color: "B7C3D0" },
      right: { style: BorderStyle.SINGLE, size: 4, color: "B7C3D0" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: "D8E0E8" },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: "D8E0E8" },
    },
  });
}

export async function renderHtmlToEditableDocxBuffer(html: string): Promise<Buffer> {
  if (!html.trim()) throw new Error("The HTML design is empty.");
  if (!/<(?:body|main|article|section|p|h[1-6]|div)\b/i.test(html)) {
    throw new Error("The HTML design has no editable document content.");
  }
  const model = await extractDocumentModel(html);
  if (model.blocks.length === 0) throw new Error("The HTML design has no editable document content.");
  const children = model.blocks.map((block) => block.kind === "table" ? tableFor(block) : paragraphFor(block));
  const document = new DocxDocument({
    creator: "NexusLM",
    title: "NexusLM document",
    description: "Editable document exported from a NexusLM HTML design.",
    sections: [{
      properties: {
        page: {
          size: {
            width: Math.round(model.pageSize.widthInches * 1440),
            height: Math.round(model.pageSize.heightInches * 1440),
          },
          margin: model.margins,
        },
      },
      children,
    }],
    numbering: {
      config: [
        {
          reference: "nexus-html-bullets",
          levels: [{ level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT }],
        },
        {
          reference: "nexus-html-numbers",
          levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT }],
        },
      ],
    },
  });
  return Packer.toBuffer(document);
}
