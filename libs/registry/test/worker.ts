import * as Sentry from "@sentry/cloudflare";
import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";

import { AccountDurableObject as BaseAccountDurableObject } from "@cup/accounts";
import type { DeletionAttempt } from "@cup/accounts/lifecycle";
import { ConversionGrantDurableObject as BaseConversionGrantDurableObject } from "@cup/conversion-grants";
import { CupError } from "@cup/errors";
import { createWorkerSentryOptions } from "@cup/telemetry.cloudflare";

import { DeletionCoordinator } from "#src/account-deletion/deletion-coordinator.ts";
import { RegistryDurableObject as BaseRegistryDurableObject } from "#src/index.ts";
import { migrateRegistry } from "#src/storage/sqlite-migrations.ts";

import { createHoldingAccounts, type AccountMethod, type Hold } from "#test/holding-accounts.ts";

export class AccountDispatchTestDurableObject extends BaseAccountDurableObject {
  constructor(
    context: DurableObjectState,
    env: {
      CONVERSION_OWNER_LIMIT: string;
      REGISTRY: DurableObjectNamespace<RegistryDurableObject>;
      AUDIO_BUCKET: R2Bucket;
    },
  ) {
    super(context, {
      CONVERSION_OWNER_LIMIT: env.CONVERSION_OWNER_LIMIT,
      REGISTRY: env.REGISTRY,
      AUDIO_BUCKET: env.AUDIO_BUCKET,
      SYNTHESIZE_AUDIO_SEGMENT_WORKFLOW: {
        create: async () => {
          throw new Error("Synthesis is controlled by the test");
        },
        get: async () => {
          throw new Error("Synthesis is controlled by the test");
        },
      },
      PREPARE_AUDIOBOOK_WORKFLOW: {
        create: async () => {
          throw new Error("Lost acknowledgement");
        },
        get: async () => ({
          status: async () => ({ status: "errored" }),
          restart: async () => {
            throw new Error("Restart is outside this dispatch test");
          },
          terminate: async () => {
            throw new Error("Termination is outside this dispatch test");
          },
        }),
      },
    });
  }
  async migrateForTest() {
    await this.migrate();
    return { snapshot: this.inspect(), accounting: this.inspectAccounting() };
  }
  reconcileForTest() {
    return this.alarm();
  }
}

export class AccountDurableObject extends BaseAccountDurableObject {
  private readonly workflows: WorkflowControl;
  private readonly registryControl: RegistryControl;
  private firedAlarms = 0;
  private shouldWriterReconciliationFail = false;

  constructor(
    context: DurableObjectState,
    env: {
      CONVERSION_OWNER_LIMIT: string;
      REGISTRY: DurableObjectNamespace<RegistryDurableObject>;
      AUDIO_BUCKET: R2Bucket;
    },
  ) {
    const registryControl: RegistryControl = {
      shouldNextOwnerRemovalFail: false,
      shouldUsageProjectionFail: false,
      beforeNextOwnerBind: undefined,
    };
    const workflows: WorkflowControl = {
      isPreparationAccepted: false,
      preparationCreations: [],
      terminations: [],
      shouldTerminationFail: false,
      stoppedStatus: undefined,
      instanceStatuses: new Map(),
    };
    const reportedStatus = (id: string) =>
      workflows.instanceStatuses.get(id) ?? workflows.stoppedStatus;
    const controlledInstance = (id: string) => ({
      status: async (): Promise<{ status: string }> => {
        const status = reportedStatus(id);
        if (status !== undefined) {
          return { status };
        }
        throw new Error("Workflows are controlled by the test");
      },
      restart: async () => {
        throw new Error("Workflows are controlled by the test");
      },
      terminate: async () => {
        workflows.terminations.push(id);
        if (workflows.shouldTerminationFail) {
          throw new Error("Termination failed");
        }
        const status = reportedStatus(id);
        if (status === "complete" || status === "errored" || status === "terminated") {
          throw new Error("The instance has already finished");
        }
      },
    });
    super(context, {
      ...env,
      REGISTRY: {
        idFromName: (name) => env.REGISTRY.idFromName(name),
        get: (id) => {
          const registry = env.REGISTRY.get(id);
          return {
            bindConversionOwner: async (conversionId, owner) => {
              const beforeNextOwnerBind = registryControl.beforeNextOwnerBind;
              registryControl.beforeNextOwnerBind = undefined;
              await beforeNextOwnerBind?.(conversionId);
              await registry.bindConversionOwner(conversionId, owner);
            },
            acceptDeletionAttempt: (attempt) => registry.acceptDeletionAttempt(attempt),
            removeAccountConversionOwners: (accountId) =>
              registry.removeAccountConversionOwners(accountId),
            applyAccountUsageProjection: async (projection) => {
              if (registryControl.shouldUsageProjectionFail) {
                throw new Error("Usage projection failed");
              }
              return registry.applyAccountUsageProjection(projection);
            },
            removeConversionOwner: async (conversionId) => {
              if (registryControl.shouldNextOwnerRemovalFail) {
                registryControl.shouldNextOwnerRemovalFail = false;
                throw new Error("Owner removal failed");
              }
              await registry.removeConversionOwner(conversionId);
            },
          };
        },
      },
      SYNTHESIZE_AUDIO_SEGMENT_WORKFLOW: {
        create: async () => {},
        get: async (id) => controlledInstance(id),
      },
      PREPARE_AUDIOBOOK_WORKFLOW: {
        create: async ({ id }) => {
          if (!workflows.isPreparationAccepted) {
            throw new Error("Preparation is controlled by the test");
          }
          workflows.preparationCreations.push(id);
        },
        get: async (id) => controlledInstance(id),
      },
    });
    this.workflows = workflows;
    this.registryControl = registryControl;
  }
  override async alarm() {
    this.firedAlarms += 1;
  }
  firedAlarmsForTest() {
    return this.firedAlarms;
  }
  alarmForTest() {
    return this.ctx.storage.getAlarm();
  }
  disarmForTest() {
    return this.ctx.storage.deleteAlarm();
  }
  restartForTest() {
    this.ctx.abort("Restarted by the test");
  }
  failUsageProjectionsForTest() {
    this.registryControl.shouldUsageProjectionFail = true;
  }
  failNextOwnerRemovalForTest() {
    this.registryControl.shouldNextOwnerRemovalFail = true;
  }
  deleteAndCleanUpDuringNextOwnerBindForTest() {
    this.registryControl.beforeNextOwnerBind = async (conversionId) => {
      await this.deleteConversion(conversionId);
      await super.alarm();
    };
  }
  acceptPreparationForTest() {
    this.workflows.isPreparationAccepted = true;
  }
  preparationCreationsForTest() {
    return this.workflows.preparationCreations;
  }
  terminationsForTest() {
    return this.workflows.terminations;
  }
  failTerminationsForTest() {
    this.workflows.shouldTerminationFail = true;
  }
  reportWorkflowStatusForTest(id: string, status: string) {
    this.workflows.instanceStatuses.set(id, status);
  }
  stopWorkflowsForTest() {
    this.workflows.stoppedStatus = "terminated";
  }
  failArtifactWriterReconciliationForTest() {
    this.shouldWriterReconciliationFail = true;
  }
  override async reconcileArtifactWriter(writerId: string) {
    if (this.shouldWriterReconciliationFail) {
      throw new CupError("Artifact writer reconciliation failed");
    }
    return super.reconcileArtifactWriter(writerId);
  }
  reconcileForTest() {
    return super.alarm();
  }
  forgetStageStartsForTest() {
    this.ctx.storage.sql.exec("UPDATE account_conversions SET stage_started_at_ms = NULL");
  }
  reconcileAtForTest(nowMs: number) {
    return super.reconcile(nowMs);
  }
  async failingReconcileAtForTest(nowMs: number) {
    try {
      await super.reconcile(nowMs);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}

type RegistryControl = {
  shouldNextOwnerRemovalFail: boolean;
  shouldUsageProjectionFail: boolean;
  beforeNextOwnerBind: ((conversionId: string) => Promise<void>) | undefined;
};

type WorkflowControl = {
  isPreparationAccepted: boolean;
  preparationCreations: string[];
  terminations: string[];
  shouldTerminationFail: boolean;
  stoppedStatus: string | undefined;
  instanceStatuses: Map<string, string>;
};
export class RegistryDurableObject extends BaseRegistryDurableObject {
  forgetAccountUsageForTest(accountId: string) {
    this.ctx.storage.sql.exec(
      `UPDATE identity_accounts SET projection_revision = NULL,
        projection_allowance_milliseconds = NULL, projection_reserved_milliseconds = NULL,
        projection_spent_milliseconds = NULL, projection_schema_version = NULL
      WHERE account_id = ?`,
      accountId,
    );
  }
  reconcileForTest() {
    return this.alarm();
  }
}

export { ConversionGrantDurableObject } from "@cup/conversion-grants";

export class ConversionGrantTestDurableObject extends BaseConversionGrantDurableObject {
  private readonly workflowControl: { areStopped: boolean; shouldSegmentReleaseFail: boolean };

  constructor(
    context: DurableObjectState,
    env: {
      CONVERSION_OWNER_LIMIT: string;
      REGISTRY: DurableObjectNamespace<RegistryDurableObject>;
      AUDIO_BUCKET: R2Bucket;
    },
  ) {
    const unreachableInstance = {
      status: async (): Promise<{ status: string }> => {
        throw new Error("Workflows are controlled by the test");
      },
      restart: async () => {},
    };
    const workflowControl = { areStopped: false, shouldSegmentReleaseFail: false };
    const acceptingWorkflow = {
      create: async () => {},
      get: async () =>
        workflowControl.areStopped
          ? { status: async () => ({ status: "terminated" }), restart: async () => {} }
          : unreachableInstance,
    };
    super(context, {
      ...env,
      PREPARE_AUDIOBOOK_WORKFLOW: acceptingWorkflow,
      SYNTHESIZE_AUDIO_SEGMENT_WORKFLOW: acceptingWorkflow,
    });
    this.workflowControl = workflowControl;
  }
  override async alarm() {}
  stopWorkflowsForTest() {
    this.workflowControl.areStopped = true;
  }
  failSegmentReleaseForTest() {
    this.workflowControl.shouldSegmentReleaseFail = true;
  }
  override async releaseAudioSegment(conversionId: string, sequence: number, attempts?: number) {
    if (this.workflowControl.shouldSegmentReleaseFail) {
      throw new CupError("Segment release failed");
    }
    return super.releaseAudioSegment(conversionId, sequence, attempts);
  }
  forgetStageStartsForTest() {
    this.ctx.storage.sql.exec("UPDATE conversions SET stage_started_at_ms = NULL");
  }
  reconcileAtForTest(nowMs: number) {
    return super.reconcile(nowMs);
  }
  async failingReconcileAtForTest(nowMs: number) {
    try {
      await super.reconcile(nowMs);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}

export const SentryAccountDurableObject = Sentry.instrumentDurableObjectWithSentry(
  (env: object) => createWorkerSentryOptions(env, "account-durable-object"),
  AccountDurableObject,
);

export const SentryConversionGrantDurableObject = Sentry.instrumentDurableObjectWithSentry(
  (env: object) => createWorkerSentryOptions(env, "conversion-grant-durable-object"),
  ConversionGrantTestDurableObject,
);

export default {
  fetch(): Response {
    return new Response("Account test Worker");
  },
} satisfies ExportedHandler;

export class DeletionTestDurableObject extends DurableObject<{
  ACCOUNTS: DurableObjectNamespace<AccountDurableObject>;
}> {
  constructor(
    context: DurableObjectState,
    env: { ACCOUNTS: DurableObjectNamespace<AccountDurableObject> },
  ) {
    super(context, env);
    void context.blockConcurrencyWhile(() => migrateRegistry(drizzle(context.storage)));
  }
  private responseStatus = 200;
  private retryAfter: string | undefined;
  private requests = 0;
  private readonly coordinator = new DeletionCoordinator(
    this.ctx.storage,
    {
      ACCOUNTS: this.env.ACCOUNTS,
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_SECRET_KEY: "test",
      RESEND_API_KEY: "test",
      RESEND_BASE_URL: "https://resend.test",
    },
    {
      request: async () => {
        this.requests += 1;
        return new Response("{}", {
          status: this.responseStatus,
          headers: this.retryAfter ? { "Retry-After": this.retryAfter } : {},
        });
      },
    },
  );
  private readonly holdingAccounts = createHoldingAccounts(this.env.ACCOUNTS);
  private accountHold: Hold | undefined;
  override async alarm() {}
  configureProviderForTest(status: number, retryAfter?: string) {
    this.responseStatus = status;
    this.retryAfter = retryAfter;
  }
  requestsForTest() {
    return this.requests;
  }
  async reconcileForTest() {
    await this.coordinator.reconcile(
      () => {},
      () => {},
    );
    return this.coordinator.receipts();
  }

  acceptForTest(attempt: DeletionAttempt) {
    return this.coordinator.accept(attempt);
  }
  statusForTest() {
    return this.coordinator.status();
  }
  async reconcileWithProvidersForTest(resendBaseUrl: string, timeoutMs: number) {
    const coordinator = new DeletionCoordinator(
      this.ctx.storage,
      {
        ACCOUNTS: this.holdingAccounts.accounts,
        SUPABASE_URL: "http://127.0.0.1:9",
        SUPABASE_SECRET_KEY: "test",
        RESEND_API_KEY: "test-resend",
        RESEND_BASE_URL: resendBaseUrl,
      },
      { timeoutMs },
    );
    await coordinator.reconcile(
      () => {},
      () => {},
    );
    return coordinator.receipts();
  }
  holdNextAccountCallForTest(method: AccountMethod) {
    this.accountHold = this.holdingAccounts.holdNext(method);
  }
  async accountCallReachedForTest() {
    await this.accountHold?.reached;
  }
  releaseAccountCallForTest() {
    this.accountHold?.release();
  }
}

export const SentryDeletionTestDurableObject = Sentry.instrumentDurableObjectWithSentry(
  (env) => createWorkerSentryOptions(env, "registry-durable-object"),
  DeletionTestDurableObject,
);
