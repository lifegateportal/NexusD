import LibraryNav from "../LibraryNav";
import LibraryVideoManager from "./LibraryVideoManager";

export const metadata = {
  title: "Video Library | Nexus Library",
  description: "Browse the author's YouTube videos and ask questions with timestamped transcript sources.",
};

export default function LibraryVideosPage() {
  return (
    <div className="min-h-dvh bg-slate-950 text-slate-100 lg:pl-64">
      <LibraryNav />
      <main className="mx-auto min-h-dvh max-w-5xl px-4 pb-24 pt-6 sm:px-6 lg:px-10 lg:pb-10">
        <header className="mb-8 border-b border-slate-800/70 pb-6">
          <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-amber-400">Nexus Library</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-white">Video library</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">
            Add your YouTube videos to make their captions searchable. Answers in Ask the Library will link directly to the relevant moment.
          </p>
        </header>
        <LibraryVideoManager />
      </main>
    </div>
  );
}
