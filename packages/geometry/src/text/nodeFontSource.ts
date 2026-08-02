/**
 * A `FontDataSource` that reads the bundled asset directory from disk.
 *
 * Node-only, and deliberately **not** re-exported from the package index —
 * importing it would drag `node:fs` into the browser bundle. Tests and
 * command-line tooling import it by path.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { FontDataSource } from './loader';

/** Absolute path of `packages/geometry/assets/fonts`. */
export const FONT_ASSET_DIR = fileURLToPath(
  new URL('../../assets/fonts/', import.meta.url)
);

export function nodeFontDataSource(
  directory: string = FONT_ASSET_DIR
): FontDataSource {
  return async ({ file }) => {
    const bytes = await readFile(path.join(directory, file));
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    );
  };
}
