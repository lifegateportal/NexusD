type CodingHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export type CodingContextFile = {
  name: string;
  content: string;
  language?: string;
};

export type CodingFocusedContextInput = {
  query: string;
  selectedFileName: string | null;
  attachedFileNames: string[];
  files: CodingContextFile[];
};

export type CodingFocusedContext = {
  files: CodingContextFile[];
  omittedFileNames: string[];
  totalFileCount: number;
  history: CodingHistoryMessage[];
};

const MAX_FOCUSED_FILES = 24;
const MAX_FOCUSED_CHARACTERS = 300_000;
const STOP_WORDS = new Set([
  "about", "after", "also", "and", "any", "are", "can", "code", "could", "does",
  "fix", "for", "from", "have", "help", "how", "into", "make", "please", "that",
  "the", "this", "with", "would",
]);
const BROAD_REQUEST_PATTERN = /\b(architecture|entire (?:app|application|codebase|project)|full codebase|overall|whole (?:app|application|codebase|project)|all files|(?:review|audit|summari[sz]e|analy[sz]e|map|explain) (?:the )?(?:(?:entire|whole) )?(?:app|application|codebase|project|repository|repo))\b/i;

function queryTerms(query: string): string[] {
  const terms = query
    .toLowerCase()
    .match(/[a-z0-9_$]+/g)
    ?.filter((term) => term.length >= 3 && !STOP_WORDS.has(term)) ?? [];
  return Array.from(new Set(terms)).slice(0, 24);
}

function normalizePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

function resolveRelativeImport(fileName: string, importPath: string, fileNames: Set<string>): string | null {
  const base = importPath.startsWith("@/")
    ? normalizePath(importPath.slice(2))
    : normalizePath(`${fileName.slice(0, fileName.lastIndexOf("/") + 1)}${importPath}`);
  const candidates = [
    base,
    ...["ts", "tsx", "js", "jsx", "mjs", "css", "json"].map((extension) => `${base}.${extension}`),
    ...["ts", "tsx", "js", "jsx", "mjs"].map((extension) => `${base}/index.${extension}`),
  ];
  return candidates.find((candidate) => fileNames.has(candidate)) ?? null;
}

function buildImportGraph(files: CodingContextFile[]): Map<string, Set<string>> {
  const fileNames = new Set(files.map((file) => normalizePath(file.name)));
  const graph = new Map<string, Set<string>>();
  const importPattern = /(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["']((?:\.{1,2}\/|@\/)[^"']+)["']/g;
  for (const file of files) {
    const name = normalizePath(file.name);
    const dependencies = new Set<string>();
    for (const match of file.content.matchAll(importPattern)) {
      const dependency = resolveRelativeImport(name, match[1], fileNames);
      if (dependency) dependencies.add(dependency);
    }
    graph.set(name, dependencies);
  }
  return graph;
}

function scoreFile(file: CodingContextFile, terms: string[]): number {
  const path = normalizePath(file.name).toLowerCase();
  const content = file.content.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (path.includes(term)) score += 12;
    const index = content.indexOf(term);
    if (index >= 0) {
      score += 2;
      if (content.indexOf(term, index + term.length) >= 0) score += 1;
    }
  }
  return score;
}

function compactFocusedHistory(
  history: CodingHistoryMessage[],
  includedFileNames: Set<string>,
): CodingHistoryMessage[] {
  return history.map((message) => {
    if (message.role !== "assistant" || /partial response/i.test(message.content)) return message;
    const content = message.content.replace(
      /```nexus-(?:file|patch)\s+path=(?:"([^"]+)"|'([^']+)'|([^\s]+))[^\n]*\n[\s\S]*?```/gi,
      (block, doubleQuotedPath: string | undefined, singleQuotedPath: string | undefined, barePath: string | undefined) => {
        const path = normalizePath(doubleQuotedPath ?? singleQuotedPath ?? barePath ?? "");
        return includedFileNames.has(path)
          ? `[Generated workspace file ${path} omitted; use the included workspace snapshot.]`
          : block;
      },
    );
    return { ...message, content };
  });
}

export function selectCodingFocusedContext(
  input: CodingFocusedContextInput & { history: CodingHistoryMessage[] },
): CodingFocusedContext {
  const { files } = input;
  if (BROAD_REQUEST_PATTERN.test(input.query)) {
    return {
      files,
      omittedFileNames: [],
      totalFileCount: files.length,
      history: input.history,
    };
  }

  const names = new Set(files.map((file) => normalizePath(file.name)));
  const pinnedNames = new Set(
    [input.selectedFileName, ...input.attachedFileNames]
      .filter((name): name is string => Boolean(name))
      .map(normalizePath)
      .filter((name) => names.has(name)),
  );
  const terms = queryTerms(input.query);
  const graph = buildImportGraph(files);
  const scores = new Map(files.map((file) => [
    normalizePath(file.name),
    scoreFile(file, terms),
  ]));
  const ranked = files
    .filter((file) => (scores.get(normalizePath(file.name)) ?? 0) > 0)
    .sort((left, right) =>
      (scores.get(normalizePath(right.name)) ?? 0) - (scores.get(normalizePath(left.name)) ?? 0),
    );
  if (terms.length === 0 || ranked.length === 0) {
    return {
      files,
      omittedFileNames: [],
      totalFileCount: files.length,
      history: input.history,
    };
  }

  const roots = ranked.slice(0, 14).map((file) => normalizePath(file.name));
  const candidateNames = new Set([...pinnedNames, ...roots]);
  for (const root of roots) {
    for (const dependency of graph.get(root) ?? []) candidateNames.add(dependency);
    for (const [dependent, dependencies] of graph) {
      if (dependencies.has(root)) candidateNames.add(dependent);
    }
  }

  if (candidateNames.size <= pinnedNames.size) {
    for (const file of files) {
      if (/^(?:package\.json|README(?:\.[^/]*)?|tsconfig(?:\.[^/]*)?\.json)$/i.test(file.name)) {
        candidateNames.add(normalizePath(file.name));
      }
    }
  }

  const candidates = files
    .filter((file) => candidateNames.has(normalizePath(file.name)))
    .sort((left, right) => {
      const leftName = normalizePath(left.name);
      const rightName = normalizePath(right.name);
      const leftPinned = pinnedNames.has(leftName);
      const rightPinned = pinnedNames.has(rightName);
      if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
      return (scores.get(rightName) ?? 0) - (scores.get(leftName) ?? 0);
    });

  const selected: CodingContextFile[] = [];
  let selectedCharacters = 0;
  for (const file of candidates) {
    const name = normalizePath(file.name);
    const pinned = pinnedNames.has(name);
    if (
      !pinned
      && (selected.length >= MAX_FOCUSED_FILES
        || selectedCharacters + file.content.length > MAX_FOCUSED_CHARACTERS)
    ) continue;
    selected.push(file);
    selectedCharacters += file.content.length;
  }

  const selectedNames = new Set(selected.map((file) => normalizePath(file.name)));
  return {
    files: selected,
    omittedFileNames: files
      .filter((file) => !selectedNames.has(normalizePath(file.name)))
      .map((file) => file.name),
    totalFileCount: files.length,
    history: compactFocusedHistory(
      input.history,
      new Set(selected.map((file) => normalizePath(file.name))),
    ),
  };
}
