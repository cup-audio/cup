import type { NarrationTrack } from "@cup/listener-api.routes";

export type AudiobookTimeline = Pick<NarrationTrack, "startMilliseconds" | "durationMilliseconds">;

export function findUnitIndexAt(timeline: AudiobookTimeline, positionMilliseconds: number) {
  let low = 0;
  let high = timeline.startMilliseconds.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (timeline.startMilliseconds[middle]! <= positionMilliseconds) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  return low;
}

export function clampToTimeline(timeline: AudiobookTimeline, positionMilliseconds: number) {
  return Math.min(
    Math.max(0, positionMilliseconds),
    Math.max(0, timeline.durationMilliseconds - 1),
  );
}
