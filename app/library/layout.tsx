// Library uses the root layout (minimal html/body shell) — no extra wrapper needed.
// This file exists to set library-specific metadata.
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pastor Josh Digital Library (PJDL)",
  description: "Published books from Nexus Director",
};

export default function LibraryLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
