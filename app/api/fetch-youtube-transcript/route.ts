import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 60;

const RequestSchema = z.object({
  url: z.string().min(1),
});

function extractVideoId(input: string): string | null {
  const patterns = [
    // Standard watch URLs, shared youtu.be links, embeds, shorts
    /(?:youtube\.com\/watch\?(?:[^#]*&)?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    // Bare 11-char ID
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  // Strip iOS/Android ?si= and &si= share-tracking params before matching
  const clean = input.trim().replace(/[?&]si=[^&]*/g, "");
  for (const p of patterns) {
    const m = clean.match(p);
    if (m?.[1]) return m[1];
  }
  return null;
}

const WEB_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};
const ANDROID_UA = "com.google.android.youtube/19.09.37 (Linux; U; Android 13; en_US) gzip";
const IOS_UA = "com.google.ios.youtube/19.09.3 (iPhone16,2; U; CPU iOS 17_4 like Mac OS X)";
const CAPTION_TIMEOUT_MS = 8_000;

type CaptionSegment = { startSeconds: number; endSeconds: number; text: string };

function decodeCaptionText(value: string): string {
  return value
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseXml(xml: string): CaptionSegment[] {
  return [...xml.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)]
    .map((match) => {
      const start = Number(match[1]?.match(/\bstart="([\d.]+)"/)?.[1] ?? 0);
      const duration = Number(match[1]?.match(/\bdur="([\d.]+)"/)?.[1] ?? 0);
      return {
        startSeconds: start,
        endSeconds: start + duration,
        text: decodeCaptionText(match[2] ?? ""),
      };
    })
    .filter((segment) => segment.text);
}

function parseJson3(data: unknown): CaptionSegment[] {
  type Seg = { utf8?: string };
  type Event = { tStartMs?: number; dDurationMs?: number; segs?: Seg[] };
  const events: Event[] = (data as { events?: Event[] })?.events ?? [];
  return events
    .filter((e) => e.segs)
    .map((event) => {
      const startSeconds = (event.tStartMs ?? 0) / 1000;
      return {
        startSeconds,
        endSeconds: startSeconds + (event.dDurationMs ?? 0) / 1000,
        text: decodeCaptionText((event.segs ?? []).map((segment) => segment.utf8 ?? "").join("")),
      };
    })
    .filter((segment) => segment.text);
}

type CaptionTrack = { baseUrl: string; languageCode: string; kind?: string };

/** Fetch a parsed transcript from a caption baseUrl (supports json3 + xml). */
async function fetchCaptionUrl(baseUrl: string): Promise<CaptionSegment[]> {
  const json3Url = new URL(baseUrl);
  json3Url.searchParams.set("fmt", "json3");
  const json3Res = await fetch(json3Url, {
    headers: WEB_HEADERS,
    signal: AbortSignal.timeout(CAPTION_TIMEOUT_MS),
  });
  if (json3Res.ok) {
    const text = json3Res.status !== 204 ? await json3Res.text() : "";
    if (text && text.length > 10) {
      const parsed = parseJson3(JSON.parse(text) as unknown);
      if (parsed.length > 0) return parsed;
    }
  }
  const xmlRes = await fetch(baseUrl, {
    headers: WEB_HEADERS,
    signal: AbortSignal.timeout(CAPTION_TIMEOUT_MS),
  });
  if (!xmlRes.ok) throw new Error(`Caption download failed: HTTP ${xmlRes.status}`);
  const xml = await xmlRes.text();
  const parsed = parseXml(xml);
  if (parsed.length === 0) throw new Error("Transcript parsed but was empty.");
  return parsed;
}

/** Pick best English track from a list, preferring ASR auto-captions. */
function pickTrack(tracks: CaptionTrack[]): CaptionTrack | undefined {
  return (
    tracks.find((t) => t.languageCode.startsWith("en")) ??
    tracks.find((t) => t.kind !== "asr") ??
    tracks[0]
  );
}

async function fetchTranscript(videoId: string): Promise<CaptionSegment[]> {
  const failures: string[] = [];
  for (const clientConfig of [
    {
      clientId: "3",
      userAgent: ANDROID_UA,
      version: "19.09.37",
      client: { clientName: "ANDROID", clientVersion: "19.09.37", androidSdkVersion: 33 },
    },
    {
      clientId: "5",
      userAgent: IOS_UA,
      version: "19.09.3",
      client: { clientName: "IOS", clientVersion: "19.09.3", deviceModel: "iPhone16,2" },
    },
    {
      clientId: "56",
      userAgent: WEB_HEADERS["User-Agent"],
      version: "1.20231121.01.00",
      client: { clientName: "WEB_EMBEDDED_PLAYER", clientVersion: "1.20231121.01.00" },
    },
  ]) {
    try {
      const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": clientConfig.userAgent,
          "Accept-Language": "en-US,en;q=0.9",
          "X-YouTube-Client-Name": clientConfig.clientId,
          "X-YouTube-Client-Version": clientConfig.version,
        },
        body: JSON.stringify({
          videoId,
          context: {
            client: { hl: "en", gl: "US", ...clientConfig.client },
          },
        }),
        signal: AbortSignal.timeout(CAPTION_TIMEOUT_MS),
      });
      if (!res.ok) {
        failures.push(`YouTube player (${clientConfig.client.clientName}): HTTP ${res.status}`);
        continue;
      }

      const data = (await res.json()) as {
        captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
      };
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
      const track = pickTrack(tracks);
      if (!track?.baseUrl) {
        failures.push(`YouTube player (${clientConfig.client.clientName}): no captions listed`);
        continue;
      }

      const segments = await fetchCaptionUrl(track.baseUrl);
      if (segments.map((segment) => segment.text).join(" ").length > 50) return segments;
    } catch (error) {
      failures.push(`YouTube player (${clientConfig.client.clientName}): ${error instanceof Error ? error.message : "request failed"}`);
    }
  }

  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: WEB_HEADERS,
    signal: AbortSignal.timeout(CAPTION_TIMEOUT_MS),
  }).catch((error: unknown) => {
    failures.push(`YouTube watch page: ${error instanceof Error ? error.message : "request failed"}`);
    return null;
  });

  if (!pageRes?.ok) {
    const status = pageRes ? `HTTP ${pageRes.status}` : "network request failed";
    throw new Error(
      `Could not retrieve this video's captions (${status}). YouTube may block server-side caption access, or captions may be disabled. The library will try audio transcription next. ${failures.slice(-3).join("; ")}`
    );
  }

  const html = await pageRes.text();
  const captionsIdx = html.indexOf('"captionTracks"');
  if (captionsIdx === -1) {
    throw new Error(
      "YouTube did not expose captions to the server. Captions may be disabled or blocked from server-side access; the library can try transcribing the video's audio instead."
    );
  }

  const segment = html.slice(captionsIdx, captionsIdx + 100_000);
  const urlMatch = segment.match(/"baseUrl":"((?:\\.|[^"\\])*)"/);
  if (!urlMatch) throw new Error("Could not extract caption URL from page.");

  const captionUrl = JSON.parse(`"${urlMatch[1]}"`) as string;
  return fetchCaptionUrl(captionUrl);
}

export async function POST(req: NextRequest) {
  let videoId: string | null = null;
  try {
    const body = (await req.json()) as unknown;
    const { url } = RequestSchema.parse(body);

    videoId = extractVideoId(url.trim());
    if (!videoId) {
      return NextResponse.json(
        { error: "Could not read the video ID. Paste the full YouTube URL — e.g. https://youtu.be/abc123xyz or https://youtube.com/watch?v=abc123xyz" },
        { status: 400 }
      );
    }

    const segments = await fetchTranscript(videoId);
    const transcript = segments.map((segment) => segment.text).join(" ");
    return NextResponse.json({ transcript, segments, videoId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch transcript";
    return NextResponse.json({ error: message, ...(videoId ? { videoId } : {}) }, { status: 500 });
  }
}
