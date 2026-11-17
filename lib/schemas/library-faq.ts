import { z } from "zod";

export const LibraryFaqSourceSchema = z.object({
  ref: z.string().min(1).max(64),
  kind: z.enum(["book", "video"]),
  title: z.string().min(1).max(300),
  excerpt: z.string().max(3000),
  href: z.string().max(2000).refine((value) =>
    value.startsWith("/library/")
    || /^https:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//.test(value),
  ),
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/).optional(),
  startSeconds: z.number().finite().min(0).optional(),
  endSeconds: z.number().finite().min(0).optional(),
}).strict();

export const LibraryFaqSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
  category: z.string().trim().min(1).max(80),
  question: z.string().trim().min(4).max(300),
  answer: z.string().trim().min(1).max(20000),
  sources: z.array(LibraryFaqSourceSchema).min(1).max(12),
  updatedAt: z.string().datetime(),
  publishedAt: z.string().datetime(),
}).strict();

export const LibraryFaqCatalogSchema = z.object({
  updatedAt: z.string().datetime(),
  faqs: z.array(LibraryFaqSchema).max(100),
}).strict();

export const DirectorFaqSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
  category: z.string().trim().min(1).max(80),
  question: z.string().trim().min(4).max(300),
  answer: z.string().trim().max(20000).optional(),
  sources: z.array(LibraryFaqSourceSchema).max(12).default([]),
  status: z.enum(["draft", "published"]),
  updatedAt: z.string().datetime(),
}).strict();

export const DirectorFaqCatalogSchema = z.object({
  updatedAt: z.string().datetime(),
  faqs: z.array(DirectorFaqSchema).max(100),
}).strict();

export const STARTER_FAQS = [
  { id: "faith", category: "Faith", question: "What does it mean to live by faith when I cannot see what God is doing?" },
  { id: "healing", category: "Healing", question: "What do these teachings say about healing, and how should I respond when healing has not come?" },
  { id: "prayer", category: "Prayer", question: "How can I pray effectively and keep praying when nothing seems to change?" },
  { id: "identity-in-christ", category: "Who we are in Christ", question: "Who am I in Christ, and how should that identity shape my daily life?" },
  { id: "love", category: "Love", question: "What does it mean to love God and other people in practical, difficult situations?" },
  { id: "sin", category: "Sin", question: "What is sin, and how should a believer respond after falling into sin?" },
  { id: "holiness", category: "Holiness", question: "What does it mean to live a holy life without relying on outward appearances?" },
  { id: "salvation", category: "Salvation", question: "How can I understand salvation, grace, and the place of faith?" },
  { id: "forgiveness", category: "Forgiveness", question: "How can I receive God's forgiveness and forgive someone who has hurt me?" },
  { id: "righteousness", category: "Righteousness", question: "What does righteousness mean, and how does it affect my relationship with God?" },
  { id: "holy-spirit", category: "The Holy Spirit", question: "How does the Holy Spirit guide and strengthen a believer?" },
  { id: "suffering", category: "Suffering and trials", question: "How can I trust God and remain faithful during suffering and difficult trials?" },
  { id: "purpose", category: "Purpose and calling", question: "How can I discern God's purpose and direction for my life?" },
  { id: "spiritual-growth", category: "Spiritual growth", question: "How can I grow spiritually and build a consistent life with God?" },
  { id: "trusting-god", category: "Trusting God", question: "How do I trust God when I feel uncertain, discouraged, or unable to hear Him?" },
] as const;
