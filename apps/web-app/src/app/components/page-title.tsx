import React from "react";

export function PageTitle({ name }: { name: string }): React.JSX.Element {
  return <title>{`${name} · Cup`}</title>;
}
