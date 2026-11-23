import { Toast } from "@base-ui/react/toast";

import { describeError } from "#src/errors.js";

export const toastManager = Toast.createToastManager();

export function notifyError(
  error: unknown,
  { title = "That did not work.", id }: { title?: string | undefined; id?: string } = {},
) {
  const description = describeError(error, title);
  toastManager.add({
    id,
    type: "error",
    priority: "high",
    title: description.title,
    description:
      description.reference === undefined
        ? description.detail
        : [description.detail, `Reference: ${description.reference}`].filter(Boolean).join(" "),
  });
}
