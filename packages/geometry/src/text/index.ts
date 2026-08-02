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
export {
  FontLibrary,
  fetchFontDataSource,
  parseFontFace,
  type FontDataSource,
  type FontLibraryOptions,
  type LoadedFont
} from './loader';
export {
  buildTextProfileSet,
  clearTextProfileCache,
  textProfileSet
} from './profiles';
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
