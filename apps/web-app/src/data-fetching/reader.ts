import { check } from "@patricktree-stack/utils-ecma/assert.utils";
import { queryOptions, useMutation } from "@tanstack/react-query";

import {
  audiobookResponseSchema,
  playbackPositionSchema,
  retryConversionResponseSchema,
  type Audiobook,
  type PlaybackPosition,
} from "@cup/listener-api.routes";

import { removeFromCachedAccountHistory } from "#src/data-fetching/account-history.js";
import { invalidateAccountQueries } from "#src/data-fetching/account.js";
import { requestApi } from "#src/data-fetching/api-request.js";
import { queryClient } from "#src/data-fetching/query-client.js";
import { QUERY_KEYS } from "#src/data-fetching/query-keys.js";
import { ERROR_CODE, RpcError } from "#src/errors.js";
import { notifyError } from "#src/notifications.js";

const POLL_INTERVAL_MS = 1_000;
const AUDIOBOOK_UPDATE_ERROR_TITLE = "The track could not be updated.";

export function createAudiobookQuery(conversionId: string) {
  return queryOptions({
    queryKey: QUERY_KEYS.audiobook(conversionId),
    queryFn: ({ signal }) => getAudiobook(conversionId, signal),
    meta: { errorTitle: AUDIOBOOK_UPDATE_ERROR_TITLE },
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "pending" || status === "synthesizing" ? POLL_INTERVAL_MS : false;
    },
    refetchIntervalInBackground: true,
  });
}

async function getAudiobook(conversionId: string, signal?: AbortSignal): Promise<Audiobook> {
  const heldNarrationDocument = findHeldNarrationDocument(conversionId);
  const response = audiobookResponseSchema.parse(
    await requestApi("optional", (client) =>
      client.getAudiobook(
        { conversionId },
        heldNarrationDocument === undefined ? {} : { narrationDocument: "omit" },
        signal,
      ),
    ),
  );
  if (response.status === "pending" || response.status === "failed") {
    return response;
  }

  const narrationDocument = response.narrationDocument ?? heldNarrationDocument;
  check.assert(narrationDocument, "A prepared audiobook response lacks its narration document.");
  return { ...response, narrationDocument };
}

function findHeldNarrationDocument(conversionId: string) {
  const held = queryClient.getQueryData<Audiobook>(QUERY_KEYS.audiobook(conversionId));
  return held === undefined || held.status === "pending" || held.status === "failed"
    ? undefined
    : held.narrationDocument;
}

export async function fetchAudiobookForPlayer(conversionId: string): Promise<Audiobook | null> {
  let audiobook: Audiobook;
  try {
    audiobook = await getAudiobook(conversionId);
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    notifyError(error, { title: AUDIOBOOK_UPDATE_ERROR_TITLE });
    throw error;
  }

  queryClient.setQueryData(createAudiobookQuery(conversionId).queryKey, audiobook);
  return audiobook;
}

export function useRetryConversion(conversionId: string) {
  return useMutation({
    meta: { errorTitle: "The retry could not start." },
    mutationFn: () => retryConversion(conversionId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: createAudiobookQuery(conversionId).queryKey }),
  });
}

async function retryConversion(conversionId: string) {
  return retryConversionResponseSchema.parse(
    await requestApi("optional", (client) => client.retryConversion({ conversionId })),
  );
}

export function useDeleteConversion({
  subject,
  conversionId,
  onDeleted,
}: {
  subject: string | undefined;
  conversionId: string;
  onDeleted: () => Promise<void>;
}) {
  return useMutation({
    meta: { errorDisplay: "inline" },
    onMutate: () => queryClient.cancelQueries({ queryKey: QUERY_KEYS.audiobook(conversionId) }),
    mutationFn: async () => {
      check.assert(subject, "Only a signed-in account deletes a conversion.");
      await deleteConversion(subject, conversionId);
      return { subject };
    },
    onSuccess: async ({ subject: deletingSubject }) => {
      await removeFromCachedAccountHistory(deletingSubject, conversionId);
      await onDeleted();
      queryClient.removeQueries({ queryKey: QUERY_KEYS.audiobook(conversionId) });
      await invalidateAccountQueries(deletingSubject);
    },
  });
}

async function deleteConversion(subject: string, conversionId: string): Promise<void> {
  try {
    await requestApi({ subject }, (client) => client.deleteConversion({ conversionId }));
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

function isNotFound(error: unknown) {
  return error instanceof RpcError && error.code === ERROR_CODE.AUDIOBOOK_NOT_FOUND;
}

export function getLocalPlaybackPosition(conversionId: string): PlaybackPosition | null {
  const value = localStorage.getItem(`cup:position:v1:${conversionId}`);
  if (!value) {
    return null;
  }
  try {
    const result = playbackPositionSchema.safeParse(JSON.parse(value));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function cachePlaybackPosition(conversionId: string, position: PlaybackPosition) {
  const queryKey = QUERY_KEYS.audiobook(conversionId);
  const cached = queryClient.getQueryState<Audiobook>(queryKey);
  if (cached?.data && cached.data.status !== "pending" && cached.data.status !== "failed") {
    const audiobook: Audiobook = { ...cached.data, playbackPosition: position };
    queryClient.setQueryData<Audiobook>(queryKey, audiobook, { updatedAt: cached.dataUpdatedAt });
  }
}

export async function savePlaybackPosition(
  conversionId: string,
  position: PlaybackPosition,
  subject: string | null,
) {
  if (!subject) {
    localStorage.setItem(`cup:position:v1:${conversionId}`, JSON.stringify(position));
    return;
  }

  const queryKey = QUERY_KEYS.audiobook(conversionId);
  await queryClient.cancelQueries({ queryKey });
  cachePlaybackPosition(conversionId, position);

  try {
    await requestApi({ subject }, (client) => client.savePosition({ conversionId }, position));
  } finally {
    await queryClient.invalidateQueries({ queryKey, refetchType: "none" });
  }
}
