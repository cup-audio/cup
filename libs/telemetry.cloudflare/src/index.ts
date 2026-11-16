export { captureAlarmFailure } from "#src/alarm-failure.ts";
export {
  setConversionScope,
  withConversionScope,
  type ConversionTelemetryContext,
} from "#src/conversion-scope.ts";
export { logEvent, type LogAttributeValue, type LogEventDetails } from "#src/log-event.ts";
export {
  handleTelemetryTunnelRequest,
  type TelemetryTunnelOptions,
} from "#src/telemetry-tunnel.ts";
export {
  createWorkerSentryOptions,
  type WorkerComponent,
  type WorkerSentryEnvironment,
} from "#src/worker-sentry-options.ts";
export { captureStoppedWorkflow, type StoppedWorkflow } from "#src/stopped-workflow.ts";
export { reportStuckConversions, type StuckConversionCandidate } from "#src/stuck-conversion.ts";
export {
  reportStuckConversionDeletions,
  type StuckConversionDeletionCandidate,
} from "#src/stuck-conversion-deletion.ts";
export {
  logAudioSegmentSettled,
  logPreparationSettled,
  type PreparationOutcome,
} from "#src/conversion-outcomes.ts";
