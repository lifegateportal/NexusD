"use client";

import { useState } from "react";

type DownloadButtonProps = {
  slug: string;
  bookTitle: string;
  accentBg: string;
};

export function DownloadButton({ slug, bookTitle, accentBg }: DownloadButtonProps) {
  const [loading, setLoading] = useState(false);

  async function handleDownload() {
    setLoading(true);
    
    try {
      // Fetch the library book manifest with its exact configuration
      const res = await fetch(`/api/ebook/manifest/${slug}`);
      if (!res.ok) throw new Error("Could not fetch book from library");
      const manifest = await res.json();

      // Export using the library book's exact settings (template, printSpec, etc.)
      const exportRes = await fetch("/api/ebook/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          manifest,
          formats: {
            pdf: false,
            epub: true,
            docx: false,
          },
          template: manifest.selectedTemplate || "devotional",
          printSpec: manifest.printSpec,
        }),
      });

      if (!exportRes.ok) {
        const error = await exportRes.json();
        throw new Error(error.error || "Export failed");
      }

      const result = await exportRes.json();
      const url = result.epubUrl;
      
      if (!url) throw new Error("No download URL returned");

      // Download the file
      const a = document.createElement("a");
      a.href = url;
      const safeName = bookTitle.replace(/[^a-z0-9]/gi, "_").toLowerCase();
      a.download = `${safeName}.epub`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err) {
      console.error("Download failed:", err);
      alert(err instanceof Error ? err.message : "Failed to download book");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative">
      <button
        onClick={handleDownload}
        disabled={loading}
        className={`inline-flex min-h-14 items-center gap-2 rounded-2xl border-2 ${accentBg.replace("bg-", "border-").replace("hover:bg-", "hover:border-")} bg-transparent px-8 text-base font-bold transition active:scale-[0.97] disabled:opacity-50`}
        title="Download EPUB"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-5 w-5">
          <path d="M12 3v12" strokeLinecap="round" />
          <polyline points="17 12 12 17 7 12" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M3 17v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2" strokeLinecap="round" />
        </svg>
        {loading ? "Preparing..." : "Download EPUB"}
      </button>

    </div>
  );
}
