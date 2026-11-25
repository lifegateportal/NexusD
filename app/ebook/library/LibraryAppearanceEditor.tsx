"use client";

import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  LibraryBrandingSchema,
  type LibraryBranding,
} from "@/lib/schemas/library-branding";
import {
  removeLibraryCover,
  fetchLibraryFeatureOptions,
  saveLibraryAppearance,
  uploadLibraryCover,
} from "@/lib/library-branding-client";

const SECTION_OPTIONS = [
  { value: "featuredSermons", label: "Featured Sermons" },
  { value: "featuredShorts", label: "Featured Shorts" },
  { value: "featuredBooks", label: "Featured Books" },
  { value: "newReleases", label: "New Releases" },
  { value: "myList", label: "My Reading List" },
  { value: "allBooks", label: "All Books" },
] as const;

const COVER_LAYER_OPTIONS = [
  { value: "behind", label: "Behind text", description: "Use the cover as a subtle background image." },
  { value: "foreground", label: "Foreground", description: "Show the cover clearly beside the welcome text." },
] as const;

const ACCENT_OPTIONS = [
  { value: "amber", label: "Amber" },
  { value: "cyan", label: "Cyan" },
  { value: "emerald", label: "Emerald" },
  { value: "rose", label: "Rose" },
  { value: "violet", label: "Violet" },
] as const;

const LAYOUT_OPTIONS = [
  { value: "cinematic", label: "Cinematic", description: "Wide cover image with text overlay" },
  { value: "split", label: "Split", description: "Cover image beside the introduction" },
  { value: "simple", label: "Simple", description: "Compact title and introduction banner" },
] as const;

const FIELD_CLASS = "mt-1 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-950/70 px-3 text-base text-slate-100 outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400";
const LABEL_CLASS = "block text-sm font-medium text-slate-300";
const MAX_COVER_BYTES = 10 * 1024 * 1024;
const MAX_FEATURED_ITEMS = 8;
const COVER_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
type LibraryFeatureOptions = Awaited<ReturnType<typeof fetchLibraryFeatureOptions>>;

function orderedSections(sections: LibraryBranding["sections"]) {
  const indexOf = (value: LibraryBranding["sections"][number]) => {
    const index = sections.indexOf(value);
    return index < 0 ? sections.length + SECTION_OPTIONS.findIndex((section) => section.value === value) : index;
  };
  return [...SECTION_OPTIONS].sort((a, b) => indexOf(a.value) - indexOf(b.value));
}

export default function LibraryAppearanceEditor({ initialBranding }: { initialBranding: LibraryBranding }) {
  const router = useRouter();
  const [branding, setBranding] = useState(initialBranding);
  const [featureOptions, setFeatureOptions] = useState<LibraryFeatureOptions>({ books: [], videos: [], shorts: [] });
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    void fetchLibraryFeatureOptions()
      .then((options) => {
        if (active) setFeatureOptions(options);
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Could not load published books, sermons, and shorts.");
      })
      .finally(() => {
        if (active) setOptionsLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  function update<K extends keyof LibraryBranding>(key: K, value: LibraryBranding[K]) {
    setBranding((current) => ({ ...current, [key]: value }));
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await saveLibraryAppearance({
        title: branding.title,
        shortName: branding.shortName,
        tagline: branding.tagline,
        description: branding.description,
        accentColor: branding.accentColor,
        colorMode: branding.colorMode,
        heroLayout: branding.heroLayout,
        simpleCoverLayer: branding.simpleCoverLayer,
        featuredSermonIds: branding.featuredSermonIds,
        featuredShortSlugs: branding.featuredShortSlugs,
        featuredBookSlugs: branding.featuredBookSlugs,
        sections: branding.sections,
      });
      setBranding(saved);
      setNotice("PJDL appearance settings saved.");
      router.refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save library appearance settings.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCoverChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!COVER_IMAGE_TYPES.includes(file.type) || file.size < 1 || file.size > MAX_COVER_BYTES) {
      setError("Choose a JPEG, PNG, or WebP image up to 10 MB.");
      setNotice("");
      return;
    }

    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await uploadLibraryCover(file);
      setBranding((current) => ({ ...current, coverImageUrl: saved.coverImageUrl }));
      setNotice("PJDL cover uploaded and saved.");
      router.refresh();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Could not upload the PJDL cover image.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveCover() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await removeLibraryCover();
      setBranding((current) => ({ ...current, coverImageUrl: saved.coverImageUrl }));
      setNotice("PJDL cover removed.");
      router.refresh();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Could not remove the PJDL cover image.");
    } finally {
      setBusy(false);
    }
  }

  function moveSection(index: number, offset: -1 | 1) {
    const sections = [...branding.sections];
    const target = index + offset;
    if (target < 0 || target >= sections.length) return;
    [sections[index], sections[target]] = [sections[target], sections[index]];
    update("sections", sections);
  }

  function toggleSection(value: LibraryBranding["sections"][number]) {
    const sections = branding.sections.includes(value)
      ? branding.sections.filter((section) => section !== value)
      : [...branding.sections, value];
    update("sections", sections);
  }

  function toggleFeaturedSermon(videoId: string) {
    const ids = branding.featuredSermonIds.includes(videoId)
      ? branding.featuredSermonIds.filter((id) => id !== videoId)
      : [...branding.featuredSermonIds, videoId];
    update("featuredSermonIds", ids);
  }

  function toggleFeaturedShort(slug: string) {
    const slugs = branding.featuredShortSlugs.includes(slug)
      ? branding.featuredShortSlugs.filter((item) => item !== slug)
      : [...branding.featuredShortSlugs, slug];
    update("featuredShortSlugs", slugs);
  }

  function toggleFeaturedBook(slug: string) {
    const slugs = branding.featuredBookSlugs.includes(slug)
      ? branding.featuredBookSlugs.filter((item) => item !== slug)
      : [...branding.featuredBookSlugs, slug];
    update("featuredBookSlugs", slugs);
  }

  function setAccent(value: string) {
    const accent = LibraryBrandingSchema.shape.accentColor.safeParse(value);
    if (accent.success) update("accentColor", accent.data);
  }

  const validatedBranding = LibraryBrandingSchema.safeParse(branding);

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4 sm:p-6">
        <div className="mb-5">
          <h2 className="text-xl font-bold text-white">Library identity</h2>
          <p className="mt-1 text-sm leading-relaxed text-slate-400">Edit the text visitors see on the public PJDL page.</p>
        </div>
        <form onSubmit={(event) => void handleSave(event)} className="space-y-5">
          <fieldset disabled={busy} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className={LABEL_CLASS}>
              Library title
              <input className={FIELD_CLASS} maxLength={80} value={branding.title} onChange={(event) => update("title", event.target.value)} />
            </label>
            <label className={LABEL_CLASS}>
              Short name
              <input className={FIELD_CLASS} maxLength={16} value={branding.shortName} onChange={(event) => update("shortName", event.target.value)} />
            </label>
            <label className={LABEL_CLASS}>
              Tagline
              <input className={FIELD_CLASS} maxLength={80} value={branding.tagline} onChange={(event) => update("tagline", event.target.value)} />
            </label>
            <label className={LABEL_CLASS}>
              Accent color
              <select className={FIELD_CLASS} value={branding.accentColor} onChange={(event) => setAccent(event.target.value)}>
                {ACCENT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
          </div>
          <label className={LABEL_CLASS}>
            Introduction
            <textarea
              className="mt-1 min-h-28 w-full rounded-xl border border-slate-700 bg-slate-950/70 p-3 text-base text-slate-100 outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400"
              maxLength={240}
              value={branding.description}
              onChange={(event) => update("description", event.target.value)}
            />
          </label>

          <fieldset>
            <legend className="mb-2 text-sm font-medium text-slate-300">Hero layout</legend>
            <div className="grid gap-3 sm:grid-cols-3">
              {LAYOUT_OPTIONS.map((option) => (
                <label key={option.value} className={`flex min-h-20 cursor-pointer items-start gap-3 rounded-xl border p-3 ${branding.heroLayout === option.value ? "border-cyan-400 bg-cyan-950/30" : "border-slate-700 bg-slate-950/40"}`}>
                  <input
                    type="radio"
                    name="heroLayout"
                    value={option.value}
                    checked={branding.heroLayout === option.value}
                    onChange={() => update("heroLayout", option.value)}
                    className="mt-1 h-4 w-4 accent-cyan-400"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-slate-100">{option.label}</span>
                    <span className="mt-1 block text-xs leading-relaxed text-slate-400">{option.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {branding.heroLayout === "simple" && (
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-slate-300">Compact cover image depth</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {COVER_LAYER_OPTIONS.map((option) => (
                  <label key={option.value} className={`flex min-h-20 cursor-pointer items-start gap-3 rounded-xl border p-3 ${branding.simpleCoverLayer === option.value ? "border-cyan-400 bg-cyan-950/30" : "border-slate-700 bg-slate-950/40"}`}>
                    <input
                      type="radio"
                      name="simpleCoverLayer"
                      value={option.value}
                      checked={branding.simpleCoverLayer === option.value}
                      onChange={() => update("simpleCoverLayer", option.value)}
                      className="mt-1 h-4 w-4 accent-cyan-400"
                    />
                    <span>
                      <span className="block text-sm font-semibold text-slate-100">{option.label}</span>
                      <span className="mt-1 block text-xs leading-relaxed text-slate-400">{option.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          <fieldset>
            <legend className="mb-2 text-sm font-medium text-slate-300">Color mode</legend>
            <div className="flex flex-wrap gap-3">
              {(["dark", "light"] as const).map((mode) => (
                <label key={mode} className={`flex min-h-12 min-w-32 cursor-pointer items-center gap-2 rounded-xl border px-4 text-sm font-medium capitalize ${branding.colorMode === mode ? "border-cyan-400 bg-cyan-950/30 text-cyan-100" : "border-slate-700 text-slate-300"}`}>
                  <input type="radio" name="colorMode" value={mode} checked={branding.colorMode === mode} onChange={() => update("colorMode", mode)} className="h-4 w-4 accent-cyan-400" />
                  {mode} mode
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-1 text-sm font-medium text-slate-300">Welcome page features</legend>
            <p className="mb-3 text-xs leading-relaxed text-slate-500">Choose up to {MAX_FEATURED_ITEMS} published items per group. Sermons and shorts default to recent items when none are selected; featured books show only the books you choose.</p>
            {optionsLoading ? (
              <p className="py-4 text-sm text-slate-400">Loading published features…</p>
            ) : (
              <div className="grid gap-4 lg:grid-cols-3">
                <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                  <h3 className="mb-2 text-sm font-semibold text-slate-200">Books</h3>
                  {featureOptions.books.length ? (
                    <div className="max-h-64 space-y-1 overflow-y-auto">
                      {featureOptions.books.map((book) => {
                        const checked = branding.featuredBookSlugs.includes(book.slug);
                        return (
                          <label key={book.slug} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg px-2 text-sm text-slate-300 hover:bg-slate-900">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={!checked && branding.featuredBookSlugs.length >= MAX_FEATURED_ITEMS}
                              onChange={() => toggleFeaturedBook(book.slug)}
                              className="h-4 w-4 accent-cyan-400"
                            />
                            <span className="line-clamp-2">{book.title}</span>
                          </label>
                        );
                      })}
                    </div>
                  ) : <p className="py-3 text-sm text-slate-500">No published books are available yet.</p>}
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                  <h3 className="mb-2 text-sm font-semibold text-slate-200">Sermon videos</h3>
                  {featureOptions.videos.length ? (
                    <div className="max-h-64 space-y-1 overflow-y-auto">
                      {featureOptions.videos.map((video) => {
                        const checked = branding.featuredSermonIds.includes(video.videoId);
                        return (
                          <label key={video.videoId} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg px-2 text-sm text-slate-300 hover:bg-slate-900">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={!checked && branding.featuredSermonIds.length >= MAX_FEATURED_ITEMS}
                              onChange={() => toggleFeaturedSermon(video.videoId)}
                              className="h-4 w-4 accent-cyan-400"
                            />
                            <span className="line-clamp-2">{video.title}</span>
                          </label>
                        );
                      })}
                    </div>
                  ) : <p className="py-3 text-sm text-slate-500">No published sermon videos are available yet.</p>}
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                  <h3 className="mb-2 text-sm font-semibold text-slate-200">Shorts</h3>
                  {featureOptions.shorts.length ? (
                    <div className="max-h-64 space-y-1 overflow-y-auto">
                      {featureOptions.shorts.map((short) => {
                        const checked = branding.featuredShortSlugs.includes(short.slug);
                        return (
                          <label key={short.slug} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg px-2 text-sm text-slate-300 hover:bg-slate-900">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={!checked && branding.featuredShortSlugs.length >= MAX_FEATURED_ITEMS}
                              onChange={() => toggleFeaturedShort(short.slug)}
                              className="h-4 w-4 accent-cyan-400"
                            />
                            <span className="line-clamp-2">{short.title}</span>
                          </label>
                        );
                      })}
                    </div>
                  ) : <p className="py-3 text-sm text-slate-500">No published shorts are available yet.</p>}
                </div>
              </div>
            )}
          </fieldset>

          <fieldset>
            <legend className="mb-2 text-sm font-medium text-slate-300">Public page sections</legend>
            <div className="space-y-2">
              {orderedSections(branding.sections).map((option) => {
                const index = branding.sections.indexOf(option.value);
                return (
                  <div key={option.value} className="flex min-h-12 items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/40 px-3">
                    <label className="flex min-h-12 min-w-0 flex-1 items-center gap-3 text-sm text-slate-200">
                      <input type="checkbox" checked={index >= 0} onChange={() => toggleSection(option.value)} className="h-4 w-4 accent-cyan-400" />
                      {option.label}
                    </label>
                    <span className="min-w-12 text-center text-xs text-slate-500">{index >= 0 ? `#${index + 1}` : "Hidden"}</span>
                    <button type="button" disabled={index <= 0} onClick={() => moveSection(index, -1)} aria-label={`Move ${option.label} up`} className="min-h-12 min-w-12 rounded-lg text-slate-300 disabled:opacity-30">↑</button>
                    <button type="button" disabled={index < 0 || index >= branding.sections.length - 1} onClick={() => moveSection(index, 1)} aria-label={`Move ${option.label} down`} className="min-h-12 min-w-12 rounded-lg text-slate-300 disabled:opacity-30">↓</button>
                  </div>
                );
              })}
            </div>
          </fieldset>

          {!validatedBranding.success && (
            <p role="alert" className="text-sm text-rose-300">
              {validatedBranding.error.issues[0]?.message ?? "Check the appearance settings before saving."}
            </p>
          )}
          <button type="submit" disabled={busy || !validatedBranding.success} className="min-h-12 rounded-xl bg-cyan-400 px-5 text-base font-bold text-slate-950 disabled:cursor-wait disabled:opacity-60">
            {busy ? "Saving…" : "Save appearance"}
          </button>
          </fieldset>
        </form>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4 sm:p-6">
        <div className="mb-4">
          <h2 className="text-xl font-bold text-white">Hero cover image</h2>
          <p className="mt-1 text-sm leading-relaxed text-slate-400">The image is sent to Nexus Director, validated, and written to PJDL storage by the authenticated server.</p>
        </div>
        {branding.coverImageUrl && (
          <div className="mb-4 overflow-hidden rounded-xl border border-slate-700">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={branding.coverImageUrl} alt="Current PJDL hero cover" className="h-44 w-full object-cover sm:h-56" />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex min-h-12 cursor-pointer items-center justify-center rounded-xl border border-cyan-700 px-4 text-base font-semibold text-cyan-100">
            {busy ? "Uploading…" : branding.coverImageUrl ? "Change cover image" : "Upload cover image"}
            <input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} className="sr-only" onChange={(event) => void handleCoverChange(event)} />
          </label>
          {branding.coverImageUrl && (
            <button type="button" disabled={busy} onClick={() => void handleRemoveCover()} className="min-h-12 rounded-xl border border-slate-700 px-4 text-base font-medium text-slate-200 disabled:opacity-60">
              Remove cover
            </button>
          )}
          <span className="text-xs text-slate-500">JPEG, PNG, or WebP · up to 10 MB</span>
        </div>
      </section>

      {error && <p role="alert" className="rounded-xl border border-rose-900 bg-rose-950/40 p-4 text-sm text-rose-200">{error}</p>}
      {notice && <p role="status" className="rounded-xl border border-emerald-900 bg-emerald-950/30 p-4 text-sm text-emerald-200">{notice}</p>}
    </div>
  );
}
