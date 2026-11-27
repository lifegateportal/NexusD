import { z } from "zod";
import {
  LibraryConfigSchema,
  PublishedCatalogSchema,
  ReaderManifestSchema,
  projectReaderManifest,
} from "./schemas";
import "./styles.css";

const SlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const root = document.querySelector<HTMLElement>("#app");
const config = LibraryConfigSchema.safeParse(window.PUBLIC_LIBRARY_CONFIG);
const r2BaseUrl = config.success ? config.data.r2PublicUrl.replace(/\/$/, "") : "";

if (!root) throw new Error("Library root element is missing.");

type Catalog = z.infer<typeof PublishedCatalogSchema>;
type Book = Catalog["books"][number];
type Manifest = z.infer<typeof ReaderManifestSchema>;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function formatWords(count: number): string {
  return `${count.toLocaleString()} words`;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`The library data could not be loaded (HTTP ${response.status}).`);
  return response.json() as Promise<unknown>;
}

async function fetchCatalog(): Promise<Catalog> {
  if (!r2BaseUrl) throw new Error("Set the public R2 URL in public/library-config.js before deploying the library.");
  return PublishedCatalogSchema.parse(await fetchJson(`${r2BaseUrl}/published/index.json`));
}

async function fetchManifest(slug: string): Promise<Manifest> {
  const safeSlug = SlugSchema.parse(slug);
  return projectReaderManifest(
    await fetchJson(`${r2BaseUrl}/published/${encodeURIComponent(safeSlug)}/manifest.json`),
  );
}

function currentRoute(): string[] {
  return window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
}

function mountPage(active: "books" | "reading"): HTMLElement {
  root.replaceChildren();
  const shell = element("div", "site-shell");
  const sidebar = element("aside", "desktop-rail");
  const brand = element("a", "brand-lockup");
  brand.href = "/#/";
  brand.setAttribute("aria-label", "Public Library home");
  brand.append(element("span", "brand-mark", "PL"), element("span", "brand-name", "Public Library"));
  const desktopNav = element("nav", "rail-nav");
  desktopNav.setAttribute("aria-label", "Main navigation");
  const browseLink = element("a", `nav-link${active === "books" ? " is-active" : ""}`, "Browse books");
  browseLink.href = "/#/";
  const websiteLink = element("a", "nav-link", "Visit epicglobal.app");
  websiteLink.href = "https://epicglobal.app";
  websiteLink.target = "_blank";
  websiteLink.rel = "noreferrer";
  desktopNav.append(browseLink, websiteLink);
  sidebar.append(brand, desktopNav, element("p", "rail-note", "A quiet place for good books."));

  const main = element("main", "site-main");
  const mobileNav = element("nav", "mobile-nav");
  mobileNav.setAttribute("aria-label", "Main navigation");
  const mobileBrowse = element("a", `mobile-nav-link${active === "books" ? " is-active" : ""}`, "Books");
  mobileBrowse.href = "/#/";
  const mobileWebsite = element("a", "mobile-nav-link", "Website");
  mobileWebsite.href = "https://epicglobal.app";
  mobileWebsite.target = "_blank";
  mobileWebsite.rel = "noreferrer";
  mobileNav.append(mobileBrowse, mobileWebsite);

  shell.append(sidebar, main, mobileNav);
  root.append(shell);
  return main;
}

function addCover(container: HTMLElement, book: Pick<Book, "title" | "authorName" | "coverImageUrl">): void {
  if (book.coverImageUrl) {
    const image = element("img", "book-cover-image");
    image.src = book.coverImageUrl;
    image.alt = `${book.title} cover`;
    image.loading = "lazy";
    container.append(image);
    return;
  }

  const fallback = element("div", "book-cover-fallback");
  fallback.append(
    element("span", "cover-author", book.authorName),
    element("span", "cover-title", book.title),
    element("span", "cover-rule"),
  );
  container.append(fallback);
}

function createBookCard(book: Book): HTMLAnchorElement {
  const card = element("a", "book-card");
  card.href = `/#/book/${encodeURIComponent(book.slug)}`;
  const cover = element("div", "book-cover");
  addCover(cover, book);
  const details = element("div", "book-card-details");
  details.append(
    element("p", "book-author", book.authorName),
    element("h2", "book-card-title", book.title),
    element("p", "book-card-subtitle", book.subtitle),
    element("p", "book-card-meta", `${book.chapterCount} chapters · ${formatWords(book.wordCount)}`),
  );
  card.append(cover, details);
  return card;
}

function renderCatalog(catalog: Catalog): void {
  const main = mountPage("books");
  const intro = element("header", "catalog-header");
  intro.append(
    element("p", "eyebrow", "EPICGLOBAL.APP · PUBLIC LIBRARY"),
    element("h1", "display-title", "Books for the long read."),
    element("p", "intro-copy", "Explore published books and read them at your own pace."),
  );

  const toolbar = element("div", "catalog-toolbar");
  const count = element("p", "result-count", `${catalog.books.length} books`);
  const searchLabel = element("label", "search-control");
  searchLabel.append(element("span", "sr-only", "Search books"));
  const search = element("input", "search-input") as HTMLInputElement;
  search.type = "search";
  search.placeholder = "Search titles or authors";
  search.autocomplete = "off";
  searchLabel.append(search);
  toolbar.append(count, searchLabel);

  const grid = element("section", "book-grid");
  grid.setAttribute("aria-label", "Published books");
  const empty = element("p", "empty-state");

  function updateBooks(): void {
    const query = search.value.trim().toLocaleLowerCase();
    const books = catalog.books.filter((book) =>
      `${book.title} ${book.subtitle} ${book.authorName}`.toLocaleLowerCase().includes(query),
    );
    count.textContent = `${books.length} ${books.length === 1 ? "book" : "books"}`;
    grid.replaceChildren(...books.map(createBookCard));
    empty.textContent = books.length ? "" : query ? "No books match that search." : "No books have been published yet.";
    empty.hidden = books.length > 0;
  }

  search.addEventListener("input", updateBooks);
  updateBooks();
  main.append(intro, toolbar, grid, empty);
}

function textBlock(text: string, className = "reading-paragraph"): HTMLElement | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const paragraph = element("p", className);
  appendInlineMarkup(paragraph, trimmed);
  return paragraph;
}

function appendInlineMarkup(container: HTMLElement, text: string): void {
  const pattern = /(\*\*\*([^*\n]+?)\*\*\*|\*\*([^*\n]+?)\*\*|\*([^*\n]+?)\*|~~([^~\n]+?)~~)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    container.append(document.createTextNode(text.slice(cursor, match.index)));
    let node: HTMLElement;
    if (match[2] !== undefined) {
      node = element("strong");
      const italic = element("em");
      italic.textContent = match[2];
      node.append(italic);
    } else if (match[3] !== undefined) {
      node = element("strong", "", match[3]);
    } else if (match[4] !== undefined) {
      node = element("em", "", match[4]);
    } else {
      node = element("s", "", match[5]);
    }
    container.append(node);
    cursor = match.index + match[0].length;
  }
  container.append(document.createTextNode(text.slice(cursor)));
}

function appendBodyMarkup(container: HTMLElement, text: string): void {
  const lines = text.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) {
      index += 1;
      continue;
    }
    if (/^-{3,}$/.test(line)) {
      container.append(element("hr", "reading-divider"));
      index += 1;
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const headingTag = heading[1].length === 1 ? "h2" : heading[1].length === 2 ? "h3" : "h4";
      const headingNode = element(headingTag, "section-heading");
      appendInlineMarkup(headingNode, heading[2]);
      container.append(headingNode);
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote = element("blockquote", "chapter-epigraph");
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        const paragraph = element("p");
        appendInlineMarkup(paragraph, lines[index].trim().replace(/^>\s?/, ""));
        quote.append(paragraph);
        index += 1;
      }
      container.append(quote);
      continue;
    }

    if (/^[*-]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      const ordered = /^\d+\.\s+/.test(line);
      const list = element(ordered ? "ol" : "ul", "reading-list");
      const itemPattern = ordered ? /^\d+\.\s+/ : /^[*-]\s+/;
      while (index < lines.length && itemPattern.test(lines[index].trim())) {
        const item = element("li");
        appendInlineMarkup(item, lines[index].trim().replace(itemPattern, ""));
        list.append(item);
        index += 1;
      }
      container.append(list);
      continue;
    }

    const paragraph = element("p", "reading-paragraph");
    appendInlineMarkup(paragraph, line);
    container.append(paragraph);
    index += 1;
  }
}

function renderBookDetails(book: Book, manifest: Manifest): void {
  const main = mountPage("books");
  const back = element("a", "back-link", "Back to books");
  back.href = "/#/";

  const detail = element("section", "book-detail");
  const cover = element("div", "detail-cover");
  addCover(cover, book);
  const copy = element("div", "detail-copy");
  copy.append(
    element("p", "eyebrow", book.authorName),
    element("h1", "detail-title", book.title),
  );
  if (book.subtitle) copy.append(element("p", "detail-subtitle", book.subtitle));
  copy.append(element("p", "detail-meta", `${book.chapterCount} chapters · ${formatWords(book.wordCount)}`));
  if (book.synopsis) copy.append(element("p", "detail-synopsis", book.synopsis));

  const start = element("a", "primary-button", "Read online");
  start.href = `/#/book/${encodeURIComponent(book.slug)}/read`;
  copy.append(start);
  detail.append(cover, copy);

  const contents = element("section", "contents-section");
  contents.append(element("h2", "section-title", "Inside the book"));
  const chapterList = element("ol", "chapter-list");
  manifest.chapters.forEach((chapter) => {
    const item = element("li", "chapter-list-item");
    const link = element("a", "chapter-list-link", chapter.title || `Chapter ${chapter.number}`);
    link.href = `/#/book/${encodeURIComponent(book.slug)}/read/chapter-${chapter.number}`;
    item.append(link);
    chapterList.append(item);
  });
  contents.append(chapterList);
  main.append(back, detail, contents);
}

function renderReader(book: Book, manifest: Manifest): void {
  const main = mountPage("reading");
  const top = element("header", "reader-header");
  const back = element("a", "back-link", "Book details");
  back.href = `/#/book/${encodeURIComponent(book.slug)}`;
  top.append(back, element("p", "eyebrow", book.authorName), element("h1", "reader-title", book.title));

  const controls = element("div", "reader-controls");
  const jumpLabel = element("label", "jump-control");
  jumpLabel.append(element("span", "jump-label", "Jump to chapter"));
  const jump = element("select", "jump-select") as HTMLSelectElement;
  manifest.chapters.forEach((chapter) => {
    const option = element("option", "", chapter.title || `Chapter ${chapter.number}`) as HTMLOptionElement;
    option.value = String(chapter.number);
    jump.append(option);
  });
  jump.addEventListener("change", () => {
    document.getElementById(`chapter-${jump.value}`)?.scrollIntoView({ behavior: "smooth" });
  });
  jumpLabel.append(jump);
  controls.append(jumpLabel);

  const article = element("article", "reader-content");
  const introduction = textBlock(manifest.frontMatter.introduction, "front-matter");
  if (introduction) article.append(introduction);
  manifest.chapters.forEach((chapter) => {
    const chapterElement = element("section", "reader-chapter");
    chapterElement.id = `chapter-${chapter.number}`;
    chapterElement.append(element("p", "chapter-number", `CHAPTER ${chapter.number}`));
    chapterElement.append(element("h2", "chapter-title", chapter.title || `Chapter ${chapter.number}`));
    const intro = textBlock(chapter.intro);
    const epigraph = textBlock(chapter.epigraph, "chapter-epigraph");
    if (intro) chapterElement.append(intro);
    if (epigraph) chapterElement.append(epigraph);
    chapter.sections.forEach((section) => {
      if (section.heading) chapterElement.append(element("h3", "section-heading", section.heading));
      appendBodyMarkup(chapterElement, section.body);
    });
    article.append(chapterElement);
  });
  const conclusion = textBlock(manifest.frontMatter.conclusion, "front-matter");
  if (conclusion) article.append(conclusion);
  main.append(top, controls, article);
}

function renderError(error: unknown): void {
  const main = mountPage("books");
  const panel = element("section", "error-state");
  panel.append(
    element("p", "eyebrow", "PUBLIC LIBRARY"),
    element("h1", "section-title", "This page is unavailable."),
    element("p", "error-copy", error instanceof Error ? error.message : "Could not load the library."),
  );
  const retry = element("button", "primary-button", "Try again") as HTMLButtonElement;
  retry.type = "button";
  retry.addEventListener("click", () => window.location.reload());
  panel.append(retry);
  main.append(panel);
}

async function start(): Promise<void> {
  try {
    const path = currentRoute();
    if (path[0] !== "book" || !path[1]) {
      renderCatalog(await fetchCatalog());
      return;
    }

    const slug = SlugSchema.parse(decodeURIComponent(path[1]));
    const [catalog, manifest] = await Promise.all([fetchCatalog(), fetchManifest(slug)]);
    const book = catalog.books.find((entry) => entry.slug === slug);
    if (!book) throw new Error("This book is not in the published library.");
    if (path[2] === "read") {
      renderReader(book, manifest);
      const chapterMatch = /^chapter-(\d+)$/.exec(path[3] ?? "");
      if (chapterMatch) {
        requestAnimationFrame(() => {
          document.getElementById(`chapter-${chapterMatch[1]}`)?.scrollIntoView();
        });
      }
    }
    else renderBookDetails(book, manifest);
  } catch (error) {
    renderError(error);
  }
}

void start();
window.addEventListener("hashchange", () => void start());