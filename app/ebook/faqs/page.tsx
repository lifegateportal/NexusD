import Link from "next/link";
import DirectorFaqs from "./DirectorFaqs";

export const metadata = {
  title: "Library FAQs | Nexus Director",
  description: "Edit, generate, and publish answers grounded in Nexus Library books and video transcripts.",
};

export default function DirectorFaqsPage() {
  return (
    <main className="min-h-dvh bg-slate-950 px-4 py-6 text-slate-100 sm:px-6 lg:px-10 lg:py-10">
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Link href="/ebook" className="inline-flex min-h-12 items-center text-sm font-semibold text-cyan-300">
            ← Nexus Director
          </Link>
          <Link href="/ebook/videos" className="inline-flex min-h-12 items-center text-sm font-semibold text-cyan-300">
            Video publishing
          </Link>
        </div>
        <header className="mb-6 mt-4 border-b border-slate-800 pb-5 sm:mb-8 sm:pb-6">
          <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-cyan-300">Director · FAQ publishing</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-white sm:text-4xl">Library frequently asked questions</h1>
          <p className="mt-3 max-w-3xl text-sm leading-relaxed text-slate-400 sm:text-base">
            Starter questions cover 15 common faith topics. Generate each answer from published books and videos, review its citations, then publish it for readers.
          </p>
        </header>
        <DirectorFaqs />
      </div>
    </main>
  );
}
