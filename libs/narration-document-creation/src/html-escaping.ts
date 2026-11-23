export function escapeHtmlText(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

export function escapeHtmlAttribute(text: string): string {
  return escapeHtmlText(text).replace(/"/gu, "&quot;");
}
