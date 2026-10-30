import { z } from "zod";
import {
  BackMatterSchema,
  FrontBackMatterSchema,
  type BackMatter,
  type FrontBackMatter,
} from "@/lib/schemas/ebook";

export const NexusLMFrontMatterFieldsSchema = FrontBackMatterSchema.pick({
  preface: true,
  introduction: true,
  conclusion: true,
  aboutAuthor: true,
  resourcesList: true,
});

export const NexusLMBackMatterFieldsSchema = BackMatterSchema.pick({
  scriptureIndex: true,
  glossary: true,
  readingGroupGuide: true,
  recommendedResources: true,
});

export type NexusLMFrontMatterFields = z.infer<typeof NexusLMFrontMatterFieldsSchema>;
export type NexusLMBackMatterFields = z.infer<typeof NexusLMBackMatterFieldsSchema>;

export type NexusLMMatterFields =
  | { kind: "frontMatter"; fields: NexusLMFrontMatterFields }
  | { kind: "backMatter"; fields: NexusLMBackMatterFields };

export function formatNexusLMFrontMatter(fields: NexusLMFrontMatterFields): string {
  return [
    `## Preface\n\n${fields.preface}`,
    `## Introduction\n\n${fields.introduction}`,
    `## Conclusion\n\n${fields.conclusion}`,
    `## About the Author\n\n${fields.aboutAuthor ?? ""}`,
    `## Resources List\n\n${fields.resourcesList.map((item) => `- ${item}`).join("\n")}`,
  ].join("\n\n");
}

export function formatNexusLMBackMatter(fields: NexusLMBackMatterFields): string {
  return [
    `## Study Questions\n\n${fields.readingGroupGuide.map((chapter) => [
      `### Chapter ${chapter.chapterNumber}: ${chapter.chapterTitle}`,
      ...chapter.questions.map((question, index) => `${index + 1}. ${question}`),
    ].join("\n")).join("\n\n")}`,
    `## Glossary\n\n${fields.glossary.map((entry) => `- **${entry.term}:** ${entry.definition} _(${entry.firstAppearance})_`).join("\n")}`,
    `## Index of Scripture\n\n${fields.scriptureIndex.map((entry) => `- ${entry.reference} (${entry.translation}) — Ch. ${entry.chapters.join(", ")}`).join("\n")}`,
    `## Recommended Resources\n\n${fields.recommendedResources.map((item) => `- ${item}`).join("\n")}`,
  ].join("\n\n");
}

export function applyNexusLMFrontMatter(
  existing: FrontBackMatter,
  generated: NexusLMFrontMatterFields,
): FrontBackMatter {
  return { ...existing, ...generated };
}

export function applyNexusLMBackMatter(
  existing: BackMatter | null | undefined,
  generated: NexusLMBackMatterFields,
): BackMatter {
  return {
    ...generated,
    ...(existing?.additionalSections ? { additionalSections: existing.additionalSections } : {}),
  };
}
