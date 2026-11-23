import { CupError } from "@cup/errors";

import { toLanguageSubtag } from "#src/language-tag.ts";
import { GEMINI_SPEECH_CONFIG, type SpeechConfig } from "#src/speech-synthesis-config.ts";

const GEMINI_FLASH_LITE_TTS_LANGUAGES = new Set([
  "ace",
  "af",
  "ak",
  "am",
  "hy",
  "as",
  "awa",
  "ban",
  "bn",
  "bjn",
  "eu",
  "be",
  "bho",
  "bs",
  "bug",
  "bg",
  "yue",
  "ca",
  "ceb",
  "ckb",
  "hne",
  "zh",
  "hr",
  "cs",
  "da",
  "nl",
  "arz",
  "en",
  "et",
  "fil",
  "fr",
  "gl",
  "lg",
  "ka",
  "de",
  "el",
  "gu",
  "ht",
  "mn",
  "ha",
  "he",
  "hi",
  "hu",
  "is",
  "ilo",
  "id",
  "fa",
  "it",
  "ja",
  "jv",
  "kam",
  "kn",
  "ks",
  "kk",
  "km",
  "ki",
  "rw",
  "kg",
  "ko",
  "ky",
  "lo",
  "ln",
  "mk",
  "mag",
  "mai",
  "ml",
  "mt",
  "mni",
  "mr",
  "min",
  "lus",
  "ne",
  "fuv",
  "az",
  "nso",
  "uz",
  "nb",
  "nn",
  "ny",
  "or",
  "pl",
  "pt",
  "pa",
  "ro",
  "ru",
  "sat",
  "sr",
  "si",
  "sk",
  "azb",
  "pbt",
  "es",
  "ar",
  "lv",
  "ms",
  "ta",
  "te",
  "tr",
  "vi",
]);

export type NarrationLanguageSupport = "speakable" | "unspeakable" | "ignored";

export function getNarrationLanguageSupport(
  narrationLanguage: string,
  speechConfig: SpeechConfig,
): NarrationLanguageSupport {
  if (speechConfig.provider === "elevenlabs") {
    return "ignored";
  }

  if (speechConfig.model !== GEMINI_SPEECH_CONFIG.model) {
    throw new CupError(
      `No speakable languages are registered for the Gemini speech model ${speechConfig.model}`,
    );
  }

  return GEMINI_FLASH_LITE_TTS_LANGUAGES.has(toLanguageSubtag(narrationLanguage))
    ? "speakable"
    : "unspeakable";
}
