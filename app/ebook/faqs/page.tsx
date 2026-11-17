import { redirect } from "next/navigation";

export default function DirectorFaqsRedirect() {
  redirect("/ebook/library?section=faqs");
}
