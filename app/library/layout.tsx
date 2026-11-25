// Library uses the root layout (minimal html/body shell) — no extra wrapper needed.
// This file exists to set library-specific metadata.
import type { Metadata } from "next";
import { readLibraryBranding } from "@/lib/library-branding-store";

export async function generateMetadata(): Promise<Metadata> {
  const branding = await readLibraryBranding();
  return {
    title: `${branding.title} (${branding.shortName})`,
    description: branding.description,
  };
}

export default function LibraryLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
