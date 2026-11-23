type PlayTrackRelease = {
  name: string;
  versionCodes: readonly string[];
  status: "completed";
};

export type PlayPublisher = {
  insertEdit(): Promise<string>;
  uploadBundle(editId: string, bundlePath: string): Promise<{ versionCode: number }>;
  updateInternalTestingTrack(editId: string, release: PlayTrackRelease): Promise<void>;
  commitEdit(editId: string): Promise<void>;
  deleteEdit(editId: string): Promise<void>;
};

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

    await publisher.updateInternalTestingTrack(editId, {
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
    console.warn(`Abandoning the Google Play edit ${editId} failed:`, deleteError);
  }
}
