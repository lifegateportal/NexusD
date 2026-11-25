import Link from "next/link";
import LibraryNav from "../LibraryNav";
import { listPublicTrailers } from "@/lib/trailer-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = {
  title: "Trailers | Pastor Josh Digital Library",
  description: "Watch published promotional trailers from Pastor Josh Digital Library.",
};

export default async function LibraryTrailersPage() {
  const catalog = await listPublicTrailers();
  return (
    <div className="min-h-dvh bg-slate-950 text-slate-100 lg:pl-64">
      <LibraryNav />
      <main className="mx-auto min-h-dvh max-w-5xl px-4 pb-24 pt-6 sm:px-6 lg:px-10 lg:pb-10">
        <header className="mb-6">
          <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-cyan-300">Watch · Share · Discover</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-white sm:text-4xl">Trailers</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">
            Watch published embedded YouTube sequences and rendered video trailers.
          </p>
        </header>
        {catalog.trailers.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-slate-700 p-10 text-center text-sm text-slate-400">
            No trailers have been published yet.
          </p>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {catalog.trailers.map((trailer) => (
              <li key={trailer.slug} className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/50">
                <Link
                  href={`/library/trailers/${encodeURIComponent(trailer.slug)}`}
                  className="block min-h-12 p-4"
                >
                  <p className="text-xs font-semibold uppercase tracking-wide text-cyan-300">
                    {trailer.aspectRatio.replace(":", " : ")}
                  </p>
                  <h2 className="mt-2 font-bold text-white">{trailer.title}</h2>
                  <p className="mt-2 text-xs text-slate-500">
                    Published {new Date(trailer.updatedAt).toLocaleDateString()}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
