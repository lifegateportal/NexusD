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
