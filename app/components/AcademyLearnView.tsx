"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { AcademyPackageSchema } from "@/lib/schemas/academy";
import type { AcademyPackage } from "@/lib/schemas/academy";
import { getVideoObjectUrl, getVideoMeta, getYoutubeId, getVideoUrl } from "@/lib/video-store";
import { getTheme } from "@/lib/theme";

type Lesson = AcademyPackage["curriculum"][number]["lessons"][number];

type LearnPageProps = {
  initialAcademy?: AcademyPackage | null;
  backHref?: string;
  storageKey?: string;
};

const TYPE_COLORS: Record<string, string> = {
  video:    "bg-violet-500/20 text-violet-300 border-violet-500/30",
  reading:  "bg-sky-500/20 text-sky-300 border-sky-500/30",
  quiz:     "bg-amber-500/20 text-amber-300 border-amber-500/30",
  exercise: "bg-orange-500/20 text-orange-300 border-orange-500/30",
};

const TYPE_ICONS: Record<string, string> = {
  video:    "▶",
  reading:  "📄",
  quiz:     "✏",
  exercise: "🏋",
};

// ── Inline markdown renderer (bold / italic) ──────────────────────────────────
function InlineContent({ text }: { text: string }) {
  const parts: Array<{ t: "text" | "bold" | "italic"; v: string }> = [];
  const re = /(\*\*([^*\n]+?)\*\*|\*([^*\n]+?)\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ t: "text", v: text.slice(last, m.index) });
    if (m[0].startsWith("**")) parts.push({ t: "bold",   v: m[2] });
    else                        parts.push({ t: "italic", v: m[3] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ t: "text", v: text.slice(last) });
  return (
    <>
      {parts.map((p, i) =>
        p.t === "bold"   ? <strong key={i} className="font-semibold text-slate-100">{p.v}</strong> :
        p.t === "italic" ? <em      key={i} className="italic text-slate-200">{p.v}</em> :
                           <span   key={i}>{p.v}</span>
      )}
    </>
  );
}

// ── Block-level markdown renderer ────────────────────────────────────────────
function MarkdownNotes({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const raw   = lines[i];
    const line  = raw.trim();
    if (!line) { i++; continue; }

    // H1
    if (/^# /.test(line)) {
      blocks.push(<h1 key={i} className="mt-7 mb-3 border-b border-slate-700/60 pb-2 text-xl font-extrabold text-white tracking-tight"><InlineContent text={line.slice(2)} /></h1>);
    }
    // H2
    else if (/^## /.test(line)) {
      blocks.push(<h2 key={i} className="mt-6 mb-2 text-base font-bold text-slate-100"><InlineContent text={line.slice(3)} /></h2>);
    }
    // H3
    else if (/^### /.test(line)) {
      blocks.push(<h3 key={i} className="mt-4 mb-1.5 text-sm font-semibold uppercase tracking-widest text-cyan-400"><InlineContent text={line.slice(4)} /></h3>);
    }
    // Horizontal rule
    else if (/^---+$/.test(line)) {
      blocks.push(<hr key={i} className="my-6 border-slate-700/60" />);
    }
    // Blockquote
    else if (/^> /.test(line)) {
      blocks.push(
        <blockquote key={i} className="my-3 border-l-4 border-cyan-500/50 pl-4 italic text-sm text-slate-400">
          <InlineContent text={line.slice(2)} />
        </blockquote>
      );
    }
    // Numbered list — collect consecutive items
    else if (/^\d+\. /.test(line)) {
      const items: React.ReactNode[] = [];
      const startI = i;
      while (i < lines.length && /^\d+\. /.test(lines[i].trim())) {
        items.push(<li key={i}><InlineContent text={lines[i].trim().replace(/^\d+\. /, "")} /></li>);
        i++;
      }
      blocks.push(<ol key={startI} className="my-3 list-decimal space-y-1.5 pl-6 text-sm text-slate-300 leading-6">{items}</ol>);
      continue;
    }
    // Bullet list — collect consecutive items
    else if (/^[-*•] /.test(line)) {
      const items: React.ReactNode[] = [];
      const startI = i;
      while (i < lines.length && /^[-*•] /.test(lines[i].trim())) {
        items.push(<li key={i}><InlineContent text={lines[i].trim().replace(/^[-*•] /, "")} /></li>);
        i++;
      }
      blocks.push(<ul key={startI} className="my-3 list-disc space-y-1.5 pl-6 text-sm text-slate-300 leading-6">{items}</ul>);
      continue;
    }
    // Regular paragraph
    else {
      blocks.push(<p key={i} className="text-sm text-slate-300 leading-7"><InlineContent text={line} /></p>);
    }
    i++;
  }
  return <div className="space-y-1">{blocks}</div>;
}

export function AcademyLearnView({
  initialAcademy = null,
  backHref = "/academy",
  storageKey = "nexus_academy_preview",
}: LearnPageProps) {
  const [academy, setAcademy]           = useState<AcademyPackage | null>(null);
  const [missing, setMissing]           = useState(false);
  const [activeModule, setActiveModule] = useState(0);
  const [activeLesson, setActiveLesson] = useState<Lesson | null>(null);
  const [videoUrl, setVideoUrl]           = useState<string | null>(null);
  const [youtubeId, setYoutubeIdState]    = useState<string | null>(null);
  const [cloudVideoUrl, setCloudVideoUrl] = useState<string | null>(null);
  const [totalDuration, setTotalDuration] = useState(0);
  const [lessonEndTime, setLessonEndTime] = useState(0);
  const [selectedAnswers, setSelectedAnswers] = useState<number[]>([]);
  const [completedLessons, setCompletedLessons] = useState<Set<string>>(new Set());
  // Mobile: toggle between lesson list and lesson content
  const [mobileView, setMobileView] = useState<"list" | "content">("list");
  const videoRef = useRef<HTMLVideoElement>(null);

  // Build a flat ordered list of all lessons with start + end times in seconds
  function buildTimestamps(ac: AcademyPackage, knownTotalSecs: number) {
    const allLessons = ac.curriculum.flatMap((m) => m.lessons);
    const totalAiMins = allLessons.reduce((s, l) => s + l.durationMinutes, 0);
    const scale = knownTotalSecs > 0 && totalAiMins > 0 ? knownTotalSecs / (totalAiMins * 60) : 1;
    const map = new Map<string, { start: number; end: number }>();
    let cursor = 0;
    for (let i = 0; i < allLessons.length; i++) {
      const start = cursor;
      cursor += allLessons[i].durationMinutes * 60 * scale;
      const end = i < allLessons.length - 1 ? cursor : knownTotalSecs;
      map.set(allLessons[i].title, { start, end });
    }

    return map;
  }

  useEffect(() => {
    try {
      const raw = initialAcademy ? null : localStorage.getItem(storageKey);
      const parsed = initialAcademy ?? (raw ? AcademyPackageSchema.parse(JSON.parse(raw)) : null);
      if (!parsed) { setMissing(true); return; }
      setAcademy(parsed);
      setActiveLesson(parsed.curriculum[0]?.lessons[0] ?? null);
    } catch {
      setMissing(true);
    }

    getVideoObjectUrl().then((url) => {
      if (url) setVideoUrl(url);
    });

    // YouTube embed takes priority over local blob
    const ytId = getYoutubeId();
    if (ytId) setYoutubeIdState(ytId);

    // R2 / cloud URL
    const cloudUrl = getVideoUrl();
    if (cloudUrl) setCloudVideoUrl(cloudUrl);

    const meta = getVideoMeta();
    if (meta?.durationSecs) setTotalDuration(meta.durationSecs);

    const progressKey = `${storageKey}_completed_lessons`;
    const savedProgress = localStorage.getItem(progressKey);
    if (savedProgress) {
      try { setCompletedLessons(new Set(JSON.parse(savedProgress) as string[])); } catch { /* ignore */ }
    }

    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAcademy, storageKey]);

  function toggleComplete(title: string) {
    setCompletedLessons((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      localStorage.setItem(`${storageKey}_completed_lessons`, JSON.stringify([...next]));
      return next;
    });
  }

  // G: Keyboard navigation — ← / → to move between lessons, Space to mark complete
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!academy || !activeLesson) return;
      const tag = (e.target as HTMLElement).tagName;
      if (["INPUT", "TEXTAREA", "BUTTON"].includes(tag)) return;
      const flatLessons = academy.curriculum.flatMap((m) => m.lessons);
      const idx = flatLessons.findIndex((l) => l.title === activeLesson.title);
      if (e.key === "ArrowRight" && idx < flatLessons.length - 1) {
        const next = flatLessons[idx + 1];
        const mi = academy.curriculum.findIndex((m) => m.lessons.some((l) => l.title === next.title));
        setActiveModule(mi);
        setActiveLesson(next);
        setSelectedAnswers([]);
        if (videoRef.current && next.type === "video") {
          const map = buildTimestamps(academy, totalDuration);
          const seg = map.get(next.title);
          if (seg) { setLessonEndTime(seg.end); videoRef.current.currentTime = seg.start; videoRef.current.play().catch(() => {}); }
        }
      } else if (e.key === "ArrowLeft" && idx > 0) {
        const prev = flatLessons[idx - 1];
        const mi = academy.curriculum.findIndex((m) => m.lessons.some((l) => l.title === prev.title));
        setActiveModule(mi);
        setActiveLesson(prev);
        setSelectedAnswers([]);
        if (videoRef.current && prev.type === "video") {
          const map = buildTimestamps(academy, totalDuration);
          const seg = map.get(prev.title);
          if (seg) { setLessonEndTime(seg.end); videoRef.current.currentTime = seg.start; videoRef.current.play().catch(() => {}); }
        }
      } else if (e.key === " ") {
        e.preventDefault();
        toggleComplete(activeLesson.title);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [academy, activeLesson, totalDuration]);

  if (missing || !academy) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-slate-950">
        <p className="text-slate-400 text-base">
          No academy data found —{" "}
          <Link href={backHref} className="text-cyan-400 underline">go back</Link> and run the pipeline first.
        </p>
      </div>
    );
  }

  const mod = academy.curriculum[activeModule];
  const allLessons = academy.curriculum.flatMap((m) => m.lessons);
  const totalLessons = allLessons.length;
  const completedCount = completedLessons.size;
  const progressPct = totalLessons > 0 ? Math.round((completedCount / totalLessons) * 100) : 0;
  const allDone = completedCount === totalLessons && totalLessons > 0;
  const timestamps = buildTimestamps(academy, totalDuration);
  const t = getTheme(academy.themeVariant);

  function selectLesson(lesson: Lesson) {
    setActiveLesson(lesson);
    setSelectedAnswers([]);
    setMobileView("content");
    if (videoRef.current && lesson.type === "video") {
      const seg = timestamps.get(lesson.title);
      if (seg) {
        setLessonEndTime(seg.end);
        videoRef.current.currentTime = seg.start;
        videoRef.current.play().catch(() => {/* autoplay blocked */});
      }
    }
  }

  return (
    <>
    <div className={`flex min-h-dvh flex-col ${t.pageBg} ${t.heading} antialiased`}>

      {/* ── Top nav ── */}
      <nav className={`sticky top-0 z-50 border-b ${t.border} ${t.nav} backdrop-blur-xl`}>
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <Link
              href={backHref}
              className={`flex min-h-10 items-center gap-1.5 rounded-lg border ${t.cardBorder} px-3 text-sm ${t.muted} transition`}
            >
              ← Home
            </Link>
            <span className={`hidden text-base font-bold sm:block ${t.heading}`}>{academy.academyName}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className={`text-xs ${t.label}`}>{completedCount}/{totalLessons} complete</span>
            <div className={`hidden h-1.5 w-24 overflow-hidden rounded-full ${t.sectionAlt} sm:block`}>
              <div className={`h-full rounded-full ${t.accentBg} transition-all`} style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        </div>
      </nav>

      {/* E: Certificate banner — shown when all lessons are complete */}
      {allDone && (
        <div className={`border-b ${t.accentBorder} bg-gradient-to-r ${t.certGradient} px-5 py-6 text-center`}>
          <p className={`mb-2 text-[11px] font-semibold uppercase tracking-widest ${t.accentText}`}>Course Complete</p>
          <h2 className={`mb-1 text-xl font-extrabold ${t.heading}`}>
            {academy.certificateTitle || academy.academyName}
          </h2>
          <p className={`text-sm ${t.muted}`}>You have completed all {totalLessons} lessons. Congratulations.</p>
          <button
            type="button"
            onClick={() => { setCompletedLessons(new Set()); localStorage.removeItem(`${storageKey}_completed_lessons`); }}
            className={`mt-4 text-xs ${t.label} underline hover:${t.muted}`}
          >
            Reset progress
          </button>
        </div>
      )}

      <div className="mx-auto flex w-full max-w-7xl flex-1 gap-0 px-0 pb-[max(env(safe-area-inset-bottom),_1rem)] sm:gap-5 sm:px-4 sm:py-6">

        {/* ── Module sidebar ── */}
        <aside className="hidden w-64 flex-shrink-0 sm:block">
          <p className={`mb-3 px-2 text-[11px] font-semibold uppercase tracking-widest ${t.label}`}>Modules</p>
          <nav className="space-y-1">
            {academy.curriculum.map((m, mi) => (
              <button
                key={mi}
                type="button"
                onClick={() => { setActiveModule(mi); selectLesson(m.lessons[0] ?? activeLesson!); }}
                className={`flex w-full min-h-12 items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition ${
                  activeModule === mi
                    ? t.sidebarActive
                    : `${t.muted} hover:${t.card}`
                }`}
              >
                <span className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                  activeModule === mi ? t.sidebarActiveBadge : `${t.sectionAlt} ${t.label}`
                }`}>
                  {mi + 1}
                </span>
                <span className="flex-1 leading-tight">{m.moduleTitle}</span>
                <span className={`text-[11px] ${t.label}`}>
                  {m.lessons.filter((l) => completedLessons.has(l.title)).length}/{m.lessons.length}
                </span>
              </button>
            ))}
          </nav>
        </aside>

        {/* ── Content column (mobile tabs + lesson list/viewer stacked) ── */}
        <div className="flex min-w-0 flex-1 flex-col">

        {/* ── Mobile module tabs ── */}
        <div className="flex gap-2 overflow-x-auto px-4 py-3 sm:hidden">
          {academy.curriculum.map((m, mi) => (
            <button
              key={mi}
              type="button"
              onClick={() => { setActiveModule(mi); setActiveLesson(m.lessons[0] ?? null); setMobileView("list"); }}
              className={`flex-shrink-0 rounded-xl border px-4 py-2 text-sm font-medium transition ${
                activeModule === mi
                  ? `${t.accentBorder} ${t.accentBgMuted} ${t.accentText}`
                  : `${t.cardBorder} ${t.muted}`
              }`}
            >
              {mi + 1}. {m.moduleTitle}
            </button>
          ))}
        </div>

        {/* ── Lesson list + viewer ── */}
        <div className="flex min-w-0 flex-1 flex-col gap-4 px-4 sm:flex-row sm:px-0">
          <div className={`w-full sm:block sm:w-72 flex-shrink-0 ${mobileView === "content" ? "hidden" : "block"}`}>
            <p className={`mb-3 text-[11px] font-semibold uppercase tracking-widest ${t.label}`}>
              {mod.moduleTitle}
            </p>
            <p className={`mb-4 text-xs ${t.muted}`}>{mod.moduleDescription}</p>
            {mod.learningObjectives && mod.learningObjectives.length > 0 && (
              <div className={`mb-4 rounded-lg border ${t.cardBorder} ${t.sectionAlt} p-3`}>
                <p className={`mb-2 text-[11px] font-semibold uppercase tracking-widest ${t.label}`}>Learning Objectives</p>
                <ul className="space-y-1">
                  {mod.learningObjectives.map((obj, i) => (
                    <li key={i} className={`flex items-start gap-1.5 text-xs ${t.muted}`}>
                      <span className={`mt-0.5 flex-shrink-0 ${t.accentText}`}>•</span>{obj}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <ol className="space-y-1.5">
              {mod.lessons.map((lesson, li) => {
                const isActive = activeLesson?.title === lesson.title;
                return (
                  <li key={li}>
                    <button
                      type="button"
                      onClick={() => selectLesson(lesson)}
                      className={`flex w-full min-h-12 items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition ${
                        isActive ? t.lessonActive : `hover:${t.sectionAlt}`
                      }`}
                    >
                      <span className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold transition ${completedLessons.has(lesson.title) ? `${t.completeBg} ${t.completeText}` : ""}`}>
                        {completedLessons.has(lesson.title) ? "✓" : (TYPE_ICONS[lesson.type] ?? "📄")}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className={`truncate font-medium ${isActive ? t.heading : t.body}`}>
                          {lesson.title}
                        </p>
                        <p className={`text-[11px] ${t.label}`}>{lesson.durationMinutes}m</p>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>

          {/* Lesson viewer */}
          {activeLesson && (
            <div className={`flex-1 rounded-2xl border ${t.cardBorder} ${t.card} p-5 sm:block sm:p-6 ${mobileView === "list" ? "hidden" : "block"}`}>
              {/* Mobile back-to-lessons button */}
              <button
                type="button"
                onClick={() => setMobileView("list")}
                className={`mb-4 flex min-h-10 items-center gap-1.5 rounded-lg border ${t.cardBorder} px-3 text-sm ${t.muted} transition sm:hidden`}
              >
                ← Lessons
              </button>
              {/* Lesson type badge */}
              <span className={`mb-4 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1 text-xs font-semibold ${TYPE_COLORS[activeLesson.type] ?? TYPE_COLORS.reading}`}>
                {TYPE_ICONS[activeLesson.type]} {activeLesson.type}
              </span>

              <div className="mb-2 flex items-start justify-between gap-3">
                <h1 className={`text-xl font-bold sm:text-2xl ${t.heading}`}>
                  {activeLesson.title}
                </h1>
              </div>

              <p className={`mb-6 text-sm ${t.muted} leading-relaxed`}>{activeLesson.durationMinutes} min</p>

              {/* Video player */}
              {activeLesson.type === "video" && (
                <div className="mb-6 w-full overflow-hidden rounded-xl border border-slate-700/50 bg-black">
                  {youtubeId ? (
                    /* YouTube nocookie embed — no ad tracking */
                    <div className="relative aspect-video w-full">
                      <iframe
                        src={`https://www.youtube-nocookie.com/embed/${youtubeId}?rel=0&modestbranding=1&color=white`}
                        title={activeLesson.title}
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                        allowFullScreen
                        className="absolute inset-0 h-full w-full"
                      />
                    </div>
                  ) : (cloudVideoUrl || videoUrl) ? (
                    <video
                      ref={videoRef}
                      src={cloudVideoUrl ?? videoUrl ?? undefined}
                      controls
                      playsInline
                      className="w-full"
                      style={{ maxHeight: "60dvh" }}
                      onTimeUpdate={() => {
                        if (videoRef.current && lessonEndTime > 0 && videoRef.current.currentTime >= lessonEndTime) {
                          videoRef.current.pause();
                        }
                      }}
                    />
                  ) : (
                    <div className="flex aspect-video items-center justify-center text-center px-4">
                      <p className="text-sm text-slate-500">No video source — paste a YouTube URL in the pipeline or enable R2 upload.</p>
                    </div>
                  )}
                </div>
              )}

              {activeLesson.type === "quiz" && (
                <div className="mb-6 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
                  <p className="text-sm font-semibold text-amber-300">Quiz Lesson</p>
                  <p className="mt-1 text-xs text-slate-400">Test your knowledge with the questions below.</p>
                </div>
              )}

              {activeLesson.type === "exercise" && (
                <div className="mb-6 rounded-xl border border-orange-500/20 bg-orange-500/5 p-4">
                  <p className="text-sm font-semibold text-orange-300">Hands-on Exercise</p>
                  <p className="mt-1 text-xs text-slate-400">Apply what you have learned in this practical exercise.</p>
                </div>
              )}

              {/* Lesson description */}
              <p className="mb-6 text-sm text-slate-400 leading-relaxed">{activeLesson.description}</p>

              {/* F: Key takeaways + action items */}
              {activeLesson.keyTakeaways && activeLesson.keyTakeaways.length > 0 && (
                <div className={`mb-6 rounded-xl border ${t.accentBorder} ${t.accentBgMuted} p-4`}>
                  <h2 className={`mb-3 text-sm font-semibold ${t.accentText}`}>Key Takeaways</h2>
                  <ul className="space-y-2">
                    {activeLesson.keyTakeaways.map((point, i) => (
                      <li key={i} className={`flex items-start gap-2 text-sm ${t.body}`}>
                        <span className={`mt-0.5 flex-shrink-0 ${t.accentText}`}>→</span>{point}
                      </li>
                    ))}
                  </ul>
                  {activeLesson.actionItems && activeLesson.actionItems.length > 0 && (
                    <div className={`mt-4 border-t ${t.accentBorder} pt-4`}>
                      <p className={`mb-2 text-xs font-semibold uppercase tracking-widest ${t.accentText} opacity-70`}>Action Items</p>
                      <ul className="space-y-1.5">
                        {activeLesson.actionItems.map((item, i) => (
                          <li key={i} className={`flex items-start gap-2 text-sm ${t.muted}`}>
                            <span className="mt-0.5 flex-shrink-0 text-amber-400">◆</span>{item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {/* Course notes */}
              {activeLesson.notes && (
                <div className="mb-8">
                  <h2 className={`mb-4 text-base font-semibold ${t.body}`}>Course Notes</h2>
                  <MarkdownNotes text={activeLesson.notes} />
                </div>
              )}

              {/* Quiz */}
              {activeLesson.quiz && activeLesson.quiz.length > 0 && (
                <div className="mb-8">
                  <h2 className={`mb-4 text-base font-semibold ${t.body}`}>Knowledge Check</h2>
                  <ol className="space-y-6">
                    {activeLesson.quiz.map((item, qi) => {
                      const picked = selectedAnswers[qi] ?? -1;
                      const revealed = picked !== -1;
                      return (
                        <li key={qi} className={`rounded-xl border ${t.cardBorder} ${t.sectionAlt} p-5`}>
                          <p className={`mb-4 text-sm font-medium ${t.heading}`}>
                            <span className={`mr-2 ${t.label}`}>{qi + 1}.</span>{item.q}
                          </p>
                          <ol className="space-y-2">
                            {item.options.map((opt, oi) => {
                              const isCorrect = oi === item.correct;
                              const isSelected = oi === picked;
                              let cls = `${t.cardBorder} ${t.sectionAlt} ${t.body}`;
                              if (revealed && isCorrect) cls = "border-emerald-500/60 bg-emerald-500/10 text-emerald-300";
                              else if (revealed && isSelected && !isCorrect) cls = "border-red-500/60 bg-red-500/10 text-red-300";
                              return (
                                <li key={oi}>
                                  <button
                                    type="button"
                                    disabled={revealed}
                                    onClick={() => {
                                      const next = [...selectedAnswers];
                                      next[qi] = oi;
                                      setSelectedAnswers(next);
                                    }}
                                    className={`flex w-full min-h-11 items-center gap-3 rounded-lg border px-4 py-2.5 text-left text-sm transition disabled:cursor-default ${cls}`}
                                  >
                                    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border border-current text-[11px] font-bold">
                                      {String.fromCharCode(65 + oi)}
                                    </span>
                                    {opt}
                                    {revealed && isCorrect && <span className="ml-auto text-emerald-400">✓</span>}
                                    {revealed && isSelected && !isCorrect && <span className="ml-auto text-red-400">✗</span>}
                                  </button>
                                </li>
                              );
                            })}
                          </ol>
                        </li>
                      );
                    })}
                  </ol>
                  {selectedAnswers.filter((a) => a !== undefined).length === activeLesson.quiz.length && (
                    <div className={`mt-4 rounded-xl border ${t.cardBorder} ${t.sectionAlt} p-4 text-center`}>
                      <p className={`text-sm font-semibold ${t.heading}`}>
                        Score: {activeLesson.quiz.filter((item, qi) => selectedAnswers[qi] === item.correct).length} / {activeLesson.quiz.length}
                      </p>
                      <button
                        type="button"
                        onClick={() => setSelectedAnswers([])}
                        className={`mt-2 text-xs ${t.accentText} underline`}
                      >
                        Retry
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Key terms glossary for this module */}
              {mod.keyTerms && mod.keyTerms.length > 0 && (
                <div className="mb-6">
                  <h2 className={`mb-3 text-base font-semibold ${t.body}`}>Glossary</h2>
                  <dl className="space-y-2">
                    {mod.keyTerms.map((kt, i) => (
                      <div key={i} className={`rounded-lg border ${t.cardBorder} ${t.sectionAlt} px-4 py-2.5`}>
                        <dt className={`text-sm font-semibold ${t.heading}`}>{kt.term}</dt>
                        <dd className={`mt-0.5 text-xs ${t.muted}`}>{kt.definition}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}

              {/* D: Complete + Next */}
              <div className="mt-8 space-y-3">
                <button
                  type="button"
                  onClick={() => toggleComplete(activeLesson.title)}
                  className={`flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border text-sm font-semibold transition ${
                    completedLessons.has(activeLesson.title)
                      ? `${t.completeText} ${t.completeBg} border-current/40`
                      : `border ${t.cardBorder} ${t.sectionAlt} ${t.body} hover:${t.accentBorder} hover:${t.accentText}`
                  }`}
                >
                  {completedLessons.has(activeLesson.title) ? "✓ Completed" : "Mark as complete"}
                </button>
                {(() => {
                  const lessons = mod.lessons;
                  const idx = lessons.findIndex((l) => l.title === activeLesson.title);
                  const next = lessons[idx + 1];
                  if (!next) return null;
                  return (
                    <button
                      type="button"
                      onClick={() => selectLesson(next)}
                      className={`flex min-h-12 w-full items-center justify-between rounded-xl border ${t.cardBorder} px-4 text-sm ${t.body} transition hover:border-opacity-80 hover:${t.sectionAlt}`}
                    >
                      <span className={t.label}>Next lesson</span>
                      <span className="font-medium">{next.title} →</span>
                    </button>
                  );
                })()}
              </div>
            </div>
          )}
        </div>
        </div>{/* end content column */}
      </div>
    </div>

    </>
  );
}
export default function LearnPage() {
  return <AcademyLearnView />;
}
