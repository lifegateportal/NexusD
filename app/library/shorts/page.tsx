import LibraryNav from "../LibraryNav";
import ShortsList from "./ShortsList";

export const metadata = {
  title: "Shorts | Nexus Library",
  description: "Watch published transcript-based video shorts.",
};

export default function LibraryShortsPage() {
  return (
    <div className="min-h-dvh bg-slate-950 text-slate-100 lg:pl-64">
      <LibraryNav />
      <main className="mx-auto min-h-dvh max-w-5xl px-4 pb-24 pt-6 sm:px-6 lg:px-10 lg:pb-10">
        <ShortsList />
      </main>
    </div>
  );
}
