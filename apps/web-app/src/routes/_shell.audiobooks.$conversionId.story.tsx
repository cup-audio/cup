import { createMemoryHistory } from "@tanstack/react-router";
import { delay, http, HttpResponse } from "msw";
import React from "react";

import type {
  Audiobook,
  ErrorResponse,
  PlaybackPosition,
  PreparationPhase,
  RetryConversionResponse,
} from "@cup/listener-api.routes";

import { createAppRouter, GlobalProviders } from "#src/app/global-providers.js";
import { queryClient } from "#src/data-fetching/query-client.js";
import { createAudiobookQuery } from "#src/data-fetching/reader.js";
import { accountStory } from "#src/ui-gallery/account-fixtures.jsx";
import gatesNotesAudiobook from "#src/ui-gallery/gates-notes-audiobook.json" with { type: "json" };
import { holdStoryResponses, waitWhileHeld } from "#src/ui-gallery/held-responses.js";
import { createStoryNarrationTrack } from "#src/ui-gallery/narration-track.js";
import type { Story } from "#src/ui-gallery/story.js";

const CONVERSION_ID = "693af4c4-9fa8-430d-9dc5-c00e88fb38a7";
const SOURCE_URL = "https://source.example.test/fixture";
const SEGMENT_DURATION_MILLISECONDS = 5_000;
const memoryHistory = createMemoryHistory({ initialEntries: [`/app/audiobooks/${CONVERSION_ID}`] });
const router = createAppRouter(memoryHistory);

export const ReadyAudiobook = {
  beforeMount: async () => {
    await queryClient.fetchQuery(createAudiobookQuery(CONVERSION_ID));
    await router.load();
  },
  component: () => <GlobalProviders router={router} />,
  handlers: [
    http.get(`/api/audiobooks/${CONVERSION_ID}`, () => HttpResponse.json(createAudiobook())),
  ],
} satisfies Story;

const GATES_NOTES_CONVERSION_ID = "7b1736db-31f7-46ba-b6b5-d965770b355b";
// The local fixture uses createNarrationDocument on the Gates Notes E2E article's source title, source subtitle and body.
const gatesNotesRouter = createAppRouter(
  createMemoryHistory({ initialEntries: [`/app/audiobooks/${GATES_NOTES_CONVERSION_ID}`] }),
);

export const GatesNotesArticle = {
  beforeMount: async () => {
    await queryClient.fetchQuery(createAudiobookQuery(GATES_NOTES_CONVERSION_ID));
    await gatesNotesRouter.load();
  },
  component: () => <GlobalProviders router={gatesNotesRouter} />,
  handlers: [
    http.get(`/api/audiobooks/${GATES_NOTES_CONVERSION_ID}`, () =>
      HttpResponse.json({
        ...gatesNotesAudiobook,
        status: "ready",
        segments: gatesNotesAudiobook.narrationDocument.synchronizationUnits.map(
          (_unit, sequence) => createReadySegment(sequence),
        ),
        narrationTrack: createStoryNarrationTrack(
          gatesNotesAudiobook.narrationDocument.synchronizationUnits.map(
            () => SEGMENT_DURATION_MILLISECONDS,
          ),
        ),
      } satisfies Audiobook),
    ),
  ],
} satisfies Story;

const SECOND_CONVERSION_ID = "c4be3f43-4a43-4d6b-9a3f-6f0d2f6e2d51";
const COVER_URL = `${window.location.origin}/__story/covers/detail.svg`;

/** A signed-in listener opens a long audiobook with a cover. */
export const AccountAudiobook = createGatesNotesAccountStory({
  items: [createRecentsItem(GATES_NOTES_CONVERSION_ID, gatesNotesAudiobook.title)],
  nextCursor: null,
});

/**
 * A signed-in listener opens a trial audiobook they can also open, such as one converted before
 * signing in. Their account history does not list it.
 */
export const AccountOpensTrialAudiobook = createGatesNotesAccountStory({
  items: [createRecentsItem(SECOND_CONVERSION_ID, "A second document about listening")],
  nextCursor: null,
});

/** The audiobook is older than the first page of the account history lists. */
export const AccountAudiobookOnLaterHistoryPage = accountStory({
  path: `/audiobooks/${CONVERSION_ID}`,
  handlers: [
    http.get(`/api/audiobooks/${CONVERSION_ID}`, () => HttpResponse.json(createAudiobook())),
    http.get("/api/account/conversions", ({ request }) =>
      HttpResponse.json(
        new URL(request.url).searchParams.has("cursor")
          ? {
              items: [createRecentsItem(CONVERSION_ID, PREPARED_AUDIOBOOK.title)],
              nextCursor: null,
            }
          : {
              items: [createRecentsItem(SECOND_CONVERSION_ID, "A second document about listening")],
              nextCursor: "later-page",
            },
      ),
    ),
  ],
});

function createGatesNotesAccountStory(recents: {
  items: Record<string, unknown>[];
  nextCursor: string | null;
}) {
  return accountStory({
    path: `/audiobooks/${GATES_NOTES_CONVERSION_ID}`,
    recents,
    handlers: [
      http.get(`/api/audiobooks/${GATES_NOTES_CONVERSION_ID}`, () =>
        HttpResponse.json({
          ...gatesNotesAudiobook,
          status: "ready",
          coverImage: { url: COVER_URL, alternativeText: "A person reading by a window" },
          segments: gatesNotesAudiobook.narrationDocument.synchronizationUnits.map(
            (_unit, sequence) => createReadySegment(sequence),
          ),
          narrationTrack: createStoryNarrationTrack(
            gatesNotesAudiobook.narrationDocument.synchronizationUnits.map(
              () => SEGMENT_DURATION_MILLISECONDS,
            ),
          ),
        } satisfies Audiobook),
      ),
      http.get(
        COVER_URL,
        () =>
          new HttpResponse(
            '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#5b7f95"/><circle cx="200" cy="100" r="60" fill="#fff"/></svg>',
            { headers: { "Content-Type": "image/svg+xml" } },
          ),
      ),
      http.put(
        `/api/audiobooks/${GATES_NOTES_CONVERSION_ID}/position`,
        () => new HttpResponse(null, { status: 204 }),
      ),
      http.post(`/api/audiobooks/${GATES_NOTES_CONVERSION_ID}/retry`, () =>
        HttpResponse.json({ result: "started" } satisfies RetryConversionResponse),
      ),
    ],
  });
}

/** The first response never arrives. */
export const LoadingAudiobook = {
  component: () => <GlobalProviders router={router} />,
  handlers: [
    http.get(`/api/audiobooks/${CONVERSION_ID}`, async () => {
      await delay("infinite");
    }),
  ],
} satisfies Story;

export const AudiobookNotFound = {
  component: () => <GlobalProviders router={router} />,
  handlers: [
    http.get(`/api/audiobooks/${CONVERSION_ID}`, () =>
      HttpResponse.json(
        {
          error: {
            traceId: "0af7651916cd43dd8448eb211c80319c",
            code: "audiobook-not-found",
            message: "Track not found.",
          },
        } satisfies ErrorResponse,
        { status: 404 },
      ),
    ),
  ],
} satisfies Story;

/** The first response fails; trying again finds the conversion still being prepared. */
export const AudiobookLoadError = {
  component: () => <GlobalProviders router={router} />,
  handlers: [
    http.get(
      `/api/audiobooks/${CONVERSION_ID}`,
      () =>
        HttpResponse.json(
          {
            error: {
              traceId: "0af7651916cd43dd8448eb211c80319c",
              code: "operational-error",
              message: "The audiobook could not be loaded.",
            },
          } satisfies ErrorResponse,
          { status: 500 },
        ),
      { once: true },
    ),
    http.get(`/api/audiobooks/${CONVERSION_ID}`, () =>
      HttpResponse.json({
        status: "pending",
        originalUrl: "https://example.com/article",
        canGenerate: true,
      } satisfies Audiobook),
    ),
  ],
} satisfies Story;

/** A signed-in listener moves between an audiobook, Recents, and a second audiobook. */
export const ListeningAcrossPages = createListeningAcrossPagesStory({
  secondUnitDurationMilliseconds: SEGMENT_DURATION_MILLISECONDS,
  secondPlaybackPosition: null,
});

/**
 * Like `ListeningAcrossPages`, but the listener stopped 12 s into the second audiobook, whose units
 * last 10 s each.
 */
export const ResumingAcrossPages = createListeningAcrossPagesStory({
  secondUnitDurationMilliseconds: 10_000,
  secondPlaybackPosition: { synchronizationUnitId: "unit-2", offsetMilliseconds: 2_000 },
});

function createListeningAcrossPagesStory({
  secondUnitDurationMilliseconds,
  secondPlaybackPosition,
}: {
  secondUnitDurationMilliseconds: number;
  secondPlaybackPosition: PlaybackPosition | null;
}) {
  return accountStory({
    path: `/audiobooks/${CONVERSION_ID}`,
    recents: {
      items: [
        createRecentsItem(CONVERSION_ID, "A deterministic document about careful testing"),
        createRecentsItem(SECOND_CONVERSION_ID, "A second document about listening"),
      ],
      nextCursor: null,
    },
    handlers: [
      http.get(`/api/audiobooks/${CONVERSION_ID}`, async () => {
        await waitWhileHeld(`audiobook:${CONVERSION_ID}`);
        return HttpResponse.json(createAudiobook());
      }),
      http.get(`/api/audiobooks/${SECOND_CONVERSION_ID}`, () =>
        HttpResponse.json({
          ...PREPARED_AUDIOBOOK,
          status: "ready",
          playbackPosition: secondPlaybackPosition,
          title: "A second document about listening",
          segments: [0, 1, 2].map(createReadySegment),
          narrationTrack: createStoryNarrationTrack(
            [
              secondUnitDurationMilliseconds,
              secondUnitDurationMilliseconds,
              secondUnitDurationMilliseconds,
            ],
            "second",
          ),
        } satisfies Audiobook),
      ),
      http.put(
        "/api/audiobooks/:conversionId/position",
        () => new HttpResponse(null, { status: 204 }),
      ),
    ],
  });
}

function createRecentsItem(conversionId: string, title: string) {
  return {
    conversionId,
    sourceUrl: SOURCE_URL,
    createdAtMs: 0,
    idempotencyKey: conversionId,
    status: "ready",
    outcome: { status: "ready", title },
  };
}

function createReadySegment(sequence: number) {
  return { sequence, status: "ready" as const };
}

const PREPARED_AUDIOBOOK = {
  canGenerate: true,
  playbackPosition: null,
  title: "A deterministic document about careful testing",
  originalUrl: SOURCE_URL,
  narrationDocument: {
    html: '<article><h1 id="unit-1">A deterministic document about careful testing</h1><p id="unit-2">Keep the important boundaries real.</p><p id="unit-3">Replace only what you cannot control.</p></article>',
    synchronizationUnits: [
      { id: "unit-1", narrationText: "A deterministic document about careful testing" },
      { id: "unit-2", narrationText: "Keep the important boundaries real." },
      { id: "unit-3", narrationText: "Replace only what you cannot control." },
    ],
  },
};

function createAudiobook(): Audiobook {
  return {
    ...PREPARED_AUDIOBOOK,
    status: "ready",
    segments: [createReadySegment(0), createReadySegment(1), createReadySegment(2)],
    narrationTrack: createStoryNarrationTrack([
      SEGMENT_DURATION_MILLISECONDS,
      SEGMENT_DURATION_MILLISECONDS,
      SEGMENT_DURATION_MILLISECONDS,
    ]),
  };
}

function createPreparedStory(audiobook: Audiobook) {
  return {
    component: () => <GlobalProviders router={router} />,
    handlers: [
      http.get(`/api/audiobooks/${CONVERSION_ID}`, () => HttpResponse.json(audiobook)),
      // The allowance was spent elsewhere, so a retry of the missing audio is refused.
      http.post(`/api/audiobooks/${CONVERSION_ID}/retry`, () =>
        HttpResponse.json({
          result: "insufficient-duration",
          requiredMilliseconds: 3_000,
          availableMilliseconds: 1_000,
        } satisfies RetryConversionResponse),
      ),
    ],
  } satisfies Story;
}

/** The audiobook offers no retry, such as once a trial no longer permits speech generation. */
export const AudiobookWithoutRetry = createPreparedStory({
  ...createAudiobook(),
  canGenerate: false,
});

export const SynthesizingAudiobook = createPreparedStory({
  ...PREPARED_AUDIOBOOK,
  status: "synthesizing",
  segments: [
    createReadySegment(0),
    { sequence: 1, status: "generating" },
    { sequence: 2, status: "generating" },
  ],
});

export const InsufficientDuration = createPreparedStory({
  ...PREPARED_AUDIOBOOK,
  status: "insufficient-duration",
  requiredMilliseconds: 754_000,
  availableMilliseconds: 95_000,
  segments: [
    { sequence: 0, status: "absent" },
    { sequence: 1, status: "absent" },
    { sequence: 2, status: "absent" },
  ],
});

/** Duration was freed after generation was refused, so the audio waits for a Retry. */
export const AudiobookNotYetGenerated = createPreparedStory({
  ...PREPARED_AUDIOBOOK,
  status: "insufficient-duration",
  requiredMilliseconds: 95_000,
  availableMilliseconds: 754_000,
  segments: [
    { sequence: 0, status: "absent" },
    { sequence: 1, status: "absent" },
    { sequence: 2, status: "absent" },
  ],
});

export const AudiobookWithoutAudio = createPreparedStory({
  ...PREPARED_AUDIOBOOK,
  status: "ready",
  segments: [0, 1, 2].map((sequence) => ({
    sequence,
    status: "failed" as const,
    explanation: "The provider is unavailable.",
  })),
});

export const AudiobookWithFailedSegment = createPreparedStory({
  ...PREPARED_AUDIOBOOK,
  status: "ready",
  segments: [
    createReadySegment(0),
    { sequence: 1, status: "failed", explanation: "The provider rejected this text." },
    createReadySegment(2),
  ],
});

function createPendingStory(preparationPhase?: PreparationPhase) {
  return {
    component: () => <GlobalProviders router={router} />,
    handlers: [
      http.get(`/api/audiobooks/${CONVERSION_ID}`, () =>
        HttpResponse.json({
          status: "pending",
          originalUrl: "https://example.com/article",
          canGenerate: true,
          ...(preparationPhase && { preparationPhase }),
        } satisfies Audiobook),
      ),
    ],
  } satisfies Story;
}

/** A conversion whose phase is not reported, or not known to this client. */
export const PendingConversion = createPendingStory();
export const PendingStarting = createPendingStory("starting");
export const PendingReadingPage = createPendingStory("reading-page");
export const PendingSelectingContent = createPendingStory("selecting-content");
export const PendingPreparingText = createPendingStory("preparing-text");

/** The first poll finds the conversion prepared, which brings in its title. */
export const PendingConversionGetsPrepared = {
  component: () => <GlobalProviders router={router} />,
  handlers: [
    http.get(
      `/api/audiobooks/${CONVERSION_ID}`,
      () =>
        HttpResponse.json({
          status: "pending",
          originalUrl: SOURCE_URL,
          canGenerate: true,
        } satisfies Audiobook),
      { once: true },
    ),
    http.get(`/api/audiobooks/${CONVERSION_ID}`, () =>
      HttpResponse.json({
        ...PREPARED_AUDIOBOOK,
        status: "synthesizing",
        segments: [
          { sequence: 0, status: "generating" },
          { sequence: 1, status: "generating" },
          { sequence: 2, status: "generating" },
        ],
      } satisfies Audiobook),
    ),
  ],
} satisfies Story;

export const FailedConversion = {
  component: () => <GlobalProviders router={router} />,
  handlers: [
    http.get("/api/audiobooks/" + CONVERSION_ID, () =>
      HttpResponse.json({
        status: "failed",
        originalUrl: "https://www.example.com/article",
        canGenerate: true,
        explanation: "Preparation failed. Retry to load this track.",
      }),
    ),
  ],
} satisfies Story;

const PENDING_AUDIOBOOK = {
  status: "pending",
  originalUrl: "https://example.com/article",
  canGenerate: true,
} satisfies Audiobook;

const FAILED_AUDIOBOOK = {
  status: "failed",
  originalUrl: "https://www.example.com/article",
  canGenerate: true,
  explanation: "Preparation failed. Retry to load this track.",
} satisfies Audiobook;

/** The account history of the stories below, which lists their conversion. */
const ACCOUNT_HISTORY = {
  items: [createRecentsItem(CONVERSION_ID, PREPARED_AUDIOBOOK.title)],
  nextCursor: null,
};

/** A signed-in listener opens a conversion that is still preparing. */
export const AccountPendingConversion = accountStory({
  path: `/audiobooks/${CONVERSION_ID}`,
  recents: ACCOUNT_HISTORY,
  handlers: [
    http.get(`/api/audiobooks/${CONVERSION_ID}`, () => HttpResponse.json(PENDING_AUDIOBOOK)),
  ],
});

/** A signed-in listener opens a conversion whose preparation failed. */
export const AccountFailedConversion = accountStory({
  path: `/audiobooks/${CONVERSION_ID}`,
  recents: ACCOUNT_HISTORY,
  handlers: [
    http.get(`/api/audiobooks/${CONVERSION_ID}`, () => HttpResponse.json(FAILED_AUDIOBOOK)),
  ],
});

/** How the stories below answer the listener's request to delete the track. */
type DeletionOutcome =
  | "deleted"
  | "deleted-recents-refresh-never-answers"
  | "not-found"
  | "fails-once"
  | "never-answers";

/** Tracks Recents lists above the deletable one when the story starts on Recents. */
const TRACKS_ABOVE_DELETABLE_COUNT = 30;
/** Tracks Recents lists below the deletable one when the story starts on Recents. */
const TRACKS_BELOW_DELETABLE_COUNT = 4;

/**
 * A signed-in listener deletes a ready track that Recents lists. Once the track is deleted, the
 * audiobook and Recents no longer have it. Opened from Recents, Recents lists enough other tracks
 * to scroll, the deletable one far down; otherwise the story starts on the detail view, as a deep
 * link does, and Recents lists only that track.
 */
function createDeletionStory(
  outcome: DeletionOutcome,
  audiobook: Audiobook = createAudiobook(),
  openedFrom: "deep-link" | "recents" = "deep-link",
) {
  let isDeleted = false;
  let deletionRequestCount = 0;
  const deletableItem = createRecentsItem(
    CONVERSION_ID,
    "A deterministic document about careful testing",
  );
  const otherItems = (count: number, firstNumber: number) =>
    Array.from({ length: openedFrom === "recents" ? count : 0 }, (_, offset) => {
      const number = firstNumber + offset;
      return createRecentsItem(
        `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
        `Another track ${number}`,
      );
    });
  const itemsAbove = otherItems(TRACKS_ABOVE_DELETABLE_COUNT, 1);
  const itemsBelow = otherItems(TRACKS_BELOW_DELETABLE_COUNT, TRACKS_ABOVE_DELETABLE_COUNT + 1);
  return accountStory({
    path: openedFrom === "recents" ? "/recent" : `/audiobooks/${CONVERSION_ID}`,
    handlers: [
      http.get(`/api/audiobooks/${CONVERSION_ID}`, () =>
        isDeleted ? trackNotFoundResponse() : HttpResponse.json(audiobook),
      ),
      http.get("/api/account/conversions", async () => {
        await waitWhileHeld("account-history");
        if (isDeleted && outcome === "deleted-recents-refresh-never-answers") {
          await delay("infinite");
        }
        return HttpResponse.json({
          items: [...itemsAbove, ...(isDeleted ? [] : [deletableItem]), ...itemsBelow],
          nextCursor: null,
        });
      }),
      http.delete(`/api/account/conversions/${CONVERSION_ID}`, async ({ request }) => {
        deletionRequestCount += 1;
        // Tests that capture the player's audio element read what it held when the request was sent.
        Object.assign(window, {
          deletionRequest: {
            contentType: request.headers.get("Content-Type"),
            narrationAudioSrc:
              "narrationAudio" in window && window.narrationAudio instanceof HTMLAudioElement
                ? window.narrationAudio.src
                : undefined,
          },
        });
        if (outcome === "never-answers") {
          await delay("infinite");
        }
        if (outcome === "fails-once" && deletionRequestCount === 1) {
          return HttpResponse.json(
            {
              error: {
                traceId: "0af7651916cd43dd8448eb211c80319c",
                code: "operational-error",
                message: "The track could not be deleted.",
              },
            } satisfies ErrorResponse,
            { status: 500 },
          );
        }
        if (outcome === "not-found") {
          return trackNotFoundResponse();
        }
        isDeleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
      http.put(
        `/api/audiobooks/${CONVERSION_ID}/position`,
        () => new HttpResponse(null, { status: 204 }),
      ),
    ],
  });
}

export const DeleteTrack = createDeletionStory("deleted");
/** The listener scrolls Recents down to the track and opens it there. */
export const DeleteTrackOpenedFromRecents = createDeletionStory(
  "deleted",
  createAudiobook(),
  "recents",
);
/** Recents can show only its cached list after the deletion, which was loaded with the track. */
export const DeleteTrackRecentsRefreshNeverAnswers = createDeletionStory(
  "deleted-recents-refresh-never-answers",
);
/** The track was already deleted, for example on another device. */
export const DeleteTrackAlreadyDeleted = createDeletionStory("not-found");
export const DeleteTrackFailsOnce = createDeletionStory("fails-once");
export const DeleteTrackNeverAnswers = createDeletionStory("never-answers");
/** A pending track is deleted while the page polls it. */
export const DeletePendingTrack = createDeletionStory("deleted", PENDING_AUDIOBOOK);

/**
 * The narration track cannot be read once Play loads it, and requesting the audiobook again finds
 * it gone, as after its deletion on another device.
 */
export const TrackGoneOnRenewal = accountStory({
  path: `/audiobooks/${CONVERSION_ID}`,
  handlers: (() => {
    let requestCount = 0;
    return [
      http.get(`/api/audiobooks/${CONVERSION_ID}`, () => {
        requestCount += 1;
        if (requestCount > 1) {
          return trackNotFoundResponse();
        }
        return HttpResponse.json({
          ...PREPARED_AUDIOBOOK,
          status: "ready",
          segments: [0, 1, 2].map(createReadySegment),
          narrationTrack: {
            ...createStoryNarrationTrack([
              SEGMENT_DURATION_MILLISECONDS,
              SEGMENT_DURATION_MILLISECONDS,
              SEGMENT_DURATION_MILLISECONDS,
            ]),
            url: `${window.location.origin}/__story/missing-narration-track.mp3`,
          },
        } satisfies Audiobook);
      }),
      http.get(
        "/__story/missing-narration-track.mp3",
        () => new HttpResponse(null, { status: 404 }),
      ),
    ];
  })(),
});

function trackNotFoundResponse() {
  return HttpResponse.json(
    {
      error: {
        traceId: "0af7651916cd43dd8448eb211c80319c",
        code: "audiobook-not-found",
        message: "Track not found.",
      },
    } satisfies ErrorResponse,
    { status: 404 },
  );
}

export const RetryRefused = {
  component: () => <GlobalProviders router={router} />,
  handlers: [
    http.get(`/api/audiobooks/${CONVERSION_ID}`, () =>
      HttpResponse.json({
        ...PREPARED_AUDIOBOOK,
        status: "ready",
        segments: [0, 1, 2].map((sequence) => ({
          sequence,
          status: "failed" as const,
          explanation: "The provider is unavailable.",
        })),
      } satisfies Audiobook),
    ),
    http.post(`/api/audiobooks/${CONVERSION_ID}/retry`, () =>
      HttpResponse.json(
        {
          error: {
            traceId: "0af7651916cd43dd8448eb211c80319c",
            code: "grant-expired",
            message: "This trial no longer permits new speech generation.",
          },
        } satisfies ErrorResponse,
        { status: 403 },
      ),
    ),
  ],
} satisfies Story;

/**
 * Polling an audiobook whose audio is generated fails three times, then recovers. The count spans
 * the page's lifetime, so the failures play out only once per page load.
 */
export const PollingInterrupted = {
  component: () => <GlobalProviders router={router} />,
  handlers: (() => {
    let requestCount = 0;
    return [
      http.get(`/api/audiobooks/${CONVERSION_ID}`, () => {
        requestCount += 1;
        if (requestCount >= 2 && requestCount <= 4) {
          return HttpResponse.json(
            {
              error: {
                traceId: "0af7651916cd43dd8448eb211c80319c",
                code: "operational-error",
                message: "The audiobook could not be loaded.",
              },
            } satisfies ErrorResponse,
            { status: 500 },
          );
        }
        return HttpResponse.json({
          ...PREPARED_AUDIOBOOK,
          status: "synthesizing",
          segments: [
            createReadySegment(0),
            { sequence: 1, status: "generating" },
            { sequence: 2, status: "generating" },
          ],
        } satisfies Audiobook);
      }),
    ];
  })(),
} satisfies Story;

/**
 * Polling an audiobook whose audio is generated finds it gone or no longer accessible, as after its
 * deletion on another device or a revoked trial. The poll's answer is held from the start, so a
 * test sees the track until it releases `audiobook-poll`, however slowly the first response
 * renders.
 */
function createAccessLostWhilePollingStory(failure: "not-found" | "access-denied") {
  let requestCount = 0;
  return {
    beforeMount: async () => holdStoryResponses("audiobook-poll"),
    component: () => <GlobalProviders router={router} />,
    handlers: [
      http.get(`/api/audiobooks/${CONVERSION_ID}`, async () => {
        requestCount += 1;
        if (requestCount === 1) {
          return HttpResponse.json({
            ...PREPARED_AUDIOBOOK,
            status: "synthesizing",
            segments: [
              createReadySegment(0),
              { sequence: 1, status: "generating" },
              { sequence: 2, status: "generating" },
            ],
          } satisfies Audiobook);
        }

        await waitWhileHeld("audiobook-poll");
        return failure === "not-found"
          ? trackNotFoundResponse()
          : HttpResponse.json(
              {
                error: {
                  traceId: "0af7651916cd43dd8448eb211c80319c",
                  code: "grant-revoked",
                  message: "This trial was revoked.",
                },
              } satisfies ErrorResponse,
              { status: 403 },
            );
      }),
    ],
  } satisfies Story;
}

export const TrackGoneWhilePolling = createAccessLostWhilePollingStory("not-found");
export const TrackAccessDeniedWhilePolling = createAccessLostWhilePollingStory("access-denied");

// PROTOTYPE (cup-audio/cup#491): a segmentation-version-2 narration document that uses every kept
// element; `?variant=A|B|C` switches the reader styles. `u="…"` expands to data-synchronization-unit,
// plus the unit ID as `id` on the unit's first element so the unchanged reader code finds the title.
const KEPT_MARKUP_CONVERSION_ID = "4f1e2b7a-0c55-4d4e-9a39-5a1b2c3d4e5f";
const KEPT_MARKUP_HTML_SOURCE = `<article>
<hgroup><h1 u="u1">Keeping the pipeline honest</h1><p u="u2">Notes from a year of running speech synthesis at scale</p></hgroup>
<p u="u3">Most of our failures were <em>boring</em>. A cron job ran twice; a cache held on to a <strong>stale manifest</strong>; a vendor quietly changed its <i>de facto</i> rate limit, which we only noticed in <b>bold red</b> on a dashboard. The <a href="https://www.example.org/postmortems">postmortem archive</a> has the details, and the <a href="https://status.vendor.example.com/incidents/2025-03">vendor's status page</a> has theirs.</p>
<p u="u4">To retry a stuck job, press <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>R</kbd> in the console. It prints <samp>job 4812 requeued</samp> and sets <code>retryCount</code> to <var>n</var> + 1.</p>
<p u="u5">Between CO<sub>2</sub> sensors and fans, the rack drew 4.2 × 10<sup>3</sup> W at peak. We <s>planned to move it in March</s> moved it in May. <del>The old server room is still in use.</del></p>
<p u="u6">As one engineer put it, <q>the queue is the product, and <q>done</q> is a state, not a feeling</q>. Everything else<br>is plumbing.</p>
<h2 u="u7">What we measured</h2>
<ul><li u="u7">Median time to first audio</li><li u="u8">Segments regenerated per thousand</li><li u="u9">Listener-reported mismatches between the text and what was spoken, which needs a long line to show wrapping in a list</li></ul>
<h3 u="u10">Monthly figures</h3>
<table><thead><tr u="u10"><th>Month</th><th>Conversions</th><th>Median wait</th><th>Regenerated</th><th>Mismatches</th><th>Spend (EUR)</th></tr></thead>
<tbody><tr u="u11"><td>January</td><td>12,480</td><td>41 s</td><td>3.1‰</td><td>14</td><td>1,920.40</td></tr>
<tr u="u12"><td>February</td><td>15,902</td><td>38 s</td><td>2.7‰</td><td>9</td><td>2,311.75</td></tr>
<tr u="u13"><td>March</td><td>19,377</td><td>52 s</td><td>4.4‰</td><td>31</td><td>2,980.10</td></tr></tbody></table>
<p u="u14">March was the month the vendor changed its limit.</p>
<table><caption u="u15">Table 2. Providers we tried</caption><thead><tr u="u16"><th>Provider</th><th>Voice</th><th>Verdict</th></tr></thead>
<tbody><tr u="u17"><td>First</td><td>Warm, slightly fast</td><td>Kept for long-form articles</td></tr>
<tr u="u18"><td>Second</td><td>Clear</td><td>Dropped: mispronounced every unit of measurement</td></tr></tbody></table>
<h2 u="u19">On-call rota</h2>
<pre u="u19">Shift   Monday to Friday                                   Weekends
Early   06:00–14:00 (two engineers, one of them in the office)    07:00–15:00
Late    14:00–22:00                                        15:00–23:00</pre>
<h2 u="u20">Glossary</h2>
<dl><dt u="u20">Segment</dt><dd u="u20">The audio for one synchronization unit.</dd><dt u="u21">Requeue</dt><dt u="u21">Retry</dt><dd u="u21">Put a stuck job back on the queue without changing its input.</dd></dl>
<blockquote><p u="u22">Make the boring parts observable, and the interesting parts will find you.</p></blockquote>
<p u="u23">Read the <a href="https://www.example.org/handbook/retries">retry handbook</a> for the <em>backoff</em> rules, the <a href="https://en.wikipedia.org/wiki/Exponential_backoff"><strong>exponential</strong> part</a> especially.</p>
</article>`;

const keptMarkupUnitIds = [...new Set([...KEPT_MARKUP_HTML_SOURCE.matchAll(/ u="([^"]+)"/g)].map((match) => match[1] ?? ""))];
const seenKeptMarkupUnits = new Set<string>();
const KEPT_MARKUP_HTML = KEPT_MARKUP_HTML_SOURCE.replaceAll(/>\n</g, "><").replaceAll(/ u="([^"]+)"/g, (_match, unitId: string) => {
  const isFirst = !seenKeptMarkupUnits.has(unitId);
  seenKeptMarkupUnits.add(unitId);
  return `${isFirst ? ` id="${unitId}"` : ""} data-synchronization-unit="${unitId}"`;
});
const keptMarkupRouter = createAppRouter(
  createMemoryHistory({ initialEntries: [`/app/audiobooks/${KEPT_MARKUP_CONVERSION_ID}`] }),
);

export const PROTOTYPEKeptMarkupArticle = {
  beforeMount: async () => {
    await queryClient.fetchQuery(createAudiobookQuery(KEPT_MARKUP_CONVERSION_ID));
    await keptMarkupRouter.load();
  },
  component: () => <GlobalProviders router={keptMarkupRouter} />,
  handlers: [
    http.get(`/api/audiobooks/${KEPT_MARKUP_CONVERSION_ID}`, () =>
      HttpResponse.json({
        canGenerate: true,
        playbackPosition: null,
        title: "Keeping the pipeline honest",
        originalUrl: "https://www.example.org/blog/keeping-the-pipeline-honest",
        status: "ready",
        narrationDocument: {
          html: KEPT_MARKUP_HTML,
          synchronizationUnits: keptMarkupUnitIds.map((id) => ({ id, narrationText: id })),
        },
        segments: keptMarkupUnitIds.map((_id, sequence) => createReadySegment(sequence)),
        narrationTrack: createStoryNarrationTrack(
          keptMarkupUnitIds.map(() => SEGMENT_DURATION_MILLISECONDS),
        ),
      } satisfies Audiobook),
    ),
    http.put(
      `/api/audiobooks/${KEPT_MARKUP_CONVERSION_ID}/position`,
      () => new HttpResponse(null, { status: 204 }),
    ),
  ],
} satisfies Story;
