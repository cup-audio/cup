export type SpeechConfig = {
  provider: "google-ai-studio" | "elevenlabs";
  model: string;
  voice: string;
  policyVersion: string;
};

export const GEMINI_SPEECH_CONFIG = {
  provider: "google-ai-studio",
  model: "gemini-3.8-flash-lite-tts",
  voice: "Charon",
  policyVersion: "6",
} as const satisfies SpeechConfig;

export const LEGACY_GEMINI_V7_SPEECH_CONFIG = {
  provider: "google-ai-studio",
  model: "gemini-3.8-flash-lite-tts",
  voice: "Charon",
  policyVersion: "7",
} as const satisfies SpeechConfig;

export const LEGACY_GEMINI_V5_SPEECH_CONFIG = {
  provider: "google-ai-studio",
  model: "gemini-3.8-flash-lite-tts",
  voice: "Charon",
  policyVersion: "5",
} as const satisfies SpeechConfig;

export const LEGACY_GEMINI_V4_SPEECH_CONFIG = {
  provider: "google-ai-studio",
  model: "gemini-3.8-flash-lite-tts",
  voice: "Charon",
  policyVersion: "4",
} as const satisfies SpeechConfig;

export const LEGACY_GEMINI_V3_SPEECH_CONFIG = {
  provider: "google-ai-studio",
  model: "gemini-3.1-flash-tts-preview",
  voice: "Charon",
  policyVersion: "3",
} as const satisfies SpeechConfig;

export const ELEVENLABS_SPEECH_CONFIG = {
  provider: "elevenlabs",
  model: "eleven_v3",
  voice: "ktkP7Nsj67dw2zcplQYt",
  policyVersion: "1",
} as const satisfies SpeechConfig;

export const KNOWN_SPEECH_CONFIGS = [
  GEMINI_SPEECH_CONFIG,
  LEGACY_GEMINI_V7_SPEECH_CONFIG,
  LEGACY_GEMINI_V5_SPEECH_CONFIG,
  LEGACY_GEMINI_V4_SPEECH_CONFIG,
  LEGACY_GEMINI_V3_SPEECH_CONFIG,
  ELEVENLABS_SPEECH_CONFIG,
] as const satisfies readonly SpeechConfig[];

export function isSameSpeechConfig(left: SpeechConfig, right: SpeechConfig): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.voice === right.voice &&
    left.policyVersion === right.policyVersion
  );
}

const POLICY_6_SPEED_FACTOR = 1.05;

export function getSpeedFactor(speechConfig: SpeechConfig): number {
  const isPolicy6Pace =
    speechConfig.provider === "google-ai-studio" &&
    (speechConfig.policyVersion === "6" || speechConfig.policyVersion === "7");

  return isPolicy6Pace ? POLICY_6_SPEED_FACTOR : 1;
}

export const SPEECH_CONFIG: SpeechConfig = { ...GEMINI_SPEECH_CONFIG };
