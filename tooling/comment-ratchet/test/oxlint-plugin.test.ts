import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";

import plugin from "#src/oxlint-plugin.ts";

RuleTester.describe = describe;
RuleTester.it = it;

new RuleTester().run("no-comments", plugin.rules["no-comments"], {
  valid: [
    { code: "export const value = 1;", filename: "not-in-baseline.ts" },
    {
      code: "// oxlint-disable-next-line no-console\nconsole.log(1);",
      filename: "not-in-baseline.ts",
    },
  ],
  invalid: [
    {
      code: "// Explains the next line.\nexport const value = 1;",
      filename: "not-in-baseline.ts",
      errors: 1,
    },
    {
      code: "/** Documents the value. */\nexport const value = 1; /* trailing */",
      filename: "not-in-baseline.ts",
      errors: 2,
    },
  ],
});
