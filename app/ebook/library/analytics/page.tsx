import type { Metadata } from "next";
import LibraryTrafficDashboard from "./LibraryTrafficDashboard";

export const metadata: Metadata = {
  title: "Library Traffic | Nexus Director",
  description: "View anonymous traffic statistics for the public Pastor Josh Digital Library.",
};

export default function LibraryTrafficPage() {
  return <LibraryTrafficDashboard />;
}
