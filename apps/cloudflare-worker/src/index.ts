import * as Sentry from "@sentry/cloudflare";

import { AccountDurableObject as UninstrumentedAccountDurableObject } from "@cup/accounts";
import { createApiServer } from "@cup/api-server";
import { ConversionGrantDurableObject as UninstrumentedConversionGrantDurableObject } from "@cup/conversion-grants";
import {
  PrepareAudiobookWorkflow as UninstrumentedPrepareAudiobookWorkflow,
  SynthesizeAudioSegmentWorkflow as UninstrumentedSynthesizeAudioSegmentWorkflow,
} from "@cup/create-audiobook-from-url-workflow";
import { RegistryDurableObject as UninstrumentedRegistryDurableObject } from "@cup/registry";

import { sentryOptionsFor } from "#src/sentry-options.ts";

export const AccountDurableObject = Sentry.instrumentDurableObjectWithSentry(
  sentryOptionsFor("account-durable-object"),
  UninstrumentedAccountDurableObject,
);
export const RegistryDurableObject = Sentry.instrumentDurableObjectWithSentry(
  sentryOptionsFor("registry-durable-object"),
  UninstrumentedRegistryDurableObject,
);
export const ConversionGrantDurableObject = Sentry.instrumentDurableObjectWithSentry(
  sentryOptionsFor("conversion-grant-durable-object"),
  UninstrumentedConversionGrantDurableObject,
);
export const PrepareAudiobookWorkflow = Sentry.instrumentWorkflowWithSentry(
  sentryOptionsFor("prepare-audiobook-workflow"),
  UninstrumentedPrepareAudiobookWorkflow,
);
export const SynthesizeAudioSegmentWorkflow = Sentry.instrumentWorkflowWithSentry(
  sentryOptionsFor("synthesize-audio-segment-workflow"),
  UninstrumentedSynthesizeAudioSegmentWorkflow,
);

export default Sentry.withSentry(sentryOptionsFor("fetch"), createApiServer());
