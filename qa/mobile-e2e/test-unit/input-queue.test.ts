import { expect, test } from "vitest";

import { readDeliveredSwipe, readRecentQueue } from "#src/android/input-queue.ts";

const SWIPE = { startX: 540, startY: 1193, endX: 540, endY: 0 };

function touch(eventTimeMilliseconds: number, action: string, x: number, y: number): string {
  return `    MotionEvent(deviceId=-1, eventTime=${eventTimeMilliseconds * 1_000_000}, source=TOUCHSCREEN, displayId=0, action=${action}, actionButton=0x00000000, flags=0x00000000, metaState=0x00000000, buttonState=0x00000000, classification=NONE, edgeFlags=0x00000000, xPrecision=1.0, yPrecision=1.0, xCursorPosition=nan, yCursorPosition=nan, pointers=[0: (${x.toFixed(1)}, ${y.toFixed(1)})]), policyFlags=0x6b000000, age=80ms`;
}

function dumpsysInput(touches: readonly string[]): string {
  return [
    "Input Dispatcher State:",
    `  RecentQueue: length=${touches.length}`,
    ...touches,
    "  PendingEvent: <none>",
    "  InboundQueue: <empty>",
    "",
  ].join("\n");
}

test("a swipe whose release came long after its last move reports that gap", () => {
  const dumpsys = dumpsysInput([
    touch(352_900, "DOWN", 540, 1193),
    touch(352_908, "MOVE", 540, 1100),
    touch(352_921, "MOVE", 540, 900),
    touch(352_956, "MOVE", 540, 700),
    touch(352_979, "MOVE", 540, 346),
    touch(353_055, "UP", 540, 0),
  ]);

  expect(readDeliveredSwipe(dumpsys, SWIPE)).toStrictEqual({
    lastMoveY: 346,
    lastMoveToReleaseMilliseconds: 76,
  });
});

test("a swipe whose release closely followed its last move reports the short gap", () => {
  const dumpsys = dumpsysInput([
    touch(352_900, "DOWN", 540, 1193),
    touch(352_960, "MOVE", 540, 400),
    touch(353_126, "MOVE", 540, 53.7),
    touch(353_147, "UP", 540, 0),
  ]);

  expect(readDeliveredSwipe(dumpsys, SWIPE)).toStrictEqual({
    lastMoveY: 53.7,
    lastMoveToReleaseMilliseconds: 21,
  });
});

test("only the latest swipe counts when the queue holds an earlier one", () => {
  const dumpsys = dumpsysInput([
    touch(100_000, "DOWN", 540, 1193),
    touch(100_100, "MOVE", 540, 50),
    touch(100_120, "UP", 540, 0),
    touch(200_000, "DOWN", 540, 1193),
    touch(200_100, "MOVE", 540, 300),
    touch(200_200, "UP", 540, 0),
  ]);

  expect(readDeliveredSwipe(dumpsys, SWIPE)).toStrictEqual({
    lastMoveY: 300,
    lastMoveToReleaseMilliseconds: 100,
  });
});

test("a swipe whose start fell out of the ten-event queue counts as delivered when every queued move lies on its path", () => {
  const dumpsys = dumpsysInput([
    touch(352_961, "MOVE", 540, 1037.9),
    touch(352_975, "MOVE", 540, 954.4),
    touch(352_993, "MOVE", 540, 847),
    touch(353_017, "MOVE", 540, 703.9),
    touch(353_035, "MOVE", 540, 596.5),
    touch(353_052, "MOVE", 540, 495.1),
    touch(353_086, "MOVE", 540, 292.3),
    touch(353_109, "MOVE", 540, 155.1),
    touch(353_126, "MOVE", 540, 53.7),
    touch(353_147, "UP", 540, 0),
  ]);

  expect(readDeliveredSwipe(dumpsys, SWIPE)).toStrictEqual({
    lastMoveY: 53.7,
    lastMoveToReleaseMilliseconds: 21,
  });
});

test("a move off the swipe's path is not reported as delivered", () => {
  const dumpsys = dumpsysInput([
    touch(352_956, "MOVE", 774, 700),
    touch(352_979, "MOVE", 540, 346),
    touch(353_055, "UP", 540, 0),
  ]);

  expect(readDeliveredSwipe(dumpsys, SWIPE)).toBeUndefined();
});

test("moves that follow another gesture's release are not reported as delivered", () => {
  const dumpsys = dumpsysInput([
    touch(352_900, "UP", 540, 1193),
    touch(352_979, "MOVE", 540, 346),
    touch(353_055, "UP", 540, 0),
  ]);

  expect(readDeliveredSwipe(dumpsys, SWIPE)).toBeUndefined();
});

test("a swipe that started elsewhere is not reported as delivered", () => {
  const dumpsys = dumpsysInput([
    touch(352_900, "DOWN", 540, 1500),
    touch(352_979, "MOVE", 540, 346),
    touch(353_055, "UP", 540, 0),
  ]);

  expect(readDeliveredSwipe(dumpsys, SWIPE)).toBeUndefined();
});

test("a release elsewhere than the swipe's end is not reported as delivered", () => {
  const dumpsys = dumpsysInput([
    touch(352_900, "DOWN", 540, 1193),
    touch(352_979, "MOVE", 540, 346),
    touch(353_055, "UP", 540, 346),
  ]);

  expect(readDeliveredSwipe(dumpsys, SWIPE)).toBeUndefined();
});

test("a queue without the swipe's release is not reported as delivered", () => {
  const dumpsys = dumpsysInput([
    touch(352_900, "DOWN", 540, 1193),
    touch(352_979, "MOVE", 540, 346),
  ]);

  expect(readDeliveredSwipe(dumpsys, SWIPE)).toBeUndefined();
});

test("the recent queue is the indented block under its heading", () => {
  const line = touch(353_055, "UP", 540, 0);

  expect(readRecentQueue(dumpsysInput([line]))).toBe(`${line}\n`);
});
