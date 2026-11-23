import { layOutConsecutively } from "@cup/conversion-contracts";
import type { NarrationTrack } from "@cup/listener-api.routes";

const SAMPLE_RATE = 3_000;
const SILENT_SAMPLE = 0x80;
const WAV_HEADER_BYTES = 44;
const BASE64_CHUNK_BYTES = 0x8000;

const trackUrlsByKey = new Map<string, string>();

export function createStoryNarrationTrack(
  unitDurationsMilliseconds: number[],
  audiobook = "story",
): NarrationTrack {
  const { startOffsets: startMilliseconds, totalLength: durationMilliseconds } =
    layOutConsecutively(unitDurationsMilliseconds);

  const key = `audiobook=${audiobook}&durationMilliseconds=${durationMilliseconds}`;
  let url = trackUrlsByKey.get(key);
  if (url === undefined) {
    url = `data:audio/wav;base64,${encodeBase64(encodeSilence(durationMilliseconds))}#${key}`;
    trackUrlsByKey.set(key, url);
  }

  return { url, durationMilliseconds, startMilliseconds };
}

function encodeSilence(durationMilliseconds: number): Uint8Array<ArrayBuffer> {
  const sampleCount = Math.ceil((durationMilliseconds * SAMPLE_RATE) / 1_000);
  const track = new Uint8Array(WAV_HEADER_BYTES + sampleCount).fill(SILENT_SAMPLE);
  const header = new DataView(track.buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      header.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  writeAscii(0, "RIFF");
  header.setUint32(4, track.length - 8, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, SAMPLE_RATE, true);
  header.setUint32(28, SAMPLE_RATE, true);
  header.setUint16(32, 1, true);
  header.setUint16(34, 8, true);
  writeAscii(36, "data");
  header.setUint32(40, sampleCount, true);
  return track;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES));
  }
  return btoa(binary);
}
