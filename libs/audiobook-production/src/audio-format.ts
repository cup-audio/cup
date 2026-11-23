import { CupError } from "@cup/errors";

export const AUDIOBOOK_CONTENT_TYPE = "audio/mpeg";
export const AUDIOBOOK_MANIFEST_CONTENT_TYPE = "application/json";

export const AUDIO_FORMAT = {
  bitrateKilobitsPerSecond: 128,
  channelCount: 1,
  encoding: "mp3",
  sampleRate: 24_000,
} as const;

const FRAME_DURATION_MILLISECONDS = 24;
const FRAME_BYTE_LENGTH = 384;

export function getSegmentByteLength(durationMilliseconds: number): number {
  const frameCount = durationMilliseconds / FRAME_DURATION_MILLISECONDS;

  if (!Number.isInteger(frameCount) || frameCount < 0) {
    throw new CupError(
      `Segment duration must be a whole number of 24 ms frames: ${durationMilliseconds} ms`,
    );
  }

  return frameCount * FRAME_BYTE_LENGTH;
}

export type Mp3Analysis = {
  audioStart: number;
  audioEnd: number;
  durationMilliseconds: number;
};

const MPEG_2_LAYER_3_BITRATES = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
] as const;
const MPEG_1_LAYER_3_BITRATES = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
] as const;
const MPEG_1_SAMPLE_RATES = [44_100, 48_000, 32_000] as const;

export function analyzeMp3(audio: Uint8Array): Mp3Analysis {
  if (audio.byteLength === 0) {
    throw new CupError("MP3 audio must contain at least one MPEG audio frame");
  }

  const audioStart = getId3v2End(audio);
  const audioEnd = hasId3v1Tag(audio, audioStart) ? audio.byteLength - 128 : audio.byteLength;
  let offset = audioStart;
  let durationMilliseconds = 0;
  let frameCount = 0;

  while (offset < audioEnd) {
    if (audioEnd - offset < 4) {
      throw new CupError(`MP3 audio ends with an incomplete frame header at byte ${offset}`);
    }

    const header = readUint32BigEndian(audio, offset);

    if ((header & 0xffe0_0000) >>> 0 !== 0xffe0_0000) {
      throw new CupError(`MP3 audio contains non-frame data at byte ${offset}`);
    }

    const versionBits = (header >>> 19) & 0b11;
    const layerBits = (header >>> 17) & 0b11;
    const bitrateIndex = (header >>> 12) & 0b1111;
    const sampleRateIndex = (header >>> 10) & 0b11;
    const padding = (header >>> 9) & 1;
    const channelMode = (header >>> 6) & 0b11;

    if (versionBits === 0b01 || layerBits !== 0b01) {
      throw new CupError(`MP3 audio contains an unsupported MPEG frame at byte ${offset}`);
    }

    if (sampleRateIndex === 0b11) {
      throw new CupError(`MP3 audio contains an invalid sample-rate index at byte ${offset}`);
    }

    const versionDivisor = versionBits === 0b11 ? 1 : versionBits === 0b10 ? 2 : 4;
    const sampleRate = MPEG_1_SAMPLE_RATES[sampleRateIndex]! / versionDivisor;
    const bitrateTable = versionBits === 0b11 ? MPEG_1_LAYER_3_BITRATES : MPEG_2_LAYER_3_BITRATES;
    const bitrateKilobitsPerSecond = bitrateTable[bitrateIndex]!;

    if (bitrateKilobitsPerSecond === 0) {
      throw new CupError(`MP3 audio contains a free or invalid bit-rate frame at byte ${offset}`);
    }

    assertFrameMatchesAudioFormat({
      offset,
      sampleRate,
      channelMode,
      bitrateKilobitsPerSecond,
      padding,
    });

    const samplesPerFrame = versionBits === 0b11 ? 1_152 : 576;
    const frameLength = Math.floor(
      ((versionBits === 0b11 ? 144 : 72) * bitrateKilobitsPerSecond * 1_000) / sampleRate,
    );

    if (offset + frameLength > audioEnd) {
      throw new CupError(`MP3 audio ends with an incomplete frame at byte ${offset}`);
    }

    durationMilliseconds += (samplesPerFrame / sampleRate) * 1_000;
    frameCount += 1;
    offset += frameLength;
  }

  if (frameCount === 0) {
    throw new CupError("MP3 audio must contain at least one MPEG audio frame");
  }

  return { audioStart, audioEnd, durationMilliseconds };
}

function assertFrameMatchesAudioFormat({
  offset,
  sampleRate,
  channelMode,
  bitrateKilobitsPerSecond,
  padding,
}: {
  offset: number;
  sampleRate: number;
  channelMode: number;
  bitrateKilobitsPerSecond: number;
  padding: number;
}): void {
  if (sampleRate !== AUDIO_FORMAT.sampleRate) {
    throw new CupError(`MP3 audio has unexpected sample rate at byte ${offset}: ${sampleRate} Hz`);
  }

  if (AUDIO_FORMAT.channelCount === 1 && channelMode !== 0b11) {
    throw new CupError(`MP3 audio has unexpected channel mode at byte ${offset}`);
  }

  if (bitrateKilobitsPerSecond !== AUDIO_FORMAT.bitrateKilobitsPerSecond) {
    throw new CupError(
      `MP3 audio has unexpected bitrate at byte ${offset}: ${bitrateKilobitsPerSecond} kbps`,
    );
  }

  if (padding === 1) {
    throw new CupError(`MP3 audio contains a padded frame at byte ${offset}`);
  }
}

function getId3v2End(audio: Uint8Array): number {
  if (audio.byteLength < 10 || audio[0] !== 0x49 || audio[1] !== 0x44 || audio[2] !== 0x33) {
    return 0;
  }

  const flags = audio[5]!;
  const sizeBytes = audio.subarray(6, 10);

  if (sizeBytes.some((byte) => byte > 0x7f)) {
    throw new CupError("MP3 audio contains an invalid ID3v2 tag size");
  }

  const tagSize =
    (sizeBytes[0]! << 21) | (sizeBytes[1]! << 14) | (sizeBytes[2]! << 7) | sizeBytes[3]!;
  const tagEnd = 10 + tagSize + (flags & 0x10 ? 10 : 0);

  if (tagEnd > audio.byteLength) {
    throw new CupError("MP3 audio contains an incomplete ID3v2 tag");
  }

  return tagEnd;
}

function hasId3v1Tag(audio: Uint8Array, audioStart: number): boolean {
  const offset = audio.byteLength - 128;

  return (
    offset > audioStart &&
    audio[offset] === 0x54 &&
    audio[offset + 1] === 0x41 &&
    audio[offset + 2] === 0x47
  );
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}
