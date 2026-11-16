/*
 * Uploads a release bundle to Google Play's internal testing track in one Play edit, which Play
 * applies only on commit: any failure before the commit abandons the edit and leaves Play
 * unchanged. The Play Developer API sits behind a small publisher interface so tests can fake it;
 * `google-play-publisher.mts` implements it. See the README's "Release builds".
 */

type PlayTrackRelease = {
  name: string;
  versionCodes: readonly string[];
  status: "completed";
};

/** One call per Play Developer API request of an edit; the edit ID comes from `insertEdit`. */
export type PlayPublisher = {
  /** Opens a new edit and returns its ID. */
  insertEdit(): Promise<string>;
  /**
   * Uploads the bundle at `bundlePath` into the edit and returns the `versionCode` Play read from
   * it.
   */
  uploadBundle(editId: string, bundlePath: string): Promise<{ versionCode: number }>;
  /** Replaces the track's releases with `release`. */
  updateTrack(editId: string, track: string, release: PlayTrackRelease): Promise<void>;
  commitEdit(editId: string): Promise<void>;
  /** Abandons the edit, discarding everything it holds. */
  deleteEdit(editId: string): Promise<void>;
};

const INTERNAL_TESTING_TRACK = "internal";

/**
 * Uploads the bundle and rolls it out to every tester of the internal testing track as release
 * `releaseName`. Rejects with the failing step's error; Play stays unchanged unless the commit
 * succeeded.
 */
export async function uploadToInternalTesting({
  publisher,
  bundlePath,
  versionCode,
  releaseName,
}: {
  publisher: PlayPublisher;
  bundlePath: string;
  versionCode: number;
  releaseName: string;
}): Promise<void> {
  const editId = await publisher.insertEdit();

  try {
    const uploadedBundle = await publisher.uploadBundle(editId, bundlePath);
    if (uploadedBundle.versionCode !== versionCode) {
      throw new Error(
        `Google Play read versionCode ${String(uploadedBundle.versionCode)} from ${bundlePath}, but this build has versionCode ${String(versionCode)}.`,
      );
    }

    await publisher.updateTrack(editId, INTERNAL_TESTING_TRACK, {
      name: releaseName,
      versionCodes: [String(versionCode)],
      status: "completed",
    });
  } catch (error) {
    await abandonEdit(publisher, editId);
    throw error;
  }

  await publisher.commitEdit(editId);
}

async function abandonEdit(publisher: PlayPublisher, editId: string): Promise<void> {
  try {
    await publisher.deleteEdit(editId);
  } catch (deleteError) {
    // The step's error is what the operator must see; an uncommitted edit changes nothing in Play and expires on its own.
    console.warn(`Abandoning the Google Play edit ${editId} failed:`, deleteError);
  }
}
