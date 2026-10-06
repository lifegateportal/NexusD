import { createHash } from "crypto";
import type { EbookManifest } from "@/lib/schemas/ebook";

export function computeEbookManifestVersion(manifest: EbookManifest): string {
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
