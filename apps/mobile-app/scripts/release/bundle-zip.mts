import zlib from "node:zlib";

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06_05_4b_50;
const END_OF_CENTRAL_DIRECTORY_LENGTH = 22;
const MAX_ZIP_COMMENT_LENGTH = 0xff_ff;
const CENTRAL_DIRECTORY_ENTRY_SIGNATURE = 0x02_01_4b_50;
const LOCAL_HEADER_SIGNATURE = 0x04_03_4b_50;
const ZIP64_MARKER = 0xff_ff_ff_ff;
const STORED = 0;
const DEFLATED = 8;

export type ZipEntry = { name: string; read(): Buffer };

export function readZipEntries(zip: Buffer): ZipEntry[] {
  const endOffset = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(endOffset + 10);
  const centralDirectoryOffset = zip.readUInt32LE(endOffset + 16);
  if (centralDirectoryOffset === ZIP64_MARKER) {
    throw new Error("The bundle is a ZIP64 archive, which the release scripts can't read.");
  }

  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index++) {
    if (zip.readUInt32LE(offset) !== CENTRAL_DIRECTORY_ENTRY_SIGNATURE) {
      throw new Error(`The bundle's zip central directory is corrupt at byte ${String(offset)}.`);
    }
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localHeaderOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (compressedSize === ZIP64_MARKER || localHeaderOffset === ZIP64_MARKER) {
      throw new Error(
        `The bundle's entry ${name} uses ZIP64, which the release scripts can't read.`,
      );
    }

    entries.push({
      name,
      read: () => readEntryData({ zip, name, method, compressedSize, localHeaderOffset }),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const lowestOffset = Math.max(
    0,
    zip.length - END_OF_CENTRAL_DIRECTORY_LENGTH - MAX_ZIP_COMMENT_LENGTH,
  );
  for (
    let offset = zip.length - END_OF_CENTRAL_DIRECTORY_LENGTH;
    offset >= lowestOffset;
    offset--
  ) {
    if (zip.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }
  throw new Error("The bundle is no zip archive: it has no end of central directory record.");
}

function readEntryData({
  zip,
  name,
  method,
  compressedSize,
  localHeaderOffset,
}: {
  zip: Buffer;
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}): Buffer {
  if (zip.readUInt32LE(localHeaderOffset) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error(
      `The bundle's entry ${name} has no local header where the central directory says.`,
    );
  }
  const dataOffset =
    localHeaderOffset +
    30 +
    zip.readUInt16LE(localHeaderOffset + 26) +
    zip.readUInt16LE(localHeaderOffset + 28);
  const data = zip.subarray(dataOffset, dataOffset + compressedSize);

  if (method === STORED) {
    return data;
  }
  if (method === DEFLATED) {
    return zlib.inflateRawSync(data);
  }
  throw new Error(
    `The bundle's entry ${name} uses zip compression method ${String(method)}, which the release scripts can't read.`,
  );
}
