import type { Audiobook, AudiobookReference } from "@cup/audiobook-production";

export type LoadReadyAudiobookDependencies = {
  getReadyAudiobookReference(): Promise<AudiobookReference | undefined>;
  loadAudiobook(reference: AudiobookReference): Promise<Audiobook>;
};

export async function loadReadyAudiobook(
  dependencies: LoadReadyAudiobookDependencies,
): Promise<Audiobook | undefined> {
  const reference = await dependencies.getReadyAudiobookReference();
  if (reference === undefined) {
    return undefined;
  }

  return dependencies.loadAudiobook(reference);
}
