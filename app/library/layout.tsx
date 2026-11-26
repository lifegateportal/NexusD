// Library uses the root layout (minimal html/body shell) — no extra wrapper needed.
// This file exists to set library-specific metadata.
import type { Metadata } from "next";
import { readLibraryBranding } from "@/lib/library-branding-store";
import type { CSSProperties } from "react";
import LibraryTrafficTracker from "./LibraryTrafficTracker";

const ACCENT_RGB = {
  amber: "251 191 36",
  cyan: "34 211 238",
  emerald: "52 211 153",
  rose: "251 113 133",
  violet: "167 139 250",
} as const;

const ACCENT_TEXT = {
  dark: {
    amber: "#fbbf24",
    cyan: "#67e8f9",
    emerald: "#6ee7b7",
    rose: "#fda4af",
    violet: "#c4b5fd",
  },
  light: {
    amber: "#92400e",
    cyan: "#0e7490",
    emerald: "#047857",
    rose: "#be123c",
    violet: "#6d28d9",
  },
} as const;

export async function generateMetadata(): Promise<Metadata> {
  const branding = await readLibraryBranding();
  return {
    title: `${branding.title} (${branding.shortName})`,
    description: branding.description,
  };
}

export default async function LibraryLayout({ children }: { children: React.ReactNode }) {
  const branding = await readLibraryBranding();
  const style = {
    "--pjdl-accent-rgb": ACCENT_RGB[branding.accentColor],
    "--pjdl-accent-text": ACCENT_TEXT[branding.colorMode][branding.accentColor],
  } as CSSProperties;

  return (
    <div
      data-pjdl-library
      data-pjdl-mode={branding.colorMode}
      data-pjdl-accent={branding.accentColor}
      style={style}
      className="min-h-dvh"
    >
      <LibraryTrafficTracker />
      {children}
    </div>
  );
}
