export function getShortMediaProxyUrl(sourceUrl: string): string {
  const parsed = new URL(sourceUrl);
  return `/api/ebook/shorts/media-proxy?url=${encodeURIComponent(parsed.href)}`;
}
