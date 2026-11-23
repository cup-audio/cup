export function isCanonicalLanguageTag(tag: string): boolean {
  try {
    return Intl.getCanonicalLocales(tag)[0] === tag;
  } catch {
    return false;
  }
}

export function toLanguageSubtag(tag: string): string {
  return new Intl.Locale(tag).language;
}
