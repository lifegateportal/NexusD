import { z } from "zod";
import { env } from "@/lib/env";

const VideoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
const ChannelsResponseSchema = z.object({
  items: z.array(z.object({
    snippet: z.object({ title: z.string() }),
    contentDetails: z.object({
      relatedPlaylists: z.object({ uploads: z.string() }),
    }),
  })).default([]),
});
const PlaylistResponseSchema = z.object({
  nextPageToken: z.string().optional(),
  items: z.array(z.object({
    snippet: z.object({
      title: z.string(),
      resourceId: z.object({ videoId: VideoIdSchema }),
    }),
  })).default([]),
});
const VideoDetailsResponseSchema = z.object({
  items: z.array(z.object({
    snippet: z.object({ title: z.string() }),
    contentDetails: z.object({ duration: z.string() }),
  })).default([]),
});
const YoutubeErrorSchema = z.object({
  error: z.object({ message: z.string().optional() }).optional(),
});

export type YoutubeChannelVideo = {
  videoId: string;
  title: string;
  youtubeUrl: string;
  thumbnailUrl: string;
};

export const YoutubePageTokenSchema = z.string().min(1).max(2048).optional();

export function getYoutubeVideoIdFromUrl(input: string): string | null {
  try {
    const url = new URL(input);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (hostname === "youtu.be") {
      const shortId = url.pathname.split("/").filter(Boolean)[0];
      return shortId && VideoIdSchema.safeParse(shortId).success ? shortId : null;
    }
    if (hostname !== "youtube.com" && hostname !== "m.youtube.com" && hostname !== "youtube-nocookie.com") {
      return null;
    }
    const candidate = url.searchParams.get("v")
      ?? url.pathname.match(/^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})/)?.[1];
    return candidate && VideoIdSchema.safeParse(candidate).success ? candidate : null;
  } catch {
    return null;
  }
}

function parseYoutubeDurationSeconds(duration: string): number {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(duration);
  if (!match || !match.slice(1).some(Boolean)) {
    throw new Error("YouTube returned an unsupported video duration.");
  }
  const seconds = Number(match[1] ?? 0) * 3600
    + Number(match[2] ?? 0) * 60
    + Number(match[3] ?? 0);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) {
    throw new Error("Direct Shorts publishing supports YouTube videos up to 60 minutes long.");
  }
  return seconds;
}

export async function fetchYoutubeVideoDetails(videoId: string): Promise<{
  videoId: string;
  title: string;
  durationSeconds: number;
}> {
  const parsedVideoId = VideoIdSchema.safeParse(videoId);
  if (!parsedVideoId.success) throw new Error("Enter a valid YouTube video ID.");
  if (!env.YOUTUBE_API_KEY) {
    throw new Error("Add YOUTUBE_API_KEY to Nexus Director to fetch YouTube video details.");
  }

  const videoUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
  videoUrl.search = new URLSearchParams({
    part: "snippet,contentDetails",
    id: parsedVideoId.data,
    key: env.YOUTUBE_API_KEY,
  }).toString();
  const response = await youtubeApiRequest(videoUrl, VideoDetailsResponseSchema, 0);
  const video = response.items?.[0];
  if (!video) throw new Error("YouTube could not find a publicly available video at that URL.");
  const title = video.snippet.title.trim();
  if (!title) throw new Error("YouTube returned an empty video title.");
  return {
    videoId: parsedVideoId.data,
    title: title.slice(0, 200),
    durationSeconds: parseYoutubeDurationSeconds(video.contentDetails.duration),
  };
}

async function youtubeApiRequest<T>(url: URL, schema: z.ZodType<T>, revalidateSeconds: number): Promise<T> {
  const response = await fetch(url, revalidateSeconds
    ? { next: { revalidate: revalidateSeconds } }
    : { cache: "no-store" });
  const raw: unknown = await response.json();
  if (!response.ok) {
    const parsedError = YoutubeErrorSchema.safeParse(raw);
    throw new Error(parsedError.success
      ? parsedError.data.error?.message ?? `YouTube Data API returned HTTP ${response.status}.`
      : `YouTube Data API returned HTTP ${response.status}.`);
  }
  return schema.parse(raw);
}

export async function fetchYoutubeChannelVideos(
  pageToken?: string,
  revalidateSeconds = 0,
): Promise<{ channelTitle: string; videos: YoutubeChannelVideo[]; nextPageToken?: string }> {
  if (!env.YOUTUBE_API_KEY) {
    throw new Error("Add YOUTUBE_API_KEY to Nexus Director to fetch the channel using YouTube’s official API.");
  }

  const channelUrl = new URL("https://www.googleapis.com/youtube/v3/channels");
  channelUrl.search = new URLSearchParams({
    part: "snippet,contentDetails",
    forHandle: "lifegatebroadcast",
    key: env.YOUTUBE_API_KEY,
  }).toString();
  const channel = await youtubeApiRequest(channelUrl, ChannelsResponseSchema, revalidateSeconds);
  const channelDetails = channel.items?.[0];
  if (!channelDetails) throw new Error("YouTube could not find channel @lifegatebroadcast.");

  const playlistUrl = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
  const params = new URLSearchParams({
    part: "snippet",
    playlistId: channelDetails.contentDetails.relatedPlaylists.uploads,
    maxResults: "50",
    key: env.YOUTUBE_API_KEY,
  });
  if (pageToken) params.set("pageToken", pageToken);
  playlistUrl.search = params.toString();
  const playlist = await youtubeApiRequest(playlistUrl, PlaylistResponseSchema, revalidateSeconds);
  const videos = (playlist.items ?? []).map((item) => {
    const videoId = item.snippet.resourceId.videoId;
    return {
      videoId,
      title: item.snippet.title.slice(0, 200),
      youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
      thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    };
  });

  return {
    channelTitle: channelDetails.snippet.title,
    videos,
    ...(playlist.nextPageToken ? { nextPageToken: playlist.nextPageToken } : {}),
  };
}
