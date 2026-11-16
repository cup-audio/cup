import type { WorkflowStep, WorkflowStepContext } from "cloudflare:workers";

import { CupError } from "@cup/errors";
import { forgetSentryCapture } from "@cup/telemetry.cloudflare";

/**
 * Wraps a run's Workflow step so that a failed `step.do` rejects with the error its callback threw,
 * not the error the engine rebuilt from it.
 *
 * The engine rebuilds a failed step's error without own properties or `cause`, which drops the
 * brand of a `CupError` and the exception chain, so telemetry would treat Cup's own error as
 * foreign and send it without its message. The original stays in this run's memory only; after an
 * engine restart, a replay of the run skips the failed step's callback and gets the rebuilt error,
 * which then reaches telemetry as foreign. A foreign error the callback threw stays foreign either
 * way and loses its message.
 */
export function keepStepErrors(step: WorkflowStep): WorkflowStep {
  const stepDo: unknown = Reflect.get(step, "do");
  if (typeof stepDo !== "function") {
    throw new CupError("A Workflow step has no do method");
  }

  // `do` takes its callback either second or third, after an optional config, and an optional
  // rollback after it.
  const keepingDo = async (name: string, ...args: unknown[]): Promise<unknown> => {
    const callbackIndex = typeof args[0] === "function" ? 0 : 1;
    const callback = args[callbackIndex];
    if (typeof callback !== "function") {
      throw new CupError(`Workflow step "${name}" has no callback`);
    }

    // Only the error of the latest attempt counts: an earlier attempt that timed out can still
    // throw while a later one runs, and a last attempt that timed out threw nothing of its own.
    let startedAttempts = 0;
    let lastAttemptFailure: { error: unknown } | undefined;
    const keepingCallback = async (context: WorkflowStepContext) => {
      startedAttempts += 1;
      const attempt = startedAttempts;
      lastAttemptFailure = undefined;
      try {
        const result: unknown = await Reflect.apply(callback, undefined, [context]);
        return result;
      } catch (error) {
        if (attempt === startedAttempts) {
          lastAttemptFailure = { error };
        }
        throw error;
      }
    };

    const stepArgs = args.with(callbackIndex, keepingCallback);
    try {
      // Called through `Reflect` because no overload of `do` takes the arguments as one list.
      const result: unknown = await Reflect.apply(stepDo, step, [name, ...stepArgs]);
      return result;
    } catch (rebuiltError) {
      if (lastAttemptFailure === undefined) {
        throw rebuiltError;
      }
      // Sentry's step wrapper captured the original on the last attempt, and a Durable Object's
      // wrapper may have captured it before it crossed an RPC call; the run captures it once more.
      forgetSentryCapture(lastAttemptFailure.error);
      throw lastAttemptFailure.error;
    }
  };

  return {
    do: keepingDo,
    sleep: (name, duration) => step.sleep(name, duration),
    sleepUntil: (name, timestamp) => step.sleepUntil(name, timestamp),
    waitForEvent: (name, options) => step.waitForEvent(name, options),
  };
}
