"use client";

import { useState, useMemo, useCallback } from "react";
import { ProseEditor } from "@/app/components/ProseEditor";
import type { EbookManifest, ChapterDraft, FrontBackMatter, BackMatter } from "@/lib/schemas/ebook";

type Props = {
  manifest: EbookManifest;
  onChange: (updated: EbookManifest) => void;
};

type Section = "metadata" | "front" | "chapter" | "back";

export function ManuscriptEditor({ manifest, onChange }: Props) {
  const [activeSection, setActiveSection] = useState<Section>("metadata");
  const [activeChapter, setActiveChapter] = useState<number>(1);
  const [activeSectionNum, setActiveSectionNum] = useState<number>(1);

  const currentChapter = useMemo(
    () => manifest.chapters.find((c) => c.number === activeChapter),
    [manifest.chapters, activeChapter]
  );

  const currentSection = useMemo(
    () => currentChapter?.sections.find((s) => s.sectionNumber === activeSectionNum),
    [currentChapter, activeSectionNum]
  );

  const updateMetadata = useCallback((field: keyof Pick<EbookManifest, "bookTitle" | "subtitle" | "authorName">, value: string) => {
    onChange({ ...manifest, [field]: value });
  }, [manifest, onChange]);

  const updateFrontMatter = useCallback((field: keyof FrontBackMatter, value: string | string[] | null) => {
    onChange({
      ...manifest,
      frontMatter: { ...manifest.frontMatter, [field]: value },
    });
  }, [manifest, onChange]);

  const updateChapter = useCallback((chapterNum: number, field: keyof ChapterDraft, value: unknown) => {
    onChange({
      ...manifest,
      chapters: manifest.chapters.map((c) =>
        c.number === chapterNum ? { ...c, [field]: value } : c
      ),
    });
  }, [manifest, onChange]);

  const updateChapterSection = useCallback((chapterNum: number, sectionNum: number, body: string) => {
    onChange({
      ...manifest,
      chapters: manifest.chapters.map((c) =>
        c.number === chapterNum
          ? {
              ...c,
              sections: c.sections.map((s) =>
                s.sectionNumber === sectionNum ? { ...s, body } : s
              ),
            }
          : c
      ),
    });
  }, [manifest, onChange]);

  const updateBackMatter = useCallback((field: keyof BackMatter, value: unknown) => {
    onChange({
      ...manifest,
      backMatter: manifest.backMatter
        ? { ...manifest.backMatter, [field]: value }
        : { scriptureIndex: [], glossary: [], readingGroupGuide: [], recommendedResources: [], [field]: value },
    });
  }, [manifest, onChange]);

  const addManualChapter = useCallback(() => {
    const newChapterNum = manifest.chapters.length + 1;
    const newChapter: ChapterDraft = {
      number: newChapterNum,
      title: `Chapter ${newChapterNum}`,
      intro: "",
      epigraph: "",
      sections: [
        {
          chapterNumber: newChapterNum,
          sectionNumber: 1,
          heading: "Section 1",
          body: "",
          wordCount: 0,
          status: "complete",
        },
      ],
      forwardQuestion: "",
      keyTakeaways: [],
      reflectionQuestions: [],
      totalWordCount: 0,
      status: "complete",
    };
    onChange({
      ...manifest,
      chapters: [...manifest.chapters, newChapter],
    });
    setActiveChapter(newChapterNum);
    setActiveSection("chapter");
  }, [manifest, onChange]);

  const addManualSection = useCallback(() => {
    if (!currentChapter) return;
    const newSectionNum = currentChapter.sections.length + 1;
    onChange({
      ...manifest,
      chapters: manifest.chapters.map((c) =>
        c.number === activeChapter
          ? {
              ...c,
              sections: [
                ...c.sections,
                {
                  chapterNumber: activeChapter,
                  sectionNumber: newSectionNum,
                  heading: `Section ${newSectionNum}`,
                  body: "",
                  wordCount: 0,
                  status: "complete",
                },
              ],
            }
          : c
      ),
    });
    setActiveSectionNum(newSectionNum);
  }, [manifest, onChange, currentChapter, activeChapter]);

  const deleteChapter = useCallback((chapterNum: number) => {
    if (!window.confirm(`Delete Chapter ${chapterNum}? This cannot be undone.`)) return;
    onChange({
      ...manifest,
      chapters: manifest.chapters
        .filter((c) => c.number !== chapterNum)
        .map((c, index) => ({ ...c, number: index + 1 })),
    });
    setActiveChapter(Math.max(1, chapterNum - 1));
  }, [manifest, onChange]);

  const deleteSection = useCallback(() => {
    if (!currentChapter || !currentSection) return;
    if (!window.confirm(`Delete "${currentSection.heading}"? This cannot be undone.`)) return;
    onChange({
      ...manifest,
      chapters: manifest.chapters.map((c) =>
        c.number === activeChapter
          ? {
              ...c,
              sections: c.sections
                .filter((s) => s.sectionNumber !== activeSectionNum)
                .map((s, index) => ({ ...s, sectionNumber: index + 1 })),
            }
          : c
      ),
    });
    setActiveSectionNum(Math.max(1, activeSectionNum - 1));
  }, [manifest, onChange, currentChapter, activeChapter, currentSection, activeSectionNum]);

  return (
    <div className="space-y-4">
      {/* Section selector tabs */}
      <div className="flex gap-2 overflow-x-auto pb-2">
        {(["metadata", "front", "chapter", "back"] as const).map((section) => (
          <button
            key={section}
            type="button"
            onClick={() => setActiveSection(section)}
            className={[
              "min-h-[44px] shrink-0 rounded-xl border px-4 text-sm font-semibold transition",
              activeSection === section
                ? "border-cyan-400/50 bg-cyan-500/15 text-cyan-200"
                : "border-slate-700/60 bg-slate-900/60 text-slate-400 hover:text-slate-200",
            ].join(" ")}
          >
            {section === "metadata" && "Book Info"}
            {section === "front" && "Front Matter"}
            {section === "chapter" && "Chapters"}
            {section === "back" && "Back Matter"}
          </button>
        ))}
      </div>

      {/* Metadata section */}
      {activeSection === "metadata" && (
        <div className="space-y-4 rounded-xl border border-slate-700/50 bg-slate-900/40 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-cyan-300">Book Metadata</h3>
          
          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-500">
              Book Title
            </label>
            <input
              type="text"
              value={manifest.bookTitle}
              onChange={(e) => updateMetadata("bookTitle", e.target.value)}
              className="w-full min-h-[48px] rounded-xl border border-slate-700/60 bg-slate-950/70 px-3 py-2 text-base text-slate-100 outline-none focus:border-cyan-500/40"
            />
          </div>

          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-500">
              Subtitle
            </label>
            <input
              type="text"
              value={manifest.subtitle}
              onChange={(e) => updateMetadata("subtitle", e.target.value)}
              className="w-full min-h-[48px] rounded-xl border border-slate-700/60 bg-slate-950/70 px-3 py-2 text-base text-slate-100 outline-none focus:border-cyan-500/40"
            />
          </div>

          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-500">
              Author Name
            </label>
            <input
              type="text"
              value={manifest.authorName}
              onChange={(e) => updateMetadata("authorName", e.target.value)}
              className="w-full min-h-[48px] rounded-xl border border-slate-700/60 bg-slate-950/70 px-3 py-2 text-base text-slate-100 outline-none focus:border-cyan-500/40"
            />
          </div>
        </div>
      )}

      {/* Front Matter section */}
      {activeSection === "front" && (
        <div className="space-y-4 rounded-xl border border-slate-700/50 bg-slate-900/40 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-cyan-300">Front Matter</h3>
          
          <ProseEditor
            label="Preface"
            value={manifest.frontMatter.preface}
            onChange={(value) => updateFrontMatter("preface", value)}
            rows={8}
          />

          <ProseEditor
            label="Introduction"
            value={manifest.frontMatter.introduction}
            onChange={(value) => updateFrontMatter("introduction", value)}
            rows={10}
          />

          <ProseEditor
            label="Conclusion"
            value={manifest.frontMatter.conclusion}
            onChange={(value) => updateFrontMatter("conclusion", value)}
            rows={10}
          />

          <ProseEditor
            label="About the Author"
            value={manifest.frontMatter.aboutAuthor ?? ""}
            onChange={(value) => updateFrontMatter("aboutAuthor", value || null)}
            rows={8}
          />

          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-500">
              Resources List
            </label>
            <textarea
              value={manifest.frontMatter.resourcesList?.join("\n") ?? ""}
              onChange={(e) => updateFrontMatter("resourcesList", e.target.value.split("\n").filter(Boolean))}
              rows={5}
              placeholder="One resource per line..."
              className="w-full rounded-xl border border-slate-700/60 bg-slate-950/70 px-3 py-2 text-base text-slate-100 outline-none focus:border-cyan-500/40"
            />
          </div>
        </div>
      )}

      {/* Chapter section */}
      {activeSection === "chapter" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            <select
              value={activeChapter}
              onChange={(e) => {
                setActiveChapter(Number(e.target.value));
                setActiveSectionNum(1);
              }}
              className="min-h-[48px] flex-1 rounded-xl border border-slate-700/60 bg-slate-950/70 px-3 py-2 text-base text-slate-100 outline-none focus:border-cyan-500/40"
            >
              {manifest.chapters.map((ch) => (
                <option key={ch.number} value={ch.number}>
                  Chapter {ch.number}: {ch.title}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={addManualChapter}
              className="min-h-[48px] shrink-0 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 text-sm font-semibold text-emerald-300 hover:bg-emerald-500/20"
            >
              + Add Chapter
            </button>
          </div>

          {currentChapter && (
            <div className="space-y-4 rounded-xl border border-slate-700/50 bg-slate-900/40 p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-cyan-300">
                  Chapter {currentChapter.number}
                </h3>
                <button
                  type="button"
                  onClick={() => deleteChapter(currentChapter.number)}
                  className="min-h-[36px] rounded-lg border border-red-500/40 bg-red-500/10 px-3 text-xs font-semibold text-red-300 hover:bg-red-500/20"
                >
                  Delete Chapter
                </button>
              </div>

              <div>
                <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-500">
                  Chapter Title
                </label>
                <input
                  type="text"
                  value={currentChapter.title}
                  onChange={(e) => updateChapter(currentChapter.number, "title", e.target.value)}
                  className="w-full min-h-[48px] rounded-xl border border-slate-700/60 bg-slate-950/70 px-3 py-2 text-base text-slate-100 outline-none focus:border-cyan-500/40"
                />
              </div>

              <ProseEditor
                label="Chapter Intro (opening statement)"
                value={currentChapter.intro}
                onChange={(value) => updateChapter(currentChapter.number, "intro", value)}
                rows={4}
              />

              <ProseEditor
                label="Epigraph (opening scripture/quote)"
                value={currentChapter.epigraph}
                onChange={(value) => updateChapter(currentChapter.number, "epigraph", value)}
                rows={3}
              />

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500">
                    Sections ({currentChapter.sections.length})
                  </label>
                  <button
                    type="button"
                    onClick={addManualSection}
                    className="min-h-[36px] rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20"
                  >
                    + Add Section
                  </button>
                </div>

                <select
                  value={activeSectionNum}
                  onChange={(e) => setActiveSectionNum(Number(e.target.value))}
                  className="mb-3 w-full min-h-[48px] rounded-xl border border-slate-700/60 bg-slate-950/70 px-3 py-2 text-base text-slate-100 outline-none focus:border-cyan-500/40"
                >
                  {currentChapter.sections.map((s) => (
                    <option key={s.sectionNumber} value={s.sectionNumber}>
                      § {s.sectionNumber}: {s.heading}
                    </option>
                  ))}
                </select>

                {currentSection && (
                  <div className="space-y-3 rounded-xl border border-violet-500/20 bg-slate-950/40 p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-violet-300">
                        Section {currentSection.sectionNumber}
                      </span>
                      <button
                        type="button"
                        onClick={deleteSection}
                        className="min-h-[36px] rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 text-xs font-semibold text-red-300 hover:bg-red-500/20"
                      >
                        Delete
                      </button>
                    </div>

                    <div>
                      <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-500">
                        Section Heading
                      </label>
                      <input
                        type="text"
                        value={currentSection.heading}
                        onChange={(e) => {
                          onChange({
                            ...manifest,
                            chapters: manifest.chapters.map((c) =>
                              c.number === activeChapter
                                ? {
                                    ...c,
                                    sections: c.sections.map((s) =>
                                      s.sectionNumber === activeSectionNum
                                        ? { ...s, heading: e.target.value }
                                        : s
                                    ),
                                  }
                                : c
                            ),
                          });
                        }}
                        className="w-full min-h-[48px] rounded-xl border border-slate-700/60 bg-slate-950/70 px-3 py-2 text-base text-slate-100 outline-none focus:border-cyan-500/40"
                      />
                    </div>

                    <ProseEditor
                      label="Section Body"
                      value={currentSection.body}
                      onChange={(value) => updateChapterSection(activeChapter, activeSectionNum, value)}
                      rows={16}
                    />
                  </div>
                )}
              </div>

              <ProseEditor
                label="Forward Question (bridge to next chapter)"
                value={currentChapter.forwardQuestion}
                onChange={(value) => updateChapter(currentChapter.number, "forwardQuestion", value)}
                rows={2}
              />

              <div>
                <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-500">
                  Key Takeaways
                </label>
                <textarea
                  value={currentChapter.keyTakeaways?.join("\n") ?? ""}
                  onChange={(e) =>
                    updateChapter(
                      currentChapter.number,
                      "keyTakeaways",
                      e.target.value.split("\n").filter(Boolean)
                    )
                  }
                  rows={4}
                  placeholder="One takeaway per line..."
                  className="w-full rounded-xl border border-slate-700/60 bg-slate-950/70 px-3 py-2 text-base text-slate-100 outline-none focus:border-cyan-500/40"
                />
              </div>

              <div>
                <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-500">
                  Reflection Questions
                </label>
                <textarea
                  value={currentChapter.reflectionQuestions?.join("\n") ?? ""}
                  onChange={(e) =>
                    updateChapter(
                      currentChapter.number,
                      "reflectionQuestions",
                      e.target.value.split("\n").filter(Boolean)
                    )
                  }
                  rows={4}
                  placeholder="One question per line..."
                  className="w-full rounded-xl border border-slate-700/60 bg-slate-950/70 px-3 py-2 text-base text-slate-100 outline-none focus:border-cyan-500/40"
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Back Matter section */}
      {activeSection === "back" && (
        <div className="space-y-4 rounded-xl border border-slate-700/50 bg-slate-900/40 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-cyan-300">Back Matter</h3>
          
          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-500">
              Recommended Resources
            </label>
            <textarea
              value={manifest.backMatter?.recommendedResources?.join("\n") ?? ""}
              onChange={(e) => updateBackMatter("recommendedResources", e.target.value.split("\n").filter(Boolean))}
              rows={6}
              placeholder="One resource per line..."
              className="w-full rounded-xl border border-slate-700/60 bg-slate-950/70 px-3 py-2 text-base text-slate-100 outline-none focus:border-cyan-500/40"
            />
          </div>

          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-500">
              Glossary Terms (JSON format)
            </label>
            <textarea
              value={JSON.stringify(manifest.backMatter?.glossary ?? [], null, 2)}
              onChange={(e) => {
                try {
                  const parsed = JSON.parse(e.target.value);
                  updateBackMatter("glossary", parsed);
                } catch {
                  // Invalid JSON - don't update
                }
              }}
              rows={8}
              placeholder='[{"term":"","definition":"","firstAppearance":""}]'
              className="w-full rounded-xl border border-slate-700/60 bg-slate-950/70 px-3 py-2 font-mono text-sm text-slate-100 outline-none focus:border-cyan-500/40"
            />
          </div>

          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-500">
              Study Questions by Chapter (JSON format)
            </label>
            <textarea
              value={JSON.stringify(manifest.backMatter?.readingGroupGuide ?? [], null, 2)}
              onChange={(e) => {
                try {
                  updateBackMatter("readingGroupGuide", JSON.parse(e.target.value));
                } catch {
                  // Invalid JSON - don't update
                }
              }}
              rows={8}
              placeholder='[{"chapterNumber":1,"chapterTitle":"","questions":[]}]'
              className="w-full rounded-xl border border-slate-700/60 bg-slate-950/70 px-3 py-2 font-mono text-base text-slate-100 outline-none focus:border-cyan-500/40"
            />
          </div>

          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-slate-500">
              Index of Scripture (JSON format)
            </label>
            <textarea
              value={JSON.stringify(manifest.backMatter?.scriptureIndex ?? [], null, 2)}
              onChange={(e) => {
                try {
                  updateBackMatter("scriptureIndex", JSON.parse(e.target.value));
                } catch {
                  // Invalid JSON - don't update
                }
              }}
              rows={8}
              placeholder='[{"reference":"","translation":"","chapters":[]}]'
              className="w-full rounded-xl border border-slate-700/60 bg-slate-950/70 px-3 py-2 font-mono text-base text-slate-100 outline-none focus:border-cyan-500/40"
            />
          </div>
        </div>
      )}
    </div>
  );
}
