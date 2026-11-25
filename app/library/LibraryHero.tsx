"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { z } from "zod";
import {
  LibraryBrandingSchema,
  LibraryCoverUploadResponseSchema,
} from "@/lib/schemas/library-branding";

const MAX_COVER_BYTES = 10 * 1024 * 1024;
const COVER_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const ErrorResponseSchema = z.object({ error: z.string() }).strict();

async function parseApiResponse<T>(response: Response, schema: z.ZodType<T>, invalidResponseMessage: string): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`The library service returned an unreadable response (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    const error = ErrorResponseSchema.safeParse(body);
    throw new Error(error.success ? error.data.error : `Cover image request failed (HTTP ${response.status}).`);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error(invalidResponseMessage);
  return parsed.data;
}

export default function LibraryHero() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [coverImageUrl, setCoverImageUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    void fetch("/api/library/branding", { cache: "no-store" })
      .then((response) => parseApiResponse(response, LibraryBrandingSchema, "The PJDL cover settings returned an invalid response."))
      .then((branding) => {
        if (active) setCoverImageUrl(branding.coverImageUrl);
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Could not load the PJDL cover image.");
      });
    return () => {
      active = false;
    };
  }, []);

  async function handleCoverChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!COVER_IMAGE_TYPES.includes(file.type) || file.size > MAX_COVER_BYTES || file.size === 0) {
      setError("Choose a JPEG, PNG, or WebP image up to 10 MB.");
      setNotice("");
      return;
    }

    setBusy(true);
    setError("");
    setNotice("");
    try {
      const prepareResponse = await fetch("/api/library/branding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentType: file.type, size: file.size }),
      });
      const upload = await parseApiResponse(
        prepareResponse,
        LibraryCoverUploadResponseSchema,
        "The PJDL cover upload returned an invalid response.",
      );
      if (upload.contentType !== file.type) throw new Error("The cover upload service returned the wrong image format.");
      const uploadResponse = await fetch(upload.presignedUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!uploadResponse.ok) throw new Error(`Cover image upload failed (HTTP ${uploadResponse.status}).`);
      const saveResponse = await fetch("/api/library/branding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coverImageUrl: upload.coverImageUrl }),
      });
      const branding = await parseApiResponse(
        saveResponse,
        LibraryBrandingSchema,
        "The PJDL cover settings returned an invalid response.",
      );
      setCoverImageUrl(branding.coverImageUrl);
      setNotice("PJDL cover image updated.");
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Could not upload the PJDL cover image.");
    } finally {
      setBusy(false);
    }
  }

  async function removeCover() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/library/branding", { method: "DELETE" });
      const branding = await parseApiResponse(response, LibraryBrandingSchema, "The PJDL cover settings returned an invalid response.");
      setCoverImageUrl(branding.coverImageUrl);
      setNotice("PJDL cover image removed.");
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Could not remove the PJDL cover image.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mx-auto max-w-6xl px-5 pb-8 pt-6 sm:pt-8 lg:pb-10">
      <div className="relative isolate overflow-hidden rounded-3xl border border-white/10 bg-slate-900 shadow-2xl shadow-black/30">
        <div aria-hidden className="pointer-events-none absolute inset-0">
          {coverImageUrl && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={coverImageUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-45" />
              <div className="absolute inset-0 bg-gradient-to-r from-slate-950 via-slate-950/85 to-slate-950/45" />
            </>
          )}
          <div className="absolute inset-0 bg-gradient-to-br from-amber-500/10 via-transparent to-cyan-500/10" />
          <div className="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-transparent to-slate-950/10" />
        </div>

        <div className="relative grid min-h-[430px] items-center gap-8 p-5 sm:p-8 lg:min-h-[400px] lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-10 lg:p-12">
          <div className="max-w-3xl">
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-amber-400/25 bg-slate-950/60 px-3 py-1.5">
              <span className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-300">PJDL</span>
              <span aria-hidden className="h-1 w-1 rounded-full bg-amber-300/70" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-300">Read · Listen · Discover</span>
            </div>
            <h2 className="max-w-2xl text-4xl font-bold leading-[1.05] tracking-tight text-white sm:text-5xl lg:text-6xl">
              Pastor Josh Digital Library
            </h2>
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-slate-300 sm:text-base">
              Explore books, teaching, and ideas in one place. Find a new read, listen in, or ask questions grounded in the source material.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link href="/library/ask" className="inline-flex min-h-12 items-center justify-center rounded-xl bg-amber-400 px-5 text-base font-bold text-slate-950 transition-colors hover:bg-amber-300">
                Ask the library
              </Link>
              <Link href="/library/videos" className="inline-flex min-h-12 items-center justify-center rounded-xl border border-white/20 bg-slate-950/40 px-5 text-base font-semibold text-white transition-colors hover:bg-slate-950/70">
                Browse videos
              </Link>
              <Link href="/library/faqs" className="inline-flex min-h-12 items-center justify-center rounded-xl border border-white/20 bg-slate-950/40 px-5 text-base font-semibold text-white transition-colors hover:bg-slate-950/70">
                Browse FAQs
              </Link>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 lg:max-w-56 lg:flex-col lg:items-stretch">
            <input
              ref={inputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              aria-label="Choose a PJDL cover image"
              className="sr-only"
              onChange={(event) => void handleCoverChange(event)}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-white/20 bg-slate-950/70 px-4 text-base font-semibold text-white transition-colors hover:bg-slate-900 disabled:cursor-wait disabled:opacity-60"
            >
              <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} className="h-5 w-5">
                <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14.5v4A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {busy ? "Saving cover…" : coverImageUrl ? "Change cover image" : "Add cover image"}
            </button>
            {coverImageUrl && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void removeCover()}
                className="inline-flex min-h-12 items-center justify-center rounded-xl border border-white/15 px-4 text-base font-medium text-slate-300 transition-colors hover:bg-white/10 disabled:cursor-wait disabled:opacity-60"
              >
                Remove cover
              </button>
            )}
            <p className="w-full text-xs leading-relaxed text-slate-400 lg:text-center">
              JPEG, PNG, or WebP · up to 10 MB
            </p>
          </div>
        </div>
      </div>
      {error && <p role="alert" className="mt-3 rounded-xl border border-rose-900/70 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">{error}</p>}
      {notice && <p role="status" className="mt-3 text-sm text-emerald-300">{notice}</p>}
    </section>
  );
}
