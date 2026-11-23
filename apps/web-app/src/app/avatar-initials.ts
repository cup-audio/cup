const STARTS_WITH_LETTER = /^\p{L}/u;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function toAvatarInitials(name: unknown): string | undefined {
  if (typeof name !== "string") {
    return undefined;
  }

  const letterGraphemes = name
    .normalize("NFC")
    .split(/\s+/u)
    .map(firstLetterGrapheme)
    .filter((grapheme) => grapheme !== undefined);

  const first = letterGraphemes.at(0);
  if (first === undefined) {
    return undefined;
  }

  return letterGraphemes.length === 1 ? first : `${first}${letterGraphemes.at(-1)}`;
}

function firstLetterGrapheme(word: string): string | undefined {
  for (const { segment } of graphemeSegmenter.segment(word)) {
    if (STARTS_WITH_LETTER.test(segment)) {
      return segment;
    }
  }
  return undefined;
}
