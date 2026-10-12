"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AcademyPackageSchema } from "@/lib/schemas/academy";
import type { AcademyPackage } from "@/lib/schemas/academy";
import { SiteConfigSchema } from "@/lib/schemas/site-config";
import type { SiteConfig } from "@/lib/schemas/site-config";
import { getTheme } from "@/lib/theme";
import type { PublishedAcademyEntry } from "@/lib/schemas/published-academy";

const LESSON_TYPE_COLORS: Record<string, string> = {
  video:    "bg-violet-500/20 text-violet-300",
  reading:  "bg-sky-500/20 text-sky-300",
  quiz:     "bg-amber-500/20 text-amber-300",
  exercise: "bg-orange-500/20 text-orange-300",
};

type PreviewPageProps = {
  initialAcademy?: AcademyPackage | null;
  initialSiteConfig?: SiteConfig | null;
  learnHref?: string;
  catalogHref?: string;
  catalogOnly?: boolean;
};

function AcademyCatalog({ courses }: { courses: PublishedAcademyEntry[] }) {
  return (
    <main className="min-h-dvh bg-slate-950 px-5 py-10 text-slate-100 sm:py-16">
      <div className="mx-auto max-w-6xl">
        <div className="mb-10 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.24em] text-cyan-400">Nexus Academy</p>
            <h1 className="text-3xl font-extrabold tracking-tight sm:text-5xl">Choose your next course</h1>
            <p className="mt-3 max-w-2xl text-base leading-relaxed text-slate-400">
              Learn at your pace with practical courses built from real source material.
            </p>
          </div>
          <Link href="/" className="inline-flex min-h-12 items-center rounded-xl border border-slate-700 px-5 text-sm font-semibold text-slate-300">
            Nexus Director
          </Link>
        </div>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {courses.map((course) => (
            <Link
              key={course.slug}
              href={`/academy/${course.slug}`}
              className="flex min-h-64 flex-col rounded-2xl border border-slate-800 bg-slate-900/70 p-6 transition hover:border-cyan-500/50"
            >
              <div className="mb-5 flex items-center justify-between gap-3">
                <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-cyan-300">
                  {course.difficultyLevel}
                </span>
                <span className="text-xs text-slate-500">{course.totalEstimatedHours}h</span>
              </div>
              <h2 className="text-xl font-bold leading-tight">{course.academyName}</h2>
              <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-slate-400">{course.tagline}</p>
              <p className="mt-auto pt-6 text-sm font-semibold text-cyan-400">
                {course.moduleCount} modules · {course.lessonCount} lessons
              </p>
            </Link>
          ))}
        </div>
      </div>
    </main>
  );
}

export function AcademyLandingView({
  initialAcademy = null,
  initialSiteConfig = null,
  learnHref = "/academy/learn",
  catalogHref = "/academy",
  catalogOnly = false,
}: PreviewPageProps) {
  const [academy, setAcademy] = useState<AcademyPackage | null>(null);
  const [missing, setMissing] = useState(false);
  const [siteConfig, setSiteConfig] = useState<SiteConfig | null>(null);
  const [publishedCourses, setPublishedCourses] = useState<PublishedAcademyEntry[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);

  useEffect(() => {
    if (initialAcademy) {
      setAcademy(initialAcademy);
      setMissing(false);
    }

    try {
      const raw = localStorage.getItem("nexus_academy_preview");
      if (!initialAcademy && raw) {
        const parsed = AcademyPackageSchema.parse(JSON.parse(raw));
        setAcademy(parsed);
        setMissing(false);
      } else if (!initialAcademy && !raw) {
        setMissing(true);
      }
    } catch {
      if (!initialAcademy) setMissing(true);
    }
    try {
      const rawCfg = localStorage.getItem("nexus_site_config");
      if (rawCfg) setSiteConfig(SiteConfigSchema.parse(JSON.parse(rawCfg)));
    } catch { /* ignore */ }
    if (initialSiteConfig) setSiteConfig(initialSiteConfig);
    fetch("/api/academy/publish")
      .then((response) => response.ok ? response.json() as Promise<{ courses?: PublishedAcademyEntry[] }> : Promise.reject(new Error("Could not load Academy catalog.")))
      .then((payload) => {
        setPublishedCourses(payload.courses ?? []);
        setCatalogLoaded(true);
      })
      .catch(() => {
        setPublishedCourses([]);
        setCatalogLoaded(true);
      });
  }, [initialAcademy, initialSiteConfig]);

  // I: Open Graph meta tags — injected dynamically for link preview support
  useEffect(() => {
    if (!academy) return;
    const setMeta = (property: string, content: string) => {
      let el = document.querySelector<HTMLMetaElement>(`meta[property="${property}"]`);
      if (!el) { el = document.createElement("meta"); el.setAttribute("property", property); document.head.appendChild(el); }
      el.setAttribute("content", content);
    };
    setMeta("og:type", "website");
    setMeta("og:title", academy.seoMeta.title);
    setMeta("og:description", academy.seoMeta.description);
    document.title = academy.seoMeta.title;
  }, [academy]);

  if (catalogOnly && !catalogLoaded) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-slate-950">
        <p className="text-base text-slate-400">Loading Academy catalog…</p>
      </div>
    );
  }

  if (catalogOnly && publishedCourses.length > 0) {
    return <AcademyCatalog courses={publishedCourses} />;
  }

  if (missing || !academy) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-slate-950">
        <p className="text-slate-400 text-base">
          No academy data found — run the pipeline in Nexus Director first.
        </p>
      </div>
    );
  }

  const free  = academy.pricing.find((t) => t.priceUsd === 0);
  const paid  = academy.pricing.filter((t) => t.priceUsd > 0);

  // H: JSON-LD Course structured data for Google rich results
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Course",
    name: academy.academyName,
    description: academy.seoMeta.description,
    provider: { "@type": "Organization", name: "Nexus Director" },
    educationalLevel: academy.difficultyLevel,
    timeRequired: academy.totalEstimatedHours > 0 ? `PT${Math.round(academy.totalEstimatedHours * 60)}M` : undefined,
    hasCourseInstance: academy.curriculum.flatMap((mod) =>
      mod.lessons.map((l) => ({
        "@type": "CourseInstance",
        name: l.title,
        courseMode: l.type,
        duration: `PT${l.durationMinutes}M`,
      }))
    ),
  };

  const t = getTheme(academy?.themeVariant);
  const layout = academy?.layoutVariant ?? "centered";
  const ctaText = (siteConfig?.ctaOverride || academy?.landingPage.cta) ?? "Get started";

  return (
    <div className={`min-h-dvh ${t.pageBg} ${t.heading} antialiased`}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* Announcement bar */}
      {siteConfig?.announcementBar && (
        <div className={`sticky top-0 z-[60] flex items-center justify-center ${t.accentBg} px-4 py-2.5 text-center text-sm font-semibold text-slate-950`}>
          {siteConfig.announcementBar}
        </div>
      )}

      {/* ── Nav ── */}
      <nav className={`sticky top-0 z-50 border-b ${t.border} ${t.nav} backdrop-blur-xl`}>
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
          <div className="flex items-center gap-3">
            <span className={`text-base font-bold tracking-tight ${t.heading}`}>{academy.academyName}</span>
            <Link
              href={catalogHref}
              className={`hidden rounded-lg border ${t.cardBorder} px-3 py-1.5 text-sm ${t.muted} transition hover:border-opacity-80 hover:${t.body} sm:block`}
            >
              Courses
            </Link>
          </div>
          <Link
            href={learnHref}
            className={`flex min-h-12 items-center rounded-xl ${t.accentBg} px-5 text-sm font-semibold text-slate-950 transition ${t.accentBgHover}`}
          >
            {ctaText}
          </Link>
        </div>
      </nav>

      {/* ── Hero ── */}
      {layout === "split" ? (
        <section className="mx-auto max-w-6xl px-5 pb-12 pt-10 sm:pb-16 sm:pt-16">
          <div className="flex flex-col gap-10 lg:flex-row lg:items-center lg:gap-16">
            <div className="flex-1">
              <span className={`mb-5 inline-block rounded-full border ${t.accentBorder} ${t.accentBgMuted} px-4 py-1.5 text-xs font-semibold uppercase tracking-widest ${t.accentText}`}>
                {academy.targetAudience}
              </span>
              {academy.difficultyLevel && (
                <span className={`mb-5 ml-2 inline-block rounded-full border ${t.cardBorder} px-3 py-1.5 text-xs font-semibold uppercase tracking-widest ${t.label}`}>
                  {academy.difficultyLevel}
                </span>
              )}
              <h1 className={`mb-5 text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl ${t.heading}`}>
                {academy.landingPage.headline}
              </h1>
              <p className={`mb-4 text-lg ${t.body}`}>{academy.landingPage.subheadline}</p>
              <p className={`mb-8 text-base ${t.muted}`}>{academy.landingPage.problemStatement}</p>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Link href={learnHref} className={`flex min-h-12 items-center justify-center rounded-xl ${t.accentBg} px-8 text-base font-bold text-slate-950 transition ${t.accentBgHover}`}>{ctaText}</Link>
                <Link href={catalogHref} className={`flex min-h-12 items-center justify-center rounded-xl border ${t.cardBorder} px-8 text-base font-semibold ${t.body} transition`}>Explore courses</Link>
              </div>
            </div>
            <div className={`flex-shrink-0 rounded-3xl border ${t.cardBorder} ${t.card} p-8 lg:w-80`}>
              <p className={`mb-4 text-xs font-semibold uppercase tracking-widest ${t.label}`}>What you will master</p>
              <ul className="space-y-3">
                {academy.landingPage.features.slice(0, 5).map((f, i) => (
                  <li key={i} className={`flex items-start gap-2 text-sm ${t.body}`}>
                    <span className={`mt-0.5 flex-shrink-0 ${t.accentText}`}>✓</span>
                    <span>{f.title}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      ) : layout === "minimal" ? (
        <section className={`border-b ${t.border} px-5 py-12 sm:py-16`}>
          <div className="mx-auto max-w-3xl">
            <p className={`mb-3 text-xs font-semibold uppercase tracking-widest ${t.accentText}`}>{academy.targetAudience}</p>
            <h1 className={`mb-4 text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl ${t.heading}`}>{academy.landingPage.headline}</h1>
            <p className={`mb-6 text-base ${t.muted} leading-relaxed`}>{academy.landingPage.problemStatement}</p>
            <Link href={learnHref} className={`inline-flex min-h-11 items-center rounded-xl ${t.accentBg} px-6 text-sm font-semibold text-slate-950 transition ${t.accentBgHover}`}>{ctaText} →</Link>
          </div>
        </section>
      ) : (
        <section className="mx-auto max-w-4xl px-5 pb-14 pt-12 text-center sm:pb-20 sm:pt-20">
          <span className={`mb-5 inline-block rounded-full border ${t.accentBorder} ${t.accentBgMuted} px-4 py-1.5 text-xs font-semibold uppercase tracking-widest ${t.accentText}`}>
            {academy.targetAudience}
          </span>
          {academy.difficultyLevel && (
            <span className={`mb-5 ml-2 inline-block rounded-full border ${t.cardBorder} px-3 py-1.5 text-xs font-semibold uppercase tracking-widest ${t.label}`}>
              {academy.difficultyLevel}
            </span>
          )}
          <h1 className={`mb-5 text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl ${t.heading}`}>
            {academy.landingPage.headline}
          </h1>
          <p className={`mb-4 text-lg ${t.body}`}>{academy.landingPage.subheadline}</p>
          <p className={`mx-auto mb-10 max-w-2xl text-base ${t.muted}`}>
            {academy.landingPage.problemStatement}
          </p>
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
            <Link
              href={catalogHref}
              className={`flex min-h-12 w-full items-center justify-center rounded-xl ${t.accentBg} px-8 text-base font-bold text-slate-950 transition ${t.accentBgHover} sm:w-auto`}
            >
              {ctaText}
            </Link>
            <Link
              href={learnHref}
              className={`flex min-h-12 w-full items-center justify-center rounded-xl border ${t.cardBorder} px-8 text-base font-semibold ${t.body} transition sm:w-auto`}
            >
              Explore courses
            </Link>
          </div>
        </section>
      )}

      {/* ── Features ── */}
      <section className={`border-y ${t.border} ${t.sectionAlt} py-10 sm:py-16`}>
        <div className="mx-auto max-w-6xl px-5">
          <p className={`mb-10 text-center text-[11px] font-semibold uppercase tracking-widest ${t.label}`}>
            What you get
          </p>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {academy.landingPage.features.map((f, i) => (
              <div
                key={i}
                className={`rounded-2xl border ${t.cardBorder} ${t.card} p-5`}
              >
                <p className={`mb-2 font-semibold ${t.heading}`}>{f.title}</p>
                <p className={`text-sm ${t.muted}`}>{f.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Curriculum ── */}
      <section className="mx-auto max-w-4xl px-5 py-10 sm:py-16">
        <p className={`mb-2 text-center text-[11px] font-semibold uppercase tracking-widest ${t.label}`}>
          Curriculum
        </p>
        <h2 className={`mb-10 text-center text-2xl font-bold ${t.heading}`}>
          {academy.curriculum.length} module{academy.curriculum.length !== 1 ? "s" : ""} · {academy.curriculum.reduce((n, m) => n + m.lessons.length, 0)} lessons
        </h2>
        <div className="space-y-3">
          {academy.curriculum.map((mod, mi) => (
            <details
              key={mi}
              className={`group rounded-2xl border ${t.cardBorder} ${t.card}`}
              open={mi === 0}
            >
              <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-5 py-4">
                <div>
                  <p className={`font-semibold ${t.heading}`}>{mod.moduleTitle}</p>
                  <p className={`text-xs ${t.muted}`}>{mod.lessons.length} lesson{mod.lessons.length !== 1 ? "s" : ""}</p>
                </div>
                <span className={`${t.label} transition group-open:rotate-180`}>▾</span>
              </summary>
              <div className={`border-t ${t.border} px-5 pb-4 pt-3`}>
                <p className={`mb-3 text-sm ${t.muted}`}>{mod.moduleDescription}</p>
                <ol className="space-y-2">
                  {mod.lessons.map((lesson, li) => (
                    <li key={li} className="flex items-center gap-3 text-sm">
                      <span className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full ${t.sectionAlt} text-[11px] font-bold ${t.label}`}>
                        {li + 1}
                      </span>
                      <span className={`flex-1 ${t.body}`}>{lesson.title}</span>
                      <span className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${LESSON_TYPE_COLORS[lesson.type] ?? LESSON_TYPE_COLORS.reading}`}>
                        {lesson.type}
                      </span>
                      <span className={`text-xs ${t.label}`}>{lesson.durationMinutes}m</span>
                    </li>
                  ))}
                </ol>
              </div>
            </details>
          ))}
        </div>
      </section>

      {/* ── Pricing ── */}
      <section id="pricing" className={`border-t ${t.border} ${t.sectionAlt} py-10 sm:py-16`}>
        <div className="mx-auto max-w-5xl px-5">
          <p className={`mb-2 text-center text-[11px] font-semibold uppercase tracking-widest ${t.label}`}>
            Pricing
          </p>
          <h2 className={`mb-10 text-center text-2xl font-bold ${t.heading}`}>Simple, transparent pricing</h2>
          <div className={`grid gap-5 ${academy.pricing.length === 3 ? "lg:grid-cols-3" : "sm:grid-cols-2"}`}>
            {academy.pricing.map((tier, i) => {
              const isPopular = tier.period !== "once" && tier.priceUsd > 0 && i === Math.floor(academy.pricing.length / 2);
              return (
                <div
                  key={i}
                  className={`relative rounded-2xl border p-6 ${
                    isPopular
                      ? `${t.popularBorder} ${t.popularBg} ring-1 ${t.accentRing}`
                      : `${t.cardBorder} ${t.card}`
                  }`}
                >
                  {isPopular && (
                    <span className={`absolute -top-3 left-1/2 -translate-x-1/2 rounded-full ${t.accentBg} px-3 py-0.5 text-[11px] font-bold text-slate-950`}>
                      Most popular
                    </span>
                  )}
                  <p className={`mb-1 font-semibold ${t.body}`}>{tier.name}</p>
                  <p className={`mb-4 text-3xl font-extrabold ${t.heading}`}>
                    {tier.priceUsd === 0 ? "Free" : `$${tier.priceUsd}`}
                    {tier.priceUsd > 0 && (
                      <span className={`ml-1 text-sm font-normal ${t.muted}`}>/{tier.period}</span>
                    )}
                  </p>
                  <ul className="mb-6 space-y-2">
                    {tier.features.map((f, fi) => (
                      <li key={fi} className={`flex items-start gap-2 text-sm ${t.body}`}>
                        <span className={`mt-px ${t.accentText}`}>✓</span>
                        {f}
                      </li>
                    ))}
                  </ul>
                  <a
                    href="#"
                    className={`flex min-h-12 items-center justify-center rounded-xl text-sm font-semibold transition ${
                      isPopular
                        ? `${t.accentBg} text-slate-950 ${t.accentBgHover}`
                        : `border ${t.cardBorder} ${t.body}`
                    }`}
                  >
                    {tier.priceUsd === 0 ? "Start free" : "Get started"}
                  </a>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── Instructor Bio ── */}
      {siteConfig?.instructorBio?.name && (
        <section className={`border-t ${t.border} py-10 sm:py-16`}>
          <div className="mx-auto max-w-3xl px-5">
            <p className={`mb-8 text-center text-[11px] font-semibold uppercase tracking-widest ${t.label}`}>Your Instructor</p>
            <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start">
              <div className={`flex h-20 w-20 flex-shrink-0 items-center justify-center rounded-full ${t.accentBgMuted} text-2xl font-extrabold ${t.accentText} ring-2 ${t.accentRing}`}>
                {siteConfig.instructorBio.avatarInitials || siteConfig.instructorBio.name.slice(0, 2).toUpperCase()}
              </div>
              <div>
                <p className={`text-xl font-bold ${t.heading}`}>{siteConfig.instructorBio.name}</p>
                {siteConfig.instructorBio.title && (
                  <p className={`mb-3 text-sm font-medium ${t.accentText}`}>{siteConfig.instructorBio.title}</p>
                )}
                {siteConfig.instructorBio.bio && (
                  <p className={`text-base ${t.muted} leading-relaxed`}>{siteConfig.instructorBio.bio}</p>
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ── Testimonials ── */}
      {siteConfig?.testimonials && siteConfig.testimonials.length > 0 && (
        <section className={`border-t ${t.border} ${t.sectionAlt} py-10 sm:py-16`}>
          <div className="mx-auto max-w-6xl px-5">
            <p className={`mb-2 text-center text-[11px] font-semibold uppercase tracking-widest ${t.label}`}>Student Results</p>
            <h2 className={`mb-10 text-center text-2xl font-bold ${t.heading}`}>What students are saying</h2>
            <div className={`grid gap-5 ${siteConfig.testimonials.length > 2 ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2"}`}>
              {siteConfig.testimonials.map((testimonial, i) => (
                <div key={i} className={`rounded-2xl border ${t.cardBorder} ${t.card} p-6`}>
                  <div className="mb-3 flex items-center gap-1">
                    {Array.from({ length: 5 }).map((_, s) => (
                      <span key={s} className={s < testimonial.rating ? t.starActive : t.label}>★</span>
                    ))}
                  </div>
                  <p className={`mb-4 text-sm ${t.body} leading-relaxed`}>&ldquo;{testimonial.quote}&rdquo;</p>
                  <div>
                    <p className={`text-sm font-semibold ${t.heading}`}>{testimonial.name}</p>
                    {testimonial.role && <p className={`text-xs ${t.label}`}>{testimonial.role}</p>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── FAQ ── */}
      {siteConfig?.faqItems && siteConfig.faqItems.length > 0 && (
        <section className="mx-auto max-w-3xl px-5 py-10 sm:py-16">
          <p className={`mb-2 text-center text-[11px] font-semibold uppercase tracking-widest ${t.label}`}>FAQ</p>
          <h2 className={`mb-10 text-center text-2xl font-bold ${t.heading}`}>Common questions</h2>
          <div className="space-y-3">
            {siteConfig.faqItems.map((item, i) => (
              <details key={i} className={`group rounded-2xl border ${t.cardBorder} ${t.card}`}>
                <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-5 py-4">
                  <p className={`font-medium ${t.heading}`}>{item.question}</p>
                  <span className={`flex-shrink-0 ${t.label} transition group-open:rotate-180`}>▾</span>
                </summary>
                <div className={`border-t ${t.border} px-5 pb-4 pt-3`}>
                  <p className={`text-sm ${t.muted} leading-relaxed`}>{item.answer}</p>
                </div>
              </details>
            ))}
          </div>
        </section>
      )}

      {/* ── Onboarding ── */}
      <section className="mx-auto max-w-3xl px-5 py-10 sm:py-16">
        <p className={`mb-2 text-center text-[11px] font-semibold uppercase tracking-widest ${t.label}`}>
          How it works
        </p>
        <h2 className={`mb-10 text-center text-2xl font-bold ${t.heading}`}>Up and running in minutes</h2>
        <ol className="space-y-4">
          {academy.onboardingSteps.map((step, i) => (
            <li key={i} className="flex items-start gap-4">
              <span className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full ${t.accentBgMuted} text-sm font-bold ${t.accentText}`}>
                {i + 1}
              </span>
              <p className={`pt-1 text-base ${t.body}`}>{step}</p>
            </li>
          ))}
        </ol>
      </section>

      {publishedCourses.length > 0 && (
        <section className={`border-t ${t.border} ${t.sectionAlt} py-10 sm:py-16`}>
          <div className="mx-auto max-w-6xl px-5">
            <div className="mb-8 flex items-end justify-between gap-4">
              <div>
                <p className={`mb-2 text-[11px] font-semibold uppercase tracking-widest ${t.label}`}>More courses</p>
                <h2 className={`text-2xl font-bold ${t.heading}`}>Explore the Academy</h2>
              </div>
              <Link href={catalogHref} className={`inline-flex min-h-12 items-center rounded-xl border ${t.cardBorder} px-4 text-sm font-semibold ${t.body}`}>
                View all
              </Link>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {publishedCourses.map((course) => (
                <Link
                  key={course.slug}
                  href={`/academy/${course.slug}`}
                  className={`flex min-h-44 flex-col rounded-2xl border ${t.cardBorder} ${t.card} p-5`}
                >
                  <p className={`text-lg font-bold ${t.heading}`}>{course.academyName}</p>
                  <p className={`mt-2 line-clamp-3 text-sm ${t.muted}`}>{course.tagline}</p>
                  <p className={`mt-auto pt-5 text-xs font-semibold ${t.accentText}`}>
                    {course.moduleCount} modules · {course.lessonCount} lessons
                  </p>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── Footer ── */}
      <footer className={`border-t ${t.border} pb-[max(env(safe-area-inset-bottom),_2.5rem)] pt-10`}>
        <div className="mx-auto max-w-6xl px-5">
          {/* Social links */}
          {siteConfig && Object.values(siteConfig.socialLinks).some(Boolean) && (
            <div className="mb-6 flex flex-wrap items-center gap-3">
              {siteConfig.socialLinks.website && (
                <a href={siteConfig.socialLinks.website} target="_blank" rel="noopener noreferrer" className={`text-xs ${t.label} transition hover:${t.body}`}>Website ↗</a>
              )}
              {siteConfig.socialLinks.youtube && (
                <a href={siteConfig.socialLinks.youtube} target="_blank" rel="noopener noreferrer" className={`text-xs ${t.label} transition hover:${t.body}`}>YouTube ↗</a>
              )}
              {siteConfig.socialLinks.twitter && (
                <a href={siteConfig.socialLinks.twitter} target="_blank" rel="noopener noreferrer" className={`text-xs ${t.label} transition hover:${t.body}`}>Twitter ↗</a>
              )}
              {siteConfig.socialLinks.instagram && (
                <a href={siteConfig.socialLinks.instagram} target="_blank" rel="noopener noreferrer" className={`text-xs ${t.label} transition hover:${t.body}`}>Instagram ↗</a>
              )}
              {siteConfig.socialLinks.linkedin && (
                <a href={siteConfig.socialLinks.linkedin} target="_blank" rel="noopener noreferrer" className={`text-xs ${t.label} transition hover:${t.body}`}>LinkedIn ↗</a>
              )}
            </div>
          )}
          <div className="mb-4 flex flex-wrap gap-1.5">
            {academy.seoMeta.keywords.map((k, i) => (
              <span key={i} className={`rounded ${t.sectionAlt} px-2 py-0.5 text-[11px] ${t.label}`}>
                {k}
              </span>
            ))}
          </div>
          <p className={`text-xs ${t.label}`}>{academy.seoMeta.description}</p>
          <p className={`mt-3 text-xs ${t.label} opacity-60`}>
            {siteConfig?.footerText || `Built with Nexus Director · ${new Date().getFullYear()}`}
          </p>
        </div>
      </footer>

    </div>
  );
}
export default function PreviewPage() {
  return <AcademyLandingView />;
}
