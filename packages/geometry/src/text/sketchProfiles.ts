/**
 * The text fast path: a text sketch object straight to `SketchProfile`s.
 *
 * Text deliberately never enters the half-edge arrangement in `regions.ts`.
 * That pipeline is quadratic in curve count in several places and runs on the
 * UI thread and the worker on every edit; a word at glyph fidelity is
 * 1,500–3,000 segments, which is ~10⁷ pair tests per keystroke. It also has
 * nothing to discover: a font already encodes which contour is an outer
 * boundary and which is a counter, through winding and containment under the
 * nonzero fill rule, and Phase 1 has already resolved that into regions.
 *
 * See `docs/plans/text-feature-plan.md`, design decision 4.
 *
 * This module only imports **types** from `../regions`, so `regions.ts` can
 * call into it without a runtime import cycle. It also stays clear of
 * `./loader`'s value exports, which is what keeps `opentype.js` out of the
 * bundle of anything that merely computes sketch regions.
 */
import { flattenLoop } from './loops';
import { textFontProvider } from './fontProvider';
import { textProfileSet } from './profiles';
import { findFontFamily, resolveFontStyle } from './registry';
import { TextGeometryError } from './types';
import type { LoadedFont } from './loader';
import type {
  FontStyle,
  TextAlign,
  TextLoop,
  TextProfileOptions,
  TextRegion,
  TextSegment
} from './types';
import type {
  RegionCurve,
  RegionLoop,
  SketchProfile,
  Vec2Like
} from '../regions';

/** Chord tolerance of a profile's sampled polyline, as a fraction of em. */
const FLATTEN_TOLERANCE_RATIO = 1 / 500;
/** Coarser tolerance for viewport outlines, which only have to look smooth. */
const DISPLAY_TOLERANCE_RATIO = 1 / 200;
/** Fingerprints are identity hints, matching `regions.ts`'s own quantum. */
const FINGERPRINT_QUANTUM = 1e-6;

/** The parameters a text sketch object stores, already dereferenced. */
export interface TextObjectParameters {
  readonly text: string;
  readonly fontFamily: string;
  readonly fontStyle: FontStyle;
  readonly size: number;
  readonly x: number;
  readonly y: number;
  /** Degrees, as the document stores it. */
  readonly rotationDeg?: number;
  readonly align?: TextAlign;
}

// ---------------------------------------------------------------------------
// Segments → region curves.
// ---------------------------------------------------------------------------

/**
 * Point objects cross this boundary **by reference**.
 *
 * Phase 1 guarantees that adjacent segments of a loop share one point object,
 * and the whole downstream wire depends on it: `makeWire` welds endpoints at
 * 1e-7, and the adapter lifts each 2D point into 3D with the same arithmetic,
 * so identical inputs give bit-identical outputs and every joint closes.
 * Copying a point here — `{ x: p.x, y: p.y }` — would still be numerically
 * identical today, but it silently gives up the guarantee.
 */
function curveFor(segment: TextSegment, sourceObjectId: string): RegionCurve {
  if (segment.kind === 'line') {
    return { kind: 'line', a: segment.a, b: segment.b, sourceObjectId };
  }
  if (segment.kind === 'quadratic') {
    return {
      kind: 'bezier',
      a: segment.a,
      b: segment.b,
      controls: [segment.control],
      sourceObjectId
    };
  }
  return {
    kind: 'bezier',
    a: segment.a,
    b: segment.b,
    controls: [segment.control1, segment.control2],
    sourceObjectId
  };
}

function regionLoopFor(
  loop: TextLoop,
  sourceObjectId: string,
  flattenTolerance: number
): RegionLoop {
  return {
    curves: loop.segments.map((segment) => curveFor(segment, sourceObjectId)),
    polyline: flattenLoop(loop.segments, flattenTolerance)
  };
}

// ---------------------------------------------------------------------------
// Identity.
// ---------------------------------------------------------------------------

function quantize(value: number): number {
  const quantized =
    Math.round(value / FINGERPRINT_QUANTUM) * FINGERPRINT_QUANTUM;
  return Object.is(quantized, -0) ? 0 : Number(quantized.toFixed(6));
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  const result = hash >>> 0;
  return result === 0 ? 1 : result;
}

function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * A signature over the loop's actual control points, in traversal order.
 *
 * The arrangement's signatures are direction-canonical because two cells
 * share an edge and traverse it opposite ways. Text regions never share a
 * boundary, so order is simply preserved, and every control point is
 * included — two glyphs that differ only in a curve's bulge must not collide.
 */
function loopSignature(loop: RegionLoop): string {
  return loop.curves
    .map((curve) => {
      if (curve.kind === 'line') {
        return `L${quantize(curve.a.x)},${quantize(curve.a.y)},${quantize(
          curve.b.x
        )},${quantize(curve.b.y)}`;
      }
      if (curve.kind === 'bezier') {
        return `B${[curve.a, ...curve.controls, curve.b]
          .map((point) => `${quantize(point.x)},${quantize(point.y)}`)
          .join(',')}`;
      }
      return `A${quantize(curve.center.x)},${quantize(curve.center.y)},${quantize(
        curve.radius
      )}`;
    })
    .join('|');
}

// ---------------------------------------------------------------------------
// Region → profile.
// ---------------------------------------------------------------------------

/** Polygon centroid of a flattened boundary; area-weighted across holes. */
function polylineCentroid(polyline: readonly Vec2Like[]): {
  centroid: Vec2Like;
  area: number;
} {
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let index = 0; index < polyline.length; index += 1) {
    const a = polyline[index]!;
    const b = polyline[(index + 1) % polyline.length]!;
    const cross = a.x * b.y - b.x * a.y;
    twiceArea += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  if (twiceArea === 0) {
    return { centroid: polyline[0] ?? { x: 0, y: 0 }, area: 0 };
  }
  return {
    centroid: { x: cx / (3 * twiceArea), y: cy / (3 * twiceArea) },
    area: twiceArea / 2
  };
}

function profileFor(
  region: TextRegion,
  sourceObjectId: string,
  flattenTolerance: number
): SketchProfile {
  const outer = regionLoopFor(region.outer, sourceObjectId, flattenTolerance);
  const holes = region.holes.map((hole) =>
    regionLoopFor(hole, sourceObjectId, flattenTolerance)
  );
  const signature = [
    sourceObjectId,
    loopSignature(outer),
    ...holes.map(loopSignature)
  ].join('#');
  const regionFingerprint = fnv1a(signature);
  const outerCentroid = polylineCentroid(outer.polyline);
  let weightX = outerCentroid.centroid.x * outerCentroid.area;
  let weightY = outerCentroid.centroid.y * outerCentroid.area;
  let weight = outerCentroid.area;
  for (const hole of holes) {
    const holeCentroid = polylineCentroid(hole.polyline);
    weightX += holeCentroid.centroid.x * holeCentroid.area;
    weightY += holeCentroid.centroid.y * holeCentroid.area;
    weight += holeCentroid.area;
  }
  const centroid =
    Math.abs(weight) > 0
      ? { x: weightX / weight, y: weightY / weight }
      : { x: region.samplePoint.x, y: region.samplePoint.y };
  return {
    // Prefixed so a text profile can never collide with an arrangement one,
    // whose ids come from a different signature scheme.
    profileId: `profile_text_${fnv1a64(signature)}`,
    regionFingerprint,
    sourceEntityIds: [sourceObjectId],
    outer,
    holes,
    signedArea: region.area,
    area: region.area,
    centroid,
    boundingBox: {
      min: { x: region.boundingBox.min.x, y: region.boundingBox.min.y },
      max: { x: region.boundingBox.max.x, y: region.boundingBox.max.y }
    },
    validity: 'valid',
    diagnostics: [],
    samplePoint: { x: region.samplePoint.x, y: region.samplePoint.y },
    // Carried, not dropped. A `'unioned'` region is every segment a line —
    // the overlap union works on polygons — so its walls extrude and export
    // faceted. That is a visible product regression and the adapter warns
    // about it; discarding the flag here is what would make it silent.
    outline: {
      fidelity: region.source === 'unioned' ? 'flattened' : 'exact'
    }
  };
}

// ---------------------------------------------------------------------------
// Entry points.
// ---------------------------------------------------------------------------

/**
 * Every profile a text object contributes, from an already-parsed face.
 *
 * Outer loops come back counter-clockwise and holes clockwise — Phase 1
 * normalizes them and nothing here re-winds them, because the kernel adapter
 * relies on that orientation even though the kernel tolerates either.
 */
export function textProfilesFromFont(
  sourceObjectId: string,
  font: LoadedFont,
  parameters: TextObjectParameters,
  options?: TextProfileOptions
): SketchProfile[] {
  const set = textProfileSet(
    font,
    {
      text: parameters.text,
      size: parameters.size,
      x: parameters.x,
      y: parameters.y,
      rotation: ((parameters.rotationDeg ?? 0) * Math.PI) / 180,
      align: parameters.align
    },
    options
  );
  const flattenTolerance = parameters.size * FLATTEN_TOLERANCE_RATIO;
  return set.regions.map((region) =>
    profileFor(region, sourceObjectId, flattenTolerance)
  );
}

/**
 * The face to actually draw with, honouring the registry's fallback chain.
 *
 * Not every bundled family ships every style — Oswald and Roboto Slab have no
 * designed italic, Pacifico has only a regular — and the plan's rule is that a
 * missing style degrades to a real file rather than to a synthetic shear.
 * `resolveFontStyle` owns that chain; this is the only runtime caller of it,
 * and without this call `{ oswald, italic }` failed permanently with a message
 * that read like a transient loading problem.
 */
function loadedFace(
  lookup: (familyOrId: string, style: FontStyle) => LoadedFont | undefined,
  familyOrId: string,
  style: FontStyle
): LoadedFont | undefined {
  return lookup(familyOrId, resolveFontStyle(familyOrId, style) ?? style);
}

/**
 * Coarse closed polylines for one text object — **viewport display only**.
 *
 * Deliberately not `textProfilesFromFont(...).map(loop => loop.polyline)`:
 * that would pay for hashing, centroids and identity on every sketch
 * redraw, and it would be sampled at the kernel path's tolerance. Nothing
 * built from these points ever reaches a solid; the kernel is handed the
 * exact beziers instead.
 *
 * Returns `null` when no face is loaded, so a caller can draw nothing this
 * frame rather than block on a fetch.
 */
export function textDisplayLoops(
  parameters: TextObjectParameters,
  toleranceRatio = DISPLAY_TOLERANCE_RATIO
): Vec2Like[][] | null {
  const provider = textFontProvider();
  const font = provider
    ? loadedFace(provider, parameters.fontFamily, parameters.fontStyle)
    : undefined;
  if (!font) {
    return null;
  }
  const set = textProfileSet(font, {
    text: parameters.text,
    size: parameters.size,
    x: parameters.x,
    y: parameters.y,
    rotation: ((parameters.rotationDeg ?? 0) * Math.PI) / 180,
    align: parameters.align
  });
  const tolerance = parameters.size * toleranceRatio;
  return set.regions.flatMap((region) =>
    [region.outer, ...region.holes].map((loop) =>
      flattenLoop(loop.segments, tolerance)
    )
  );
}

/**
 * The same thing, resolving the face through the installed provider.
 *
 * Throws when no provider is installed or the requested face is not loaded.
 * That is deliberate: text with no font is not "text with no regions", and
 * quietly contributing nothing would surface as a broken profile reference
 * somewhere far away from the cause.
 */
export function textSketchProfiles(
  sourceObjectId: string,
  parameters: TextObjectParameters,
  options?: TextProfileOptions
): SketchProfile[] {
  const provider = textFontProvider();
  if (!provider) {
    throw new TextGeometryError(
      'No font provider is installed, so text outlines cannot be expanded. ' +
        'Call setTextFontProvider once the font faces a document needs are loaded.'
    );
  }
  if (!findFontFamily(parameters.fontFamily)) {
    throw new TextGeometryError(
      `There is no bundled font family "${parameters.fontFamily}".`
    );
  }
  const font = loadedFace(
    provider,
    parameters.fontFamily,
    parameters.fontStyle
  );
  if (!font) {
    throw new TextGeometryError(
      `The font face "${parameters.fontFamily}" ${parameters.fontStyle} is not loaded yet.`
    );
  }
  return textProfilesFromFont(sourceObjectId, font, parameters, options);
}
