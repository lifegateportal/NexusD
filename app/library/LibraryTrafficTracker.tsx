"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

function getSessionId(): string {
  try {
    const existing = sessionStorage.getItem("pjdl_traffic_session");
    if (existing) return existing;
    const created = crypto.randomUUID();
    sessionStorage.setItem("pjdl_traffic_session", created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

function getBrowserId(): string | null {
  try {
    const existing = localStorage.getItem("pjdl_traffic_browser_v1");
    if (existing && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing)) {
      return existing;
    }
    const created = crypto.randomUUID();
    localStorage.setItem("pjdl_traffic_browser_v1", created);
    return created;
  } catch {
    return null;
  }
}

function getSource(): string {
  if (!document.referrer) return "Direct / unknown";
  try {
    const referrer = new URL(document.referrer);
    return referrer.origin === window.location.origin
      ? "Internal navigation"
      : referrer.hostname;
  } catch {
    return "Direct / unknown";
  }
}

function getDevice(): "mobile" | "tablet" | "desktop" {
  const width = window.innerWidth;
  if (width < 768) return "mobile";
  if (width < 1024) return "tablet";
  return "desktop";
}

export default function LibraryTrafficTracker() {
  const pathname = usePathname();
  const lastPathRef = useRef("");

  useEffect(() => {
    if (!pathname?.startsWith("/library") || pathname === lastPathRef.current) return;
    lastPathRef.current = pathname;
    if (navigator.doNotTrack === "1") return;

    void fetch("/api/library/traffic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: pathname,
        sessionId: getSessionId(),
        browserId: getBrowserId(),
        source: getSource(),
        device: getDevice(),
      }),
      keepalive: true,
    }).then((response) => {
      if (!response.ok) console.warn("Library traffic was not recorded.", response.status);
    }).catch((error: unknown) => {
      console.warn("Library traffic could not be recorded.", error);
    });
  }, [pathname]);

  return null;
}
