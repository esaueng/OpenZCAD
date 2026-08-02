/**
 * The bundled font set.
 *
 * Every style listed here is a separately designed font file. There is no
 * synthetic bold (stroke widening) and no synthetic italic (shear) anywhere in
 * this module — both produce wrong letterforms and are rejected by
 * `docs/plans/text-feature-plan.md`, design decision 3. A family that has no
 * designed italic simply does not list one, and callers must handle that.
 *
 * Binaries and their per-family licence texts live in
 * `packages/geometry/assets/fonts/`, refreshed by
 * `scripts/fetch-text-fonts.mjs`. Six families are SIL OFL 1.1 and Roboto Slab
 * is Apache-2.0 — the licence recorded here comes from each font's own name
 * table, not from an assumption that everything on Google Fonts is OFL.
 */
import type { FontStyle } from './types';

export interface FontFaceAsset {
  readonly style: FontStyle;
  /** Asset file name inside the font asset directory. */
  readonly file: string;
  /** CSS weight of the designed file (400 or 700). */
  readonly weight: 400 | 700;
  readonly italic: boolean;
}

export type FontLicense = 'OFL-1.1' | 'Apache-2.0';

export interface FontFamilyEntry {
  /** Stable identifier persisted in the document. */
  readonly id: string;
  /** Display name, also the CSS family name for UI previews. */
  readonly family: string;
  readonly category: 'sans-serif' | 'serif' | 'monospace' | 'display' | 'script';
  /** Taken from the font binary's licence URL; asserted by a test. */
  readonly license: FontLicense;
  /** File name of the bundled licence text for this family. */
  readonly licenseFile: string;
  readonly faces: readonly FontFaceAsset[];
}

function face(
  style: FontStyle,
  file: string
): FontFaceAsset {
  return {
    style,
    file,
    weight: style === 'bold' || style === 'boldItalic' ? 700 : 400,
    italic: style === 'italic' || style === 'boldItalic'
  };
}

function family(
  id: string,
  name: string,
  category: FontFamilyEntry['category'],
  styles: readonly FontStyle[],
  license: FontLicense = 'OFL-1.1'
): FontFamilyEntry {
  return {
    id,
    family: name,
    category,
    license,
    licenseFile: `LICENSE-${id}.txt`,
    faces: styles.map((style) => face(style, `${id}-${style.toLowerCase()}.ttf`))
  };
}

const ALL_STYLES: readonly FontStyle[] = [
  'regular',
  'bold',
  'italic',
  'boldItalic'
];

/**
 * Roboto Slab and Oswald ship no designed italic, and Pacifico is a
 * single-weight script face. Those gaps are declared, not faked.
 */
export const FONT_FAMILIES: readonly FontFamilyEntry[] = Object.freeze([
  family('inter', 'Inter', 'sans-serif', ALL_STYLES),
  family('open-sans', 'Open Sans', 'sans-serif', ALL_STYLES),
  family('lora', 'Lora', 'serif', ALL_STYLES),
  family('roboto-slab', 'Roboto Slab', 'serif', ['regular', 'bold'], 'Apache-2.0'),
  family('jetbrains-mono', 'JetBrains Mono', 'monospace', ALL_STYLES),
  family('oswald', 'Oswald', 'display', ['regular', 'bold']),
  family('pacifico', 'Pacifico', 'script', ['regular'])
]);

const BY_ID = new Map(FONT_FAMILIES.map((entry) => [entry.id, entry]));
const BY_NAME = new Map(
  FONT_FAMILIES.map((entry) => [entry.family.toLowerCase(), entry])
);

/**
 * The default family + style a new text object starts with.
 *
 * Open Sans, not Inter, and for a geometric reason: across the ASCII range
 * Open Sans has no glyph whose contours cross themselves or each other, so
 * every letter reaches the kernel with its beziers intact. Inter has 36 such
 * glyphs out of 95 and JetBrains Mono 20; those have to be resolved through
 * the flattening union (see `overlap.ts`) and arrive as polylines. All
 * families remain selectable — this only picks the one that starts exact.
 */
export const DEFAULT_FONT_FAMILY_ID = 'open-sans';
export const DEFAULT_FONT_STYLE: FontStyle = 'regular';

/** Accepts either the stable id (`'open-sans'`) or the display name. */
export function findFontFamily(
  familyOrId: string
): FontFamilyEntry | undefined {
  return BY_ID.get(familyOrId) ?? BY_NAME.get(familyOrId.toLowerCase());
}

export function findFontFace(
  familyOrId: string,
  style: FontStyle
): { entry: FontFamilyEntry; face: FontFaceAsset } | undefined {
  const entry = findFontFamily(familyOrId);
  if (!entry) {
    return undefined;
  }
  const match = entry.faces.find((candidate) => candidate.style === style);
  return match ? { entry, face: match } : undefined;
}

/**
 * Closest available style when a family lacks the requested one. Italic falls
 * back to regular (never a shear), bold-italic prefers a real italic over a
 * real bold, and everything ends at regular.
 */
export function resolveFontStyle(
  familyOrId: string,
  style: FontStyle
): FontStyle | undefined {
  const entry = findFontFamily(familyOrId);
  if (!entry) {
    return undefined;
  }
  const has = (candidate: FontStyle): boolean =>
    entry.faces.some((asset) => asset.style === candidate);
  const chain: Record<FontStyle, readonly FontStyle[]> = {
    regular: ['regular'],
    bold: ['bold', 'regular'],
    italic: ['italic', 'regular'],
    boldItalic: ['boldItalic', 'italic', 'bold', 'regular']
  };
  return chain[style].find(has);
}

/** Default public path the web app serves the font assets from. */
export const FONT_ASSET_BASE = '/fonts/';

/** `family + style → asset URL`, the mapping the plan calls for. */
export function fontAssetUrl(
  familyOrId: string,
  style: FontStyle,
  base: string = FONT_ASSET_BASE
): string | undefined {
  const found = findFontFace(familyOrId, style);
  return found ? `${base}${found.face.file}` : undefined;
}
