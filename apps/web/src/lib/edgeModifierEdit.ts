import { commandFactories } from '@openzcad/command-system';
import type {
  BodyId,
  EdgeTopologyReferenceV5,
  FeatureNode,
  ParamValue,
  VariableFilletLaw
} from '@openzcad/shared';

/** A fillet or chamfer as its command takes it, created or edited. */
export interface EdgeModifierFormValue {
  name: string;
  targetBodyId: BodyId;
  edgeHashes: number[];
  edgeReferences?: EdgeTopologyReferenceV5[];
  size: ParamValue;
  /** Chamfer only: bevel angle in degrees; absent means symmetric 45°. */
  angleDeg?: ParamValue;
  /** Fillet only: far-end radius; absent means a constant-radius fillet. */
  endRadius?: ParamValue;
  /** Fillet only: read only with `endRadius`; absent means 'linear'. */
  radiusLaw?: VariableFilletLaw;
  /** Chamfer only: setback on the other face; absent means symmetric. */
  distance2?: ParamValue;
}

export function edgeModifierCommand(
  feature: FeatureNode | null,
  kind: 'fillet' | 'chamfer',
  value: EdgeModifierFormValue
) {
  if (!feature) {
    return kind === 'fillet'
      ? commandFactories.filletEdges(value)
      : commandFactories.chamferEdges(value);
  }
  // A patch cannot delete a key, and a variable fillet turned back into a
  // constant one — or an asymmetric chamfer back into a symmetric one — is
  // exactly a deletion: the same radius twice is a different blend from no
  // end radius at all, and it goes through a different kernel engine. Name
  // the fields to drop instead of storing a lookalike.
  //
  // A chamfer's angle is named the same way, and for a sharper reason: an
  // angle and a second distance are mutually exclusive, so a stored angle
  // left behind by a patch makes the feature unbuildable the moment a
  // second distance is added. Blanking the angle has to delete it.
  const clearData =
    kind === 'fillet'
      ? value.endRadius === undefined
        ? ['endRadius', 'radiusLaw']
        : []
      : [
          ...(value.angleDeg === undefined ? ['angleDeg'] : []),
          ...(value.distance2 === undefined ? ['distance2'] : [])
        ];
  return commandFactories.updateFeature(
    {
      featureId: feature.featureId,
      name: value.name,
      // The edge set travels with the edit, so a fillet can take more edges
      // after creation. Hash-only sets clear the stored references: those
      // named the old set, and the kernel resolves the new one by fingerprint.
      data: {
        edgeHashes: value.edgeHashes,
        edgeReferences: value.edgeReferences,
        ...(kind === 'fillet'
          ? {
              radius: value.size,
              ...(value.endRadius !== undefined
                ? {
                    endRadius: value.endRadius,
                    radiusLaw: value.radiusLaw ?? 'linear'
                  }
                : {})
            }
          : {
              distance: value.size,
              ...(value.angleDeg !== undefined
                ? { angleDeg: value.angleDeg }
                : {}),
              ...(value.distance2 !== undefined
                ? { distance2: value.distance2 }
                : {})
            })
      },
      ...(clearData.length > 0 ? { clearData } : {})
    },
    `Edit ${value.name}`
  );
}
