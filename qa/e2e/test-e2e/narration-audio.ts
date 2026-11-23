import type { Page } from "@playwright/test";

export async function captureNarrationAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio {
      constructor(source?: string) {
        super(source);
        if (!("narrationAudio" in window)) {
          Object.assign(window, { narrationAudio: this });
        }
      }
    };
  });
}

export async function readNarrationAudio(
  page: Page,
): Promise<{ src: string; currentTime: number; paused: boolean }> {
  return page.evaluate(() => {
    const audio = "narrationAudio" in window ? window.narrationAudio : undefined;
    if (!(audio instanceof HTMLAudioElement)) {
      throw new Error("The player host created no audio element.");
    }
    return { src: audio.src, currentTime: audio.currentTime, paused: audio.paused };
  });
}
