/**
 * Lazy ZIP reading, for .pk3 archives.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * A .pk3 is an ordinary ZIP. Quake 3's own pak0.pk3 is 457MB, so this reads
 * only the central directory up front — a few hundred KB at the tail of the
 * file — and inflates individual entries on demand from a Blob slice. Nothing
 * larger than the file being extracted is ever held in memory.
 *
 * Decompression uses the platform's `DecompressionStream('deflate-raw')`, which
 * exists in both browsers and Node, so this pulls in no dependencies.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;

/** ZIP compression methods this reader understands. */
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

export interface ZipEntry {
  /** Path within the archive, forward slashes, as stored. */
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  /** Byte offset of the local file header. */
  localHeaderOffset: number;
}

export interface ZipArchive {
  /** Where the bytes come from. */
  readonly blob: Blob;
  /** Entries by lowercased name, directories excluded. */
  readonly entries: Map<string, ZipEntry>;
}

async function slice(blob: Blob, start: number, end: number): Promise<DataView> {
  const buf = await blob.slice(start, end).arrayBuffer();
  return new DataView(buf);
}

/**
 * Locate the End Of Central Directory record.
 *
 * It sits at the very end of the file unless the archive has a comment, which
 * can push it back by up to 64KB, so the tail is scanned backwards for the
 * signature.
 */
async function findEocd(blob: Blob): Promise<{ cdOffset: number; cdSize: number; count: number }> {
  const maxComment = 0xffff;
  const tailLen = Math.min(blob.size, maxComment + 22);
  const start = blob.size - tailLen;
  const view = await slice(blob, start, blob.size);

  for (let i = view.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) !== EOCD_SIGNATURE) {
      continue;
    }

    const count = view.getUint16(i + 10, true);
    const cdSize = view.getUint32(i + 12, true);
    const cdOffset = view.getUint32(i + 16, true);

    // Zip64 marks these fields as 0xffff/0xffffffff and puts the real values
    // in a separate record. Quake pk3s never need it, so say so plainly
    // rather than silently reading nonsense.
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locatorAt = i - 20;
      const isZip64 =
        locatorAt >= 0 && view.getUint32(locatorAt, true) === ZIP64_EOCD_LOCATOR_SIGNATURE;
      throw new Error(
        `zip64 archives are not supported${isZip64 ? '' : ' (and the zip64 locator is missing)'}`,
      );
    }

    return { cdOffset, cdSize, count };
  }

  throw new Error('not a zip archive: no end-of-central-directory record found');
}

/** Read an archive's directory. Does not read or decompress any file data. */
export async function openZip(blob: Blob): Promise<ZipArchive> {
  const { cdOffset, cdSize, count } = await findEocd(blob);
  const cd = await slice(blob, cdOffset, cdOffset + cdSize);

  const entries = new Map<string, ZipEntry>();
  const decoder = new TextDecoder();

  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.byteLength || cd.getUint32(p, true) !== CENTRAL_SIGNATURE) {
      throw new Error(`corrupt central directory at entry ${i}`);
    }

    const method = cd.getUint16(p + 10, true);
    const compressedSize = cd.getUint32(p + 20, true);
    const uncompressedSize = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const localHeaderOffset = cd.getUint32(p + 42, true);

    const nameBytes = new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen);
    const name = decoder.decode(nameBytes);

    // Directory entries have a trailing slash and no content.
    if (!name.endsWith('/')) {
      entries.set(name.toLowerCase(), {
        name,
        compressedSize,
        uncompressedSize,
        method,
        localHeaderOffset,
      });
    }

    p += 46 + nameLen + extraLen + commentLen;
  }

  return { blob, entries };
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** Extract one entry. Only the bytes of this entry are read from the blob. */
export async function readZipEntry(
  archive: ZipArchive,
  entry: ZipEntry,
): Promise<Uint8Array> {
  // The local header repeats the name and extra fields, and its extra field
  // length can differ from the central directory's, so it must be read rather
  // than assumed.
  const header = await slice(
    archive.blob,
    entry.localHeaderOffset,
    entry.localHeaderOffset + 30,
  );
  if (header.getUint32(0, true) !== LOCAL_SIGNATURE) {
    throw new Error(`corrupt local header for "${entry.name}"`);
  }
  const nameLen = header.getUint16(26, true);
  const extraLen = header.getUint16(28, true);

  const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
  const raw = new Uint8Array(
    await archive.blob.slice(dataStart, dataStart + entry.compressedSize).arrayBuffer(),
  );

  if (entry.method === METHOD_STORE) {
    return raw;
  }
  if (entry.method === METHOD_DEFLATE) {
    return inflateRaw(raw);
  }
  throw new Error(
    `unsupported compression method ${entry.method} for "${entry.name}"`,
  );
}
