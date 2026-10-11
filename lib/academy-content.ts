import type { AcademyPackage } from "@/lib/schemas/academy";

const REPORTING_PREFIX = /^\s*(?:according to|as|the)\s+(?:speaker|transcript|source|material)\s+(?:(?:said|says|explains?|describes?|mentions?|notes?|argues?|states?|teaches?)\s*:?\s*|,\s*)/i;

export function directLearnerText(value: string): string {
  return value
    .replace(REPORTING_PREFIX, "")
    .replace(/\bthe speaker (?:said|says|explains?|describes?|mentions?|notes?|argues?|states?|teaches?)\b[:,]?\s*/gi, "")
    .replace(/\bthe transcript (?:says|explains?|describes?|mentions?|notes?|states?|teaches?)\b[:,]?\s*/gi, "")
    .replace(/\bthe source (?:says|explains?|describes?|mentions?|notes?|states?|teaches?)\b[:,]?\s*/gi, "")
    .replace(/\bthe material (?:says|explains?|describes?|mentions?|notes?|states?|teaches?)\b[:,]?\s*/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function normalizeAcademyLearnerVoice(academy: AcademyPackage): AcademyPackage {
  return {
    ...academy,
    tagline: directLearnerText(academy.tagline),
    targetAudience: directLearnerText(academy.targetAudience),
    landingPage: {
      ...academy.landingPage,
      headline: directLearnerText(academy.landingPage.headline),
      subheadline: directLearnerText(academy.landingPage.subheadline),
      problemStatement: directLearnerText(academy.landingPage.problemStatement),
      cta: directLearnerText(academy.landingPage.cta),
      features: academy.landingPage.features.map((feature) => ({
        title: directLearnerText(feature.title),
        description: directLearnerText(feature.description),
      })),
    },
    pricing: academy.pricing.map((tier) => ({
      ...tier,
      features: tier.features.map(directLearnerText),
    })),
    curriculum: academy.curriculum.map((module) => ({
      ...module,
      moduleDescription: directLearnerText(module.moduleDescription),
      learningObjectives: module.learningObjectives.map(directLearnerText),
      keyTerms: module.keyTerms.map((term) => ({
        term: directLearnerText(term.term),
        definition: directLearnerText(term.definition),
      })),
      lessons: module.lessons.map((lesson) => ({
        ...lesson,
        description: directLearnerText(lesson.description),
        notes: directLearnerText(lesson.notes),
        keyTakeaways: lesson.keyTakeaways.map(directLearnerText),
        actionItems: lesson.actionItems.map(directLearnerText),
        quiz: lesson.quiz.map((item) => ({
          ...item,
          q: directLearnerText(item.q),
          options: item.options.map(directLearnerText),
        })),
      })),
    })),
    seoMeta: {
      ...academy.seoMeta,
      description: directLearnerText(academy.seoMeta.description),
      keywords: academy.seoMeta.keywords.map(directLearnerText),
    },
    onboardingSteps: academy.onboardingSteps.map(directLearnerText),
  };
}

export function enforceAcademyMediaCapabilities(
  academy: AcademyPackage,
  hasVideoSource: boolean,
): AcademyPackage {
  return {
    ...academy,
    sourceCapabilities: { hasVideo: hasVideoSource },
    curriculum: academy.curriculum.map((module) => ({
      ...module,
      lessons: module.lessons.map((lesson) => (
        !hasVideoSource && lesson.type === "video"
          ? { ...lesson, type: "reading" as const }
          : lesson
      )),
    })),
  };
}
