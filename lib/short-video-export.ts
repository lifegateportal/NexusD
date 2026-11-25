import { buildTimedCaptionCues } from "@/lib/short-caption-cues";
import {
  getRemovedTranscriptWordIndexes,
  getTranscriptCutAtTime,
} from "@/lib/short-transcript-edits";
import { getShortMediaProxyUrl } from "@/lib/short-media-proxy";
import type { ShortProject, ShortFrameSlot, ShortCropKeyframe } from "@/lib/schemas/video-short";

type ExportProgress = (progress: number) => void;
type LoadedBroll = { video: HTMLVideoElement; startSeconds: number; endSeconds: number; fit: "cover" | "contain" };
type LoadedMusic = {
  fileName: string;
  audio: HTMLAudioElement;
  gain: GainNode;
  startSeconds: number;
  endSeconds: number;
  volume: number;
  duckUnderSpeech: boolean;
  duckVolume: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
};

const OUTPUT_FPS = 30;
const MAX_EXPORT_MS = 5 * 60 * 1000;

function getFramePosition(slot: ShortFrameSlot, timeSeconds: number): ShortCropKeyframe {
  const frames = [...slot.keyframes].sort((a, b) => a.timeSeconds - b.timeSeconds);
  if (frames.length === 0) return { timeSeconds, x: 50, y: 50, zoom: 1, fit: slot.fit };
  if (timeSeconds <= frames[0].timeSeconds) return { ...frames[0], fit: frames[0].fit ?? slot.fit };
  for (let index = 1; index < frames.length; index += 1) {
    const previous = frames[index - 1];
    const next = frames[index];
    if (timeSeconds < next.timeSeconds) {
      const progress = (timeSeconds - previous.timeSeconds) / Math.max(0.001, next.timeSeconds - previous.timeSeconds);
      return {
        timeSeconds,
        x: previous.x + (next.x - previous.x) * progress,
        y: previous.y + (next.y - previous.y) * progress,
        zoom: previous.zoom + (next.zoom - previous.zoom) * progress,
        fit: previous.fit ?? slot.fit,
      };
    }
  }
  const last = frames[frames.length - 1];
  return { ...last, fit: last.fit ?? slot.fit };
}

function dimensionsFor(aspectRatio: ShortFrameSlot["aspectRatio"]): { width: number; height: number } {
  const [aspectWidth, aspectHeight] = aspectRatio.split(":").map(Number);
  const ratio = aspectWidth / aspectHeight;
  if (ratio >= 1) return { width: 1280, height: Math.round(1280 / ratio) };
  return { width: 720, height: Math.round(720 / ratio) };
}

function frameBox(
  canvasWidth: number,
  canvasHeight: number,
  aspectRatio: ShortFrameSlot["aspectRatio"],
): { x: number; y: number; width: number; height: number } {
  const [aspectWidth, aspectHeight] = aspectRatio.split(":").map(Number);
  const ratio = aspectWidth / aspectHeight;
  const canvasRatio = canvasWidth / canvasHeight;
  const width = ratio > canvasRatio ? canvasWidth : canvasHeight * ratio;
  const height = width / ratio;
  return {
    x: (canvasWidth - width) / 2,
    y: (canvasHeight - height) / 2,
    width,
    height,
  };
}

function waitForMedia(
  media: HTMLMediaElement,
  minimumReadyState: number,
  description = "A video or audio layer",
): Promise<void> {
  if (media.readyState >= minimumReadyState) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(`${description} did not load in time.`));
    }, 30000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      media.removeEventListener("loadeddata", onReady);
      media.removeEventListener("loadedmetadata", onReady);
      media.removeEventListener("error", onError);
    };
    const onReady = () => {
      if (media.readyState < minimumReadyState) return;
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`${description} could not be loaded for export.`));
    };
    media.addEventListener("loadeddata", onReady);
    media.addEventListener("loadedmetadata", onReady);
    media.addEventListener("error", onError);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    const timeout = window.setTimeout(() => {
      reject(new Error("An image overlay did not load in time for export."));
    }, 30000);
    image.onload = () => {
      window.clearTimeout(timeout);
      resolve(image);
    };
    image.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error("An image overlay could not be loaded for export."));
    };
    image.src = url;
  });
}

function drawFittedMedia(
  context: CanvasRenderingContext2D,
  media: CanvasImageSource & { width?: number; height?: number; videoWidth?: number; videoHeight?: number },
  x: number,
  y: number,
  width: number,
  height: number,
  fit: "cover" | "contain",
): void {
  const mediaWidth = media.videoWidth ?? media.width ?? 0;
  const mediaHeight = media.videoHeight ?? media.height ?? 0;
  if (mediaWidth <= 0 || mediaHeight <= 0) return;
  const scale = fit === "cover"
    ? Math.max(width / mediaWidth, height / mediaHeight)
    : Math.min(width / mediaWidth, height / mediaHeight);
  const drawWidth = mediaWidth * scale;
  const drawHeight = mediaHeight * scale;
  context.drawImage(media, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
}

function drawSource(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  box: { x: number; y: number; width: number; height: number },
  position: ShortCropKeyframe,
  slot: ShortFrameSlot,
): void {
  if (video.videoWidth <= 0 || video.videoHeight <= 0) return;
  const fit = position.fit ?? slot.fit;
  const baseScale = fit === "cover"
    ? Math.max(box.width / video.videoWidth, box.height / video.videoHeight)
    : Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
  const baseWidth = video.videoWidth * baseScale;
  const baseHeight = video.videoHeight * baseScale;
  const zoom = position.zoom;
  const drawWidth = baseWidth * zoom;
  const drawHeight = baseHeight * zoom;
  const baseLeft = (box.width - baseWidth) * position.x / 100;
  const baseTop = (box.height - baseHeight) * position.y / 100;
  const left = box.x + box.width / 2 + (baseLeft - box.width / 2) * zoom;
  const top = box.y + box.height / 2 + (baseTop - box.height / 2) * zoom;
  context.save();
  context.beginPath();
  context.rect(box.x, box.y, box.width, box.height);
  context.clip();
  context.drawImage(video, left, top, drawWidth, drawHeight);
  context.restore();
}

function drawFrameBackground(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  box: { x: number; y: number; width: number; height: number },
  slot: ShortFrameSlot,
  fit: "cover" | "contain",
): void {
  if (fit !== "contain") return;
  if (slot.backgroundMode === "color") {
    context.fillStyle = slot.backgroundColor;
    context.fillRect(box.x, box.y, box.width, box.height);
    return;
  }

  const blur = Math.max(12, Math.round(Math.min(box.width, box.height) * 0.035));
  const bleed = blur * 2;
  context.save();
  context.beginPath();
  context.rect(box.x, box.y, box.width, box.height);
  context.clip();
  context.filter = `blur(${blur}px) brightness(0.72)`;
  drawFittedMedia(
    context,
    video,
    box.x - bleed,
    box.y - bleed,
    box.width + bleed * 2,
    box.height + bleed * 2,
    "cover",
  );
  context.restore();
}

function drawCaption(
  context: CanvasRenderingContext2D,
  text: string,
  project: ShortProject,
  box: { x: number; y: number; width: number; height: number },
): void {
  const size = project.captionFontSize ?? (
    project.captionSize === "small" ? 4.4 : project.captionSize === "large" ? 6.2 : 5.2
  );
  const fontSize = Math.max(14, box.width * size / 100);
  const family = {
    sans: "Arial, sans-serif",
    condensed: '"Arial Narrow", Arial, sans-serif',
    rounded: '"Trebuchet MS", Arial, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
  }[project.captionFontFamily];
  context.font = `${project.captionStyle === "clean" || project.captionStyle === "minimal" ? 700 : 800} ${fontSize}px ${family}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  const maxWidth = box.width * 0.9;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && context.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  const visibleLines = lines.slice(0, 2);
  const lineHeight = fontSize * 1.12;
  const textHeight = lineHeight * visibleLines.length;
  const top = project.captionPosition === "top"
    ? box.y + fontSize
    : project.captionPosition === "middle"
      ? box.y + (box.height - textHeight) / 2
      : box.y + box.height - textHeight - fontSize;
  const fill = project.captionBackgroundColor === "transparent"
    ? "transparent"
    : project.captionBackgroundColor;
  const background = fill !== "transparent"
    ? `${fill}${Math.round(project.captionBackgroundOpacity * 255).toString(16).padStart(2, "0")}`
    : "transparent";
  if (background !== "transparent" && ["bold-box", "pill"].includes(project.captionStyle)) {
    const lineWidths = visibleLines.map((item) => context.measureText(item).width);
    const width = Math.min(maxWidth, Math.max(...lineWidths)) + fontSize * 0.7;
    context.fillStyle = background;
    context.fillRect(box.x + (box.width - width) / 2, top - textHeight / 2, width, textHeight);
  }
  context.fillStyle = project.captionTextColor;
  context.shadowColor = "#000";
  context.shadowBlur = project.captionStyle === "outline" ? fontSize * 0.16 : fontSize * 0.12;
  context.shadowOffsetY = 2;
  visibleLines.forEach((item, index) => {
    context.fillText(item, box.x + box.width / 2, top + index * lineHeight, maxWidth);
  });
  context.shadowColor = "transparent";
  context.shadowBlur = 0;
  context.shadowOffsetY = 0;
}

function drawOverlays(
  context: CanvasRenderingContext2D,
  project: ShortProject,
  timeSeconds: number,
  box: { x: number; y: number; width: number; height: number },
  images: Map<string, HTMLImageElement>,
  minimumZIndex: number,
  maximumZIndex: number,
): void {
  const active = project.overlays
    .filter((overlay) =>
      overlay.zIndex >= minimumZIndex
      && overlay.zIndex <= maximumZIndex
      && timeSeconds >= overlay.startSeconds
      && timeSeconds < overlay.endSeconds,
    )
    .sort((first, second) => first.zIndex - second.zIndex);
  for (const overlay of active) {
    const x = box.x + box.width * overlay.left / 100;
    const y = box.y + box.height * overlay.top / 100;
    const width = box.width * overlay.width / 100;
    const height = box.height * overlay.height / 100;
    context.save();
    context.globalAlpha = overlay.opacity;
    if (overlay.type === "text" && overlay.text) {
      const fontSize = overlay.fontSize * box.width / 400;
      context.font = `800 ${fontSize}px Arial, sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillStyle = overlay.backgroundColor === "transparent" ? "transparent" : overlay.backgroundColor;
      if (overlay.backgroundColor !== "transparent") {
        context.fillRect(x, y, width, height);
      }
      context.fillStyle = overlay.textColor;
      context.shadowColor = overlay.backgroundColor === "transparent" ? "#000" : "transparent";
      context.shadowBlur = fontSize * 0.2;
      const text = overlay.textStyle === "headline" || overlay.textStyle === "pill"
        ? overlay.text.toLocaleUpperCase()
        : overlay.text;
      context.fillText(text, x + width / 2, y + height / 2, width * 0.94);
      if (overlay.borderWidth > 0) {
        context.shadowBlur = 0;
        context.strokeStyle = overlay.borderColor;
        context.lineWidth = overlay.borderWidth * box.width / 400;
        context.strokeRect(x, y, width, height);
      }
    } else if (overlay.imageUrl) {
      const image = images.get(overlay.id);
      if (image) {
        if (overlay.type === "frame") context.drawImage(image, x, y, width, height);
        else drawFittedMedia(context, image, x, y, width, height, overlay.imageFit ?? "contain");
      }
    } else if (overlay.type === "frame") {
      context.strokeStyle = overlay.borderColor;
      context.lineWidth = Math.max(1, overlay.borderWidth * box.width / 400);
      if (overlay.frameStyle === "corner-brackets") {
        const cornerWidth = width / 4;
        const cornerHeight = height / 4;
        context.beginPath();
        context.moveTo(x, y + cornerHeight);
        context.lineTo(x, y);
        context.lineTo(x + cornerWidth, y);
        context.moveTo(x + width - cornerWidth, y);
        context.lineTo(x + width, y);
        context.lineTo(x + width, y + cornerHeight);
        context.moveTo(x, y + height - cornerHeight);
        context.lineTo(x, y + height);
        context.lineTo(x + cornerWidth, y + height);
        context.moveTo(x + width - cornerWidth, y + height);
        context.lineTo(x + width, y + height);
        context.lineTo(x + width, y + height - cornerHeight);
        context.stroke();
      } else {
        context.strokeRect(x, y, width, height);
      }
      if (overlay.frameStyle === "neon") {
        context.shadowColor = overlay.borderColor;
        context.shadowBlur = overlay.borderWidth * 4;
        context.strokeRect(x, y, width, height);
      }
    }
    context.restore();
  }
}

function assertCanvasReadable(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
): void {
  try {
    context.clearRect(0, 0, 2, 2);
    context.drawImage(source, 0, 0, 2, 2);
    context.getImageData(0, 0, 1, 1);
  } catch {
    throw new Error("A B-roll or image layer blocks browser export. Its source must allow cross-origin canvas use; re-upload it to Shorts Studio storage and try again.");
  }
}

export async function exportShortVideo(
  project: ShortProject,
  sourceFile: Blob,
  onProgress: ExportProgress,
): Promise<{ blob: Blob; extension: "mp4" | "webm" }> {
  if (project.source.type !== "upload") {
    throw new Error("MP4 export needs an authorized MP4 or WebM source file. YouTube-only projects remain preview-only.");
  }
  if (!("captureStream" in HTMLCanvasElement.prototype) || typeof MediaRecorder === "undefined") {
    throw new Error("This browser cannot export canvas video. Use a current Safari or Chromium-based browser.");
  }
  const mimeType = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ].find((candidate) => MediaRecorder.isTypeSupported(candidate));
  if (!mimeType) throw new Error("This browser does not support MP4 or WebM recording.");

  const primarySlot = project.frameSlots[0];
  const dimensions = dimensionsFor(primarySlot.aspectRatio);
  const canvas = document.createElement("canvas");
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("This browser could not create the video export canvas.");

  const sourceUrl = URL.createObjectURL(sourceFile);
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.preload = "auto";
  video.playsInline = true;
  video.src = sourceUrl;
  video.load();

  const AudioContextConstructor = window.AudioContext;
  if (!AudioContextConstructor) {
    URL.revokeObjectURL(sourceUrl);
    throw new Error("This browser cannot mix audio for export.");
  }
  const audioContext = new AudioContextConstructor();
  const audioDestination = audioContext.createMediaStreamDestination();
  const mainAudio = audioContext.createMediaElementSource(video);
  const mainGain = audioContext.createGain();
  mainGain.gain.value = 1;
  mainAudio.connect(mainGain);
  mainGain.connect(audioDestination);
  const videoStream = canvas.captureStream(OUTPUT_FPS);
  const recordingStream = new MediaStream([
    ...videoStream.getVideoTracks(),
    ...audioDestination.stream.getAudioTracks(),
  ]);
  const broll: LoadedBroll[] = [];
  const music: LoadedMusic[] = [];
  const images = new Map<string, HTMLImageElement>();
  const audioSources: MediaElementAudioSourceNode[] = [];
  const musicReadyPromises: Array<Promise<void>> = [];
  const musicStartPromises: Array<Promise<{ fileName: string; started: boolean }>> = [];
  let animationFrame = 0;
  let recorder: MediaRecorder | null = null;
  let stopped = false;

  try {
    const audioResume = audioContext.resume();
    const initialPlay = video.play().then(() => true).catch(() => false);
    for (const track of project.musicTracks) {
      const audio = document.createElement("audio");
      audio.crossOrigin = "anonymous";
      audio.preload = "auto";
      audio.src = getShortMediaProxyUrl(track.audioUrl);
      audio.load();
      musicReadyPromises.push(
        waitForMedia(audio, 2, `Music track "${track.fileName}"`),
      );
      const source = audioContext.createMediaElementSource(audio);
      const gain = audioContext.createGain();
      source.connect(gain);
      gain.connect(audioDestination);
      audioSources.push(source);
      music.push({
        fileName: track.fileName,
        audio,
        gain,
        startSeconds: track.startSeconds,
        endSeconds: track.endSeconds,
        volume: track.volume,
        duckUnderSpeech: track.duckUnderSpeech,
        duckVolume: track.duckVolume,
        fadeInSeconds: track.fadeInSeconds,
        fadeOutSeconds: track.fadeOutSeconds,
      });
      musicStartPromises.push(
        audio.play()
          .then(() => ({ fileName: track.fileName, started: true }))
          .catch(() => ({ fileName: track.fileName, started: false })),
      );
    }
    await waitForMedia(video, 2);
    await audioResume;
    for (const clip of project.brollClips) {
      const element = document.createElement("video");
      element.crossOrigin = "anonymous";
      element.preload = "auto";
      element.muted = true;
      element.playsInline = true;
      element.src = getShortMediaProxyUrl(clip.videoUrl);
      element.load();
      await waitForMedia(element, 2);
      broll.push({
        video: element,
        startSeconds: clip.startSeconds,
        endSeconds: clip.endSeconds,
        fit: clip.fit,
      });
    }
    for (const overlay of project.overlays) {
      if (overlay.imageUrl) {
        images.set(overlay.id, await loadImage(getShortMediaProxyUrl(overlay.imageUrl)));
      }
    }
    await Promise.all(musicReadyPromises);
    const failedMusicStart = (await Promise.all(musicStartPromises))
      .find((result) => !result.started);
    if (failedMusicStart) {
      throw new Error(`The browser could not start music track "${failedMusicStart.fileName}". Press Export again and allow media playback.`);
    }
    music.forEach((track) => {
      track.audio.pause();
      track.audio.currentTime = 0;
    });

    const checkCanvas = document.createElement("canvas");
    checkCanvas.width = 2;
    checkCanvas.height = 2;
    const checkContext = checkCanvas.getContext("2d");
    if (!checkContext) throw new Error("This browser could not verify media layers for export.");
    broll.forEach((clip) => assertCanvasReadable(checkContext, clip.video));
    images.forEach((image) => assertCanvasReadable(checkContext, image));
    if (!await initialPlay) throw new Error("The browser blocked source video playback. Press Export again and allow media playback.");
    if (Number.isFinite(video.duration) && project.endSeconds > video.duration) {
      throw new Error("The short range is longer than the selected source video.");
    }
    video.pause();
    video.currentTime = project.startSeconds;
    if (video.seeking || Math.abs(video.currentTime - project.startSeconds) > 0.05) {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error("Could not seek to the beginning of the short.")), 10000);
        video.addEventListener("seeked", () => {
          window.clearTimeout(timeout);
          resolve();
        }, { once: true });
      });
    }
    await audioContext.resume();

    const removedWords = getRemovedTranscriptWordIndexes(project.transcriptCuts);
    const captionCues = buildTimedCaptionCues(project.captions, removedWords);
    const allCuts = [...project.transcriptCuts, ...project.pauseCuts];
    const chunks: Blob[] = [];
    recorder = new MediaRecorder(recordingStream, {
      mimeType,
      videoBitsPerSecond: 5_000_000,
      audioBitsPerSecond: 128_000,
    });

    const result = await new Promise<{ blob: Blob; extension: "mp4" | "webm" }>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        if (recorder?.state === "recording") recorder.stop();
        reject(new Error("Export exceeded five minutes. Keep this tab open and in the foreground while exporting."));
      }, MAX_EXPORT_MS);
      const finish = (error?: Error) => {
        if (stopped) return;
        stopped = true;
        window.clearTimeout(timeout);
        if (animationFrame) window.cancelAnimationFrame(animationFrame);
        broll.forEach((clip) => clip.video.pause());
        music.forEach((track) => track.audio.pause());
        if (recorder?.state === "recording") recorder.stop();
        if (error) reject(error);
      };
      recorder!.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder!.onerror = () => finish(new Error("The browser stopped recording the export."));
      recorder!.onstop = () => {
        const blob = new Blob(chunks, { type: recorder?.mimeType || mimeType });
        if (blob.size === 0) {
          reject(new Error("The browser produced an empty video export."));
          return;
        }
        resolve({
          blob,
          extension: blob.type.includes("mp4") ? "mp4" : "webm",
        });
      };

      let lastProgressUpdate = 0;
      let lastSkippedCutId: string | null = null;
      const drawFrame = () => {
        if (stopped) return;
        const timeSeconds = video.currentTime;
        const cut = getTranscriptCutAtTime(allCuts, timeSeconds);
        if (cut) {
          if (lastSkippedCutId !== cut.id) {
            lastSkippedCutId = cut.id;
            video.currentTime = cut.endSeconds;
          }
          animationFrame = window.requestAnimationFrame(drawFrame);
          return;
        }
        lastSkippedCutId = null;
        if (timeSeconds >= project.endSeconds || video.ended) {
          finish();
          return;
        }

        context.fillStyle = "#000";
        context.fillRect(0, 0, canvas.width, canvas.height);
        const slot = project.frameSlots.find((frame) =>
          timeSeconds >= frame.startSeconds && timeSeconds < frame.endSeconds,
        ) ?? project.frameSlots[project.frameSlots.length - 1];
        const box = frameBox(canvas.width, canvas.height, slot.aspectRatio);
        const position = getFramePosition(slot, timeSeconds);
        drawFrameBackground(context, video, box, slot, position.fit ?? slot.fit);
        drawSource(context, video, box, position, slot);

        for (const clip of broll) {
          const active = timeSeconds >= clip.startSeconds && timeSeconds < clip.endSeconds;
          if (!active) {
            clip.video.pause();
            continue;
          }
          const elapsed = Math.min(clip.video.duration || 0, timeSeconds - clip.startSeconds);
          if (clip.video.readyState >= 2 && Math.abs(clip.video.currentTime - elapsed) > 0.4) {
            clip.video.currentTime = elapsed;
          }
          if (clip.video.paused) {
            void clip.video.play().catch(() => finish(new Error("A B-roll video was blocked during export.")));
          }
          drawFittedMedia(context, clip.video, box.x, box.y, box.width, box.height, clip.fit);
        }

        const speechCue = captionCues.find((cue) =>
          timeSeconds >= cue.startSeconds && timeSeconds < cue.endSeconds,
        );
        const caption = project.captionsEnabled ? speechCue : undefined;
        drawOverlays(context, project, timeSeconds, box, images, 0, 49);
        if (caption) drawCaption(context, caption.text, project, box);
        drawOverlays(context, project, timeSeconds, box, images, 50, 100);

        const speechActive = Boolean(speechCue) && !getTranscriptCutAtTime(allCuts, timeSeconds);
        for (const track of music) {
          const active = timeSeconds >= track.startSeconds && timeSeconds < track.endSeconds;
          if (!active) {
            track.gain.gain.value = 0;
            track.audio.pause();
            continue;
          }
          const elapsed = timeSeconds - track.startSeconds;
          const remaining = track.endSeconds - timeSeconds;
          const fadeIn = track.fadeInSeconds > 0 ? Math.min(1, elapsed / track.fadeInSeconds) : 1;
          const fadeOut = track.fadeOutSeconds > 0 ? Math.min(1, remaining / track.fadeOutSeconds) : 1;
          const duck = track.duckUnderSpeech && speechActive ? track.duckVolume : 1;
          track.gain.gain.value = track.volume * fadeIn * fadeOut * duck;
          if (Math.abs(track.audio.currentTime - elapsed) > 0.75) track.audio.currentTime = elapsed;
          if (track.audio.paused) {
            void track.audio.play().catch(() => finish(new Error(
              `Music track "${track.fileName}" was blocked during export.`,
            )));
          }
        }

        if (performance.now() - lastProgressUpdate > 500) {
          onProgress(Math.max(0, Math.min(1, (timeSeconds - project.startSeconds) / (project.endSeconds - project.startSeconds))));
          lastProgressUpdate = performance.now();
        }
        animationFrame = window.requestAnimationFrame(drawFrame);
      };

      recorder!.start(1000);
      video.play().then(() => {
        animationFrame = window.requestAnimationFrame(drawFrame);
      }).catch(() => finish(new Error("The browser blocked source video playback. Press Export again and allow media playback.")));
    });
    onProgress(1);
    return result;
  } finally {
    stopped = true;
    if (animationFrame) window.cancelAnimationFrame(animationFrame);
    if (recorder?.state === "recording") recorder.stop();
    video.pause();
    broll.forEach((clip) => {
      clip.video.pause();
      clip.video.removeAttribute("src");
    });
    music.forEach((track) => {
      track.audio.pause();
      track.audio.removeAttribute("src");
    });
    videoStream.getTracks().forEach((track) => track.stop());
    recordingStream.getTracks().forEach((track) => track.stop());
    audioSources.forEach((source) => source.disconnect());
    mainAudio.disconnect();
    mainGain.disconnect();
    await audioContext.close();
    URL.revokeObjectURL(sourceUrl);
  }
}
