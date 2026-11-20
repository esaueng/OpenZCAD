/**
 * M01: a hole's callout data, read from the stored hole as its build reads
 * it: the standard's table diameter (schema v65), the bore's depth, and the
 * tapped thread (schema v66), cut or cosmetic (schema v67). What D02
 * drawings write beside a hole, and what any later reader of holes reads,
 * without asking the kernel.
 */
import {
  holeStandardDiameter,
  holeStandardThread,
  holeThreadDesignation,
  millimetresPerUnit,
  type FaceTopologyReferenceV5,
  type FeatureId,
  type HoleCallout,
  type ProjectDocument
} from '@openzcad/shared';
import { findFeature, getParameterScope, resolveParamValue } from './index';

/**
 * The callout of hole `featureId`, or null when it is no hole or a value it
 * reads does not resolve (the build names why).
 */
export function holeCallout(
  document: ProjectDocument,
  featureId: FeatureId,
  scope: Record<string, number> = getParameterScope(document).scope
): HoleCallout | null {
  const data = findFeature(document, featureId)?.data;
  if (data?.featureKind !== 'hole') return null;
  const units = document.units;
  try {
    const value = (stored: Parameters<typeof resolveParamValue>[0]) =>
      resolveParamValue(stored, scope, 'hole callout', units);
    const diameter = data.standard
      ? holeStandardDiameter(data.standard, units)
      : value(data.diameter);
    const depth =
      data.depthMode === 'blind' && data.depth !== undefined
        ? value(data.depth)
        : null;
    const mm = millimetresPerUnit(units);
    const tapped =
      data.tapped && data.standard?.kind === 'tap-drill'
        ? (() => {
            const thread = holeStandardThread(data.standard);
            return {
              designation: holeThreadDesignation(data.standard),
              majorDiameter: thread.majorDiameterMm / mm,
              pitch: thread.pitchMm / mm,
              length:
                data.tapped.length === undefined
                  ? null
                  : value(data.tapped.length),
              hand: data.tapped.hand ?? 'right',
              cosmetic: data.tapped.cosmetic === true
            };
          })()
        : undefined;
    const entryPlane = storedEntryPlane(data.faceReference);
    return {
      count: data.points?.pointIds.length ?? 1,
      diameter,
      depth,
      style: data.style,
      ...(data.standard ? { standard: { ...data.standard } } : {}),
      ...(tapped ? { thread: tapped } : {}),
      ...(entryPlane ? { entryPlane } : {})
    };
  } catch {
    return null;
  }
}

/** ADR-011: witnesses count in 1e-6 document units, directions 1000× finer. */
const WITNESS_QUANTUM = 1e-6;

/** The entry face's plane, from its stored witness, else undefined. */
function storedEntryPlane(
  reference: FaceTopologyReferenceV5 | undefined
): HoleCallout['entryPlane'] {
  const witness = reference?.witness;
  if (witness?.analytic.kind !== 'plane' || !witness.centroid) return undefined;
  const [nx, ny, nz] = witness.analytic.normal.map(
    (value) => (value * WITNESS_QUANTUM) / 1000
  ) as [number, number, number];
  const [px, py, pz] = witness.centroid.map(
    (value) => value * WITNESS_QUANTUM
  ) as [number, number, number];
  const size = Math.hypot(nx, ny, nz);
  if (!(size > 0)) return undefined;
  return {
    point: { x: px, y: py, z: pz },
    normal: { x: nx / size, y: ny / size, z: nz / size }
  };
}

/**
 * The hole a face's lineage name says it is a bore of: the hole itself
 * (`hole.face.bore`, `hole.face.at.<point>.bore`) or, for an M02 pattern's
 * copy, the hole it repeats (`pattern.face.instance.<n>.source.<hole>.…`).
 */
export function holeOfBoreFace(reference: {
  producingFeatureId: FeatureId;
  lineageName: string;
}): FeatureId | null {
  const match =
    /^(?:pattern\.face\.instance\.[A-Za-z0-9_-]+\.source\.([A-Za-z0-9_-]+)\.)?hole\.face(?:\.at\.[A-Za-z0-9_-]+)?\.bore$/.exec(
      reference.lineageName
    );
  if (!match) return null;
  return (match[1] as FeatureId | undefined) ?? reference.producingFeatureId;
}
