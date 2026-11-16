import { expect, test } from "vitest";

import { conversionFailureCategories } from "@cup/conversion-contracts";

import { accountOutcomeSchema } from "#src/domain/account-contracts.ts";

test("a failed outcome stored with the former `execution-failed` category reads as workflow-platform", () => {
  expect(
    accountOutcomeSchema.parse({
      status: "failed",
      failureCategory: "execution-failed",
      explanation: "The conversion could not be completed.",
    }),
  ).toEqual({
    status: "failed",
    failureCategory: "workflow-platform",
    explanation: "The conversion could not be completed.",
  });
});

test("a failed outcome carries a known failure category", () => {
  expect(conversionFailureCategories).not.toContain("execution-failed");
  expect(() =>
    accountOutcomeSchema.parse({
      status: "failed",
      failureCategory: "something-else",
      explanation: "The conversion could not be completed.",
    }),
  ).toThrow("Invalid option");
});
