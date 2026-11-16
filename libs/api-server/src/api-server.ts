import { captureException, getActiveSpan, getCurrentScope } from "@sentry/core";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { NONCE, secureHeaders } from "hono/secure-headers";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { Temporal } from "temporal-polyfill";

import { countNarrationTextCharactersBySegment } from "@cup/audiobook-production";
import { findNarrationTrackDurations } from "@cup/conversion-contracts";
import {
  clearGrantSessionCookie,
  createGrantSessionCookie,
  createRootCredential,
  getGrantSessionCookie,
  toGrantConversionSnapshot,
  type ConversionGrantDurableObject,
} from "@cup/conversion-grants";
import { CupError, assertUnreachable } from "@cup/errors";
import {
  createListenerApi,
  type Audiobook,
  type ListenerApiHandlers,
  type RetryConversionResponse,
  type ScheduleDeletionResponse,
  type StartConversionResponse,
} from "@cup/listener-api.routes";
import {
  createOperatorApi,
  type DeleteConversionResponse,
  type InspectAccountResponse,
  type ListAccountDeletionsResponse,
  type OperatorApiHandlers,
} from "@cup/operator-api.routes";
import type { RegistryDurableObject } from "@cup/registry";
import {
  handleTelemetryTunnelRequest,
  logEvent,
  setConversionScope,
} from "@cup/telemetry.cloudflare";

import { resolveConversionDispatch } from "#src/adapters/conversion-dispatch.ts";
import { resolveConversionReader } from "#src/adapters/conversion-reader.ts";
import { revokeVerifiedGoogleToken } from "#src/adapters/google-token-revocation.ts";
import type { ApiServerEnvironment } from "#src/api-server-environment.ts";
import { authenticateAccountRequest, localTestAccount } from "#src/http/account-auth.ts";
import { APPLICATION_ORIGIN, routeApplicationDomain } from "#src/http/domain-routing.ts";
import { accountAuthError, jsonError, requireAccessibleGrantState } from "#src/http/http-errors.ts";
import { ingressIdentity } from "#src/http/ingress-identity.ts";
import {
  toAccountHistoryResponse,
  toAccountSnapshotResponse,
  toDeletionChallengeResponse,
  toDurationBalanceResponse,
  toGrantSnapshotResponse,
  toNarrationDocumentResponse,
  toNarrationTrackResponse,
  toPlaybackPositionResponse,
  toPreparationPhaseField,
} from "#src/http/listener-responses.ts";
import { isDevelopmentOperatorRequest } from "#src/http/operator-access.ts";
import {
  loadReadyAudiobookFromEnvironment,
  serveCoverImage,
  serveNarrationTrack,
} from "#src/http/serve-audiobook.ts";
import {
  createMediaUrlSigner,
  requireSignedMediaUrl,
  signPositionUrl,
  verifySignedPositionUrl,
} from "#src/http/signed-media-url.ts";
import { applyWebAppCspNonce } from "#src/http/web-app-csp.ts";
import { createConversionGrant } from "#src/use-cases/create-conversion-grant.ts";
import { getSynthesisState } from "#src/use-cases/get-synthesis-state.ts";
import { startAudiobookConversion } from "#src/use-cases/start-audiobook-conversion.ts";

type GrantStub = DurableObjectStub<ConversionGrantDurableObject>;
type RegistryStub = DurableObjectStub<RegistryDurableObject>;

/** The telemetry tunnel's path, outside `/api/*`. */
const TELEMETRY_TUNNEL_PATH = "/_/e";

const accessKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
type ApiServerDependencies = {
  validateOperatorAccess(request: Request, env: ApiServerEnvironment): Promise<boolean>;
};
const productionDependencies: ApiServerDependencies = {
  validateOperatorAccess: async (request, env) =>
    isDevelopmentOperatorRequest(request) ||
    (await validateAccessAssertion(
      request.headers.get("Cf-Access-Jwt-Assertion") ?? undefined,
      env,
    )),
};

const validateAccountLifecycleRequest: MiddlewareHandler<{
  Bindings: ApiServerEnvironment;
  Variables: { traceId: string };
}> = async (context, next) => {
  if (!["POST", "DELETE"].includes(context.req.method)) {
    return next();
  }
  const origin = context.req.header("Origin");
  if (
    context.req.header("X-Create-Audiobook-From-URL-Request") !== "1" ||
    context.req.header("Content-Type") !== "application/json" ||
    (origin && ![new URL(context.req.url).origin, "https://localhost"].includes(origin))
  ) {
    return jsonError(
      context.get("traceId"),
      "origin-blocked",
      "The request origin is not allowed.",
      403,
    );
  }
  return next();
};

const listenerApiHandlers: ListenerApiHandlers<ApiServerEnvironment> = {
  async deletionChallenge(context) {
    const auth = await authenticateAccountRequest(context.req.raw, context.env);
    if (auth.result !== "authenticated") {
      return accountAuthError(auth.result, context.get("traceId"));
    }
    return context.json(toDeletionChallengeResponse(await auth.account.deletionChallenge()), 200);
  },
  async scheduleDeletion(context) {
    const auth = await authenticateAccountRequest(context.req.raw, context.env);
    if (auth.result !== "authenticated") {
      return accountAuthError(auth.result, context.get("traceId"));
    }
    const input = context.req.valid("json");
    if (!auth.identity.email || !auth.identity.authenticatedAtSeconds) {
      return jsonError(
        context.get("traceId"),
        "fresh-auth-required",
        "Fresh Google sign-in is required.",
        400,
      );
    }
    const result = await auth.account.scheduleDeletion({
      challengeId: input.challengeId,
      authenticatedAtSeconds: auth.identity.authenticatedAtSeconds,
      email: auth.identity.email,
    });
    if (result.result === "conflict") {
      return jsonError(
        context.get("traceId"),
        "confirmation-unavailable",
        "Confirm deletion with a fresh sign-in using the same Google account.",
        409,
      );
    }
    const { attempt } = result;
    if (input.providerToken && auth.identity.provider === "google") {
      const revoked = await revokeVerifiedGoogleToken(
        context.env,
        auth.identity.subject,
        input.providerToken,
      ).catch(() => false);
      if (attempt) {
        await context.env.REGISTRY.get(
          context.env.REGISTRY.idFromName("registry"),
        ).recordGoogleRevocation(
          attempt.attemptId,
          auth.identity.subject,
          revoked ? "revoked" : "failed",
        );
      }
    }
    return context.json(
      {
        state: "deletion_scheduled",
        ...(attempt === undefined ? {} : { recoveryDeadlineMs: attempt.deadlineMs }),
      } satisfies ScheduleDeletionResponse,
      200,
    );
  },
  async restoreAccount(context) {
    const auth = await authenticateAccountRequest(context.req.raw, context.env);
    if (auth.result !== "authenticated") {
      return accountAuthError(auth.result, context.get("traceId"));
    }
    const input = context.req.valid("json");
    if (!auth.identity.authenticatedAtSeconds) {
      return jsonError(
        context.get("traceId"),
        "fresh-auth-required",
        "Fresh Google sign-in is required.",
        400,
      );
    }
    const result = await auth.account.restoreAccount(
      input.challengeId,
      auth.identity.authenticatedAtSeconds,
    );
    if (result.result === "conflict") {
      return jsonError(
        context.get("traceId"),
        "confirmation-unavailable",
        "Recovery is unavailable. Use the same Google account before the recovery deadline.",
        409,
      );
    }
    return context.json(toAccountSnapshotResponse(result.account), 200);
  },
  health(context) {
    return context.json({ status: "ok" as const }, 200);
  },
  authConfig(context) {
    const testAccount = localTestAccount(context.env);
    return context.json(
      {
        supabaseUrl: context.env.SUPABASE_URL,
        publishableKey: context.env.SUPABASE_PUBLISHABLE_KEY,
        ...(context.env.GOOGLE_WEB_CLIENT_ID
          ? { googleWebClientId: context.env.GOOGLE_WEB_CLIENT_ID }
          : {}),
        ...(testAccount ? { testAccount } : {}),
      },
      200,
    );
  },
  async getHistory(context) {
    const auth = await authenticateAccountRequest(context.req.raw, context.env);
    if (auth.result !== "authenticated") {
      return accountAuthError(auth.result, context.get("traceId"));
    }
    if (auth.snapshot.state !== "active") {
      return accountAuthError("blocked", context.get("traceId"));
    }
    const cursor = context.req.valid("query").cursor;
    const split = cursor?.split(":");
    const page = await auth.account.history(
      split?.[1] ? { createdAtMs: Number(split[0]), conversionId: split[1] } : undefined,
    );
    const signMediaUrl = createMediaUrlSigner(context, {
      kind: "account",
      accountId: auth.snapshot.accountId,
    });
    return context.json(
      await toAccountHistoryResponse(page, (conversionId) =>
        signMediaUrl(conversionId, "cover-image"),
      ),
      200,
    );
  },
  async getAccount(context) {
    const auth = await authenticateAccountRequest(context.req.raw, context.env);
    if (auth.result !== "authenticated") {
      return accountAuthError(auth.result, context.get("traceId"));
    }
    return context.json(toAccountSnapshotResponse(auth.snapshot), 200);
  },
  async startAccountConversion(context) {
    const validation = validateSessionMutationRequest(context.req.raw, context.get("traceId"));
    if (validation.result === "invalid") {
      return validation.response;
    }
    const auth = await authenticateAccountRequest(context.req.raw, context.env);
    if (auth.result !== "authenticated") {
      return accountAuthError(auth.result, context.get("traceId"));
    }
    if (auth.snapshot.state !== "active") {
      return accountAuthError("blocked", context.get("traceId"));
    }
    try {
      const result = await auth.account.startConversion({
        sourceUrl: new URL(context.req.valid("json").sourceUrl).toString(),
        idempotencyKey: context.req.valid("header")["idempotency-key"],
      });
      if (result.result === "rate-limited") {
        return jsonError(
          context.get("traceId"),
          "rate-limited",
          "Too many conversion requests. Please wait before retrying.",
          429,
          { "Retry-After": String(result.retryAfter ?? 60) },
        );
      }
      if (!result.conversion) {
        return jsonError(
          context.get("traceId"),
          "credits-unavailable",
          "No conversion credits are available.",
          409,
        );
      }
      setConversionScope({
        conversionId: result.conversion.conversionId,
        owner: { kind: "account", accountId: auth.snapshot.accountId },
      });
      return context.json(
        { conversionId: result.conversion.conversionId },
        result.result === "created" ? 202 : 200,
      );
    } catch {
      return jsonError(
        context.get("traceId"),
        "account-start-conflict",
        "The conversion request could not be accepted. Retry the same request.",
        409,
      );
    }
  },
  /** Acts only on the caller's own account, so another account's or a trial conversion is not found. */
  async deleteAccountConversion(context) {
    const validation = validateSessionMutationRequest(context.req.raw, context.get("traceId"));
    if (validation.result === "invalid") {
      return validation.response;
    }
    const auth = await authenticateAccountRequest(context.req.raw, context.env);
    if (auth.result !== "authenticated") {
      return accountAuthError(auth.result, context.get("traceId"));
    }
    if (auth.snapshot.state !== "active") {
      return accountAuthError("blocked", context.get("traceId"));
    }
    const { conversionId } = context.req.valid("param");
    setConversionScope({
      conversionId,
      owner: { kind: "account", accountId: auth.snapshot.accountId },
    });
    const { result } = await auth.account.deleteConversion(conversionId);
    if (result === "marked" || result === "already-marked") {
      return context.body(null, 204);
    }
    if (result === "not-found") {
      return jsonError(context.get("traceId"), "audiobook-not-found", "Track not found.", 404);
    }
    if (result === "account-unavailable") {
      return accountAuthError("blocked", context.get("traceId"));
    }
    return assertUnreachable(result);
  },
  async exchangeSession(context) {
    const validation = validateSessionMutationRequest(context.req.raw, context.get("traceId"));
    if (validation.result === "invalid") {
      return validation.response;
    }
    const { grantId } = context.req.valid("param");
    try {
      const result = await getGrantStub(context.env, grantId).exchangeCredential(
        context.req.valid("json").credential,
      );
      if (result.result === "invalid-credential") {
        return jsonError(
          context.get("traceId"),
          "invalid-credential",
          "This trial link is invalid.",
          401,
        );
      }
      if (result.result === "grant-revoked") {
        return jsonError(
          context.get("traceId"),
          "grant-revoked",
          "This trial link was revoked.",
          403,
        );
      }
      return context.json(toGrantSnapshotResponse(result.snapshot), 201, {
        "Set-Cookie": createGrantSessionCookie(grantId, result.sessionToken),
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("not initialized")) {
        return jsonError(
          context.get("traceId"),
          "invalid-credential",
          "This trial link is invalid.",
          401,
        );
      }
      captureException(error);
      return jsonError(
        context.get("traceId"),
        "dependency-unavailable",
        "The trial link service is temporarily unavailable.",
        503,
      );
    }
  },

  async getGrant(context) {
    const { grantId } = context.req.valid("param");
    const authenticated = await authenticateGrant(
      context.env,
      grantId,
      context.req.header("Cookie"),
    );
    if (authenticated.result === "missing") {
      return jsonError(
        context.get("traceId"),
        "grant-session-required",
        "A grant session is required.",
        401,
      );
    }
    if (authenticated.result === "invalid") {
      return jsonError(
        context.get("traceId"),
        "grant-session-invalid",
        "This browser no longer has access. Open the original trial link again.",
        401,
        { "Set-Cookie": clearGrantSessionCookie(grantId) },
      );
    }
    if (authenticated.result === "operational-error") {
      return jsonError(
        context.get("traceId"),
        "operational-error",
        "The grant could not be loaded.",
        500,
      );
    }
    return context.json(toGrantSnapshotResponse(authenticated.snapshot), 200, {
      "Set-Cookie": createGrantSessionCookie(grantId, authenticated.token),
    });
  },

  async startTrialConversion(context) {
    const validation = validateSessionMutationRequest(context.req.raw, context.get("traceId"));
    if (validation.result === "invalid") {
      return validation.response;
    }
    const { grantId } = context.req.valid("param");
    const authenticated = await authenticateGrant(
      context.env,
      grantId,
      context.req.header("Cookie"),
    );
    if (authenticated.result === "missing") {
      return jsonError(
        context.get("traceId"),
        "grant-session-required",
        "A grant session is required.",
        401,
      );
    }
    if (authenticated.result === "invalid") {
      return jsonError(
        context.get("traceId"),
        "grant-session-invalid",
        "This browser no longer has access. Open the original trial link again.",
        401,
        { "Set-Cookie": clearGrantSessionCookie(grantId) },
      );
    }
    if (authenticated.result === "operational-error") {
      return jsonError(
        context.get("traceId"),
        "operational-error",
        "The grant could not be loaded.",
        500,
      );
    }

    const grant = getGrantStub(context.env, grantId);
    const sourceUrl = new URL(context.req.valid("json").sourceUrl).toString();
    const result = await startAudiobookConversion(
      {
        sourceUrl,
        grantId,
        idempotencyKey: context.req.valid("header")["idempotency-key"],
      },
      {
        grant,
        registry: getRegistryStub(context.env),
        createWorkflow: async (conversionId, params) => {
          setConversionScope({ conversionId, owner: { kind: "trial", grantId } });
          await context.env.PREPARE_AUDIOBOOK_WORKFLOW.create({ id: conversionId, params });
        },
      },
    );
    if (result.result === "rate-limited") {
      return jsonError(
        context.get("traceId"),
        "start-rate-limited",
        "Wait briefly and try again.",
        429,
        {
          "Retry-After": result.retryAfterSeconds.toString(),
        },
      );
    }
    if (result.result === "idempotency-conflict") {
      return jsonError(
        context.get("traceId"),
        "idempotency-conflict",
        "This request key is already bound to a different source URL.",
        409,
      );
    }
    if (result.result === "temporarily-full") {
      return jsonError(
        context.get("traceId"),
        "grant-temporarily-full",
        "No audio duration is currently available. Try again when generation finishes.",
        409,
      );
    }
    if (result.result === "exhausted") {
      return jsonError(
        context.get("traceId"),
        "grant-exhausted",
        "The audio duration allowance has been used.",
        409,
      );
    }
    if (result.result === "expired") {
      return jsonError(
        context.get("traceId"),
        "grant-expired",
        "This conversion grant has expired.",
        403,
      );
    }
    if (result.result === "revoked") {
      return jsonError(
        context.get("traceId"),
        "grant-revoked",
        "This conversion grant was revoked.",
        403,
      );
    }

    return context.json(
      {
        result: result.result,
        conversion: toGrantConversionSnapshot(result.conversion),
        duration: toDurationBalanceResponse(result.duration),
      } satisfies StartConversionResponse,
      result.result === "created" ? 202 : 200,
      { "Set-Cookie": createGrantSessionCookie(grantId, authenticated.token) },
    );
  },

  async getAudiobook(context) {
    const { conversionId } = context.req.valid("param");
    const owner = await getRegistryStub(context.env).findConversionOwner(conversionId);
    if (!owner) {
      return jsonError(context.get("traceId"), "audiobook-not-found", "Track not found.", 404);
    }
    const reader = resolveConversionReader(context.env, conversionId, owner);
    const conversion = await reader.getConversion();
    if (!conversion) {
      return jsonError(context.get("traceId"), "audiobook-not-found", "Track not found.", 404);
    }
    const canGenerate =
      owner.kind === "account" ||
      (owner.kind === "trial" &&
        (await authenticateGrant(context.env, owner.grantId, context.req.header("Cookie")))
          .result === "valid");
    const base = { originalUrl: conversion.sourceUrl, canGenerate };
    if (conversion.status === "pending") {
      return context.json(
        {
          ...base,
          status: "pending",
          ...toPreparationPhaseField(conversion.lastStartedPhase),
        } satisfies Audiobook,
        200,
      );
    }
    if (conversion.status === "failed") {
      return context.json(
        {
          ...base,
          status: "failed",
          explanation: "Preparation failed. Retry to load this track.",
        } satisfies Audiobook,
        200,
      );
    }
    const audiobook = await loadReadyAudiobookFromEnvironment(context.env, conversionId, reader);
    if (!audiobook) {
      return jsonError(context.get("traceId"), "audiobook-not-found", "Track not found.", 404);
    }
    // The ownership middleware admitted this request for the owner alone.
    const signMediaUrl = createMediaUrlSigner(context, owner);
    const segmentUsage = await reader.listAudioSegments();
    const narrationTrackDurations = findNarrationTrackDurations(segmentUsage);
    const synthesis = await getSynthesisState(
      {
        narrationTextCharactersBySegment: countNarrationTextCharactersBySegment(
          audiobook.narrationDocument,
        ),
        segmentUsage,
      },
      {
        getAvailableMilliseconds: () => reader.getAvailableMilliseconds(),
        getFailureExplanation: async (sequence) => {
          const failure = await context.env.AUDIO_BUCKET.get(
            `${reader.artifactPrefix}segment-${sequence}-failure.json`,
          );
          return failure ? (await failure.json<{ explanation: string }>()).explanation : undefined;
        },
      },
    );
    const account =
      owner.kind === "account"
        ? context.env.ACCOUNTS.get(context.env.ACCOUNTS.idFromName(owner.accountId))
        : undefined;
    const listener = account
      ? account
      : context.req.header("Authorization")
        ? await authenticateAccountRequest(context.req.raw, context.env).then((auth) =>
            auth.result === "authenticated" && auth.snapshot.state === "active"
              ? auth.account
              : undefined,
          )
        : undefined;
    const playbackPosition = listener ? await listener.getPlaybackPosition(conversionId) : null;
    return context.json(
      {
        ...base,
        ...synthesis,
        title: audiobook.title,
        ...(audiobook.coverImage === undefined
          ? {}
          : {
              coverImage: {
                url: await signMediaUrl(conversionId, "cover-image"),
                ...(audiobook.coverImage.alternativeText === undefined
                  ? {}
                  : { alternativeText: audiobook.coverImage.alternativeText }),
              },
            }),
        ...(narrationTrackDurations === undefined
          ? {}
          : {
              narrationTrack: toNarrationTrackResponse(
                await signMediaUrl(conversionId, "narration-track.mp3"),
                narrationTrackDurations,
                owner.kind === "account"
                  ? await signPositionUrl(context, owner, conversionId)
                  : undefined,
              ),
            }),
        narrationDocument: toNarrationDocumentResponse(audiobook.narrationDocument),
        playbackPosition: toPlaybackPositionResponse(playbackPosition),
      } satisfies Audiobook,
      200,
    );
  },

  async retryConversion(context) {
    const { conversionId } = context.req.valid("param");
    const denied = requireBrowserMutation(context.req.raw, context.get("traceId"));
    if (denied) {
      return denied;
    }
    const owner = await getRegistryStub(context.env).findConversionOwner(conversionId);
    if (!owner) {
      return jsonError(context.get("traceId"), "audiobook-not-found", "Track not found.", 404);
    }
    if (owner.kind === "trial") {
      if (
        (await authenticateGrant(context.env, owner.grantId, context.req.header("Cookie")))
          .result !== "valid"
      ) {
        return jsonError(
          context.get("traceId"),
          "grant-session-required",
          "Open the original trial link to retry.",
          401,
        );
      }
    }
    const dispatch = resolveConversionDispatch(context.env, conversionId, owner);
    const audiobook = await loadReadyAudiobookFromEnvironment(context.env, conversionId);
    if (!audiobook) {
      await dispatch.retryPreparation();
      return context.json({ result: "started" } satisfies RetryConversionResponse, 200);
    }

    // A prepared conversion retries synthesis: failed segments, or the whole document when it
    // previously did not fit. A refusal for insufficient duration is an outcome, not an error.
    const result = await dispatch.startSynthesis(
      countNarrationTextCharactersBySegment(audiobook.narrationDocument),
    );
    if (result.result === "started") {
      return context.json({ result: "started" } satisfies RetryConversionResponse, 200);
    }
    if (result.result === "insufficient-duration") {
      return context.json(
        {
          result: "insufficient-duration",
          requiredMilliseconds: result.requiredMilliseconds,
          availableMilliseconds: result.availableMilliseconds,
        } satisfies RetryConversionResponse,
        200,
      );
    }
    if (result.result === "expired" || result.result === "revoked") {
      return jsonError(
        context.get("traceId"),
        `grant-${result.result}`,
        "This trial no longer permits new speech generation.",
        403,
      );
    }
    return assertUnreachable(result.result);
  },

  async savePosition(context) {
    const { conversionId } = context.req.valid("param");
    const denied = requireBrowserMutation(context.req.raw, context.get("traceId"));
    if (denied) {
      return denied;
    }
    const listener = await authorizePositionSave(
      context.env,
      context.req.raw,
      conversionId,
      context.get("traceId"),
    );
    if (listener.result === "denied") {
      return listener.response;
    }
    const position = context.req.valid("json");
    const audiobook = await loadReadyAudiobookFromEnvironment(context.env, conversionId);
    if (!audiobook) {
      return jsonError(
        context.get("requestId"),
        "audiobook-not-found",
        "Audiobook not found.",
        404,
      );
    }
    if (
      !audiobook.narrationDocument.synchronizationUnits.some(
        (unit) => unit.id === position.synchronizationUnitId,
      )
    ) {
      return jsonError(context.get("traceId"), "invalid-input", "Segment not found.", 400);
    }
    await listener.account.savePlaybackPosition(conversionId, position);
    return context.body(null, 204);
  },

  async getNarrationTrack(context) {
    const { conversionId } = context.req.valid("param");
    return serveNarrationTrack(context.env, context.req.raw, conversionId, context.get("traceId"));
  },
  async headNarrationTrack(context) {
    const { conversionId } = context.req.valid("param");
    return serveNarrationTrack(context.env, context.req.raw, conversionId, context.get("traceId"));
  },
  async getCoverImage(context) {
    const { conversionId } = context.req.valid("param");
    return serveCoverImage(
      context.env,
      context.req.raw,
      conversionId,
      false,
      context.get("traceId"),
    );
  },
  async headCoverImage(context) {
    const { conversionId } = context.req.valid("param");
    return serveCoverImage(
      context.env,
      context.req.raw,
      conversionId,
      true,
      context.get("traceId"),
    );
  },
};

// Durable Object RPC rejections carry only the thrown message, so ledger rejections are matched by it.
const ACCOUNT_ADJUSTMENT_CONFLICTS = [
  {
    thrownMessage: "Account is not active",
    code: "account-not-active",
    message: "The account is not active.",
  },
  {
    thrownMessage: "Account is not initialized",
    code: "account-not-active",
    message: "The account is not active.",
  },
  {
    thrownMessage: "Allowance adjustment exceeds available duration",
    code: "adjustment-exceeds-available-duration",
    message: "The reduction exceeds the account's available duration.",
  },
  {
    thrownMessage: "Allowance adjustment idempotency conflict",
    code: "idempotency-conflict",
    message: "The request ID is already bound to another adjustment.",
  },
] as const;

const operatorApiHandlers: OperatorApiHandlers<ApiServerEnvironment> = {
  async listAccounts(context) {
    const searchParameters = new URL(context.req.url).searchParams;
    if (["phase", "limit", "cursor"].some((name) => searchParameters.getAll(name).length > 1)) {
      return jsonError(
        context.get("traceId"),
        "invalid-input",
        "Query parameters cannot be repeated.",
        400,
      );
    }
    const query = context.req.valid("query");
    try {
      const result = await getRegistryStub(context.env).listAccounts({
        limit: query.limit,
        ...(query.phase === undefined ? {} : { phase: query.phase }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      });
      return context.json(
        {
          accounts: result.accounts.map((account) => ({
            accountId: account.accountId,
            subject: account.subject,
            createdAt: toIsoString(account.createdAtMs),
            phase: account.phase,
            ...(account.usage === undefined
              ? {}
              : {
                  usage: {
                    allowanceMilliseconds: account.usage.allowanceMilliseconds,
                    reservedMilliseconds: account.usage.reservedMilliseconds,
                    spentMilliseconds: account.usage.spentMilliseconds,
                    availableMilliseconds: account.usage.availableMilliseconds,
                  },
                }),
          })),
          ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
        },
        200,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("Invalid Registry cursor")) {
        return jsonError(
          context.get("traceId"),
          "invalid-cursor",
          "The Registry cursor is invalid.",
          400,
        );
      }
      captureException(error);
      return jsonError(
        context.get("traceId"),
        "operational-error",
        "The Registry could not be read.",
        500,
      );
    }
  },
  async adjustAccountAllowance(context) {
    const { accountId } = context.req.valid("param");
    const { requestId, amountMilliseconds, reason } = context.req.valid("json");
    if ((await getRegistryStub(context.env).findAccount(accountId)) === undefined) {
      return jsonError(context.get("traceId"), "account-not-found", "Account not found.", 404);
    }
    const account = context.env.ACCOUNTS.get(context.env.ACCOUNTS.idFromName(accountId));
    try {
      await account.adjustAllowance(requestId, amountMilliseconds, reason);
      const snapshot = await account.inspect();
      return context.json({ accountId, balance: snapshot.balance }, 200);
    } catch (error) {
      const conflict = ACCOUNT_ADJUSTMENT_CONFLICTS.find(
        ({ thrownMessage }) => error instanceof Error && error.message.includes(thrownMessage),
      );
      if (conflict !== undefined) {
        return jsonError(context.get("traceId"), conflict.code, conflict.message, 409);
      }
      captureException(error);
      // Retrying with the same request ID replays a recorded adjustment, so failures stay safe to retry.
      return jsonError(
        context.get("traceId"),
        "operational-error",
        "The allowance adjustment could not be confirmed.",
        500,
      );
    }
  },
  async listAccountDeletions(context) {
    const registry = context.env.REGISTRY;
    const accountRegistry = registry.get(registry.idFromName("registry"));
    // Typed rather than parsed, like the account inspection below.
    return context.json(
      {
        attempts: await accountRegistry.inspectDeletions(),
        receipts: await accountRegistry.deletionReceipts(),
      } satisfies ListAccountDeletionsResponse,
      200,
    );
  },
  async inspectAccount(context) {
    const { accountId } = context.req.valid("param");
    const account = context.env.ACCOUNTS.get(context.env.ACCOUNTS.idFromName(accountId));
    // Checked against the contract at compile time, not parsed, so an unexpected shape reaches the
    // operator instead of failing as a server error; the route tests parse responses strictly.
    // `satisfies` rejects missing or mismatched properties, but not extra ones in nested values.
    return context.json(
      {
        account: await account.inspect(),
        accounting: await account.inspectAccounting(),
        history: await account.history(),
        writers: await account.inspectArtifactWriters(),
        conversionDeletions: await account.inspectConversionDeletions(),
      } satisfies InspectAccountResponse,
      200,
    );
  },
  /** Deletes an account's conversion; a trial conversion is refused. */
  async deleteConversion(context) {
    const { conversionId } = context.req.valid("param");
    const owner = await getRegistryStub(context.env).findConversionOwner(conversionId);
    setConversionScope({ conversionId, ...(owner ? { owner } : {}) });
    if (owner === undefined) {
      return conversionNotFound(context.get("traceId"));
    }
    if (owner.kind === "trial") {
      return jsonError(
        context.get("traceId"),
        "conversion-not-account-owned",
        "The conversion belongs to a conversion grant, not an account.",
        409,
      );
    }
    const account = context.env.ACCOUNTS.get(context.env.ACCOUNTS.idFromName(owner.accountId));
    const { result } = await account.deleteConversion(conversionId);
    if (result === "marked" || result === "already-marked") {
      return context.json(
        { conversionId, accountId: owner.accountId } satisfies DeleteConversionResponse,
        200,
      );
    }
    if (result === "not-found") {
      return conversionNotFound(context.get("traceId"));
    }
    if (result === "account-unavailable") {
      return jsonError(
        context.get("traceId"),
        "account-unavailable",
        "The account is being deleted.",
        404,
      );
    }
    return assertUnreachable(result);
  },
  async createGrant(context) {
    const { label, requestId } = context.req.valid("json");
    try {
      const result = await createConversionGrant(
        { label, requestId, issuedAtMs: Temporal.Now.instant().epochMilliseconds },
        {
          registry: getRegistryStub(context.env),
          getGrant: (grantId) => getGrantStub(context.env, grantId),
          createRootCredential,
        },
      );
      if (result.result === "already-issued") {
        return context.json(
          {
            result: "already-issued",
            grantId: result.grantId,
            requestId: result.requestId,
            label: result.label,
            createdAt: toIsoString(result.createdAtMs),
            expiresAt: toIsoString(result.expiresAtMs),
            state: "open",
          },
          200,
        );
      }
      const origin = new URL(context.req.url).origin;
      return context.json(
        {
          result: "issued",
          grantId: result.grantId,
          requestId: result.requestId,
          label: result.label,
          createdAt: toIsoString(result.createdAtMs),
          expiresAt: toIsoString(result.expiresAtMs),
          state: "open",
          trialLink: `${origin}/app/trials/${result.grantId}#credential=${result.credential}`,
        },
        201,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("different label")) {
        return jsonError(
          context.get("traceId"),
          "idempotency-conflict",
          "The request ID is already bound to another label.",
          409,
        );
      }
      captureException(error);
      return jsonError(
        context.get("traceId"),
        "operational-error",
        "The conversion grant could not be created.",
        500,
      );
    }
  },

  async listGrants(context) {
    try {
      const searchParameters = new URL(context.req.url).searchParams;
      if (
        ["label", "state", "limit", "cursor"].some(
          (name) => searchParameters.getAll(name).length > 1,
        )
      ) {
        return jsonError(
          context.get("traceId"),
          "invalid-input",
          "Query parameters cannot be repeated.",
          400,
        );
      }
      const query = context.req.valid("query");
      return context.json(
        await getRegistryStub(context.env).listGrants({
          limit: query.limit,
          ...(query.label === undefined ? {} : { label: query.label }),
          ...(query.state === undefined ? {} : { state: query.state }),
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        }),
        200,
      );
    } catch (error) {
      if (error instanceof Error && error.message === "Invalid Registry cursor") {
        return jsonError(
          context.get("traceId"),
          "invalid-cursor",
          "The Registry cursor is invalid.",
          400,
        );
      }
      captureException(error);
      return jsonError(
        context.get("traceId"),
        "operational-error",
        "The Registry could not be read.",
        500,
      );
    }
  },

  async inspectGrant(context) {
    const { grantId } = context.req.valid("param");
    const entry = await getRegistryStub(context.env).getGrant(grantId);
    if (entry === undefined) {
      return jsonError(
        context.get("traceId"),
        "grant-not-found",
        "Conversion grant not found.",
        404,
      );
    }
    const authoritative = await getGrantStub(context.env, grantId).inspectOperator();
    return context.json(
      {
        registry: {
          grantId: entry.grantId,
          requestId: entry.requestId,
          label: entry.label,
          createdAt: toIsoString(entry.createdAtMs),
          expiresAt: toIsoString(entry.expiresAtMs),
          state: deriveEntryState(entry, Temporal.Now.instant().epochMilliseconds),
        },
        authoritative,
        registrySnapshotDisagreement:
          entry.grantSnapshot?.reservedMilliseconds !==
            authoritative.duration.reservedMilliseconds ||
          entry.grantSnapshot?.spentMilliseconds !== authoritative.duration.spentMilliseconds ||
          entry.grantSnapshot?.allowanceMilliseconds !== authoritative.allowanceMilliseconds,
      },
      200,
    );
  },

  async setGrantAllowance(context) {
    const { grantId } = context.req.valid("param");
    const { allowanceMilliseconds } = context.req.valid("json");
    if ((await getRegistryStub(context.env).getGrant(grantId)) === undefined) {
      return jsonError(
        context.get("traceId"),
        "grant-not-found",
        "Conversion grant not found.",
        404,
      );
    }
    const result = await getGrantStub(context.env, grantId).setDurationAllowance(
      allowanceMilliseconds,
    );
    if (result.result === "below-used-duration") {
      return jsonError(
        context.get("traceId"),
        "allowance-below-used-duration",
        "Allowance cannot be lower than reserved and spent duration.",
        409,
      );
    }
    await getRegistryStub(context.env).applyGrantRegistrySnapshot(result.registrySnapshot);
    await getGrantStub(context.env, grantId).confirmRegistrySnapshot(
      result.registrySnapshot.revision,
    );
    return context.json({ changed: result.changed, grant: result.snapshot }, 200);
  },

  async revokeGrant(context) {
    const { grantId } = context.req.valid("param");
    if ((await getRegistryStub(context.env).getGrant(grantId)) === undefined) {
      return jsonError(
        context.get("traceId"),
        "grant-not-found",
        "Conversion grant not found.",
        404,
      );
    }
    const result = await getGrantStub(context.env, grantId).revoke();
    await getRegistryStub(context.env).applyGrantRegistrySnapshot(result.registrySnapshot);
    return context.json({ changed: result.changed, grant: result.snapshot }, 200);
  },

  async invalidateSessions(context) {
    const { grantId } = context.req.valid("param");
    if ((await getRegistryStub(context.env).getGrant(grantId)) === undefined) {
      return jsonError(
        context.get("traceId"),
        "grant-not-found",
        "Conversion grant not found.",
        404,
      );
    }
    const result = await getGrantStub(context.env, grantId).invalidateSessions();
    await getRegistryStub(context.env).applyGrantRegistrySnapshot(result.registrySnapshot);
    return context.json(
      { invalidatedAt: toIsoString(result.invalidatedAtMs), grant: result.snapshot },
      200,
    );
  },

  async migrateGrants(context) {
    const registry = getRegistryStub(context.env);
    const registryVersion = await registry.migrate();
    const reports = await Promise.all(
      (await registry.enumerateGrantIds()).map(async (grantId) => {
        try {
          return {
            grantId,
            success: true as const,
            schemaVersion: await getGrantStub(context.env, grantId).migrate(),
          };
        } catch {
          return { grantId, success: false as const, error: "Migration failed." };
        }
      }),
    );
    return context.json(
      { complete: reports.every((report) => report.success), registryVersion, grants: reports },
      200,
    );
  },
};

export type ApiServerHonoEnvironment = {
  Bindings: ApiServerEnvironment;
  Variables: { traceId: string };
};

/** Creates the HTTP server for the web application and operator interfaces. */
export function createApiServer(dependencies: ApiServerDependencies = productionDependencies) {
  const app = new Hono<ApiServerHonoEnvironment>();
  app.use("*", async (context, next) => {
    await next();
    if (!context.res.headers.has("Cache-Control")) {
      context.header("Cache-Control", "private, no-store");
    }
  });
  app.use("*", async (context, next) => {
    const response = routeApplicationDomain(context.req.raw);
    if (response !== undefined) {
      return response;
    }
    return next();
  });
  const limitApiRequestBody = bodyLimit({
    maxSize: 4_096,
    onError: (context) =>
      jsonError(
        context.get("traceId"),
        "request-too-large",
        "JSON request bodies are limited to 4 KiB.",
        413,
      ),
  });
  app.use("*", (context, next) =>
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", new URL(context.env.SUPABASE_URL).origin],
        imgSrc: ["'self'"],
        // The web player's narration track: a signed media URL on this origin's file routes.
        mediaSrc: [`${new URL(context.req.url).origin}/api/files/`],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'", NONCE],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
      },
      // The Android and iOS apps embed media from their own origins (`https://localhost` on Android,
      // `capacitor://localhost` on iOS) with plain `<img>` and `<audio>` elements. A signed media URL authorizes the request by itself, so its
      // routes allow a cross-origin embed; credentialed CORS still admits only the app's origins.
      crossOriginResourcePolicy: isSignedMediaPath(context.req.path) ? "cross-origin" : true,
      referrerPolicy: "no-referrer",
      xFrameOptions: "DENY",
    })(context, next),
  );
  app.use("*", async (context, next) => {
    context.set("traceId", readTraceId());
    const allowedMethods = allowedMethodsForApiPath(context.req.path);
    if (allowedMethods !== undefined && !allowedMethods.includes(context.req.method)) {
      context.res = jsonError(
        context.get("traceId"),
        "method-not-allowed",
        "The request method is not allowed for this API route.",
        405,
        { Allow: allowedMethods.join(", ") },
      );
    } else {
      await next();
    }
    return context.res;
  });

  app.use("/api/*", async (context, next) => {
    if (context.req.method === "GET" || context.req.method === "HEAD") {
      return next();
    }
    return limitApiRequestBody(context, next);
  });

  app.use("/api/*", async (context, next) => {
    if (
      context.req.method !== "POST" ||
      !/^\/api\/(?:account\/conversions|grants\/[^/]+\/conversions)$/.test(context.req.path)
    ) {
      return next();
    }
    const key = await ingressIdentity(context.req.raw, context.env.LOCAL_DEVELOPMENT === "true");
    if (!key) {
      return jsonError(
        context.get("traceId"),
        "ingress-unavailable",
        "Request ingress metadata is unavailable.",
        503,
      );
    }
    const retryAfter = await context.env.REGISTRY.get(
      context.env.REGISTRY.idFromName("registry"),
    ).consumeIngressRequest(key);
    if (retryAfter) {
      return jsonError(
        context.get("traceId"),
        "rate-limited",
        "Too many requests. Please wait before retrying.",
        429,
        { "Retry-After": String(retryAfter) },
      );
    }
    return next();
  });

  app.use("/api/audiobooks/*", async (context, next) => {
    const origin = context.req.header("Origin");
    allowApplicationOrigin(context, origin);
    if (isPositionPath(context.req.path)) {
      // The position route authorizes either of its two credentials, the bearer token or a signed
      // position URL, and checks ownership itself (`authorizePositionSave`).
      await next();
      context.header("Cross-Origin-Resource-Policy", "same-origin");
      return;
    }
    const rawConversionId = context.req.path.split("/")[3];
    if (!rawConversionId) {
      return next();
    }
    let conversionId: string;
    try {
      conversionId = decodeURIComponent(rawConversionId);
    } catch {
      return jsonError(context.get("traceId"), "invalid-input", "Invalid conversion ID.", 400);
    }
    const owner = await getRegistryStub(context.env).findConversionOwner(conversionId);
    setConversionScope({ conversionId, ...(owner ? { owner } : {}) });
    if (owner?.kind === "trial") {
      const denied = await requireActiveTrialAudiobookSession(
        context.env,
        owner.grantId,
        context.req.header("Cookie"),
        context.get("traceId"),
      );
      if (denied) {
        return denied;
      }
      await next();
      allowApplicationOrigin(context, origin);
      context.header("Cross-Origin-Resource-Policy", "same-origin");
      return;
    }
    if (!owner) {
      return next();
    }
    const auth = await authenticateAccountRequest(context.req.raw, context.env);
    if (auth.result !== "authenticated") {
      return accountAuthError(auth.result, context.get("traceId"));
    }
    if (auth.snapshot.state !== "active") {
      return accountAuthError("blocked", context.get("traceId"));
    }
    if (auth.snapshot.accountId !== owner.accountId) {
      return jsonError(context.get("traceId"), "audiobook-not-found", "Audiobook not found.", 404);
    }
    await next();
    if (!isApplicationOrigin(origin)) {
      context.header("Access-Control-Allow-Origin", undefined);
    }
    context.header("Cross-Origin-Resource-Policy", "same-origin");
  });

  // Media routes accept only a signed media URL. Registering the exact media routes, as listed in
  // `allowedMethodsForApiPath`, lets other paths under `/api/files/` answer 404 instead of 401.
  for (const path of [
    "/api/files/audiobooks/:conversionId/narration-track.mp3",
    "/api/files/audiobooks/:conversionId/cover-image",
  ]) {
    app.use(path, async (context, next) => {
      let conversionId: string;
      try {
        conversionId = decodeURIComponent(context.req.path.split("/")[4] ?? "");
      } catch {
        return jsonError(context.get("traceId"), "invalid-input", "Invalid conversion ID.", 400);
      }
      const owner = await getRegistryStub(context.env).findConversionOwner(conversionId);
      setConversionScope({ conversionId, ...(owner ? { owner } : {}) });
      const denied = await requireSignedMediaUrl(
        context.env,
        context.req.url,
        conversionId,
        owner,
        context.get("traceId"),
      );
      if (denied) {
        return denied;
      }
      await next();
      allowApplicationOrigin(context, context.req.header("Origin"));
      return context.res;
    });
  }

  app.use("/api/operator/*", async (context, next) => {
    if (!(await dependencies.validateOperatorAccess(context.req.raw, context.env))) {
      return jsonError(
        context.get("traceId"),
        "operator-unauthorized",
        "Cloudflare Access authorization is required.",
        401,
      );
    }
    if (
      context.req.method !== "GET" &&
      context.req.method !== "HEAD" &&
      context.req.header("Content-Type") !== "application/json"
    ) {
      return jsonError(
        context.get("traceId"),
        "unsupported-media-type",
        "Content-Type must be application/json.",
        415,
      );
    }
    await next();
    if (context.req.method !== "GET" && context.req.method !== "HEAD") {
      // No operator email: no log record carries an email address. Like every Sentry log record, it
      // carries the trace ID of the request, the one error bodies carry.
      logEvent("operator-mutation", "The operator changed something through the Operator API.", {
        attributes: {
          "http.request.method": context.req.method,
          "url.path": context.req.path,
          "http.response.status_code": context.res.status,
        },
      });
    }
    return context.res;
  });

  // The telemetry tunnel: the client SDK posts its envelopes here, on Cup's own domain, past ad
  // blockers. It is not part of the Listener API, and its path avoids "sentry" so filter lists miss it.
  // Same-origin in the browser; the shells post from their own origins without credentials.
  app.use(
    TELEMETRY_TUNNEL_PATH,
    cors({
      origin: ["capacitor://localhost", "https://localhost"],
      allowMethods: ["POST"],
      // The client SDK reads its rate limits from these.
      exposeHeaders: ["Retry-After", "X-Sentry-Rate-Limits"],
    }),
  );
  app.post(TELEMETRY_TUNNEL_PATH, (context) => {
    // `cf` is typed as incoming or outgoing request properties, which leaves `country` unknown.
    const country = context.req.raw.cf?.country;
    return handleTelemetryTunnelRequest(context.req.raw, {
      tunnelDsns: context.env.SENTRY_TUNNEL_DSNS,
      country: typeof country === "string" ? country : undefined,
    });
  });

  app.notFound(async (context) => {
    if (context.req.path === "/api" || context.req.path.startsWith("/api/")) {
      return jsonError(context.get("traceId"), "not-found", "API route not found.", 404);
    }

    if (context.req.method !== "GET" && context.req.method !== "HEAD") {
      return context.text("Not Found", 404);
    }

    const url = new URL(context.req.url);
    if (url.pathname === "/") {
      return context.redirect(`/app/${url.search}`, 302);
    }
    if (url.pathname === "/app") {
      return context.redirect(`/app/${url.search}`, 308);
    }
    if (/^\/trials\/[^/]+\/?$/.test(url.pathname)) {
      // Leave Location without a fragment so browsers inherit the original trial credential.
      return context.redirect(`/app${url.pathname}${url.search}`, 308);
    }

    // The shell is internal; other existing assets also include Vite's development modules.
    if (url.pathname === "/index.html") {
      return context.text("Not Found", 404);
    }

    let response = await context.env.ASSETS.fetch(context.req.raw);
    if (
      response.status === 404 &&
      url.pathname.startsWith("/app/") &&
      url.pathname !== "/app/assets" &&
      !url.pathname.startsWith("/app/assets/") &&
      !/\.[^/]*$/.test(url.pathname)
    ) {
      url.pathname = "/index.html";
      response = await context.env.ASSETS.fetch(new Request(url, context.req.raw));
    }
    if (!response.headers.get("Content-Type")?.startsWith("text/html")) {
      // An asset response's headers are immutable; the secure headers middleware and the
      // Cache-Control middleware set headers on the response this handler returns.
      return new Response(response.body, response);
    }

    const nonce = context.get("secureHeadersNonce");
    if (nonce === undefined) {
      throw new CupError("Expected the secure headers middleware to set a nonce.");
    }
    return applyWebAppCspNonce(response, nonce);
  });

  app.onError((error, context) => {
    // Hono's own 4xx, such as the validator's answer to a malformed JSON body, is the client's
    // fault: it keeps its status and opens no issue.
    if (error instanceof HTTPException && error.status < 500) {
      return error.status === 400
        ? jsonError(context.get("traceId"), "invalid-input", "The request could not be read.", 400)
        : error.getResponse();
    }
    // Hono hands the error here instead of rethrowing it, so Sentry's handler wrapper never sees it.
    captureException(error);
    return jsonError(
      context.get("traceId"),
      "operational-error",
      "The request could not be completed.",
      500,
    );
  });

  app.use("/api/account/deletion", validateAccountLifecycleRequest);
  app.use("/api/account/deletion/*", validateAccountLifecycleRequest);

  return app
    .route("/", createListenerApi(listenerApiHandlers))
    .route("/", createOperatorApi(operatorApiHandlers));
}

/**
 * The Sentry trace ID of the request, which error bodies carry so that a reported reference finds
 * the request's trace. Sentry's request wrapper makes the request's span active; without one, as in
 * tests that call the app directly, the scope's propagation context still holds a trace ID.
 */
function readTraceId(): string {
  return (
    getActiveSpan()?.spanContext().traceId ?? getCurrentScope().getPropagationContext().traceId
  );
}

/** Whether the path is one of the media routes that a signed media URL authorizes. */
function isSignedMediaPath(path: string): boolean {
  return /^\/api\/files\/audiobooks\/[^/]+\/(?:narration-track\.mp3|cover-image)$/.test(path);
}

/** Whether the path is the listening-position route, which a signed position URL authorizes. */
function isPositionPath(path: string): boolean {
  return /^\/api\/audiobooks\/[^/]+\/position$/.test(path);
}

type PositionSaveAuthorization =
  | { result: "authorized"; account: ReturnType<ApiServerEnvironment["ACCOUNTS"]["get"]> }
  | { result: "denied"; response: Response };

/**
 * Authorizes a listening-position save by exactly one credential: the listener's bearer token or a
 * signed position URL's `token`. Either way, the save goes to an active account, which must own the
 * audiobook; with the bearer token, a trial audiobook that the request's grant session covers
 * counts too. Sign-out does not revoke a position URL; it stays valid until it expires.
 */
async function authorizePositionSave(
  env: ApiServerEnvironment,
  request: Request,
  conversionId: string,
  requestId: string,
): Promise<PositionSaveAuthorization> {
  const hasBearer = request.headers.has("Authorization");
  const hasToken = new URL(request.url).searchParams.has("token");
  if (hasBearer && hasToken) {
    return {
      result: "denied",
      response: jsonError(
        requestId,
        "position-url-invalid",
        "Send either a bearer token or a position URL, not both.",
        401,
      ),
    };
  }

  const owner = await getRegistryStub(env).findConversionOwner(conversionId);
  if (hasToken) {
    const verification = await verifySignedPositionUrl(
      env,
      request.url,
      conversionId,
      owner,
      requestId,
    );
    if (verification.result === "denied") {
      return verification;
    }
    return {
      result: "authorized",
      account: env.ACCOUNTS.get(env.ACCOUNTS.idFromName(verification.accountId)),
    };
  }

  const auth = await authenticateAccountRequest(request, env);
  if (auth.result !== "authenticated") {
    return { result: "denied", response: accountAuthError(auth.result, requestId) };
  }
  if (auth.snapshot.state !== "active") {
    return { result: "denied", response: accountAuthError("blocked", requestId) };
  }
  if (owner?.kind === "trial") {
    // A signed-in listener saves a trial audiobook's position to their account when the request's
    // grant session covers the audiobook. A position URL never authorizes such a save.
    const denied = await requireActiveTrialAudiobookSession(
      env,
      owner.grantId,
      request.headers.get("Cookie") ?? undefined,
      requestId,
    );
    if (denied) {
      return { result: "denied", response: denied };
    }
    return { result: "authorized", account: auth.account };
  }
  if (owner?.accountId !== auth.snapshot.accountId) {
    return {
      result: "denied",
      response: jsonError(requestId, "audiobook-not-found", "Audiobook not found.", 404),
    };
  }
  return { result: "authorized", account: auth.account };
}

/** The web app's origins: the production origin and the one its Capacitor shells load it from. */
function isApplicationOrigin(origin: string | undefined): origin is string {
  return origin === "https://localhost" || origin === APPLICATION_ORIGIN;
}

/**
 * Lets the web app read the response with credentials when the request comes from one of its
 * origins.
 */
function allowApplicationOrigin(context: Context, origin: string | undefined): void {
  if (!isApplicationOrigin(origin)) {
    return;
  }
  context.header("Access-Control-Allow-Origin", origin);
  context.header("Access-Control-Allow-Credentials", "true");
  context.header("Vary", "Origin");
}

function getGrantStub(env: ApiServerEnvironment, grantId: string): GrantStub {
  return env.CONVERSION_GRANTS.get(env.CONVERSION_GRANTS.idFromName(grantId));
}

function conversionNotFound(traceId: string) {
  return jsonError(traceId, "conversion-not-found", "Conversion not found.", 404);
}

function getRegistryStub(env: ApiServerEnvironment): RegistryStub {
  return env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
}

async function authenticateGrant(
  env: ApiServerEnvironment,
  grantId: string,
  cookieHeader: string | undefined,
) {
  const token = getGrantSessionCookie(cookieHeader, grantId);
  if (token === undefined || token === "") {
    return { result: "missing" as const };
  }
  try {
    const result = await getGrantStub(env, grantId).validateSession(token);
    return result.result === "valid"
      ? { result: "valid" as const, token, snapshot: result.snapshot }
      : { result: "invalid" as const };
  } catch (error) {
    // Every caller answers this result with a 500.
    captureException(error);
    return { result: "operational-error" as const };
  }
}

async function requireActiveTrialAudiobookSession(
  env: ApiServerEnvironment,
  grantId: string,
  cookieHeader: string | undefined,
  traceId: string,
): Promise<Response | undefined> {
  const auth = await authenticateGrant(env, grantId, cookieHeader);
  if (auth.result === "operational-error") {
    return jsonError(traceId, "operational-error", "The grant could not be loaded.", 500);
  }
  if (auth.result !== "valid") {
    return jsonError(
      traceId,
      "grant-session-required",
      "Open the original trial link to access this audiobook.",
      401,
    );
  }
  return requireAccessibleGrantState(auth.snapshot.state, traceId);
}

function requireBrowserMutation(request: Request, traceId: string): Response | undefined {
  const origin = request.headers.get("Origin");
  if (
    request.headers.get("X-Create-Audiobook-From-URL-Request") !== "1" ||
    request.headers.get("Content-Type") !== "application/json" ||
    (origin &&
      ![new URL(request.url).origin, "https://localhost", APPLICATION_ORIGIN].includes(origin))
  ) {
    return jsonError(traceId, "origin-blocked", "The request origin is not allowed.", 403);
  }
  return undefined;
}

type SessionMutationRequestValidation =
  | { result: "valid" }
  | { result: "invalid"; response: Response };

function validateSessionMutationRequest(
  request: Request,
  traceId: string,
): SessionMutationRequestValidation {
  if (request.headers.get("Content-Type") !== "application/json") {
    return {
      result: "invalid",
      response: jsonError(
        traceId,
        "unsupported-media-type",
        "Content-Type must be application/json.",
        415,
      ),
    };
  }
  if (
    (request.headers.has("Origin") &&
      request.headers.get("Origin") !== new URL(request.url).origin) ||
    // Reject browser requests from another site; native HTTP requests can omit Fetch Metadata.
    request.headers.get("Sec-Fetch-Site") === "cross-site" ||
    // Require a custom header that cross-origin browser requests cannot send without a CORS preflight.
    request.headers.get("X-Create-Audiobook-From-URL-Request") !== "1"
  ) {
    return {
      result: "invalid",
      response: jsonError(traceId, "origin-forbidden", "The request origin is not allowed.", 403),
    };
  }

  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > 4_096) {
    return {
      result: "invalid",
      response: jsonError(
        traceId,
        "request-too-large",
        "JSON request bodies are limited to 4 KiB.",
        413,
      ),
    };
  }

  return { result: "valid" };
}

function allowedMethodsForApiPath(pathname: string): string[] | undefined {
  const routes: ReadonlyArray<readonly [RegExp, string[]]> = [
    [/^\/api\/grants\/[^/]+\/sessions$/, ["POST"]],
    [/^\/api\/grants\/[^/]+$/, ["GET"]],
    [/^\/api\/grants\/[^/]+\/conversions$/, ["POST"]],
    [/^\/api\/conversions\/[^/]+$/, ["GET"]],
    [/^\/api\/audiobooks\/[^/]+$/, ["GET"]],
    [/^\/api\/audiobooks\/[^/]+\/segments\/[^/]+$/, ["GET", "POST"]],
    [/^\/api\/audiobooks\/[^/]+\/retry$/, ["POST"]],
    [/^\/api\/audiobooks\/[^/]+\/position$/, ["PUT"]],
    [/^\/api\/files\/audiobooks\/[^/]+\/narration-track\.mp3$/, ["GET", "HEAD"]],
    [/^\/api\/files\/audiobooks\/[^/]+\/cover-image$/, ["GET", "HEAD"]],
    [/^\/api\/operator\/grants$/, ["GET", "POST"]],
    [/^\/api\/operator\/grants\/[^/]+$/, ["GET"]],
    [/^\/api\/operator\/grants\/[^/]+\/allowance$/, ["PUT"]],
    [/^\/api\/operator\/grants\/[^/]+\/revocation$/, ["POST"]],
    [/^\/api\/operator\/grants\/[^/]+\/session-invalidations$/, ["POST"]],
    [/^\/api\/operator\/grant-migrations$/, ["POST"]],
    [/^\/api\/operator\/conversions\/[^/]+$/, ["DELETE"]],
  ];
  return routes.find(([pattern]) => pattern.test(pathname))?.[1];
}

function deriveEntryState(
  entry: Awaited<ReturnType<RegistryStub["getGrant"]>> & {},
  nowMs: number,
) {
  if (entry.phase !== "active" || entry.grantSnapshot === undefined) {
    return "provisioning" as const;
  }
  if (entry.grantSnapshot.revokedAtMs !== undefined) {
    return "revoked" as const;
  }
  if (nowMs >= entry.expiresAtMs) {
    return "expired" as const;
  }
  if (entry.grantSnapshot.spentMilliseconds >= entry.grantSnapshot.allowanceMilliseconds) {
    return "exhausted" as const;
  }
  if (
    entry.grantSnapshot.spentMilliseconds + entry.grantSnapshot.reservedMilliseconds >=
    entry.grantSnapshot.allowanceMilliseconds
  ) {
    return "temporarily-full" as const;
  }
  return "open" as const;
}

async function validateAccessAssertion(
  assertion: string | undefined,
  env: ApiServerEnvironment,
): Promise<boolean> {
  if (assertion === undefined) {
    return false;
  }
  try {
    const { payload } = await jwtVerify(assertion, getAccessKeySet(env.OPERATOR_ACCESS_ISSUER), {
      issuer: env.OPERATOR_ACCESS_ISSUER,
      audience: env.OPERATOR_ACCESS_AUDIENCE,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "email"],
    });
    return payload["email"] === env.OPERATOR_EMAIL;
  } catch {
    return false;
  }
}

function getAccessKeySet(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  const normalizedIssuer = issuer.replace(/\/$/, "");
  const existingKeySet = accessKeySets.get(normalizedIssuer);
  if (existingKeySet !== undefined) {
    return existingKeySet;
  }
  const keySet = createRemoteJWKSet(new URL(`${normalizedIssuer}/cdn-cgi/access/certs`));
  accessKeySets.set(normalizedIssuer, keySet);
  return keySet;
}

function toIsoString(epochMilliseconds: number): string {
  return Temporal.Instant.fromEpochMilliseconds(epochMilliseconds).toString();
}
