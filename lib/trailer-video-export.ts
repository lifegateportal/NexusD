import { TrailerProjectSchema, type TrailerProject } from "@/lib/schemas/trailer";

const OUTPUT_FPS = 30;
const MAX_EXPORT_MS = 6 * 60 * 1000;

function dimensionsFor(aspectRatio: TrailerProject["aspectRatio"]): { width: number; height: number } {
  const [aspectWidth, aspectHeight] = aspectRatio.split(":").map(Number);
  const ratio = aspectWidth / aspectHeight;
  if (ratio >= 1) return { width: 1280, height: Math.round(1280 / ratio) };
  return { width: 720, height: Math.round(720 / ratio) };
}

function waitForVideoEvent(video: HTMLVideoElement, eventName: "loadeddata" | "seeked"): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(eventName === "seeked"
        ? "The source video could not seek to a trailer moment."
        : "The uploaded source video could not be loaded."));
    }, 10_000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener(eventName, onReady);
      video.removeEventListener("error", onError);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("The uploaded source video could not be decoded by this browser."));
    };
    video.addEventListener(eventName, onReady, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

function drawWrappedText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && context.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    } else {
      line = candidate;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}

async function seekVideoTo(video: HTMLVideoElement, targetSeconds: number): Promise<void> {
  if (Math.abs(video.currentTime - targetSeconds) <= 0.05) return;
  const seeked = waitForVideoEvent(video, "seeked");
  video.currentTime = targetSeconds;
  await seeked;
}

function drawTrailerFrame(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  project: TrailerProject,
  momentIndex: number,
  width: number,
  height: number,
): void {
  context.fillStyle = "#05070b";
  context.fillRect(0, 0, width, height);

  if (video.videoWidth > 0 && video.videoHeight > 0) {
    const scale = project.fit === "cover"
      ? Math.max(width / video.videoWidth, height / video.videoHeight) * project.zoom
      : Math.min(width / video.videoWidth, height / video.videoHeight) * project.zoom;
    const drawWidth = video.videoWidth * scale;
    const drawHeight = video.videoHeight * scale;
    const left = (width - drawWidth) * project.cropX / 100;
    const top = (height - drawHeight) * project.cropY / 100;
    context.drawImage(video, left, top, drawWidth, drawHeight);
  }

  const currentMoment = project.moments[momentIndex];
  context.save();
  context.textAlign = "center";
  context.shadowColor = "rgba(0, 0, 0, 0.9)";
  context.shadowBlur = Math.max(8, width * 0.012);
  context.shadowOffsetY = Math.max(2, height * 0.004);

  if (project.brandLine) {
    context.font = `700 ${Math.max(18, width * 0.035)}px system-ui, sans-serif`;
    context.fillStyle = "#67e8f9";
    context.fillText(project.brandLine, width / 2, height * 0.11, width * 0.84);
  }
  if (project.headline) {
    context.font = `800 ${Math.max(28, width * 0.075)}px system-ui, sans-serif`;
    context.fillStyle = "#ffffff";
    context.fillText(project.headline, width / 2, height * 0.2, width * 0.88);
  }
  if (currentMoment?.title) {
    context.font = `700 ${Math.max(22, width * 0.05)}px system-ui, sans-serif`;
    context.fillStyle = "#ffffff";
    context.fillText(currentMoment.title, width / 2, height * (project.callToAction ? 0.76 : 0.84), width * 0.88);
  }
  if (currentMoment?.hook) {
    const fontSize = Math.max(18, width * 0.04);
    context.font = `600 ${fontSize}px system-ui, sans-serif`;
    context.fillStyle = "#ffffff";
    const lines = drawWrappedText(context, currentMoment.hook, width * 0.84, 3);
    const lineHeight = fontSize * 1.2;
    const firstLineY = height * (project.callToAction ? 0.68 : 0.73)
      - (lines.length - 1) * lineHeight / 2;
    lines.forEach((line, index) => {
      context.fillText(line, width / 2, firstLineY + index * lineHeight, width * 0.84);
    });
  }
  if (project.callToAction && momentIndex === project.moments.length - 1) {
    const fontSize = Math.max(18, width * 0.038);
    const textWidth = Math.min(width * 0.84, context.measureText(project.callToAction).width + fontSize * 2);
    const buttonHeight = fontSize * 2.1;
    const buttonX = (width - textWidth) / 2;
    const buttonY = height * 0.87;
    context.shadowBlur = 0;
    context.fillStyle = "#22d3ee";
    context.beginPath();
    context.roundRect(buttonX, buttonY, textWidth, buttonHeight, buttonHeight / 2);
    context.fill();
    context.fillStyle = "#082f49";
    context.font = `800 ${fontSize}px system-ui, sans-serif`;
    context.shadowColor = "transparent";
    context.fillText(project.callToAction, width / 2, buttonY + buttonHeight * 0.67, textWidth - fontSize);
  }
  context.restore();
}

export async function exportTrailerVideo(
  projectInput: TrailerProject,
  sourceFile: Blob,
  onProgress: (progress: number) => void,
): Promise<{ blob: Blob; extension: "mp4" | "webm" }> {
  const project = TrailerProjectSchema.parse(projectInput);
  if (!project.source.uploadedFileName) {
    throw new Error("Trailer export needs an uploaded authorized source video. YouTube embed projects remain preview-only.");
  }
  const totalDuration = project.moments.reduce(
    (total, moment) => total + moment.endSeconds - moment.startSeconds,
    0,
  );
  if (totalDuration <= 0 || totalDuration > 300) {
    throw new Error("Keep the assembled trailer at five minutes or less before exporting.");
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

  const { width, height } = dimensionsFor(project.aspectRatio);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("This browser could not create the trailer export canvas.");

  const sourceUrl = URL.createObjectURL(sourceFile);
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.preload = "auto";
  video.playsInline = true;
  video.src = sourceUrl;
  video.load();

  let audioContext: AudioContext | null = null;
  let animationFrame = 0;
  let recorder: MediaRecorder | null = null;
  let recordingStopped = false;
  let exportError: Error | null = null;
  const recordingChunks: Blob[] = [];
  const stopRecorder = () => {
    if (recorder?.state === "recording") recorder.stop();
  };

  try {
    await waitForVideoEvent(video, "loadeddata");
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error("The uploaded source video has no valid duration.");
    }
    if (project.moments.some((moment) => moment.endSeconds > video.duration)) {
      throw new Error("A trailer moment extends beyond the uploaded source video. Re-select the correct source or adjust the moments.");
    }

    audioContext = new AudioContext();
    const audioDestination = audioContext.createMediaStreamDestination();
    const sourceAudio = audioContext.createMediaElementSource(video);
    sourceAudio.connect(audioDestination);
    await audioContext.resume();

    const videoStream = canvas.captureStream(OUTPUT_FPS);
    const recordingStream = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...audioDestination.stream.getAudioTracks(),
    ]);
    recorder = new MediaRecorder(recordingStream, { mimeType });
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) recordingChunks.push(event.data);
    };
    recorder.onerror = () => {
      exportError = new Error("The browser stopped recording the trailer.");
      stopRecorder();
    };
    const stopped = new Promise<void>((resolve) => {
      recorder!.onstop = () => {
        recordingStopped = true;
        resolve();
      };
    });

    const startedAt = performance.now();
    let activeMomentIndex = 0;
    let completedDuration = 0;
    const drawFrame = () => {
      if (performance.now() - startedAt > MAX_EXPORT_MS) {
        exportError = new Error("Trailer export took too long. Keep this tab open and in the foreground, then try again.");
        stopRecorder();
        return;
      }
      try {
        if (video.currentTime >= project.moments[activeMomentIndex].endSeconds) {
          completedDuration += project.moments[activeMomentIndex].endSeconds
            - project.moments[activeMomentIndex].startSeconds;
          activeMomentIndex += 1;
          if (activeMomentIndex >= project.moments.length) {
            stopRecorder();
            return;
          }
          video.pause();
          void seekVideoTo(video, project.moments[activeMomentIndex].startSeconds).then(() => video.play()).catch((error: unknown) => {
            exportError = error instanceof Error ? error : new Error("The source video could not seek to the next trailer moment.");
            stopRecorder();
          });
        }

        drawTrailerFrame(context, video, project, activeMomentIndex, width, height);
        const currentMoment = project.moments[activeMomentIndex];
        const currentDuration = Math.max(0, Math.min(
          currentMoment.endSeconds - currentMoment.startSeconds,
          video.currentTime - currentMoment.startSeconds,
        ));
        onProgress(Math.min(0.99, (completedDuration + currentDuration) / totalDuration));
      } catch (error) {
        exportError = error instanceof Error ? error : new Error("Could not render a trailer frame.");
        stopRecorder();
        return;
      }
      animationFrame = requestAnimationFrame(drawFrame);
    };

    await seekVideoTo(video, project.moments[0].startSeconds);
    recorder.start(250);
    await video.play();
    drawFrame();
    await stopped;
    if (exportError) throw exportError;
    if (!recordingStopped) {
      throw new Error("The browser stopped recording the trailer before it finished.");
    }
    if (recordingChunks.length === 0) throw new Error("The browser produced an empty trailer export.");
    onProgress(1);
    const blob = new Blob(recordingChunks, { type: recorder.mimeType || mimeType });
    return {
      blob,
      extension: blob.type.includes("mp4") ? "mp4" : "webm",
    };
  } catch (error) {
    stopRecorder();
    if (error instanceof Error && error.message) throw error;
    throw new Error("Could not export this trailer.");
  } finally {
    cancelAnimationFrame(animationFrame);
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(sourceUrl);
    if (audioContext && audioContext.state !== "closed") await audioContext.close();
  }
}
