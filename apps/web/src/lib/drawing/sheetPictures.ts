import type { SheetImage } from './sheetPage';

/**
 * D02 sheet images (schema v92): the pictures a composed page shows, read
 * from the project's content-addressed store by checksum and prepared for
 * each writer. The page model never holds pixels; only an export does, for
 * as long as it writes.
 */

export type PictureLoader = (checksumSha256: string) => Promise<Blob | null>;

/** The distinct pictures a page shows, by checksum. */
export function pagePictures(
  images: readonly SheetImage[] | undefined
): Map<string, SheetImage['contentType']> {
  const out = new Map<string, SheetImage['contentType']>();
  for (const image of images ?? [])
    out.set(image.checksumSha256, image.contentType);
  return out;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** A picture's bytes as a data URL of its own type, for an SVG file. */
export async function pictureDataUrl(
  blob: Blob,
  contentType: SheetImage['contentType']
): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:${contentType};base64,${base64(bytes)}`;
}

/**
 * A JPEG's EXIF orientation (1–8), read from its APP1 Exif block's first
 * image directory; 1 (upright) when it has none or it cannot be read.
 */
export function jpegExifOrientation(bytes: Uint8Array): number {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  let at = 2;
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1]!;
    if (marker === 0xda || marker === 0xd9) break;
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    const start = at + 4;
    if (
      marker === 0xe1 &&
      length >= 16 &&
      String.fromCharCode(...bytes.subarray(start, start + 4)) === 'Exif' &&
      bytes[start + 4] === 0 &&
      bytes[start + 5] === 0
    ) {
      const tiff = start + 6;
      const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
      const big = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d;
      if (!little && !big) return 1;
      const end = Math.min(bytes.length, at + 2 + length);
      const u16 = (offset: number) =>
        offset + 2 > end
          ? null
          : little
            ? bytes[offset]! | (bytes[offset + 1]! << 8)
            : (bytes[offset]! << 8) | bytes[offset + 1]!;
      const u32 = (offset: number) => {
        const a = u16(offset);
        const b = u16(offset + 2);
        if (a === null || b === null) return null;
        return little ? a + b * 0x10000 : a * 0x10000 + b;
      };
      const ifd = u32(tiff + 4);
      if (ifd === null) return 1;
      const count = u16(tiff + ifd);
      if (count === null) return 1;
      for (let entry = 0; entry < count; entry += 1) {
        const offset = tiff + ifd + 2 + entry * 12;
        if (u16(offset) === 0x0112) {
          const value = u16(offset + 8);
          return value !== null && value >= 1 && value <= 8 ? value : 1;
        }
      }
      return 1;
    }
    at += 2 + length;
  }
  return 1;
}

/** Draws a picture upright onto white and encodes it as JPEG (0.92). */
async function uprightJpeg(blob: Blob): Promise<Uint8Array> {
  // createImageBitmap applies the picture's own EXIF orientation.
  const bitmap = await createImageBitmap(blob, {
    imageOrientation: 'from-image'
  });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot draw the picture.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, bitmap.width, bitmap.height);
    context.drawImage(bitmap, 0, 0);
    const jpeg = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: 0.92
    });
    return new Uint8Array(await jpeg.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

/**
 * A picture as baseline JPEG bytes for a PDF: an upright JPEG as it is
 * (DCTDecode carries it unchanged); a JPEG its EXIF turns, or a PNG, drawn
 * upright onto white and encoded as JPEG at quality 0.92 — the PDF has no
 * EXIF, and on white paper a PNG's transparent parts print as before. The
 * re-encoding is the one approximation in the export. `reencode` is there
 * for tests.
 */
export async function pictureJpegBytes(
  blob: Blob,
  contentType: SheetImage['contentType'],
  reencode: (blob: Blob) => Promise<Uint8Array> = uprightJpeg
): Promise<Uint8Array> {
  if (contentType === 'image/jpeg') {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (jpegExifOrientation(bytes) === 1) return bytes;
  }
  return reencode(blob);
}

/**
 * Every picture a page shows, prepared by `prepare`; null when any is not
 * on this device (the export then refuses by name rather than leaving a
 * hole in the print).
 */
export async function loadPagePictures<T>(
  images: readonly SheetImage[] | undefined,
  load: PictureLoader | undefined,
  prepare: (blob: Blob, contentType: SheetImage['contentType']) => Promise<T>
): Promise<Map<string, T> | null> {
  const wanted = pagePictures(images);
  const out = new Map<string, T>();
  if (wanted.size === 0) return out;
  if (!load) return null;
  for (const [checksum, contentType] of wanted) {
    const blob = await load(checksum);
    if (!blob) return null;
    out.set(checksum, await prepare(blob, contentType));
  }
  return out;
}
