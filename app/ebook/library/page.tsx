import DirectorLibraryWorkspace from "./DirectorLibraryWorkspace";

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
  const initialSection = section === "videos" ? "videos" : "faqs";
  return <DirectorLibraryWorkspace initialSection={initialSection} />;
}
