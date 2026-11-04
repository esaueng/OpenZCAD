import { useMemo } from 'react';
import type {
  BodyId,
  BodyRepresentation,
  ProjectDocument
} from '@openzcad/shared';
import { boxPreviewProfile } from '../lib/interaction/boxPreviewProfile';
import { capPreviewProfile } from '../lib/interaction/capPreviewProfile';
import { cylinderPreviewProfile } from '../lib/interaction/cylinderRadius';
import {
  primitiveBoxFaceAncestor,
  primitiveCylinderHeightAncestor
} from '../lib/interaction/cylinderPrimitiveAncestry';
import { faceOffsetBaseline } from '../lib/interaction/faceOffsetPlan';
import { gearHeightPreviewProfile } from '../lib/interaction/gearHeightPreviewProfile';
import type { InteractionState } from '../lib/interaction/machine';
import { stepPreviewProfile } from '../lib/interaction/stepPreviewProfile';

/** Keep source-mesh recognition independent of changing drag values and phases. */
export function useOffsetFaceHandle(
  document: ProjectDocument | null,
  representations: ProjectDocument['derived']['bodyRepresentations'],
  interaction: InteractionState,
  previewValue: number | null | undefined,
  exactFaceDrag: boolean
) {
  const target =
    interaction.mode === 'face' &&
    interaction.op === 'offset-face' &&
    interaction.target.surfaceType === 'planar'
      ? interaction.target
      : null;
  const body: BodyRepresentation | undefined = target
    ? representations[target.bodyId as BodyId]
    : undefined;
  const profile = useMemo(() => {
    if (!target) return null;
    const total =
      document && target.hash !== undefined && !target.localFaceOffset
        ? faceOffsetBaseline(
            document,
            target.bodyId as BodyId,
            { reference: target.reference },
            target.hash
          )
        : undefined;
    const profile =
      document &&
      target.hash !== undefined &&
      primitiveCylinderHeightAncestor(
        document,
        target.bodyId as BodyId,
        target.reference,
        target.hash
      )
        ? cylinderPreviewProfile(body)
        : null;
    const boxProfile =
      document &&
      !target.localFaceOffset &&
      target.hash !== undefined &&
      primitiveBoxFaceAncestor(
        document,
        target.bodyId as BodyId,
        target.reference,
        target.hash
      )
        ? boxPreviewProfile(body, {
            x: target.normal[0],
            y: target.normal[1],
            z: target.normal[2]
          })
        : null;
    const pickedFace = body?.topology?.faces.find(
      (face) =>
        face.topologyId === target.topologyId && face.hash === target.hash
    );
    // A cached pick must still name the exact face installed for this revision.
    if (!pickedFace?.geometry) return null;
    const gearProfile =
      !profile && !boxProfile && document
        ? gearHeightPreviewProfile(document, body, pickedFace)
        : null;
    const terminalProfile =
      !profile && !boxProfile && !gearProfile
        ? capPreviewProfile(body, pickedFace)
        : null;
    const linearProfile = boxProfile ?? terminalProfile;
    // Any other planar face: move it with its blends and stretch the walls
    // they meet, when that is what the exact move would do.
    const stepProfile =
      !profile && !linearProfile && !gearProfile && !exactFaceDrag
        ? stepPreviewProfile(body, pickedFace)
        : null;
    return {
      ...(gearProfile ? { gearHeightProfilePreview: gearProfile } : {}),
      ...(linearProfile ? { linearProfilePreview: linearProfile } : {}),
      ...(stepProfile ? { stepProfilePreview: stepProfile } : {}),
      ...(profile ? { profilePreview: profile } : {}),
      bodyId: target.bodyId,
      topologyId: target.topologyId,
      point: {
        x: target.point[0],
        y: target.point[1],
        z: target.point[2]
      },
      normal: {
        x: target.normal[0],
        y: target.normal[1],
        z: target.normal[2]
      },
      ...(total === undefined
        ? {}
        : { totalBaseline: total.total, totalSense: total.sense })
    };
  }, [document, target, body, exactFaceDrag]);
  const phase = interaction.mode === 'face' ? interaction.phase : null;
  const lastValue = interaction.mode === 'face' ? interaction.lastValue : null;
  return useMemo(
    () =>
      profile
        ? {
            ...profile,
            initialValue: previewValue ?? lastValue ?? 0,
            ...(phase === 'validating' ? { locked: true } : {}),
            ...(phase === 'exact-entry' ? { entry: true } : {})
          }
        : null,
    [profile, previewValue, lastValue, phase]
  );
}
