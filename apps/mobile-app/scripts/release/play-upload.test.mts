import { expect, test, vi } from "vitest";

import { uploadToInternalTesting } from "#scripts/release/play-upload.mts";
import type { PlayPublisher } from "#scripts/release/play-upload.mts";

const BUNDLE_PATH =
  "/checkout/apps/mobile-app/android/app/build/outputs/bundle/release/app-release.aab";
const VERSION_CODE = 457_310;
const RELEASE_NAME = "2026.11.14 (8e5c815)";
const EDIT_ID = "edit-1";

type PublisherStep = "insertEdit" | "uploadBundle" | "updateInternalTestingTrack" | "commitEdit";

function fakePublisher({
  failingStep,
  uploadedVersionCode = VERSION_CODE,
}: {
  failingStep?: PublisherStep;
  uploadedVersionCode?: number;
} = {}): { publisher: PlayPublisher; calls: unknown[][]; error: Error } {
  const calls: unknown[][] = [];
  const error = new Error(`${failingStep ?? "nothing"} failed`);

  function record(step: PublisherStep | "deleteEdit", ...args: unknown[]): void {
    calls.push([step, ...args]);
    if (step === failingStep) {
      throw error;
    }
  }

  const publisher: PlayPublisher = {
    insertEdit: async () => {
      record("insertEdit");
      return EDIT_ID;
    },
    uploadBundle: async (editId, bundlePath) => {
      record("uploadBundle", editId, bundlePath);
      return { versionCode: uploadedVersionCode };
    },
    updateInternalTestingTrack: async (editId, release) => {
      record("updateInternalTestingTrack", editId, release);
    },
    commitEdit: async (editId) => {
      record("commitEdit", editId);
    },
    deleteEdit: async (editId) => {
      record("deleteEdit", editId);
    },
  };

  return { publisher, calls, error };
}

function upload(publisher: PlayPublisher): Promise<void> {
  return uploadToInternalTesting({
    publisher,
    bundlePath: BUNDLE_PATH,
    versionCode: VERSION_CODE,
    releaseName: RELEASE_NAME,
  });
}

test("one edit uploads the bundle and rolls it out to the internal testing track", async () => {
  const { publisher, calls } = fakePublisher();

  await upload(publisher);

  expect(calls).toEqual([
    ["insertEdit"],
    ["uploadBundle", EDIT_ID, BUNDLE_PATH],
    [
      "updateInternalTestingTrack",
      EDIT_ID,
      { name: RELEASE_NAME, versionCodes: ["457310"], status: "completed" },
    ],
    ["commitEdit", EDIT_ID],
  ]);
});

test("a failed edit insert surfaces the error and commits nothing", async () => {
  const { publisher, calls, error } = fakePublisher({ failingStep: "insertEdit" });

  await expect(upload(publisher)).rejects.toBe(error);

  expect(calls).toEqual([["insertEdit"]]);
});

test("a failed bundle upload surfaces the error and abandons the edit without committing", async () => {
  const { publisher, calls, error } = fakePublisher({ failingStep: "uploadBundle" });

  await expect(upload(publisher)).rejects.toBe(error);

  expect(calls).toEqual([
    ["insertEdit"],
    ["uploadBundle", EDIT_ID, BUNDLE_PATH],
    ["deleteEdit", EDIT_ID],
  ]);
});

test("a failed track update surfaces the error and abandons the edit without committing", async () => {
  const { publisher, calls, error } = fakePublisher({ failingStep: "updateInternalTestingTrack" });

  await expect(upload(publisher)).rejects.toBe(error);

  expect(calls.map(([step]) => step)).toEqual([
    "insertEdit",
    "uploadBundle",
    "updateInternalTestingTrack",
    "deleteEdit",
  ]);
});

test("a bundle whose versionCode differs from the built one abandons the edit without committing", async () => {
  const { publisher, calls } = fakePublisher({ uploadedVersionCode: 457_309 });

  await expect(upload(publisher)).rejects.toThrow(/457309.*457310/);

  expect(calls.map(([step]) => step)).toEqual(["insertEdit", "uploadBundle", "deleteEdit"]);
});

test("a failed abandon still surfaces the step's error and reports the abandon's", async () => {
  const { publisher, error } = fakePublisher({ failingStep: "uploadBundle" });
  const deleteError = new Error("delete failed");
  publisher.deleteEdit = async () => {
    throw deleteError;
  };
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  await expect(upload(publisher)).rejects.toBe(error);

  expect(warn).toHaveBeenCalledWith(expect.stringContaining(EDIT_ID), deleteError);
  warn.mockRestore();
});

test("a failed commit surfaces the error", async () => {
  const { publisher, calls, error } = fakePublisher({ failingStep: "commitEdit" });

  await expect(upload(publisher)).rejects.toBe(error);

  expect(calls.at(-1)).toEqual(["commitEdit", EDIT_ID]);
});
