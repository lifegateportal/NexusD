import DirectorLibraryWorkspace from "./DirectorLibraryWorkspace";
import { readLibraryBranding } from "@/lib/library-branding-store";

export const metadata = {
  title: "Library Studio | Nexus Director",
  description: "Manage FAQs, published video content, and the video studio from one Library workspace.",
};

export default async function DirectorLibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>;
}) {
  const { section } = await searchParams;
  const initialSection = section === "videos" || section === "appearance" ? section : "faqs";
  const initialBranding = await readLibraryBranding();
  return <DirectorLibraryWorkspace initialSection={initialSection} initialBranding={initialBranding} />;
}
