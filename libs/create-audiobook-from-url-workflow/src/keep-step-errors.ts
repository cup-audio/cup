import type { WorkflowStep, WorkflowStepContext } from "cloudflare:workers";

import { CupError } from "@cup/errors";

const ORIGINAL_STEP_ERRORS = new WeakMap<object, unknown>();

export function keepStepErrors(step: WorkflowStep): WorkflowStep {
  const stepDo: unknown = Reflect.get(step, "do");
  if (typeof stepDo !== "function") {
    throw new CupError("A Workflow step has no do method");
  }

  const keepingDo = async (name: string, ...args: unknown[]): Promise<unknown> => {
    const callbackIndex = typeof args[0] === "function" ? 0 : 1;
    const callback = args[callbackIndex];
    if (typeof callback !== "function") {
      throw new CupError(`Workflow step "${name}" has no callback`);
    }

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

export function originalStepError(error: unknown): unknown {
  return isObject(error) && ORIGINAL_STEP_ERRORS.has(error)
    ? ORIGINAL_STEP_ERRORS.get(error)
    : error;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
