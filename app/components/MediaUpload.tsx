"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import type { LogEntry, PipelineStage } from "@/lib/types";
import { IngestResultSchema, type IngestResult } from "@/lib/schemas/blueprint";
import { storeVideoBlob, setVideoUrl, setYoutubeId } from "@/lib/video-store";

type UploadedFile = { name: string; size: number; type: string; content: string; raw?: File };

type MediaUploadProps = {
  onLog: (entry: Omit<LogEntry, "id" | "timestamp">) => void;
  onBlueprint: (data: IngestResult, sourceText: string) => void;
  onStageChange: (stage: PipelineStage) => void;
  onDeliveryChange?: (text: string) => void;
};

function formatBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

const TEXT_EXTS = [".txt", ".json", ".md", ".log", ".csv", ".xml", ".yaml", ".yml", ".ts", ".js"];

function readFile(file: File): Promise<UploadedFile> {
  return new Promise((resolve) => {
    const isText =
      file.type.startsWith("text/") || TEXT_EXTS.some((ext) => file.name.endsWith(ext));

    if (isText && file.size < 5 * 1024 * 1024) {
      const reader = new FileReader();
      reader.onload = (e) =>
        resolve({ name: file.name, size: file.size, type: file.type, content: (e.target?.result as string) ?? "" });
      reader.onerror = () =>
        resolve({ name: file.name, size: file.size, type: file.type, content: `[read error: ${file.name}]` });
      reader.readAsText(file);
    } else if (file.type.startsWith("video/") || file.type.startsWith("audio/")) {
      const url = URL.createObjectURL(file);
      const el = document.createElement(file.type.startsWith("video/") ? "video" : "audio");
      el.src = url;
      el.onloadedmetadata = () => {
        const durationSecs = Math.round(el.duration) || 0;
        URL.revokeObjectURL(url);
        storeVideoBlob(file, durationSecs).catch(console.error);
        const mins = Math.floor(durationSecs / 60);
        const secs = durationSecs % 60;
        resolve({
          name: file.name,
          size: file.size,
          type: file.type,
          raw: file,
          content: `[media: ${file.name} (${file.type}, ${formatBytes(file.size)}, duration: ${mins}m ${secs}s) — awaiting transcription]`
        });
      };
      el.onerror = () => {
        URL.revokeObjectURL(url);
        storeVideoBlob(file, 0).catch(console.error);
        resolve({
          name: file.name,
          size: file.size,
          type: file.type,
          raw: file,
          content: `[media: ${file.name} (${file.type}, ${formatBytes(file.size)}) — awaiting transcription]`
        });
      };
    } else {
      resolve({
        name: file.name,
        size: file.size,
        type: file.type,
        content: `[media: ${file.name} (${file.type || "unknown"}, ${formatBytes(file.size)})]`
      });
    }
  });
}

export function MediaUpload({ onLog, onBlueprint, onStageChange, onDeliveryChange }: MediaUploadProps) {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [youtubeLoading, setYoutubeLoading] = useState(false);
  const [uploadToCloud, setUploadToCloud] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [showDelivery, setShowDelivery] = useState(false);
  const [deliveryText, setDeliveryText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const saved = localStorage.getItem("nexus_delivery_instructions") ?? "";
    setDeliveryText(saved);
    onDeliveryChange?.(saved);
  }, [onDeliveryChange]);

  const addFiles = useCallback(async (raw: FileList | File[]) => {
    const processed = await Promise.all(Array.from(raw).map(readFile));
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.name));
      return [...prev, ...processed.filter((f) => !existing.has(f.name))];
    });
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) addFiles(e.target.files);
    },
    [addFiles]
  );

  const removeFile = useCallback((name: string) => {
    setFiles((prev) => prev.filter((f) => f.name !== name));
  }, []);

  const fetchYoutubeTranscript = useCallback(async () => {
    const url = youtubeUrl.trim();
    if (!url || youtubeLoading) return;
    setYoutubeLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/fetch-youtube-transcript", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const json = await res.json() as { transcript?: string; videoId?: string; error?: string };
      if (!res.ok || json.error) {
        // Persist the video ID even on transcript failure so the embed still renders
        if (json.videoId) setYoutubeId(json.videoId);
        throw new Error(json.error ?? "Failed to fetch transcript");
      }
      setYoutubeId(json.videoId!);
      const virtualFile: UploadedFile = {
        name: `youtube-${json.videoId}.txt`,
        size: json.transcript!.length,
        type: "text/plain",
        content: `[YouTube transcript: ${url}]\n\n${json.transcript}`,
      };
      setFiles((prev) =>
        prev.some((f) => f.name === virtualFile.name) ? prev : [...prev, virtualFile]
      );
      onLog({ level: "success", message: `YouTube transcript ready — ${json.transcript!.length.toLocaleString()} chars` });
      setYoutubeUrl("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed";
      setError(msg);
      onLog({ level: "error", message: `YouTube transcript failed: ${msg}` });
    } finally {
      setYoutubeLoading(false);
    }
  }, [youtubeUrl, youtubeLoading, onLog]);

  const runIngest = useCallback(async () => {
    const promptText = prompt.trim();
    if (!files.length && !promptText) return;
    setIsLoading(true);
    setError(null);
    onStageChange("ingesting");

    // Resolve final content for each file — transcribe video/audio via Deepgram
    let resolvedFiles = [...files];
    let sourceText = promptText;
    const mediaFiles = files.filter((f) => f.raw);

    if (mediaFiles.length > 0) {
      onLog({ level: "info", message: `Transcribing ${mediaFiles.length} media file(s) with Deepgram…`, model: "deepseek" });

      // Fetch token first — key never leaves the server
      let deepgramKey: string | null = null;
      try {
        const tokenRes = await fetch("/api/transcribe-token");
        if (tokenRes.ok) {
          const tokenJson = await tokenRes.json() as { apiKey?: string };
          deepgramKey = tokenJson.apiKey ?? null;
        }
      } catch { /* key unavailable */ }

      const transcribed = await Promise.all(
        mediaFiles.map(async (f) => {
          if (!deepgramKey) {
            onLog({ level: "warn", message: `Transcription skipped — DEEPGRAM_API_KEY not configured`, model: "deepseek" });
            return { name: f.name, transcript: null };
          }
          try {
            // Upload directly from browser to Deepgram — bypasses Codespaces proxy size limits
            const res = await fetch(
              "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true&paragraphs=true&language=en",
              {
                method: "POST",
                headers: {
                  Authorization: `Token ${deepgramKey}`,
                  "Content-Type": f.raw!.type || "audio/mpeg",
                },
                body: f.raw!,
              }
            );
            const json = await res.json() as { results?: { channels?: { alternatives?: { transcript?: string }[] }[] }; err_msg?: string };
            if (!res.ok) throw new Error(json.err_msg ?? `Deepgram ${res.status}`);
            const transcript = json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
            if (!transcript.trim()) throw new Error("Empty transcript returned");
            onLog({ level: "success", message: `Transcript ready for "${f.name}" (${transcript.length.toLocaleString()} chars)`, model: "deepseek" });
            return { name: f.name, transcript };
          } catch (err) {
            const msg = err instanceof Error ? err.message : "unknown";
            onLog({ level: "warn", message: `Transcription skipped for "${f.name}": ${msg}`, model: "deepseek" });
            return { name: f.name, transcript: null };
          }
        })
      );
      const tMap = new Map(transcribed.map((t) => [t.name, t.transcript]));
      resolvedFiles = files.map((f) => {
        const tx = tMap.get(f.name);
        return tx ? { ...f, content: `[transcript of ${f.name}]\n\n${tx}` } : f;
      });
    }

    // Upload video to Cloudflare R2 if enabled
    if (uploadToCloud) {
      const videoFile = mediaFiles.find((f) => f.raw?.type.startsWith("video/"));
      if (videoFile?.raw) {
        try {
          onLog({ level: "info", message: `Requesting cloud upload slot for "${videoFile.raw.name}"…` });
          const signRes = await fetch("/api/r2-presign", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename: videoFile.raw.name, contentType: videoFile.raw.type }),
          });
          const signJson = await signRes.json() as { presignedUrl?: string; publicUrl?: string; error?: string };
          if (!signRes.ok || !signJson.presignedUrl) throw new Error(signJson.error ?? "Presign failed");
          onLog({ level: "info", message: `Uploading to R2 — this may take a moment for large files…` });
          const uploadRes = await fetch(signJson.presignedUrl, {
            method: "PUT",
            headers: { "Content-Type": videoFile.raw.type },
            body: videoFile.raw,
          });
          if (!uploadRes.ok) throw new Error(`R2 upload failed: HTTP ${uploadRes.status}`);
          if (signJson.publicUrl) {
            setVideoUrl(signJson.publicUrl);
            onLog({ level: "success", message: `Video stored at: ${signJson.publicUrl}` });
          } else {
            onLog({ level: "warn", message: `Uploaded to R2 but no public URL — set R2_PUBLIC_URL in env to enable playback` });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Upload failed";
          onLog({ level: "warn", message: `Cloud upload skipped: ${msg}` });
        }
      }
    }

    if (files.length > 0) {
      const fileSource = resolvedFiles
        .map((f) => `--- ${f.name} (${f.type || "unknown"}) ---\n${f.content}`)
        .join("\n\n");
      sourceText = [promptText ? `COURSE BRIEF:\n${promptText}` : "", fileSource]
        .filter(Boolean)
        .join("\n\n");
    }

    onLog({
      level: "info",
      message: files.length > 0
        ? `Sending ${files.length} file(s) to DeepSeek ingest pipeline…`
        : "Sending course brief to DeepSeek ingest pipeline…",
      model: "deepseek",
    });

    try {
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceText, locale: "en-US" })
      });

      const json: unknown = await res.json();
      if (!res.ok) {
        const msg = (json as { detail?: string }).detail ?? res.statusText;
        throw new Error(msg);
      }

      const parsed = IngestResultSchema.safeParse(json);
      if (!parsed.success) {
        throw new Error(`Schema validation failed: ${parsed.error.issues[0]?.message}`);
      }

      onLog({ level: "success", message: `Blueprint extracted: "${parsed.data.title}"`, model: "deepseek" });
      onBlueprint(parsed.data, sourceText);
      // Stage management handed to the pipeline orchestrator in page.tsx
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Ingest failed";
      setError(msg);
      onLog({ level: "error", message: `Ingest failed: ${msg}`, model: "deepseek" });
      onStageChange("error");
    } finally {
      setIsLoading(false);
    }
  }, [files, onLog, onBlueprint, onStageChange, prompt, uploadToCloud]);

  const canRun = (files.length > 0 || prompt.trim().length > 0) && !isLoading;

  return (
    <section className="w-full overflow-hidden rounded-2xl border border-cyan-500/15 glass shadow-panel">
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-slate-700/50 px-4 py-3">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4 text-accent-400">
          <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" strokeLinecap="round" />
          <path d="M12 4v13M8.5 7.5 12 4l3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-200">Source Intake</h2>
          <p className="mt-0.5 text-xs text-slate-500">Start with a brief, transcript, URL, audio, or video.</p>
        </div>
      </header>

      <div className="grid gap-3 p-4 lg:grid-cols-[1.2fr_1fr]">
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void runIngest();
            }
          }}
          placeholder="Describe the course or paste a transcript…"
          rows={2}
          className="min-h-24 w-full resize-none rounded-xl border border-slate-600 bg-slate-800/60 px-4 py-3 text-base text-slate-100 placeholder-slate-500 focus:border-cyan-500 focus:outline-none lg:row-start-1"
        />

        {/* YouTube URL input */}
        <div className="flex gap-2 lg:row-start-2">
          <input
            type="url"
            value={youtubeUrl}
            onChange={(e) => setYoutubeUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && fetchYoutubeTranscript()}
            placeholder="Paste YouTube URL to auto-fetch transcript…"
            className="min-h-12 flex-1 rounded-xl border border-slate-600 bg-slate-800/60 px-4 text-base text-slate-100 placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
          />
          <button
            type="button"
            onClick={fetchYoutubeTranscript}
            disabled={!youtubeUrl.trim() || youtubeLoading}
            className="flex min-h-12 min-w-12 items-center justify-center rounded-xl border border-slate-600 bg-slate-800/60 text-slate-400 transition hover:border-red-500/60 hover:text-red-400 disabled:opacity-40"
            aria-label="Fetch YouTube transcript"
          >
            {youtubeLoading ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-500/30 border-t-slate-300" />
            ) : (
              <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
                <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
              </svg>
            )}
          </button>
        </div>

        {/* Drop zone */}
        <div
          role="button"
          tabIndex={0}
          aria-label="Upload files — drag and drop or tap to browse"
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
          className={[
            "focus-ring flex min-h-28 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed transition-colors lg:col-start-2 lg:row-span-2 lg:row-start-1",
            isDragging
              ? "border-accent-500 bg-accent-500/10"
              : "border-slate-600 bg-shell-800/40 hover:border-slate-500 active:border-accent-500/60"
          ].join(" ")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="mb-2 h-8 w-8 text-slate-500">
            <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" strokeLinecap="round" />
            <path d="M12 4v13M8.5 7.5 12 4l3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <p className="text-sm text-slate-400">Drop files or tap to browse</p>
          <p className="mt-0.5 text-xs text-slate-600">Footage · workshops · podcasts</p>
          <input ref={inputRef} id="media-upload-input" type="file" multiple className="sr-only" onChange={handleInputChange} />
        </div>

        {/* File list */}
        {files.length > 0 && (
          <ul className="space-y-1.5 lg:col-start-2">
            {files.map((f) => (
              <li key={f.name} className="flex items-center gap-3 rounded-xl border border-slate-700/50 bg-shell-800/50 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-slate-200">{f.name}</p>
                  <p className="text-xs text-slate-500">{formatBytes(f.size)}</p>
                </div>
                <button
                  type="button"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => removeFile(f.name)}
                  className="focus-ring flex min-h-9 min-w-9 items-center justify-center rounded-lg text-slate-500 transition active:bg-slate-700/50 active:text-red-400"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
                    <path d="M6 6l12 12M6 18L18 6" strokeLinecap="round" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Error banner */}
        {error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-300 lg:col-span-2">
            {error}
          </div>
        )}

        <div className="rounded-xl border border-slate-700/50 bg-slate-900/30 lg:col-span-2">
          <button
            type="button"
            onClick={() => setShowDelivery((visible) => !visible)}
            className="flex min-h-12 w-full items-center justify-between px-4 text-left text-sm font-medium text-slate-300"
          >
            <span>Delivery preferences</span>
            <span className="text-xs text-slate-500">{showDelivery ? "Hide" : deliveryText ? "Configured" : "Optional"}</span>
          </button>
          {showDelivery && (
            <textarea
              value={deliveryText}
              onChange={(event) => {
                const value = event.target.value;
                setDeliveryText(value);
                localStorage.setItem("nexus_delivery_instructions", value);
                onDeliveryChange?.(value);
              }}
              placeholder="Audience, tone, pacing, module style, and lesson outcomes…"
              rows={3}
              className="mx-3 mb-3 w-[calc(100%-1.5rem)] resize-none rounded-xl border border-slate-700/60 bg-slate-900/60 px-4 py-3 text-base text-slate-100 placeholder-slate-600 focus:border-cyan-500/60 focus:outline-none"
            />
          )}
        </div>
      </div>

      {/* Run button — fixed at bottom */}
      <div className="flex-shrink-0 border-t border-slate-700/50 p-4">
        {/* Cloud upload toggle — only shown when a video file is queued */}
        {files.some((f) => f.raw?.type.startsWith("video/")) && (
          <label className="mb-3 flex cursor-pointer items-center gap-3 rounded-xl border border-slate-700/50 bg-slate-800/30 px-4 py-2.5">
            <div
              role="checkbox"
              aria-checked={uploadToCloud}
              tabIndex={0}
              onClick={() => setUploadToCloud((v) => !v)}
              onKeyDown={(e) => e.key === " " && setUploadToCloud((v) => !v)}
              className={[
                "flex h-6 w-10 flex-shrink-0 items-center rounded-full transition-colors",
                uploadToCloud ? "bg-cyan-500" : "bg-slate-600"
              ].join(" ")}
            >
              <span className={`h-4 w-4 rounded-full bg-white shadow transition-transform mx-1 ${uploadToCloud ? "translate-x-4" : "translate-x-0"}`} />
            </div>
            <span className="text-sm text-slate-300">
              Upload video to Cloudflare R2
              <span className="ml-1 text-xs text-slate-500">(requires R2 env vars)</span>
            </span>
          </label>
        )}
        <button
          type="button"
          disabled={!canRun}
          onClick={runIngest}
          className={[
            "focus-ring inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl text-base font-semibold transition active:scale-[0.99]",
            !canRun
              ? "cursor-not-allowed bg-slate-700/50 text-slate-500"
              : "bg-accent-500 text-slate-950 shadow-glow"
          ].join(" ")}
        >
          {isLoading ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-400/30 border-t-slate-950" />
              Processing…
            </>
          ) : (
            <>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-5 w-5">
                <path d="M5 12h14M12 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Run Ingest Pipeline
            </>
          )}
        </button>
      </div>
    </section>
  );
}
