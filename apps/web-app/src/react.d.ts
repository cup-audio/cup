import * as _React from "react";

declare module "react" {
  // oxlint-disable-next-line typescript/consistent-type-definitions
  interface CSSProperties {
    [key: `--${string}`]: string | number | undefined;
  }
}
