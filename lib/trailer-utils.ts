import {
  TrailerProjectSchema,
  type PublishedTrailer,
  type TrailerMoment,
  type TrailerProject,
} from "@/lib/schemas/trailer";
import type { ShortCropKeyframe, ShortFrameSlot } from "@/lib/schemas/video-short";

export type TrailerFramePosition = ShortCropKeyframe & { fit: "cover" | "contain" };
export type TrailerTransitionEffect = {
  opacity: number;
  translateX: number;
  translateY: number;
  scale: number;
};

export function createEmbeddedTrailerProject(trailer: PublishedTrailer): TrailerProject {
  if (trailer.sourceType !== "youtube" || !trailer.videoId || trailer.moments.length === 0) {
    throw new Error("This published trailer does not contain an embedded YouTube sequence.");
  }
  const firstFrame = trailer.moments[0].frameSlots?.[0];
  const legacyFrame = trailer.moments[0].frame;
  const sourceDurationSeconds = Math.max(...trailer.moments.map((moment) => moment.endSeconds));
  return TrailerProjectSchema.parse({
    slug: trailer.slug,
    title: trailer.title,
    source: {
      videoId: trailer.videoId,
      youtubeUrl: `https://www.youtube.com/watch?v=${trailer.videoId}`,
      videoTitle: trailer.videoTitle || trailer.title,
    },
    sourceDurationSeconds,
    transcript: [],
    moments: trailer.moments,
    aspectRatio: trailer.aspectRatio,
    fit: firstFrame?.fit ?? legacyFrame?.fit ?? "cover",
    cropX: legacyFrame?.cropX ?? 50,
    cropY: legacyFrame?.cropY ?? 50,
    zoom: legacyFrame?.zoom ?? 1,
    musicTracks: trailer.musicTracks,
    headline: trailer.headline,
    brandLine: trailer.brandLine,
    callToAction: trailer.callToAction,
    updatedAt: trailer.updatedAt,
  });
}

export function getTrailerTransitionEffect(
  moment: TrailerMoment,
  timeSeconds: number,
): TrailerTransitionEffect {
  const duration = moment.transitionDurationSeconds;
  const entryProgress = duration > 0
    ? Math.max(0, Math.min(1, (timeSeconds - moment.startSeconds) / duration))
    : 1;
  const exitProgress = duration > 0
    ? Math.max(0, Math.min(1, (moment.endSeconds - timeSeconds) / duration))
    : 1;
  const isEntering = moment.transitionIn !== "cut" && entryProgress < 1;
  const transition = isEntering ? moment.transitionIn : moment.transitionOut;
  const progress = isEntering ? entryProgress : exitProgress;
  const effect: TrailerTransitionEffect = { opacity: 1, translateX: 0, translateY: 0, scale: 1 };
  if (transition === "fade") {
    effect.opacity = progress;
  } else if (transition === "slide-left") {
    effect.translateX = progress - 1;
  } else if (transition === "slide-right") {
    effect.translateX = 1 - progress;
  } else if (transition === "slide-up") {
    effect.translateY = progress - 1;
  } else if (transition === "slide-down") {
    effect.translateY = 1 - progress;
  } else if (transition === "zoom-in") {
    effect.scale = isEntering ? 0.8 + progress * 0.2 : 1 + (1 - progress) * 0.2;
  } else if (transition === "zoom-out") {
    effect.scale = isEntering ? 1.2 - progress * 0.2 : 1 - (1 - progress) * 0.2;
  }
  return effect;
}

export function getTrailerFrameSlots(project: TrailerProject, momentIndex: number): ShortFrameSlot[] {
  const moment = project.moments[momentIndex];
  if (!moment) return [];
  if (moment.frameSlots) return [...moment.frameSlots].sort((first, second) => first.startSeconds - second.startSeconds);
  const frame = moment.frame ?? {
    fit: project.fit,
    cropX: project.cropX,
    cropY: project.cropY,
    zoom: project.zoom,
  };
  return [{
    startSeconds: moment.startSeconds,
    endSeconds: moment.endSeconds,
    aspectRatio: project.aspectRatio,
    fit: frame.fit,
    keyframes: [{
      timeSeconds: moment.startSeconds,
      x: frame.cropX,
      y: frame.cropY,
      zoom: frame.zoom,
      fit: frame.fit,
    }],
  }];
}

export function getTrailerFramePosition(slot: ShortFrameSlot, timeSeconds: number): TrailerFramePosition {
  const frames = [...slot.keyframes].sort((first, second) => first.timeSeconds - second.timeSeconds);
  if (frames.length === 0) return { timeSeconds, x: 50, y: 50, zoom: 1, fit: slot.fit };
  if (timeSeconds <= frames[0].timeSeconds) return { ...frames[0], fit: frames[0].fit ?? slot.fit };
  for (let index = 1; index < frames.length; index += 1) {
    const previous = frames[index - 1];
    const next = frames[index];
    if (timeSeconds < next.timeSeconds) {
      const progress = (timeSeconds - previous.timeSeconds)
        / Math.max(0.001, next.timeSeconds - previous.timeSeconds);
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

export function getTrailerFrameAtTime(project: TrailerProject, momentIndex: number, timeSeconds: number) {
  const slots = getTrailerFrameSlots(project, momentIndex);
  const slot = slots.find((item) =>
    timeSeconds >= item.startSeconds && timeSeconds <= item.endSeconds,
  ) ?? slots[0];
  return slot
    ? { slot, position: getTrailerFramePosition(slot, timeSeconds) }
    : null;
}

export function createTrailerFrameSlots(
  startSeconds: number,
  endSeconds: number,
  aspectRatio: ShortFrameSlot["aspectRatio"],
  position: TrailerFramePosition,
): ShortFrameSlot[] {
  return [{
    startSeconds,
    endSeconds,
    aspectRatio,
    fit: position.fit,
    keyframes: [{
      timeSeconds: startSeconds,
      x: position.x,
      y: position.y,
      zoom: position.zoom,
      fit: position.fit,
    }],
  }];
}

export function setTrailerFrameKeyframe(
  slots: ShortFrameSlot[],
  timeSeconds: number,
  patch: Partial<TrailerFramePosition>,
  persistFit = false,
): ShortFrameSlot[] {
  const selectedSlotIndex = slots.findIndex((slot) =>
    timeSeconds >= slot.startSeconds && timeSeconds <= slot.endSeconds,
  );
  if (selectedSlotIndex < 0) {
    throw new Error("The playhead is outside the selected framing slots.");
  }
  const slot = slots[selectedSlotIndex];
  const existingKeyframeIndex = slot.keyframes.findIndex((frame) =>
    Math.abs(frame.timeSeconds - timeSeconds) <= 0.001,
  );
  if (existingKeyframeIndex < 0 && slot.keyframes.length >= 100) {
    throw new Error("This framing slot has reached its 100-keyframe limit. Split the slot or edit an existing keyframe.");
  }

  const position = {
    ...getTrailerFramePosition(slot, timeSeconds),
    ...patch,
    timeSeconds,
  };
  return slots.map((currentSlot, slotIndex) => {
    if (slotIndex < selectedSlotIndex) return currentSlot;
    if (slotIndex > selectedSlotIndex) {
      if (!persistFit || !patch.fit) return currentSlot;
      return {
        ...currentSlot,
        fit: patch.fit,
        keyframes: currentSlot.keyframes.map((frame) => ({ ...frame, fit: patch.fit })),
      };
    }

    const keyframes = currentSlot.keyframes
      .filter((frame) => Math.abs(frame.timeSeconds - timeSeconds) > 0.001)
      .map((frame) => ({
        ...frame,
        ...(persistFit && patch.fit && frame.timeSeconds >= timeSeconds ? { fit: patch.fit } : {}),
      }));
    keyframes.push(position);
    keyframes.sort((first, second) => first.timeSeconds - second.timeSeconds);
    return {
      ...currentSlot,
      ...(persistFit && patch.fit ? { fit: patch.fit } : {}),
      keyframes,
    };
  });
}

export function splitTrailerFrameSlot(slots: ShortFrameSlot[], timeSeconds: number): ShortFrameSlot[] {
  const splitIndex = slots.findIndex((slot) =>
    timeSeconds >= slot.startSeconds && timeSeconds <= slot.endSeconds,
  );
  const slot = slots[splitIndex];
  if (!slot) throw new Error("The playhead is outside the selected framing slots.");
  if (slots.length >= 100) throw new Error("This moment cannot contain any more framing slots.");
  if (timeSeconds - slot.startSeconds < 0.5 || slot.endSeconds - timeSeconds < 0.5) {
    throw new Error("Move the playhead at least half a second inside the framing slot before splitting it.");
  }

  const position = getTrailerFramePosition(slot, timeSeconds);
  const leftKeyframes = slot.keyframes.filter((frame) => frame.timeSeconds < timeSeconds);
  const rightKeyframes = slot.keyframes.filter((frame) => frame.timeSeconds > timeSeconds);
  if (leftKeyframes.length >= 100 || rightKeyframes.length >= 100) {
    throw new Error("This slot has too many keyframes to split without losing crop positions.");
  }
  const leftSlot = {
    ...slot,
    endSeconds: timeSeconds,
    keyframes: [
      ...leftKeyframes,
      { ...position, timeSeconds },
    ],
  };
  const rightSlot = {
    ...slot,
    startSeconds: timeSeconds,
    keyframes: [
      { ...position, timeSeconds },
      ...rightKeyframes,
    ],
  };
  return [
    ...slots.slice(0, splitIndex),
    leftSlot,
    rightSlot,
    ...slots.slice(splitIndex + 1),
  ];
}

export function resizeTrailerFrameSlots(
  slots: ShortFrameSlot[],
  startSeconds: number,
  endSeconds: number,
): ShortFrameSlot[] {
  if (slots.length === 0) throw new Error("At least one framing slot is required to resize a trailer moment.");
  const sorted = [...slots].sort((first, second) => first.startSeconds - second.startSeconds);
  const boundaries = [
    startSeconds,
    ...sorted.flatMap((slot) => [slot.startSeconds, slot.endSeconds])
      .filter((time) => time > startSeconds && time < endSeconds),
    endSeconds,
  ].sort((first, second) => first - second).filter((time, index, values) =>
    index === 0 || time - values[index - 1] > 0.001,
  );
  return boundaries.slice(0, -1).flatMap((slotStart, index) => {
    const slotEnd = boundaries[index + 1];
    if (slotEnd <= slotStart) return [];
    const midpoint = (slotStart + slotEnd) / 2;
    const source = sorted.find((slot) => midpoint >= slot.startSeconds && midpoint <= slot.endSeconds)
      ?? (midpoint < sorted[0].startSeconds ? sorted[0] : sorted[sorted.length - 1]);
    const samplePosition = (timeSeconds: number) =>
      getTrailerFramePosition(source, Math.max(source.startSeconds, Math.min(source.endSeconds, timeSeconds)));
    const keyframes = [
      { ...samplePosition(slotStart), timeSeconds: slotStart },
      ...source.keyframes.filter((frame) => frame.timeSeconds > slotStart && frame.timeSeconds < slotEnd),
      { ...samplePosition(slotEnd), timeSeconds: slotEnd },
    ].sort((first, second) => first.timeSeconds - second.timeSeconds)
      .filter((frame, frameIndex, frames) =>
        frameIndex === 0 || frame.timeSeconds - frames[frameIndex - 1].timeSeconds > 0.001,
      );
    if (keyframes.length > 100) {
      throw new Error("This moment has too many crop keyframes to resize without losing positions.");
    }
    return [{ ...source, startSeconds: slotStart, endSeconds: slotEnd, keyframes }];
  });
}
