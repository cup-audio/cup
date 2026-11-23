import { useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import React from "react";

import { DSButton } from "#src/app/design-system/button.js";
import { describeError, type DescribeApiRefusal } from "#src/errors.js";

function ErrorMessage({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <h1>{title}</h1>
      <div>{children}</div>
    </div>
  );
}

export function ErrorScreen({
  error,
  fallbackTitle,
  describeApiRefusal,
  onRetry,
}: {
  error: unknown;
  fallbackTitle: string;
  describeApiRefusal?: DescribeApiRefusal;
  onRetry: () => void;
}): React.JSX.Element {
  const description = describeError(error, fallbackTitle, describeApiRefusal);

  return (
    <ErrorMessage title={description.title}>
      {description.detail}
      {description.reference === undefined ? null : <p>Reference: {description.reference}</p>}
      {description.isRetryable ? (
        <DSButton type="button" variant="contained" onClick={onRetry}>
          Try again
        </DSButton>
      ) : null}
    </ErrorMessage>
  );
}

export function RouteErrorScreen({ error }: ErrorComponentProps): React.JSX.Element {
  const router = useRouter();

  return (
    <ErrorScreen
      error={error}
      fallbackTitle="This page could not be loaded."
      onRetry={() => void router.invalidate()}
    />
  );
}
