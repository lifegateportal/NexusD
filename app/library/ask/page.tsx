import LibraryNav from "../LibraryNav";
import LibraryAssistant from "./LibraryAssistant";

export const metadata = {
  title: "Ask the Library | Nexus Library",
  description: "Ask questions answered only from published books and video transcripts.",
};

export default function LibraryAskPage() {
  return (
    <div className="min-h-dvh bg-slate-950 text-slate-100 lg:pl-64">
      <LibraryNav />
      <main className="mx-auto flex h-dvh max-w-5xl flex-col px-4 pb-20 sm:px-6 lg:px-10 lg:pb-0">
        <header className="shrink-0 border-b border-slate-800/70 py-5">
          <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-amber-400">Nexus Library</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-white">Ask the library</h1>
          <p className="mt-1 text-sm text-slate-400">Answers come only from the published books and indexed video transcripts.</p>
        </header>
        <LibraryAssistant />
      </main>
    </div>
  );
}
