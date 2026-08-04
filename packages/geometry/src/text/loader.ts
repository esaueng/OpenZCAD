/**
 * Font loading and parse caching.
 *
 * The module never reaches for `fetch` or the filesystem itself — a
 * `FontDataSource` is injected. The browser wires one that fetches the bundled
 * asset URL; tests and Node tooling wire one that reads the asset directory.
 * Keeping the byte source outside means the glyph pipeline stays pure and the
 * geometry package keeps no platform dependency.
 */
import { findFontFace, fontAssetUrl } from './registry';
import type { FontFaceAsset, FontFamilyEntry } from './registry';
import { TextGeometryError } from './types';
import type { FontStyle } from './types';
import { parse } from 'opentype.js';
import type { Font } from 'opentype.js';

/** Resolves a bundled asset file name to its bytes. */
export type FontDataSource = (
  request: Readonly<{ file: string; url: string; family: string; style: FontStyle }>
) => Promise<ArrayBuffer>;

export interface LoadedFont {
  readonly family: string;
  readonly familyId: string;
  readonly style: FontStyle;
  readonly file: string;
  readonly font: Font;
  readonly unitsPerEm: number;
  readonly ascender: number;
  readonly descender: number;
}

export interface FontLibraryOptions {
  /** Base the asset URLs are resolved against. Defaults to the registry's. */
  readonly assetBase?: string;
}

function loadedFontFrom(
  entry: FontFamilyEntry,
  asset: FontFaceAsset,
  font: Font
): LoadedFont {
  return Object.freeze({
    family: entry.family,
    familyId: entry.id,
    style: asset.style,
    file: asset.file,
    font,
    unitsPerEm: font.unitsPerEm,
    ascender: font.ascender,
    descender: font.descender
  });
}

/**
 * Caches parsed fonts by `familyId|style`. Concurrent requests for the same
 * face share one in-flight promise so a word never parses the same file twice.
 */
export class FontLibrary {
  private readonly source: FontDataSource;
  private readonly assetBase: string | undefined;
  private readonly cache = new Map<string, LoadedFont>();
  private readonly inFlight = new Map<string, Promise<LoadedFont>>();

  constructor(source: FontDataSource, options: FontLibraryOptions = {}) {
    this.source = source;
    this.assetBase = options.assetBase;
  }

  /** Already-parsed face, or `undefined`. Never triggers a load. */
  peek(familyOrId: string, style: FontStyle): LoadedFont | undefined {
    const found = findFontFace(familyOrId, style);
    return found ? this.cache.get(`${found.entry.id}|${style}`) : undefined;
  }

  async load(familyOrId: string, style: FontStyle): Promise<LoadedFont> {
    const found = findFontFace(familyOrId, style);
    if (!found) {
      throw new TextGeometryError(
        `No bundled font face for "${familyOrId}" ${style}. ` +
          'Styles are real font files; there is no synthetic bold or italic.'
      );
    }
    const key = `${found.entry.id}|${style}`;
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }
    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }
    const url =
      fontAssetUrl(found.entry.id, style, this.assetBase) ?? found.face.file;
    const promise = this.source({
      file: found.face.file,
      url,
      family: found.entry.family,
      style
    })
      .then((bytes) => {
        let font: Font;
        try {
          font = parse(bytes);
        } catch (cause) {
          throw new TextGeometryError(
            `Failed to parse font asset "${found.face.file}": ${
              cause instanceof Error ? cause.message : String(cause)
            }`
          );
        }
        const loaded = loadedFontFrom(found.entry, found.face, font);
        this.cache.set(key, loaded);
        return loaded;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  clear(): void {
    this.cache.clear();
  }
}

/**
 * A `FontDataSource` backed by `fetch`. Browser and worker use this; the URL
 * comes from the registry, so the app only has to serve the asset directory.
 */
export function fetchFontDataSource(
  fetchImpl: typeof fetch = fetch
): FontDataSource {
  return async ({ url, family, style }) => {
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new TextGeometryError(
        `Font asset for ${family} ${style} responded ${response.status} (${url}).`
      );
    }
    return response.arrayBuffer();
  };
}

/** Parses an already-fetched face without going through a `FontLibrary`. */
export function parseFontFace(
  familyOrId: string,
  style: FontStyle,
  bytes: ArrayBuffer
): LoadedFont {
  const found = findFontFace(familyOrId, style);
  if (!found) {
    throw new TextGeometryError(
      `No bundled font face for "${familyOrId}" ${style}.`
    );
  }
  return loadedFontFrom(found.entry, found.face, parse(bytes));
}
