import LibraryNav from "../LibraryNav";
import LibraryFaqs from "./LibraryFaqs";

export const metadata = {
  title: "FAQs | Pastor Josh Digital Library",
  description: "Browse published answers grounded in Pastor Josh Digital Library books and video transcripts.",
};

export default function LibraryFaqsPage() {
  return (
    <div className="min-h-dvh bg-slate-950 text-slate-100 lg:pl-64">
      <LibraryNav />
      <main className="mx-auto min-h-dvh max-w-5xl px-4 pb-24 pt-6 sm:px-6 lg:px-10 lg:pb-10">
        <LibraryFaqs />
      </main>
    </div>
  );
}
