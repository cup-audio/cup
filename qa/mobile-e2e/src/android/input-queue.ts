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
  readonly action: "DOWN" | "MOVE" | "UP" | "OTHER";
  readonly eventTimeMilliseconds: number;
  readonly x: number;
  readonly y: number;
};

const COORDINATE_TOLERANCE = 1;

export function readDeliveredSwipe(dumpsysInput: string, swipe: Swipe): DeliveredSwipe | undefined {
  const touches = readRecentTouches(dumpsysInput);
  const releaseIndex = touches.findLastIndex((touch) => touch.action === "UP");
  const release = touches[releaseIndex];
  const lastMove = touches[releaseIndex - 1];
  if (
    release === undefined ||
    !isAt(release, swipe.endX, swipe.endY) ||
    lastMove?.action !== "MOVE"
  ) {
    return undefined;
  }

  for (const touch of touches.slice(0, releaseIndex).toReversed()) {
    if (touch.action === "DOWN") {
      if (!isAt(touch, swipe.startX, swipe.startY)) {
        return undefined;
      }
      break;
    }
    if (touch.action !== "MOVE" || !isOnPath(touch, swipe)) {
      return undefined;
    }
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
    action: toTouchAction(action),
    eventTimeMilliseconds: Number(eventTimeNanoseconds) / 1_000_000,
    x: Number(x),
    y: Number(y),
  }));
}

function toTouchAction(action: string | undefined): QueuedTouch["action"] {
  return action === "DOWN" || action === "MOVE" || action === "UP" ? action : "OTHER";
}

function isAt(touch: QueuedTouch, x: number, y: number): boolean {
  return (
    Math.abs(touch.x - x) <= COORDINATE_TOLERANCE && Math.abs(touch.y - y) <= COORDINATE_TOLERANCE
  );
}

function isOnPath(touch: QueuedTouch, swipe: Swipe): boolean {
  const [topY, bottomY] = [Math.min(swipe.startY, swipe.endY), Math.max(swipe.startY, swipe.endY)];
  return (
    Math.abs(touch.x - swipe.startX) <= COORDINATE_TOLERANCE &&
    touch.y >= topY - COORDINATE_TOLERANCE &&
    touch.y <= bottomY + COORDINATE_TOLERANCE
  );
}
