import { createHash } from "crypto";
import type { EbookManifest } from "@/lib/schemas/ebook";

type ManifestVersionInput = Pick<EbookManifest, "chapters" | "frontMatter">
  & Partial<Pick<EbookManifest, "bookTitle" | "subtitle" | "authorName" | "backMatter">>;

export function computeEbookManifestVersion(manifest: ManifestVersionInput): string {
  return createHash("sha256")
    .update(JSON.stringify({
      bookTitle: manifest.bookTitle,
      subtitle: manifest.subtitle,
      authorName: manifest.authorName,
      chapters: manifest.chapters,
      frontMatter: manifest.frontMatter,
      backMatter: manifest.backMatter,
    }))
    .digest("hex")
    .slice(0, 12);
}
