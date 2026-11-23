import { css } from "@linaria/core";
import React from "react";

import { composeClassnames } from "#src/app/utils.js";

type DSButtonGroupProps = {
  children: React.ReactNode;
  className?: string;
};

export const DSButtonGroup: React.FC<DSButtonGroupProps> = ({ children, className }) => {
  return (
    <div
      className={composeClassnames(
        css`
          display: flex;
          flex-wrap: wrap;
          gap: var(--spacing-base);
          justify-content: flex-end;
        `,
        className,
      )}
    >
      {children}
    </div>
  );
};
