import { expect, test } from "vitest";

import { maskSpanUrls, maskUrl, maskEventUrls } from "#src/url-masking.ts";

test("masks every credential query parameter of a URL and keeps the rest", () => {
  expect(
    maskUrl(
      "https://cup.audio/api/files/audiobooks/c1/cover-image?token=v1.abc.def&size=large&sig=s&signature=t&key=k&auth=a&code=c&access_token=at#part",
    ),
  ).toBe(
    "https://cup.audio/api/files/audiobooks/c1/cover-image?token=[Filtered]&size=large&sig=[Filtered]&signature=[Filtered]&key=[Filtered]&auth=[Filtered]&code=[Filtered]&access_token=[Filtered]#part",
  );
});

test("masks credential parameters in a bare query string, a relative URL and inside text", () => {
  expect(maskUrl("token=abc&page=2")).toBe("token=[Filtered]&page=2");
  expect(maskUrl("/app/auth/callback?code=xyz")).toBe("/app/auth/callback?code=[Filtered]");
  expect(maskUrl("GET https://cup.audio/x?Token=abc failed")).toBe(
    "GET https://cup.audio/x?Token=[Filtered] failed",
  );
});

test("leaves parameters alone whose name only contains a credential name", () => {
  expect(maskUrl("https://cup.audio/x?monkey=1&keyboard=2&barcode=3")).toBe(
    "https://cup.audio/x?monkey=1&keyboard=2&barcode=3",
  );
});

test("the span hook masks URLs in the span name and in string attributes", () => {
  const span = {
    trace_id: "0".repeat(32),
    span_id: "0".repeat(16),
    name: "GET /api/files/audiobooks/c1/narration-track.mp3?token=secret",
    start_timestamp: 1,
    status: "ok" as const,
    is_segment: true,
    attributes: {
      "url.full": "https://cup.audio/api/files/audiobooks/c1/narration-track.mp3?token=secret",
      "url.query": "token=secret",
      "http.request.header.referer": { value: "https://cup.audio/app/?code=abc", type: "string" },
      "http.response.status_code": 200,
    },
  };

  expect(maskSpanUrls(span)).toEqual({
    ...span,
    name: "GET /api/files/audiobooks/c1/narration-track.mp3?token=[Filtered]",
    attributes: {
      "url.full": "https://cup.audio/api/files/audiobooks/c1/narration-track.mp3?token=[Filtered]",
      "url.query": "token=[Filtered]",
      "http.request.header.referer": {
        value: "https://cup.audio/app/?code=[Filtered]",
        type: "string",
      },
      "http.response.status_code": 200,
    },
  });
});

test("the event masking masks URLs in the message, the request, the exception values and the breadcrumbs", () => {
  const masked = maskEventUrls({
    message: "Could not read https://cup.audio/x?token=secret",
    request: { url: "https://cup.audio/x?code=secret&size=2", query_string: "code=secret&size=2" },
    exception: { values: [{ type: "Error", value: "Failed: /x?sig=secret" }, { type: "Error" }] },
    breadcrumbs: [
      {
        message: "GET /x?key=secret",
        data: { url: "/x?auth=secret", from: "/a?token=secret", to: "/b", status_code: 500 },
      },
    ],
  });

  expect(masked).toEqual({
    message: "Could not read https://cup.audio/x?token=[Filtered]",
    request: {
      url: "https://cup.audio/x?code=[Filtered]&size=2",
      query_string: "code=[Filtered]&size=2",
    },
    exception: {
      values: [{ type: "Error", value: "Failed: /x?sig=[Filtered]" }, { type: "Error" }],
    },
    breadcrumbs: [
      {
        message: "GET /x?key=[Filtered]",
        data: {
          url: "/x?auth=[Filtered]",
          from: "/a?token=[Filtered]",
          to: "/b",
          status_code: 500,
        },
      },
    ],
  });
});

test("the event masking masks a query string parsed into entries or a record", () => {
  const entries: [string, string][] = [
    ["token", "secret"],
    ["size", "2"],
  ];

  expect(maskEventUrls({ request: { query_string: entries } }).request?.query_string).toEqual([
    ["token", "[Filtered]"],
    ["size", "2"],
  ]);
  expect(
    maskEventUrls({ request: { query_string: { token: "secret", size: "2" } } }).request
      ?.query_string,
  ).toEqual({ token: "[Filtered]", size: "2" });
});
