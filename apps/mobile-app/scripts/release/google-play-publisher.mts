import { androidpublisher } from "@googleapis/androidpublisher";
import { GoogleAuth, Impersonated } from "google-auth-library";
import fs from "node:fs";

import type { PlayPublisher } from "#scripts/release/play-upload.mts";

const PACKAGE_NAME = "audio.cup.app";
const INTERNAL_TESTING_TRACK = "internal";
export const UPLOADER_SERVICE_ACCOUNT = "play-publisher@cup-production.iam.gserviceaccount.com";

const SOURCE_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];
const ANDROID_PUBLISHER_SCOPES = ["https://www.googleapis.com/auth/androidpublisher"];
const TOKEN_LIFETIME_SECONDS = 3600;
const QUOTA_PROJECT = "cup-production";

export async function createGooglePlayPublisher(): Promise<PlayPublisher> {
  const sourceClient = await new GoogleAuth({ scopes: SOURCE_SCOPES }).getClient();
  sourceClient.quotaProjectId = QUOTA_PROJECT;
  const auth = new Impersonated({
    sourceClient,
    targetPrincipal: UPLOADER_SERVICE_ACCOUNT,
    targetScopes: ANDROID_PUBLISHER_SCOPES,
    lifetime: TOKEN_LIFETIME_SECONDS,
  });
  const edits = androidpublisher({ version: "v3", auth }).edits;

  return {
    insertEdit: async () => {
      const response = await edits.insert({ packageName: PACKAGE_NAME });
      const editId = response.data.id;
      if (editId === undefined || editId === null || editId === "") {
        throw new Error("Google Play opened an edit but returned no edit ID.");
      }
      return editId;
    },
    uploadBundle: async (editId, bundlePath) => {
      const response = await edits.bundles.upload({
        packageName: PACKAGE_NAME,
        editId,
        media: { mimeType: "application/octet-stream", body: fs.createReadStream(bundlePath) },
      });
      const versionCode = response.data.versionCode;
      if (typeof versionCode !== "number") {
        throw new Error(`Google Play accepted ${bundlePath} but returned no versionCode.`);
      }
      return { versionCode };
    },
    updateInternalTestingTrack: async (editId, release) => {
      await edits.tracks.update({
        packageName: PACKAGE_NAME,
        editId,
        track: INTERNAL_TESTING_TRACK,
        requestBody: {
          track: INTERNAL_TESTING_TRACK,
          releases: [{ ...release, versionCodes: [...release.versionCodes] }],
        },
      });
    },
    commitEdit: async (editId) => {
      await edits.commit({ packageName: PACKAGE_NAME, editId });
    },
    deleteEdit: async (editId) => {
      await edits.delete({ packageName: PACKAGE_NAME, editId });
    },
  };
}
