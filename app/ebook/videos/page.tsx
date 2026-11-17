import { redirect } from "next/navigation";

export default function DirectorVideosRedirect() {
  redirect("/ebook/library?section=videos");
}
