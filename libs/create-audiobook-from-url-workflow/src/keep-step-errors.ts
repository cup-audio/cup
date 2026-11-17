import type { WorkflowStep, WorkflowStepContext } from "cloudflare:workers";

import { CupError } from "@cup/errors";

/** The error each failed step's last attempt threw, by the error the engine rebuilt from it. */
const ORIGINAL_STEP_ERRORS = new WeakMap<object, unknown>();

/**
 * Wraps a run's Workflow step so that the run can capture the error a failed step's callback threw:
 * `originalStepError` finds it from the error the engine rebuilt.
 *
 * The engine rebuilds a failed step's error without own properties or `cause`, which drops the
 * brand of a `CupError` and the exception chain, so telemetry would treat Cup's own error as
 * foreign and send it without its message. `step.do` still rejects with the rebuilt error, so
 * everything but telemetry behaves as before, such as a failed segment's explanation, whose text
 * the engine prefixes with `NonRetryableError: ` for that error. The original stays in this run's
 * memory only; after an engine restart, a replay of the run skips the failed step's callback and
 * has only the rebuilt error, which then reaches telemetry as foreign. A foreign error the callback
 * threw stays foreign either way and loses its message.
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
      if (lastAttemptFailure !== undefined && isObject(rebuiltError)) {
        ORIGINAL_STEP_ERRORS.set(rebuiltError, lastAttemptFailure.error);
      }
      throw rebuiltError;
    }
  };

  return {
    do: keepingDo,
    sleep: (name, duration) => step.sleep(name, duration),
    sleepUntil: (name, timestamp) => step.sleepUntil(name, timestamp),
    waitForEvent: (name, options) => step.waitForEvent(name, options),
  };
}

/**
 * The error to capture for a caught error: the one a step's callback threw, when the caught error
 * is the engine's rebuild of it in this run, and otherwise the caught error itself.
 */
export function originalStepError(error: unknown): unknown {
  return isObject(error) && ORIGINAL_STEP_ERRORS.has(error)
    ? ORIGINAL_STEP_ERRORS.get(error)
    : error;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
