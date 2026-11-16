import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 30;

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
// Android UA — used when calling InnerTube as ANDROID client
const ANDROID_UA = "com.google.android.youtube/17.36.4 (Linux; U; Android 12; GB) gzip";

type CaptionSegment = { startSeconds: number; endSeconds: number; text: string };

function decodeCaptionText(value: string): string {
  return value
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
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
  const json3Res = await fetch(baseUrl + "&fmt=json3", { headers: WEB_HEADERS });
  if (json3Res.ok) {
    const text = json3Res.status !== 204 ? await json3Res.text() : "";
    if (text && text.length > 10) {
      const parsed = parseJson3(JSON.parse(text) as unknown);
      if (parsed.length > 0) return parsed;
    }
  }
  // Fall back to XML
  const xmlRes = await fetch(baseUrl, { headers: WEB_HEADERS });
  if (!xmlRes.ok) throw new Error(`Caption download failed: HTTP ${xmlRes.status}`);
  const xml = await xmlRes.text();
  const parsed = parseXml(xml);
  if (parsed.length === 0) throw new Error("Transcript parsed but was empty.");
  return parsed;
}

/** Pick best English track from a list, preferring ASR auto-captions. */
function pickTrack(tracks: CaptionTrack[]): CaptionTrack | undefined {
  return (
    tracks.find((t) => t.languageCode.startsWith("en") && t.kind === "asr") ??
    tracks.find((t) => t.languageCode.startsWith("en")) ??
    tracks[0]
  );
}

async function fetchTranscript(videoId: string): Promise<CaptionSegment[]> {
  // ── Strategy 1: InnerTube ANDROID client ─────────────────────────────
  // YouTube's internal player API. The ANDROID client identity bypasses
  // bot-detection that blocks plain web scraping from cloud/Codespace IPs.
  for (const clientConfig of [
    { clientName: "ANDROID", clientVersion: "17.36.4", androidSdkVersion: 31 },
    { clientName: "WEB_EMBEDDED_PLAYER", clientVersion: "1.20231121.01.00" },
  ]) {
    try {
      const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": ANDROID_UA,
          "Accept-Language": "en-US,en;q=0.9",
          "X-YouTube-Client-Name": "3",
          "X-YouTube-Client-Version": clientConfig.clientVersion,
        },
        body: JSON.stringify({
          videoId,
          context: {
            client: { hl: "en", gl: "US", ...clientConfig },
          },
        }),
      });
      if (!res.ok) continue;

      const data = (await res.json()) as {
        captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
      };
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
      const track = pickTrack(tracks);
      if (!track?.baseUrl) continue;

      const segments = await fetchCaptionUrl(track.baseUrl);
      if (segments.map((segment) => segment.text).join(" ").length > 50) return segments;
    } catch { /* try next client */ }
  }

  // ── Strategy 2: direct timedtext API ─────────────────────────────────
  for (const lang of ["en", "en-US", "en-GB"]) {
    for (const kind of ["asr", ""]) {
      try {
        const params = new URLSearchParams({ v: videoId, lang, fmt: "json3", ...(kind ? { kind } : {}) });
        const res = await fetch(`https://www.youtube.com/api/timedtext?${params.toString()}`, {
          headers: WEB_HEADERS,
        });
        if (!res.ok) continue;
        const raw = await res.text();
        if (!raw || raw === "{}" || raw.length < 20) continue;
        const segments = parseJson3(JSON.parse(raw) as unknown);
        if (segments.map((segment) => segment.text).join(" ").length > 80) return segments;
      } catch { /* try next */ }
    }
  }

  // ── Strategy 3: page scrape with consent cookie ───────────────────────
  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { ...WEB_HEADERS, Cookie: "CONSENT=YES+cb; YSC=aaaabbbb; VISITOR_INFO1_LIVE=ccccdddd;" },
  });

  if (!pageRes.ok) {
    throw new Error(
      `All fetch strategies failed (HTTP ${pageRes.status}). This video's captions are inaccessible from this server. Paste the transcript text directly into the pipeline input field instead.`
    );
  }

  const html = await pageRes.text();
  const captionsIdx = html.indexOf('"captionTracks"');
  if (captionsIdx === -1) {
    throw new Error(
      `YouTube is blocking transcript access from this server IP. Paste the transcript text directly into the pipeline input field (you can copy it from youtube.com/watch?v=${videoId} → ⋯ → Show transcript).`
    );
  }

  const segment = html.slice(captionsIdx, captionsIdx + 4000);
  const urlMatch = segment.match(/"baseUrl":"([^"]+)"/);
  if (!urlMatch) throw new Error("Could not extract caption URL from page.");

  const captionUrl = urlMatch[1].replace(/\\u([0-9a-fA-F]{4})/g, (_, c) =>
    String.fromCharCode(parseInt(c, 16))
  );
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
