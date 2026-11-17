import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { fetchYoutubeChannelVideos } from "@/lib/youtube-channel";

export const runtime = "nodejs";

export async function GET() {
  if (!env.YOUTUBE_API_KEY) {
    return NextResponse.json(
      { error: "The channel video feed is not configured. Add YOUTUBE_API_KEY on the server." },
      { status: 503 },
    );
  }
  try {
    const channel = await fetchYoutubeChannelVideos(50, 1800);
    return NextResponse.json(channel, {
      headers: { "Cache-Control": "public, max-age=1800, s-maxage=1800" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load the YouTube channel." },
      { status: 502 },
    );
  }
}
