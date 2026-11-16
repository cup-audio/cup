import { expect, test } from "vitest";

import { beforeSendLog } from "#src/log-events.ts";

test("drops logs below info", () => {
  expect(beforeSendLog({ level: "debug", message: "Cache miss" })).toBeNull();
  expect(beforeSendLog({ level: "trace", message: "Entered handler" })).toBeNull();
});

test("keeps info and higher", () => {
  for (const level of ["info", "warn", "error", "fatal"] as const) {
    expect(beforeSendLog({ level, message: "Kept" })).toEqual({ level, message: "Kept" });
  }
});

test("masks credentials in the message and the attributes", () => {
  expect(
    beforeSendLog({
      level: "warn",
      message: "Could not load https://cup.audio/a?token=v1.secret",
      attributes: {
        "event.name": "cover-image-unavailable",
        "exception.stacktrace": "Error: GET https://x.test/i.png?sig=abc failed",
        "cup.exception.chain": ["Error"],
        "cup.audio_segment.sequence": 3,
      },
    }),
  ).toEqual({
    level: "warn",
    message: "Could not load https://cup.audio/a?token=[Filtered]",
    attributes: {
      "event.name": "cover-image-unavailable",
      "exception.stacktrace": "Error: GET https://x.test/i.png?sig=[Filtered] failed",
      "cup.exception.chain": ["Error"],
      "cup.audio_segment.sequence": 3,
    },
  });
});
