"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { z } from "zod";
import { LibraryFaqCatalogSchema } from "@/lib/schemas/library-faq";

const ErrorSchema = z.object({ error: z.string() });
type Faq = z.infer<typeof LibraryFaqCatalogSchema>["faqs"][number];

function renderAnswerLine(line: string, faq: Faq, key: string): ReactNode[] {
  const pattern = /\*\*([^*]+)\*\*|\*([^*]+)\*|\[(S\d+)\]/g;
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(line)) !== null) {
    if (match.index > cursor) nodes.push(line.slice(cursor, match.index));
    const nodeKey = `${key}-${index++}`;
    if (match[1]) nodes.push(<strong key={nodeKey} className="font-semibold text-slate-100">{match[1]}</strong>);
    else if (match[2]) nodes.push(<em key={nodeKey}>{match[2]}</em>);
    else {
      const sourceRef = match[3];
      const source = faq.sources.find((item) => item.ref === sourceRef);
      nodes.push(source
        ? <a key={nodeKey} href={source.href} target={source.href.startsWith("https://") ? "_blank" : undefined} rel={source.href.startsWith("https://") ? "noreferrer" : undefined} className="font-semibold text-amber-300 underline underline-offset-2">{match[3]}</a>
        : <span key={nodeKey}>{match[0]}</span>);
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < line.length) nodes.push(line.slice(cursor));
  return nodes;
}

function FaqAnswer({ faq }: { faq: Faq }) {
  const blocks = faq.answer.replace(/\r\n?/g, "\n").split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  return (
    <div className="space-y-3 border-t border-slate-800 pt-4 text-sm leading-7 text-slate-300">
      {blocks.map((block, index) => {
        const lines = block.split("\n");
        const heading = lines[0].match(/^#{1,3}\s+(.+)$/);
        if (heading) {
          return (
            <div key={index} className="space-y-2">
              <h3 className="font-semibold text-white">{renderAnswerLine(heading[1], faq, `heading-${index}`)}</h3>
              {lines.slice(1).map((line, lineIndex) => (
                <p key={lineIndex} className="whitespace-pre-line">{renderAnswerLine(line.replace(/^[-*]\s+/, ""), faq, `${index}-${lineIndex}`)}</p>
              ))}
            </div>
          );
        }
        if (lines.every((line) => /^[-*]\s+/.test(line))) {
          return (
            <ul key={index} className="list-disc space-y-1 pl-5 marker:text-amber-400">
              {lines.map((line, lineIndex) => (
                <li key={lineIndex}>{renderAnswerLine(line.replace(/^[-*]\s+/, ""), faq, `${index}-${lineIndex}`)}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={index} className="whitespace-pre-line">
            {lines.map((line, lineIndex) => (
              <span key={lineIndex}>
                {lineIndex > 0 && <br />}
                {renderAnswerLine(line, faq, `${index}-${lineIndex}`)}
              </span>
            ))}
          </p>
        );
      })}
      <div className="border-t border-slate-800 pt-3">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">Sources</p>
        <ul className="space-y-2">
          {faq.sources.map((source) => (
            <li key={source.ref}>
              <a
                href={source.href}
                target={source.href.startsWith("https://") ? "_blank" : undefined}
                rel={source.href.startsWith("https://") ? "noreferrer" : undefined}
                className="block min-h-12 rounded-lg border border-slate-800 bg-slate-950/60 p-3"
              >
                <span className="block text-xs font-semibold text-cyan-200">[{source.ref}] {source.title}</span>
                <span className="mt-1 block text-xs leading-relaxed text-slate-400">{source.excerpt}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function LibraryFaqs() {
  const [faqs, setFaqs] = useState<Faq[]>([]);
  const [query, setQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/library/faqs", { cache: "no-store" })
      .then(async (response) => {
        const body: unknown = await response.json();
        if (!response.ok) {
          const parsed = ErrorSchema.safeParse(body);
          throw new Error(parsed.success ? parsed.data.error : `Could not load FAQs (HTTP ${response.status}).`);
        }
        const parsed = LibraryFaqCatalogSchema.safeParse(body);
        if (!parsed.success) throw new Error("The published FAQ catalog has an invalid format.");
        if (active) setFaqs(parsed.data.faqs);
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Could not load published FAQs.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const categories = useMemo(
    () => [...new Set(faqs.map((faq) => faq.category))].sort((a, b) => a.localeCompare(b)),
    [faqs],
  );
  const filteredFaqs = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return faqs.filter((faq) =>
      (!selectedCategory || faq.category === selectedCategory)
      && (!needle || `${faq.question} ${faq.answer} ${faq.category}`.toLocaleLowerCase().includes(needle)),
    );
  }, [faqs, query, selectedCategory]);

  return (
    <div className="space-y-6">
      <header className="border-b border-slate-800 pb-6">
        <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-amber-400">PJDL</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-white">Frequently asked questions</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">
          Browse published answers grounded in the Library’s books and video transcripts.
        </p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <label>
            <span className="sr-only">Search FAQs</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search questions and answers…"
              className="min-h-12 w-full rounded-xl border border-slate-700 bg-slate-900 px-4 text-base text-white placeholder:text-slate-500 focus:border-amber-400 focus:outline-none"
            />
          </label>
          <label>
            <span className="sr-only">Filter by FAQ category</span>
            <select
              value={selectedCategory}
              onChange={(event) => setSelectedCategory(event.target.value)}
              className="min-h-12 w-full rounded-xl border border-slate-700 bg-slate-900 px-4 text-base text-white focus:border-amber-400 focus:outline-none"
            >
              <option value="">All categories</option>
              {categories.map((category) => <option key={category} value={category}>{category}</option>)}
            </select>
          </label>
        </div>
      </header>
      {error && <p role="alert" className="rounded-xl border border-rose-900 bg-rose-950/40 p-4 text-sm text-rose-200">{error}</p>}
      {loading ? (
        <p className="py-12 text-center text-sm text-slate-400">Loading published FAQs…</p>
      ) : filteredFaqs.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-700 p-10 text-center text-sm text-slate-400">
          {faqs.length ? "No published FAQs match those filters." : "No FAQs have been published yet."}
        </p>
      ) : (
        <ul className="space-y-3">
          {filteredFaqs.map((faq) => (
            <li key={faq.id} className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4 sm:p-5">
              <p className="text-[10px] font-bold uppercase tracking-wider text-cyan-300">{faq.category}</p>
              <details className="mt-1">
                <summary className="flex min-h-12 cursor-pointer items-center text-base font-semibold leading-snug text-white">
                  {faq.question}
                </summary>
                <FaqAnswer faq={faq} />
              </details>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
