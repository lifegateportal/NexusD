import LibraryGrid from "../LibraryGrid";
import LibraryNav from "../LibraryNav";
import { readLibraryBranding } from "@/lib/library-branding-store";
import { readPublishedBooks } from "@/lib/library-welcome-content";

export const revalidate = 60;

export const metadata = {
  title: "Books | Pastor Josh Digital Library",
  description: "Browse and read published books from Pastor Josh Digital Library.",
};

export default async function LibraryBooksPage() {
  const [books, branding] = await Promise.all([
    readPublishedBooks(),
    readLibraryBranding(),
  ]);
  const light = branding.colorMode === "light";

  return (
    <div
      data-pjdl-mode={branding.colorMode}
      style={{ colorScheme: branding.colorMode }}
      className={`min-h-dvh lg:pl-64 ${light ? "bg-slate-50 text-slate-900" : "bg-slate-950 text-slate-100"}`}
    >
      <LibraryNav branding={branding} />
      <main className="mx-auto min-h-dvh max-w-5xl px-4 pb-24 pt-6 sm:px-6 lg:px-10 lg:pb-10">
        <header className="mb-8">
          <p className={`text-xs font-semibold uppercase tracking-[0.2em] ${light ? "text-slate-600" : "text-slate-400"}`}>
            {branding.shortName}
          </p>
          <h1 className={`mt-2 text-3xl font-bold tracking-tight ${light ? "text-slate-950" : "text-white"}`}>
            Books
          </h1>
          <p className={`mt-2 text-sm leading-relaxed ${light ? "text-slate-600" : "text-slate-400"}`}>
            Browse and search all published books in the library.
          </p>
        </header>

        {books.length ? (
          <LibraryGrid books={books} colorMode={branding.colorMode} accentColor={branding.accentColor} />
        ) : (
          <div className={`flex min-h-48 items-center justify-center rounded-2xl border px-5 text-center ${light ? "border-slate-200 bg-white text-slate-600" : "border-slate-800 bg-slate-900/50 text-slate-400"}`}>
            No books have been published yet.
          </div>
        )}
      </main>
    </div>
  );
}
