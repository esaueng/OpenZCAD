/**
 * Text → sketch profiles.
 *
 * A text sketch object stores only `{ text, family, style, size, ... }`; the
 * outlines are derived here at rebuild time and never persisted. The pipeline
 * is pure and deterministic, keeps the font's quadratic and cubic beziers
 * exact rather than flattening them, and emits `TextRegion`s shaped like
 * `SketchProfile` (outer loop + hole loops) so the region-extrude path can
 * consume them directly.
 *
 * See `docs/plans/text-feature-plan.md`, design decisions 3 and 4.
 */
export {
  DEFAULT_FONT_FAMILY_ID,
  DEFAULT_FONT_STYLE,
  FONT_ASSET_BASE,
  FONT_FAMILIES,
  findFontFace,
  findFontFamily,
  fontAssetUrl,
  resolveFontStyle,
  type FontFaceAsset,
  type FontFamilyEntry,
  type FontLicense
} from './registry';
/**
 * Types only, deliberately.
 *
 * `loader.ts` imports opentype.js — a few hundred kilobytes of font parser.
 * Re-exporting its values here would put that in the static module graph of
 * every consumer of this barrel, and a host that only ever draws rectangles
 * would pay for it. Type exports erase, so this costs nothing at runtime.
 *
 * Import the values from `./loader` (or the `@openzcad/geometry/text-loader`
 * subpath) at the point of use, ideally behind a dynamic import so the parser
 * lands in its own chunk.
 */
export type {
  FontDataSource,
  FontLibraryOptions,
  LoadedFont
} from './loader';
export {
  buildTextProfileSet,
  clearTextProfileCache,
  textProfileSet
} from './profiles';
export {
  setTextFontProvider,
  textFontProvider,
  type TextFontProvider
} from './fontProvider';
export {
  textDisplayLoops,
  textProfilesFromFont,
  textSketchProfiles,
  type TextObjectParameters
} from './sketchProfiles';
export { localPolygonUnion2d } from './polygonUnion';
export { flattenLoop, loopSignedArea, orientLoop } from './loops';
export { DEFAULT_LINE_HEIGHT, layoutText, type TextLayout } from './layout';
export {
  TextGeometryError,
  type FontStyle,
  type PlacedGlyph,
  type PolygonUnion2d,
  type TextAlign,
  type TextBoundingBox,
  type TextLoop,
  type TextPoint,
  type TextProfileOptions,
  type TextProfileSet,
  type TextRegion,
  type TextRequest,
  type TextSegment,
  type TextWinding
} from './types';
