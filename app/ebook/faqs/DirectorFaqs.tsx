"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import {
  DirectorFaqCatalogSchema,
  DirectorFaqSchema,
  LibraryFaqSourceSchema,
} from "@/lib/schemas/library-faq";

type Catalog = z.infer<typeof DirectorFaqCatalogSchema>;
type Faq = z.infer<typeof DirectorFaqSchema>;
type Action = "publish" | "unpublish" | "delete";

const ErrorSchema = z.object({ error: z.string() });
const GeneratedAnswerSchema = z.object({
  answer: z.string().min(1),
  sources: z.array(LibraryFaqSourceSchema).min(1).max(12),
}).strict();

async function responseError(response: Response, body: unknown): Promise<Error> {
  const parsed = ErrorSchema.safeParse(body);
  return new Error(parsed.success ? parsed.data.error : `Request failed (HTTP ${response.status}).`);
}

export default function DirectorFaqs() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dirtyFaqIds, setDirtyFaqIds] = useState<Record<string, boolean>>({});
  const [openFaqId, setOpenFaqId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadCatalog = useCallback(async () => {
    const response = await fetch("/api/ebook/faqs", { cache: "no-store" });
    const body: unknown = await response.json();
    if (!response.ok) throw await responseError(response, body);
    const parsed = DirectorFaqCatalogSchema.safeParse(body);
    if (!parsed.success) throw new Error("Nexus Director returned an invalid FAQ list.");
    setCatalog(parsed.data);
    setOpenFaqId((current) => current ?? parsed.data.faqs[0]?.id ?? null);
  }, []);

  useEffect(() => {
    loadCatalog()
      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : "Could not load FAQs."))
      .finally(() => setLoading(false));
  }, [loadCatalog]);

  function updateFaq(id: string, patch: Partial<Faq>) {
    setDirtyFaqIds((current) => ({ ...current, [id]: true }));
    setCatalog((current) => current && ({
      ...current,
      faqs: current.faqs.map((faq) => faq.id === id
        ? { ...faq, ...patch, status: "draft" as const }
        : faq),
    }));
  }

  async function postAction(body: unknown) {
    const response = await fetch("/api/ebook/faqs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const responseBody: unknown = await response.json();
    if (!response.ok) throw await responseError(response, responseBody);
    const parsed = DirectorFaqCatalogSchema.safeParse(responseBody);
    if (!parsed.success) throw new Error("The FAQ operation returned an invalid catalog.");
    setCatalog(parsed.data);
    return parsed.data;
  }

  async function saveFaq(faq: Faq) {
    setBusyId(faq.id);
    setError("");
    setNotice("");
    try {
      const saved = await postAction({
        action: "save",
        faq: DirectorFaqSchema.parse({ ...faq, status: "draft" }),
      });
      setDirtyFaqIds((current) => ({ ...current, [faq.id]: false }));
      setNotice(`Saved “${saved.faqs.find((item) => item.id === faq.id)?.question ?? faq.question}” as a private draft.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save this FAQ.");
    } finally {
      setBusyId(null);
    }
  }

  async function generateAnswer(faq: Faq) {
    setBusyId(faq.id);
    setError("");
    setNotice("");
    try {
      const editableFaq = DirectorFaqSchema.parse({ ...faq, status: "draft" });
      const response = await fetch("/api/library/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: editableFaq.question, purpose: "faq", scope: "all" }),
      });
      const body: unknown = await response.json();
      if (!response.ok) throw await responseError(response, body);
      const generated = GeneratedAnswerSchema.safeParse(body);
      if (!generated.success) {
        const answerOnly = z.object({ answer: z.string().min(1), sources: z.array(LibraryFaqSourceSchema).max(12) }).safeParse(body);
        if (!answerOnly.success) throw new Error("The library could not generate a source-backed answer. Check that relevant books or videos are published.");
        if (answerOnly.data.sources.length === 0) throw new Error("No matching published book or video sources were found for this question.");
        const saved = await postAction({
          action: "save",
          faq: { ...editableFaq, answer: answerOnly.data.answer, sources: answerOnly.data.sources, status: "draft" },
        });
        setDirtyFaqIds((current) => ({ ...current, [faq.id]: false }));
        setNotice(`Generated and saved a private answer for “${saved.faqs.find((item) => item.id === faq.id)?.question ?? faq.question}”. Review it before publishing.`);
        return;
      }
      const saved = await postAction({
        action: "save",
        faq: { ...editableFaq, answer: generated.data.answer, sources: generated.data.sources, status: "draft" },
      });
      setDirtyFaqIds((current) => ({ ...current, [faq.id]: false }));
      setNotice(`Generated and saved a private answer for “${saved.faqs.find((item) => item.id === faq.id)?.question ?? faq.question}”. Review it before publishing.`);
    } catch (generateError) {
      setError(generateError instanceof Error ? generateError.message : "Could not generate an FAQ answer.");
    } finally {
      setBusyId(null);
    }
  }

  async function runAction(action: Action, faq: Faq) {
    if (action === "delete" && !window.confirm(`Delete “${faq.question}” from Nexus Director?`)) return;
    setBusyId(faq.id);
    setError("");
    setNotice("");
    try {
      const result = await postAction({ action, faqId: faq.id });
      setDirtyFaqIds((current) => ({ ...current, [faq.id]: false }));
      if (action === "delete") setOpenFaqId((current) => current === faq.id ? null : current);
      setNotice(action === "publish"
        ? `Published “${faq.question}” to the Library.`
        : action === "unpublish"
          ? `Removed “${faq.question}” from the public Library.`
          : `Deleted “${faq.question}”.`);
      if (action === "delete" && result.faqs.length === 0) setSearch("");
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : `Could not ${action} this FAQ.`);
    } finally {
      setBusyId(null);
    }
  }

  function addFaq() {
    const id = `faq-${typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "")
      : Date.now().toString(36)}`;
    const faq = DirectorFaqSchema.parse({
      id,
      category: "New topic",
      question: "What question should this FAQ answer?",
      answer: "",
      sources: [],
      status: "draft",
      updatedAt: new Date().toISOString(),
    });
    setCatalog((current) => current && ({ ...current, faqs: [faq, ...current.faqs] }));
    setDirtyFaqIds((current) => ({ ...current, [id]: true }));
    setOpenFaqId(id);
  }

  const faqs = catalog?.faqs ?? [];
  const visibleFaqs = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return faqs.filter((faq) => !needle
      || faq.category.toLocaleLowerCase().includes(needle)
      || faq.question.toLocaleLowerCase().includes(needle));
  }, [faqs, search]);
  const publishedCount = faqs.filter((faq) => faq.status === "published").length;

  return (
    <div className="space-y-5">
      <section className="grid gap-3 rounded-2xl border border-slate-800 bg-slate-900/40 p-4 sm:grid-cols-[1fr_auto] sm:items-center sm:p-6">
        <div>
          <h2 className="text-lg font-semibold text-white">FAQ publishing</h2>
          <p className="mt-1 text-sm leading-relaxed text-slate-400">
            Edit the questions, generate answers from published books and video transcripts, review their citations, then publish selected FAQs.
          </p>
        </div>
        <button
          type="button"
          onClick={addFaq}
          disabled={loading || faqs.length >= 100}
          className="min-h-12 rounded-xl bg-cyan-400 px-5 text-sm font-bold text-slate-950 disabled:opacity-50"
        >
          + Add FAQ
        </button>
      </section>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <label>
          <span className="sr-only">Filter FAQs</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter by topic or question…"
            className="min-h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 text-base text-white placeholder:text-slate-500"
          />
        </label>
        <p className="text-sm text-slate-400">{publishedCount} published · {faqs.length - publishedCount} drafts</p>
      </div>

      {error && <p role="alert" className="rounded-xl border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-200">{error}</p>}
      {notice && <p role="status" className="rounded-xl border border-emerald-900 bg-emerald-950/30 p-3 text-sm text-emerald-200">{notice}</p>}
      {loading ? (
        <p className="py-8 text-center text-sm text-slate-400">Loading FAQs…</p>
      ) : visibleFaqs.length === 0 ? (
        <p className="rounded-xl border border-slate-800 p-6 text-sm text-slate-400">No FAQs match this filter.</p>
      ) : (
        <ol className="space-y-3">
          {visibleFaqs.map((faq) => {
            const busy = busyId === faq.id;
            return (
              <li key={faq.id} className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4 sm:p-5">
                <details
                  open={openFaqId === faq.id}
                  onToggle={(event) => {
                    if (event.currentTarget.open) setOpenFaqId(faq.id);
                    else setOpenFaqId((current) => current === faq.id ? null : current);
                  }}
                >
                  <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3">
                    <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase ${
                      faq.status === "published"
                        ? "border-emerald-800 text-emerald-300"
                        : "border-amber-900 text-amber-300"
                    }`}>{faq.status}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-semibold text-cyan-300">{faq.category}</span>
                      <span className="block text-sm font-semibold text-white">{faq.question}</span>
                    </span>
                  </summary>
                  <div className="mt-4 space-y-3">
                    <label className="block text-sm font-medium text-slate-300">
                      Topic
                      <input
                        type="text"
                        maxLength={80}
                        value={faq.category}
                        onChange={(event) => updateFaq(faq.id, { category: event.target.value })}
                        className="mt-1 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-base text-white"
                      />
                    </label>
                    <label className="block text-sm font-medium text-slate-300">
                      Question
                      <textarea
                        value={faq.question}
                        maxLength={300}
                        rows={2}
                        onChange={(event) => updateFaq(faq.id, {
                          question: event.target.value,
                          answer: undefined,
                          sources: [],
                        })}
                        className="mt-1 min-h-20 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-base text-white"
                      />
                    </label>
                    <label className="block text-sm font-medium text-slate-300">
                      Answer
                      <textarea
                        value={faq.answer ?? ""}
                        maxLength={20000}
                        rows={8}
                        onChange={(event) => updateFaq(faq.id, { answer: event.target.value })}
                        placeholder="Generate from the published library or edit the answer here."
                        className="mt-1 min-h-40 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-base leading-relaxed text-white"
                      />
                    </label>
                    {faq.sources.length > 0 && (
                      <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                        <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Generated sources</p>
                        {faq.sources.map((source) => (
                          <a
                            key={source.ref}
                            href={source.href}
                            target={source.href?.startsWith("https://") ? "_blank" : undefined}
                            rel={source.href?.startsWith("https://") ? "noreferrer" : undefined}
                            className="block min-h-12 rounded-lg border border-slate-800 p-3 text-sm"
                          >
                            <span className="font-semibold text-amber-300">[{source.ref}] {source.kind} · {source.title}</span>
                            <span className="mt-1 block text-xs text-slate-400">{source.excerpt}</span>
                          </a>
                        ))}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void generateAnswer(faq)}
                        disabled={busyId !== null || faq.question.trim().length < 4}
                        className="min-h-12 rounded-xl bg-cyan-400 px-4 text-sm font-bold text-slate-950 disabled:opacity-50"
                      >
                        {busy ? "Generating…" : "Generate from library"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void saveFaq(faq)}
                        disabled={busyId !== null}
                        className="min-h-12 rounded-xl border border-slate-700 px-4 text-sm font-semibold text-slate-200 disabled:opacity-50"
                      >
                        Save draft
                      </button>
                      {faq.status === "published" ? (
                        <button
                          type="button"
                          onClick={() => void runAction("unpublish", faq)}
                          disabled={busyId !== null}
                          className="min-h-12 rounded-xl border border-amber-900 px-4 text-sm font-semibold text-amber-200 disabled:opacity-50"
                        >
                          Unpublish
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void runAction("publish", faq)}
                          disabled={busyId !== null || dirtyFaqIds[faq.id] || !faq.answer?.trim() || faq.sources.length === 0}
                          className="min-h-12 rounded-xl bg-emerald-400 px-4 text-sm font-bold text-slate-950 disabled:opacity-50"
                        >
                          Publish
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void runAction("delete", faq)}
                        disabled={busyId !== null}
                        className="min-h-12 rounded-xl border border-rose-900 px-4 text-sm font-semibold text-rose-300 disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </details>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
