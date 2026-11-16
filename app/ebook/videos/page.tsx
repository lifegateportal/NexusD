import Link from "next/link";
import DirectorVideos from "./DirectorVideos";

export const metadata = {
  title: "Video Publishing | Nexus Director",
  description: "Import, transcribe, review, and approve videos for the Nexus Library.",
};

export default function DirectorVideosPage() {
  return (
    <main className="min-h-dvh bg-slate-950 px-4 py-6 text-slate-100 sm:px-6 lg:px-10 lg:py-10">
      <div className="mx-auto max-w-5xl">
        <Link href="/ebook" className="inline-flex min-h-12 items-center text-sm font-semibold text-cyan-300">
          ← Nexus Director
        </Link>
        <header className="mb-8 mt-4 border-b border-slate-800 pb-6">
          <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-cyan-300">Director · Video publishing</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-white sm:text-4xl">Review videos before they go public</h1>
          <p className="mt-3 max-w-3xl text-sm leading-relaxed text-slate-400 sm:text-base">
            Discover videos from Lifegate Broadcast, transcribe and retain their timed transcripts privately, then approve only selected videos for the searchable Library.
          </p>
        </header>
        <DirectorVideos />
      </div>
    </main>
  );
}
