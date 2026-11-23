import { TrailerProjectSchema, type TrailerProject } from "@/lib/schemas/trailer";
import { getTrailerFrameAtTime, getTrailerFrameSlots } from "@/lib/trailer-utils";

const OUTPUT_FPS = 30;
const MAX_EXPORT_MS = 6 * 60 * 1000;

function dimensionsFor(project: TrailerProject): { width: number; height: number } {
  const aspectRatio = getTrailerFrameSlots(project, 0)[0]?.aspectRatio ?? project.aspectRatio;
  const [aspectWidth, aspectHeight] = aspectRatio.split(":").map(Number);
  const ratio = aspectWidth / aspectHeight;
  if (ratio >= 1) return { width: 1280, height: Math.round(1280 / ratio) };
  return { width: 720, height: Math.round(720 / ratio) };
}

function frameBox(
  canvasWidth: number,
  canvasHeight: number,
  aspectRatio: TrailerProject["aspectRatio"],
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

function waitForVideoEvent(video: HTMLVideoElement, eventName: "loadeddata" | "seeked"): Promise<void> {
  if (eventName === "loadeddata" && video.readyState >= 2) return Promise.resolve();
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

  const frameAtTime = getTrailerFrameAtTime(project, momentIndex, video.currentTime);
  const slot = frameAtTime?.slot;
  const frame = frameAtTime?.position ?? { x: 50, y: 50, zoom: 1, fit: project.fit };
  const box = frameBox(width, height, slot?.aspectRatio ?? project.aspectRatio);
  if (video.videoWidth > 0 && video.videoHeight > 0) {
    const baseScale = frame.fit === "cover"
      ? Math.max(box.width / video.videoWidth, box.height / video.videoHeight)
      : Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
    const baseWidth = video.videoWidth * baseScale;
    const baseHeight = video.videoHeight * baseScale;
    const drawWidth = baseWidth * frame.zoom;
    const drawHeight = baseHeight * frame.zoom;
    const baseLeft = box.x + (box.width - baseWidth) * frame.x / 100;
    const baseTop = box.y + (box.height - baseHeight) * frame.y / 100;
    const left = box.x + box.width / 2 + (baseLeft - box.x - box.width / 2) * frame.zoom;
    const top = box.y + box.height / 2 + (baseTop - box.y - box.height / 2) * frame.zoom;
    context.save();
    context.beginPath();
    context.rect(box.x, box.y, box.width, box.height);
    context.clip();
    context.drawImage(video, left, top, drawWidth, drawHeight);
    context.restore();
  }

  const currentMoment = project.moments[momentIndex];
  context.save();
  context.textAlign = "center";
  context.shadowColor = "rgba(0, 0, 0, 0.9)";
  context.shadowBlur = Math.max(8, width * 0.012);
  context.shadowOffsetY = Math.max(2, height * 0.004);

  if (project.brandLine) {
    context.font = `700 ${Math.max(18, box.width * 0.035)}px system-ui, sans-serif`;
    context.fillStyle = "#67e8f9";
    context.fillText(project.brandLine, box.x + box.width / 2, box.y + box.height * 0.11, box.width * 0.84);
  }
  if (project.headline) {
    context.font = `800 ${Math.max(28, box.width * 0.075)}px system-ui, sans-serif`;
    context.fillStyle = "#ffffff";
    context.fillText(project.headline, box.x + box.width / 2, box.y + box.height * 0.2, box.width * 0.88);
  }
  if (currentMoment?.title) {
    context.font = `700 ${Math.max(22, box.width * 0.05)}px system-ui, sans-serif`;
    context.fillStyle = "#ffffff";
    context.fillText(currentMoment.title, box.x + box.width / 2, box.y + box.height * (project.callToAction ? 0.76 : 0.84), box.width * 0.88);
  }
  if (currentMoment?.hook) {
    const fontSize = Math.max(18, box.width * 0.04);
    context.font = `600 ${fontSize}px system-ui, sans-serif`;
    context.fillStyle = "#ffffff";
    const lines = drawWrappedText(context, currentMoment.hook, box.width * 0.84, 3);
    const lineHeight = fontSize * 1.2;
    const firstLineY = box.y + box.height * (project.callToAction ? 0.68 : 0.73)
      - (lines.length - 1) * lineHeight / 2;
    lines.forEach((line, index) => {
      context.fillText(line, box.x + box.width / 2, firstLineY + index * lineHeight, box.width * 0.84);
    });
  }
  if (project.callToAction && momentIndex === project.moments.length - 1) {
    const fontSize = Math.max(18, box.width * 0.038);
    const textWidth = Math.min(box.width * 0.84, context.measureText(project.callToAction).width + fontSize * 2);
    const buttonHeight = fontSize * 2.1;
    const buttonX = box.x + (box.width - textWidth) / 2;
    const buttonY = box.y + box.height * 0.87;
    context.shadowBlur = 0;
    context.fillStyle = "#22d3ee";
    context.beginPath();
    context.roundRect(buttonX, buttonY, textWidth, buttonHeight, buttonHeight / 2);
    context.fill();
    context.fillStyle = "#082f49";
    context.font = `800 ${fontSize}px system-ui, sans-serif`;
    context.shadowColor = "transparent";
    context.fillText(project.callToAction, box.x + box.width / 2, buttonY + buttonHeight * 0.67, textWidth - fontSize);
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

  const { width, height } = dimensionsFor(project);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("This browser could not create the trailer export canvas.");

  const sourceUrl = URL.createObjectURL(sourceFile);
  const videos = [document.createElement("video"), document.createElement("video")];
  for (const video of videos) {
    video.crossOrigin = "anonymous";
    video.preload = "auto";
    video.playsInline = true;
    video.src = sourceUrl;
    video.load();
  }

  let audioContext: AudioContext | null = null;
  let videoStream: MediaStream | null = null;
  let recordingStream: MediaStream | null = null;
  let animationFrame = 0;
  let recorder: MediaRecorder | null = null;
  let recordingStopped = false;
  let exportError: Error | null = null;
  const recordingChunks: Blob[] = [];
  const stopRecorder = () => {
    if (recorder?.state === "recording") recorder.stop();
  };

  try {
    await Promise.all(videos.map((video) => waitForVideoEvent(video, "loadeddata")));
    if (!Number.isFinite(videos[0].duration) || videos[0].duration <= 0) {
      throw new Error("The uploaded source video has no valid duration.");
    }
    if (project.moments.some((moment) => moment.endSeconds > videos[0].duration)) {
      throw new Error("A trailer moment extends beyond the uploaded source video. Re-select the correct source or adjust the moments.");
    }

    audioContext = new AudioContext();
    const audioDestination = audioContext.createMediaStreamDestination();
    const audioGains = videos.map((video, index) => {
      const sourceAudio = audioContext!.createMediaElementSource(video);
      const gain = audioContext!.createGain();
      gain.gain.value = index === 0 ? 1 : 0;
      sourceAudio.connect(gain);
      gain.connect(audioDestination);
      return gain;
    });
    await audioContext.resume();

    videoStream = canvas.captureStream(OUTPUT_FPS);
    recordingStream = new MediaStream([
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
    let activeDeck = 0;
    let completedDuration = 0;
    let transitioning = false;
    const preparedMomentByDeck: Array<number | null> = [null, null];
    const preparationByDeck: Array<Promise<void>> = [Promise.resolve(), Promise.resolve()];
    const prepareDeck = (deckIndex: number, momentIndex: number): Promise<void> => {
      const deck = videos[deckIndex];
      deck.pause();
      preparedMomentByDeck[deckIndex] = null;
      const preparation = seekVideoTo(deck, project.moments[momentIndex].startSeconds).then(() => {
        preparedMomentByDeck[deckIndex] = momentIndex;
      });
      preparationByDeck[deckIndex] = preparation;
      return preparation;
    };

    await prepareDeck(0, 0);
    if (project.moments.length > 1) await prepareDeck(1, 1);

    const transitionToMoment = (nextMomentIndex: number) => {
      transitioning = true;
      const previousDeck = activeDeck;
      const nextDeck = 1 - previousDeck;
      videos[previousDeck].pause();
      void (async () => {
        await preparationByDeck[nextDeck];
        if (preparedMomentByDeck[nextDeck] !== nextMomentIndex) {
          throw new Error("The next trailer moment was not ready for a smooth cut.");
        }
        const now = audioContext!.currentTime;
        audioGains[previousDeck].gain.setTargetAtTime(0, now, 0.01);
        audioGains[nextDeck].gain.setTargetAtTime(1, now, 0.01);
        await videos[nextDeck].play();
        activeDeck = nextDeck;
        activeMomentIndex = nextMomentIndex;
        transitioning = false;
        const followingMoment = nextMomentIndex + 1;
        if (followingMoment < project.moments.length) {
          void prepareDeck(previousDeck, followingMoment).catch((error: unknown) => {
            exportError = error instanceof Error ? error : new Error("The next trailer moment could not be prepared.");
            stopRecorder();
          });
        }
      })().catch((error: unknown) => {
        exportError = error instanceof Error ? error : new Error("The next trailer moment could not be prepared.");
        stopRecorder();
      });
    };

    const drawFrame = () => {
      if (performance.now() - startedAt > MAX_EXPORT_MS) {
        exportError = new Error("Trailer export took too long. Keep this tab open and in the foreground, then try again.");
        stopRecorder();
        return;
      }
      try {
        if (transitioning) {
          drawTrailerFrame(context, videos[activeDeck], project, activeMomentIndex, width, height);
          animationFrame = requestAnimationFrame(drawFrame);
          return;
        }
        const video = videos[activeDeck];
        const currentMoment = project.moments[activeMomentIndex];
        if (video.currentTime >= currentMoment.endSeconds) {
          completedDuration += currentMoment.endSeconds - currentMoment.startSeconds;
          const nextMomentIndex = activeMomentIndex + 1;
          if (nextMomentIndex >= project.moments.length) {
            stopRecorder();
            return;
          }
          transitionToMoment(nextMomentIndex);
          animationFrame = requestAnimationFrame(drawFrame);
          return;
        }

        drawTrailerFrame(context, video, project, activeMomentIndex, width, height);
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

    recorder.start(250);
    await videos[0].play();
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
    videos.forEach((video) => {
      video.pause();
      video.removeAttribute("src");
      video.load();
    });
    videoStream?.getTracks().forEach((track) => track.stop());
    recordingStream?.getTracks().forEach((track) => track.stop());
    URL.revokeObjectURL(sourceUrl);
    if (audioContext && audioContext.state !== "closed") await audioContext.close();
  }
}
