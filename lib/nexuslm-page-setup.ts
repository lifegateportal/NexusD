export const NEXUSLM_CSS_PX_PER_INCH = 96;

export type NexusLMPageOrientation = "portrait" | "landscape";

export type NexusLMPageSize = {
  widthInches: number;
  heightInches: number;
  orientation: NexusLMPageOrientation;
};

export type NexusLMPageMargins = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

const DEFAULT_PAGE_SIZE = { widthInches: 8.27, heightInches: 11.69 };
const KNOWN_PAGE_SIZES: Record<string, { widthInches: number; heightInches: number }> = {
  a3: { widthInches: 11.69, heightInches: 16.54 },
  a4: { widthInches: 8.27, heightInches: 11.69 },
  a5: { widthInches: 5.83, heightInches: 8.27 },
  "jis-b5": { widthInches: 7.17, heightInches: 10.12 },
  ledger: { widthInches: 17, heightInches: 11 },
  legal: { widthInches: 8.5, heightInches: 14 },
  letter: { widthInches: 8.5, heightInches: 11 },
  tabloid: { widthInches: 11, heightInches: 17 },
};

function createPageSize(widthInches: number, heightInches: number): NexusLMPageSize {
  return {
    widthInches,
    heightInches,
    orientation: widthInches > heightInches ? "landscape" : "portrait",
  };
}

function parseLength(value: string): number | null {
  const match = value.trim().match(/^([\d.]+)\s*(in|cm|mm|px|pt)$/i);
  if (!match) return null;
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  switch (match[2].toLowerCase()) {
    case "in": return amount;
    case "cm": return amount / 2.54;
    case "mm": return amount / 25.4;
    case "pt": return amount / 72;
    case "px": return amount / NEXUSLM_CSS_PX_PER_INCH;
    default: return null;
  }
}

function pageDeclarationFromHtml(html: string): string {
  const withoutComments = html.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = Array.from(withoutComments.matchAll(/@page(?:\s+([^{]*?))?\s*\{([^{}]*)\}/gi));
  const defaultRules = rules.filter((match) => !(match[1] ?? "").trim());
  return (defaultRules.length > 0 ? defaultRules : rules).map((match) => match[2]).join(";");
}

function pagePropertyFromDeclaration(declaration: string, property: string): string | null {
  const matches = Array.from(declaration.matchAll(new RegExp(`\\b${property}\\s*:\\s*([^;]+)`, "gi")));
  return matches.at(-1)?.[1] ?? null;
}

function sizeFromDeclaration(value: string): NexusLMPageSize | null {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ").replace(/\s*!important$/, "");
  if (normalized === "portrait") return createPageSize(DEFAULT_PAGE_SIZE.widthInches, DEFAULT_PAGE_SIZE.heightInches);
  if (normalized === "landscape") return createPageSize(DEFAULT_PAGE_SIZE.heightInches, DEFAULT_PAGE_SIZE.widthInches);

  const namedWithOrientation = normalized.match(/^([a-z-]+)\s+(portrait|landscape)$/);
  if (namedWithOrientation) {
    const base = KNOWN_PAGE_SIZES[namedWithOrientation[1]];
    if (base) {
      return namedWithOrientation[2] === "landscape"
        ? createPageSize(base.heightInches, base.widthInches)
        : createPageSize(base.widthInches, base.heightInches);
    }
  }

  const named = KNOWN_PAGE_SIZES[normalized];
  if (named) return createPageSize(named.widthInches, named.heightInches);

  const lengths = normalized
    .split(" ")
    .map(parseLength)
    .filter((value): value is number => value !== null);
  return lengths.length >= 2 && lengths[0] > 0 && lengths[1] > 0
    ? createPageSize(lengths[0], lengths[1])
    : null;
}

export function pageSizeFromHtml(html: string): NexusLMPageSize {
  const fallback = createPageSize(DEFAULT_PAGE_SIZE.widthInches, DEFAULT_PAGE_SIZE.heightInches);
  const declaration = pagePropertyFromDeclaration(pageDeclarationFromHtml(html), "size");
  return declaration ? sizeFromDeclaration(declaration) ?? fallback : fallback;
}

export function pageMarginsFromHtml(html: string): NexusLMPageMargins {
  const declaration = pagePropertyFromDeclaration(pageDeclarationFromHtml(html), "margin")?.trim();
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
  return {
    top: toTwips(top),
    right: toTwips(right),
    bottom: toTwips(bottom),
    left: toTwips(left),
  };
}
