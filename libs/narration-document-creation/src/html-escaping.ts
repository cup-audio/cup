/** Escapes text for an HTML text node. */
export function escapeHtmlText(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

/** Escapes text for a double-quoted HTML attribute value. */
export function escapeHtmlAttribute(text: string): string {
  return escapeHtmlText(text).replace(/"/gu, "&quot;");
}
