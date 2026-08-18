/**
 * TGA decoding.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Most Quake III textures are .jpg, which the browser decodes natively, but
 * anything needing an alpha channel is .tga and browsers have never supported
 * it. Player skins, weapon skins and most model textures are .tga, so without
 * this the models render untextured.
 *
 * Only the variants id actually ships are handled: uncompressed and RLE, in
 * true colour or greyscale. Colour-mapped TGAs are rejected rather than
 * half-decoded.
 */

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, top row first. */
  data: Uint8Array;
}

const TYPE_COLOR_MAPPED = 1;
const TYPE_TRUE_COLOR = 2;
const TYPE_GREYSCALE = 3;
const TYPE_RLE_TRUE_COLOR = 10;
const TYPE_RLE_GREYSCALE = 11;

export function decodeTga(bytes: Uint8Array): DecodedImage {
  if (bytes.length < 18) {
    throw new Error('not a TGA: shorter than its header');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const idLength = view.getUint8(0);
  const colorMapType = view.getUint8(1);
  const imageType = view.getUint8(2);
  const width = view.getUint16(12, true);
  const height = view.getUint16(14, true);
  const depth = view.getUint8(16);
  const descriptor = view.getUint8(17);

  if (imageType === TYPE_COLOR_MAPPED || colorMapType !== 0) {
    throw new Error('colour-mapped TGA files are not supported');
  }
  if (
    imageType !== TYPE_TRUE_COLOR &&
    imageType !== TYPE_GREYSCALE &&
    imageType !== TYPE_RLE_TRUE_COLOR &&
    imageType !== TYPE_RLE_GREYSCALE
  ) {
    throw new Error(`unsupported TGA image type ${imageType}`);
  }
  if (depth !== 8 && depth !== 24 && depth !== 32) {
    throw new Error(`unsupported TGA pixel depth ${depth}`);
  }
  if (width <= 0 || height <= 0) {
    throw new Error(`bad TGA dimensions ${width}x${height}`);
  }

  const bytesPerPixel = depth / 8;
  const rle = imageType === TYPE_RLE_TRUE_COLOR || imageType === TYPE_RLE_GREYSCALE;
  let p = 18 + idLength;

  const pixelCount = width * height;
  const out = new Uint8Array(pixelCount * 4);

  /** Expand one source pixel into RGBA. TGA true colour is stored BGR(A). */
  const put = (dst: number, src: number): void => {
    if (bytesPerPixel === 1) {
      const g = bytes[src];
      out[dst] = g;
      out[dst + 1] = g;
      out[dst + 2] = g;
      out[dst + 3] = 255;
    } else {
      out[dst] = bytes[src + 2];
      out[dst + 1] = bytes[src + 1];
      out[dst + 2] = bytes[src];
      out[dst + 3] = bytesPerPixel === 4 ? bytes[src + 3] : 255;
    }
  };

  if (!rle) {
    if (p + pixelCount * bytesPerPixel > bytes.length) {
      throw new Error('truncated TGA pixel data');
    }
    for (let i = 0; i < pixelCount; i++) {
      put(i * 4, p + i * bytesPerPixel);
    }
  } else {
    let i = 0;
    while (i < pixelCount) {
      if (p >= bytes.length) {
        throw new Error('truncated RLE TGA');
      }
      const packet = bytes[p++];
      const count = (packet & 0x7f) + 1;

      if (packet & 0x80) {
        // Run-length packet: one pixel repeated.
        for (let k = 0; k < count && i < pixelCount; k++, i++) {
          put(i * 4, p);
        }
        p += bytesPerPixel;
      } else {
        // Raw packet: `count` distinct pixels.
        for (let k = 0; k < count && i < pixelCount; k++, i++) {
          put(i * 4, p);
          p += bytesPerPixel;
        }
      }
    }
  }

  // Bit 5 of the descriptor sets the origin at the top-left. It is usually
  // clear, meaning the first row stored is the BOTTOM one, so the image has to
  // be flipped to end up the right way up.
  const topDown = (descriptor & 0x20) !== 0;
  if (!topDown) {
    const rowBytes = width * 4;
    const tmp = new Uint8Array(rowBytes);
    for (let y = 0; y < (height >> 1); y++) {
      const a = y * rowBytes;
      const b = (height - 1 - y) * rowBytes;
      tmp.set(out.subarray(a, a + rowBytes));
      out.copyWithin(a, b, b + rowBytes);
      out.set(tmp, b);
    }
  }

  return { width, height, data: out };
}
