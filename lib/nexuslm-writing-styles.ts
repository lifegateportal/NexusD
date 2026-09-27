import { z } from "zod";

export const NexusLMWritingStyleSchema = z.enum([
  "book-prose",
  "novel",
  "devotional",
  "academic",
  "blog",
  "sermon",
  "memoir",
  "study-guide",
  "newsletter",
  "screenplay",
  "course-lesson",
  "research-brief",
]);

export type NexusLMWritingStyle = z.infer<typeof NexusLMWritingStyleSchema>;

export const NEXUSLM_WRITING_STYLES: Record<NexusLMWritingStyle, { label: string; description: string; instruction: string }> = {
  "book-prose": {
    label: "Book prose",
    description: "Clear, polished manuscript prose",
    instruction: "Write as polished nonfiction book prose with a clear through-line, developed paragraphs, and an intentional beginning and ending.",
  },
  novel: {
    label: "Novel",
    description: "Scene, character, atmosphere, and story",
    instruction: "Write as literary fiction only when the supplied sources support it: use scene, sensory detail, character perspective, tension, and concrete moments. Do not invent people, events, or quotations that are not supported by the sources; when the request is nonfiction, use a narrative nonfiction approach instead.",
  },
  devotional: {
    label: "Devotional",
    description: "Reflection, Scripture, prayer, and practice",
    instruction: "Write as a devotional with a focused reflection, careful use of supplied Scripture or source material, a personal application, and a brief closing prayer or practice only when appropriate. Do not fabricate biblical quotations or references.",
  },
  academic: {
    label: "Academic publication",
    description: "Thesis, evidence, definitions, and limitations",
    instruction: "Write as an academic publication section with a precise thesis, explicit definitions, logical headings, evidence-aware claims, limitations, and formal language. Do not invent citations, sources, data, or peer-review claims.",
  },
  blog: {
    label: "Blog article",
    description: "Web-ready, scannable, and accessible",
    instruction: "Write as a publishable blog article with a strong title, a concise opening, descriptive headings, short readable paragraphs, practical takeaways, and a natural closing. Keep the author's substance and do not add unsupported claims.",
  },
  sermon: {
    label: "Sermon",
    description: "Preaching movement and congregational application",
    instruction: "Write as a sermon manuscript with a clear big idea, memorable movement, Scripture handled accurately from the supplied sources, transitions, illustrations only when sourced, and a grounded congregational application.",
  },
  memoir: {
    label: "Memoir",
    description: "Personal memory and meaning",
    instruction: "Write as memoir with a specific lived moment, honest reflection, sensory detail, and a meaningful change in understanding. Preserve the author's perspective and never invent autobiographical facts.",
  },
  "study-guide": {
    label: "Study guide",
    description: "Objectives, teaching notes, and questions",
    instruction: "Write as a study guide with a concise overview, learning objectives, organized teaching points, source-grounded notes, discussion questions, and a practical exercise when supported.",
  },
  newsletter: {
    label: "Newsletter",
    description: "Warm, direct, and action-oriented",
    instruction: "Write as an email newsletter with a compelling subject-style heading, a personal but focused opening, one central insight, useful action steps, and a concise closing invitation.",
  },
  screenplay: {
    label: "Screenplay",
    description: "Visual beats, dialogue, and scene movement",
    instruction: "Write in screenplay form with scene headings, visible action, economical dialogue, and clear beats. Use only characters, events, and ideas supported by the sources; do not manufacture dialogue and present nonfiction material as documentary-style scenes when needed.",
  },
  "course-lesson": {
    label: "Course lesson",
    description: "Teach, practice, and check understanding",
    instruction: "Write as a course lesson with a learning outcome, brief explanation, ordered teaching steps, an example grounded in the sources, a practice activity, and a check for understanding.",
  },
  "research-brief": {
    label: "Research brief",
    description: "Decision-ready findings and implications",
    instruction: "Write as a research brief with an executive summary, question, findings grounded in supplied material, implications, uncertainties, and next steps. Do not present interpretation as measured data or invent references.",
  },
};
