import LibraryNav from "../LibraryNav";
import LibraryVideoManager from "./LibraryVideoManager";

export const metadata = {
  title: "Video Library | Pastor Josh Digital Library",
  description: "Watch approved YouTube videos and find answers in their timestamped transcripts.",
};

export default function LibraryVideosPage() {
  return (
    <div className="min-h-dvh bg-slate-950 text-slate-100 lg:pl-64">
      <LibraryNav />
      <main className="mx-auto min-h-dvh max-w-5xl px-4 pb-24 pt-6 sm:px-6 lg:px-10 lg:pb-10">
        <LibraryVideoManager />
      </main>
    </div>
  );
}
