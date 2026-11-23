import { CupError } from "@cup/errors";

import type { SpeechConfig } from "#src/speech-synthesis-config.ts";

export type SpeechSynthesisAi = {
  gateway(gatewayId: string): Pick<AiGateway, "run">;
};

export type NarrationSynthesisResponseMode = "streaming" | "non-streaming";

export type SpeechSynthesizer = (options: SynthesisOptions) => Promise<Uint8Array>;

export type NarrationChunk = {
  text: string;
};

export class PermanentNarrationSynthesisError extends CupError {
  constructor(message: string) {
    super(message);
    this.name = "PermanentNarrationSynthesisError";
  }
}

export class RateLimitedNarrationSynthesisError extends CupError {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitedNarrationSynthesisError";
  }
}

export type SynthesisOptions = {
  ai: SpeechSynthesisAi;
  conversionId: string;
  narrationText: string;
  sequence: number;
  synthesisAttempt: number;
  synthesisResponseMode: NarrationSynthesisResponseMode;
  speechConfig: SpeechConfig;
  narrationLanguage?: string | undefined;
};
