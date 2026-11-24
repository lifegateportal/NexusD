import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 300;

const UrlSchema = z.string().url().max(4000);
const MAX_REDIRECTS = 4;

function isAllowedMediaUrl(url: URL): boolean {
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const hostname = url.hostname.toLowerCase();
  const trustedProvider = ["pexels.com", "jamendo.com"].some((domain) =>
    hostname === domain || hostname.endsWith(`.${domain}`),
  );
  if (trustedProvider) return true;
  if (!env.R2_PUBLIC_URL) return false;
  try {
    const publicBase = new URL(env.R2_PUBLIC_URL);
    const assetPrefix = `${publicBase.pathname.replace(/\/$/, "")}/published/shorts/assets/`;
    return url.origin === publicBase.origin && url.pathname.startsWith(assetPrefix);
  } catch {
    return false;
  }
}

function rangeHeader(request: NextRequest): string | undefined {
  const value = request.headers.get("range");
  return value && /^bytes=\d*-\d*$/.test(value) ? value : undefined;
}

export async function GET(request: NextRequest) {
  const parsedUrl = UrlSchema.safeParse(request.nextUrl.searchParams.get("url"));
  if (!parsedUrl.success) {
    return NextResponse.json({ error: "A valid media URL is required." }, { status: 400 });
  }

  let url: URL;
  try {
    url = new URL(parsedUrl.data);
  } catch {
    return NextResponse.json({ error: "Invalid media URL." }, { status: 400 });
  }
  if (!isAllowedMediaUrl(url)) {
    return NextResponse.json({ error: "Only Shorts media from approved providers and storage can be relayed." }, { status: 403 });
  }

  try {
    const range = rangeHeader(request);
    let response: Response | undefined;
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      response = await fetch(url, {
        headers: range ? { Range: range } : undefined,
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(300000),
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirectCount === MAX_REDIRECTS) {
        throw new Error("The Shorts media provider redirected too many times.");
      }
      url = new URL(location, url);
      if (!isAllowedMediaUrl(url)) {
        throw new Error("The Shorts media provider redirected to an unapproved host.");
      }
    }

    if (!response?.ok && response?.status !== 206) {
      return NextResponse.json({ error: `Media provider returned HTTP ${response?.status ?? 502}.` }, { status: 502 });
    }
    const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
    if (!/^(audio|video|image)\//.test(contentType)) {
      await response.body?.cancel();
      return NextResponse.json({ error: "The media provider returned an unsupported content type." }, { status: 502 });
    }
    const headers = new Headers({
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
    for (const name of ["accept-ranges", "content-length", "content-range", "content-type", "etag", "last-modified"]) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new NextResponse(response.body, { status: response.status, headers });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load Shorts media." },
      { status: 502 },
    );
  }
}
