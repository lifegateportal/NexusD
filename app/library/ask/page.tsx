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
        <header className="shrink-0 border-b border-slate-800/70 py-2 lg:py-5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="hidden text-[10px] font-bold uppercase tracking-[0.25em] text-amber-400 lg:block">Nexus Library</p>
              <h1 className="text-lg font-bold tracking-tight text-white lg:mt-1 lg:text-2xl">Ask the library</h1>
            </div>
            <p className="hidden text-right text-xs text-slate-400 sm:block lg:text-sm">
              Published books + video transcripts
            </p>
          </div>
          <p className="mt-1 hidden text-sm text-slate-400 lg:block">Answers come only from the published books and indexed video transcripts.</p>
        </header>
        <LibraryAssistant />
      </main>
    </div>
  );
}
