export type YouTubePlayerInstance = {
  destroy(): void;
  getCurrentTime(): number;
  getIframe(): HTMLIFrameElement;
  getPlayerState(): number;
  unloadModule(moduleName: string): void;
  pauseVideo(): void;
  playVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
};

export type YouTubeApi = {
  Player: new (
    element: HTMLElement,
    options: Record<string, unknown>,
  ) => YouTubePlayerInstance;
  PlayerState: { PLAYING: number };
};

declare global {
  interface Window {
    YT?: YouTubeApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let youtubeApiPromise: Promise<YouTubeApi> | null = null;

export function loadYouTubeApi(): Promise<YouTubeApi> {
  if (typeof window.YT?.Player === "function") return Promise.resolve(window.YT);
  if (youtubeApiPromise) return youtubeApiPromise;

  youtubeApiPromise = new Promise((resolve, reject) => {
    let settled = false;
    let script: HTMLScriptElement | null = null;
    const timeout = window.setTimeout(() => {
      settled = true;
      youtubeApiPromise = null;
      script?.remove();
      reject(new Error("YouTube player API did not load."));
    }, 20_000);
    const previousCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (settled) return;
      try {
        previousCallback?.();
        const api = window.YT;
        if (!api?.Player) throw new Error("YouTube player API loaded without a player.");
        settled = true;
        window.clearTimeout(timeout);
        resolve(api);
      } catch (error) {
        settled = true;
        window.clearTimeout(timeout);
        youtubeApiPromise = null;
        reject(error);
      }
    };

    script = document.querySelector<HTMLScriptElement>("script[data-youtube-iframe-api]");
    if (!script) {
      script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.dataset.youtubeIframeApi = "true";
      script.async = true;
      script.onerror = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        youtubeApiPromise = null;
        script?.remove();
        reject(new Error("Could not load the YouTube player API."));
      };
      document.head.appendChild(script);
    }
  });
  return youtubeApiPromise;
}
