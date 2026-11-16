import type { ErrorEvent } from "@sentry/react";
import { expect, test } from "vitest";

import { beforeBreadcrumbClient, beforeSendClientEvent } from "#src/client-before-send.ts";

const SIGNED_MEDIA_URL =
  "https://cup.audio/api/files/audiobooks/c1/cover-image?token=v1.secret&w=2";
const MASKED_MEDIA_URL =
  "https://cup.audio/api/files/audiobooks/c1/cover-image?token=[Filtered]&w=2";

test("an event keeps only the user ID, without an IP address, and no device identifiers", () => {
  const event: ErrorEvent = {
    type: undefined,
    message: "Playback failed",
    user: { id: "3f0c1f9e-8f5e-4d4e-9d3a-0c2f1b6a7e11", email: "a@example.com", username: "a" },
    contexts: {
      device: { id: "6c0f3d6ae3b54f7b9a1c2d3e4f5a6b7c", model: "iPhone15,3" },
      app: { device_app_hash: "ab12", app_version: "1.0" },
      os: { name: "iOS" },
    },
  };

  expect(beforeSendClientEvent(event, {})).toEqual({
    type: undefined,
    message: "Playback failed",
    user: { id: "3f0c1f9e-8f5e-4d4e-9d3a-0c2f1b6a7e11", ip_address: null },
    contexts: {
      device: { model: "iPhone15,3" },
      app: { app_version: "1.0" },
      os: { name: "iOS" },
    },
  });
});

test("an event without a user still nulls the IP address", () => {
  expect(beforeSendClientEvent({ type: undefined }, {})).toEqual({
    type: undefined,
    user: { ip_address: null },
  });
});

test("an event masks credential query parameters in its URLs, messages and breadcrumbs", () => {
  const event: ErrorEvent = {
    type: undefined,
    message: `Could not load ${SIGNED_MEDIA_URL}`,
    request: { url: SIGNED_MEDIA_URL, query_string: "token=v1.secret&w=2" },
    exception: {
      values: [{ type: "Error", value: `Request to ${SIGNED_MEDIA_URL} failed` }],
    },
    breadcrumbs: [
      { category: "fetch", data: { url: SIGNED_MEDIA_URL, method: "GET" } },
      { category: "navigation", data: { from: "/app/?code=abc", to: "/app/recent" } },
    ],
  };

  expect(beforeSendClientEvent(event, {})).toEqual({
    type: undefined,
    message: `Could not load ${MASKED_MEDIA_URL}`,
    request: { url: MASKED_MEDIA_URL, query_string: "token=[Filtered]&w=2" },
    exception: {
      values: [{ type: "Error", value: `Request to ${MASKED_MEDIA_URL} failed` }],
    },
    breadcrumbs: [
      { category: "fetch", data: { url: MASKED_MEDIA_URL, method: "GET" } },
      { category: "navigation", data: { from: "/app/?code=[Filtered]", to: "/app/recent" } },
    ],
    user: { ip_address: null },
  });
});

test("an auth error that Sentry's Supabase integration captured is dropped", () => {
  const event: ErrorEvent = {
    type: undefined,
    exception: {
      values: [
        {
          type: "AuthApiError",
          value: "Invalid Refresh Token",
          mechanism: { type: "auto.db.supabase.auth", handled: false },
        },
      ],
    },
  };

  expect(beforeSendClientEvent(event, {})).toBeNull();
});

test("an error that Cup captured is kept", () => {
  const event: ErrorEvent = {
    type: undefined,
    exception: {
      values: [
        { type: "Error", value: "Failed to initialize Android share intake" },
        { type: "Error", value: "Plugin not available", mechanism: { type: "generic" } },
      ],
    },
  };

  expect(beforeSendClientEvent(event, {})).not.toBeNull();
});

test("a breadcrumb masks credential query parameters in its message and data", () => {
  expect(
    beforeBreadcrumbClient({
      category: "console",
      message: `GET ${SIGNED_MEDIA_URL}`,
      data: { url: SIGNED_MEDIA_URL, status_code: 403 },
    }),
  ).toEqual({
    category: "console",
    message: `GET ${MASKED_MEDIA_URL}`,
    data: { url: MASKED_MEDIA_URL, status_code: 403 },
  });
});
