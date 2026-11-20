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
    return {
      count: data.points?.pointIds.length ?? 1,
      diameter,
      depth,
      style: data.style,
      ...(data.standard ? { standard: { ...data.standard } } : {}),
      ...(tapped ? { thread: tapped } : {}),
      ...(data.faceReference
        ? {
            entryFace: {
              producingFeatureId: data.faceReference.producingFeatureId,
              lineageName: data.faceReference.lineageName
            }
          }
        : {})
    };
  } catch {
    return null;
  }
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
