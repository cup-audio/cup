export type Swipe = {
  readonly startX: number;
  readonly startY: number;
  readonly endX: number;
  readonly endY: number;
};

export type DeliveredSwipe = {
  readonly lastMoveY: number;
  readonly lastMoveToReleaseMilliseconds: number;
};

type QueuedTouch = {
  readonly action: string;
  readonly eventTimeMilliseconds: number;
  readonly x: number;
  readonly y: number;
};

const COORDINATE_TOLERANCE = 1;

export function readDeliveredSwipe(dumpsysInput: string, swipe: Swipe): DeliveredSwipe | undefined {
  const touches = readRecentTouches(dumpsysInput);
  const releaseIndex = touches.findLastIndex((touch) => touch.action === "UP");
  const release = touches[releaseIndex];
  if (release === undefined || !isAt(release, swipe.endX, swipe.endY)) {
    return undefined;
  }

  const touchesBeforeRelease = touches.slice(0, releaseIndex);
  const downIndex = touchesBeforeRelease.findLastIndex((touch) => touch.action === "DOWN");
  const down = touchesBeforeRelease[downIndex];
  if (down === undefined || !isAt(down, swipe.startX, swipe.startY)) {
    return undefined;
  }

  const lastMove = touchesBeforeRelease
    .slice(downIndex + 1)
    .findLast((touch) => touch.action === "MOVE");
  if (lastMove === undefined) {
    return undefined;
  }
  return {
    lastMoveY: lastMove.y,
    lastMoveToReleaseMilliseconds: release.eventTimeMilliseconds - lastMove.eventTimeMilliseconds,
  };
}

export function readRecentQueue(dumpsysInput: string): string {
  return /RecentQueue:[^\n]*\n((?: {4}[^\n]*\n)*)/u.exec(dumpsysInput)?.[1] ?? "";
}

function readRecentTouches(dumpsysInput: string): QueuedTouch[] {
  return [
    ...readRecentQueue(dumpsysInput).matchAll(
      /MotionEvent\([^\n]*?eventTime=(\d+), source=TOUCHSCREEN,[^\n]*?action=(\w+),[^\n]*?pointers=\[0: \((-?[\d.]+), (-?[\d.]+)\)/gu,
    ),
  ].map(([, eventTimeNanoseconds, action, x, y]) => ({
    action: action ?? "",
    eventTimeMilliseconds: Number(eventTimeNanoseconds) / 1_000_000,
    x: Number(x),
    y: Number(y),
  }));
}

function isAt(touch: QueuedTouch, x: number, y: number): boolean {
  return (
    Math.abs(touch.x - x) <= COORDINATE_TOLERANCE && Math.abs(touch.y - y) <= COORDINATE_TOLERANCE
  );
}
