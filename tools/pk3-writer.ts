/**
 * A minimal store-only ZIP writer, for building .pk3 files.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Split out of `build-devpak.ts` when a second tool needed it. A Quake .pk3 is
 * a plain zip and stored (uncompressed) entries read fine, so this is as small
 * as a zip writer gets -- with one field that is emphatically not optional; see
 * the CRC note below.
 */

/**
 * CRC-32, the one field a zip cannot omit.
 *
 * fflate -- which is what the browser side reads paks with -- does not verify
 * it, so a pak written with a zero CRC loads in the game and looks fine while
 * being rejected by every standard tool: Python's zipfile, 7-zip, and Quake
 * itself. That makes the dev pak impossible to inspect, which is exactly when
 * you most want to inspect it.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal store-only ZIP writer. Q3 paks are plain zips and read fine. */
export function writeZip(entries: { path: string; data: Uint8Array }[]): Buffer {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const { path, data } of entries) {
    const nb = enc.encode(path);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nb.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true); // stored, not deflated
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nb.length, true);
    local.set(nb, 30);
    local.set(data, 30 + nb.length);
    locals.push(local);

    const central = new Uint8Array(46 + nb.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nb.length, true);
    cv.setUint32(42, offset, true);
    central.set(nb, 46);
    centrals.push(central);

    offset += local.length;
  }

  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  return Buffer.concat([...locals, ...centrals, eocd].map((u) => Buffer.from(u)));
}
