import {
  defaultGearXDirection,
  GEAR_PLACEMENT_UNUSABLE,
  gearModule,
  gearPlacementFrame,
  isFeatureSuppressed,
  type BodyId,
  type BodyNode,
  type FeatureNode,
  type GearMeshGear,
  type GearMeshRefusal,
  type ParamValue,
  type ProjectDocument,
  type Vector3
} from '@openzcad/shared';
import { getParameterScope, resolveParamValue } from './index';
import { bodySourceMap } from './object-folders';

/**
 * M14 meshing-pair helper: the gear a body shows, with its values resolved
 * in document units, for `meshGearPair`. A body made from a gear by edits
 * that leave the gear where it was (a fillet, a hole, a boolean that keeps
 * it as the first operand…) still shows that gear; a gear moved after it
 * was made, a copy or mirror of one, and teeth cut into a cylinder (whose
 * axis comes from the picked face) are refused.
 */

/** Features that remake a body in place without moving it. */
const IN_PLACE_KINDS = new Set<FeatureNode['featureKind']>([
  'fillet',
  'chamfer',
  'hole',
  'shell',
  'draft',
  'thread',
  'boolean',
  'direct-edit',
  'split'
]);

function targetsOf(feature: FeatureNode): string[] {
  const data = feature.data as {
    targetBodyId?: unknown;
    targetBodyIds?: unknown;
  };
  const ids: string[] = [];
  if (typeof data.targetBodyId === 'string') ids.push(data.targetBodyId);
  if (Array.isArray(data.targetBodyIds))
    for (const id of data.targetBodyIds)
      if (typeof id === 'string') ids.push(id);
  return ids;
}

function refusal(
  code: GearMeshRefusal['code'],
  message: string
): GearMeshRefusal {
  return { code, message };
}

/** The gear `bodyId` shows, or why it cannot be meshed. */
export function gearMeshGearOfBody(
  document: ProjectDocument,
  bodyId: BodyId
): GearMeshGear | GearMeshRefusal {
  const bodies = new Map<BodyId, BodyNode>();
  const features = new Map<string, FeatureNode>();
  for (const node of Object.values(document.nodes)) {
    if (node.kind === 'body') bodies.set(node.bodyId, node);
    else if (node.kind === 'feature') features.set(node.featureId, node);
  }
  const sources = bodySourceMap(document);
  const notAGear = refusal('gear-mesh:not-a-gear', 'That part is not a gear.');

  // Back along the bodies it was made from, to the gear that started it.
  const chain: BodyId[] = [];
  let current: BodyId | null = bodyId;
  let gear: FeatureNode | null = null;
  while (current && !chain.includes(current)) {
    chain.push(current);
    const body = bodies.get(current);
    const feature = body ? features.get(body.featureId) : undefined;
    if (!feature) return notAGear;
    if (feature.featureKind === 'gear') {
      gear = feature;
      break;
    }
    if (!IN_PLACE_KINDS.has(feature.featureKind)) return notAGear;
    current = sources.get(current) ?? null;
  }
  if (!gear || gear.data.featureKind !== 'gear') return notAGear;
  const data = gear.data;
  if (data.targetBodyId !== undefined)
    return refusal(
      'gear-mesh:teeth-on-body',
      `${gear.name} cuts teeth into a cylinder; the pair helper places gears made as their own body only so far.`
    );

  // A Move of the gear's body after it was made shifts it off its frame.
  const order = document.featureOrder;
  const after = order.indexOf(gear.featureId);
  for (const featureId of order.slice(after + 1)) {
    const feature = features.get(featureId);
    if (
      feature &&
      !isFeatureSuppressed(feature) &&
      (feature.featureKind === 'transform' ||
        feature.featureKind === 'mirror' ||
        feature.featureKind === 'pattern') &&
      targetsOf(feature).some((id) => chain.includes(id as BodyId)) &&
      // A copy leaves the gear where it is; only an in-place move shifts it.
      !(feature.bodyId && !chain.includes(feature.bodyId))
    )
      return refusal(
        'gear-mesh:moved',
        `${gear.name} was moved after it was made (${feature.name}); the pair helper reads the gear where it was made.`
      );
  }

  if (
    data.pitch === undefined ||
    data.faceWidth === undefined ||
    !data.origin ||
    !data.axis
  )
    return refusal(
      'gear-mesh:unresolved',
      `${gear.name} has no size or placement.`
    );
  const { scope } = getParameterScope(document);
  try {
    const value = (v: ParamValue, label: string) =>
      resolveParamValue(v, scope, `${gear.name} ${label}`, document.units);
    const optional = (
      v: ParamValue | undefined,
      label: string,
      fallback: number
    ) => (v === undefined ? fallback : value(v, label));
    const vector = (
      v: { x: ParamValue; y: ParamValue; z: ParamValue },
      label: string
    ): Vector3 => ({
      x: value(v.x, `${label} X`),
      y: value(v.y, `${label} Y`),
      z: value(v.z, `${label} Z`)
    });
    const axis = vector(data.axis, 'axis');
    const helix = optional(data.helixAngleDeg, 'helix angle', 0);
    // The frame the kernel builds from what the adapter sends it (the
    // stored x direction, else the adapter's default), so the helper phases
    // the teeth the kernel cut; refused where that phase is ill-conditioned.
    const frame = gearPlacementFrame(
      vector(data.origin, 'origin'),
      axis,
      data.xDirection
        ? vector(data.xDirection, 'x direction')
        : defaultGearXDirection(axis)
    );
    if (!frame)
      return refusal(
        'gear-mesh:invalid-placement',
        `${gear.name} cannot be placed: ${GEAR_PLACEMENT_UNUSABLE}.`
      );
    return {
      gearType: data.gearType,
      teeth: Math.round(value(data.teeth, 'teeth')),
      module: gearModule(
        data.sizing,
        value(data.pitch, 'pitch'),
        document.units
      ),
      pressureAngleDeg: optional(data.pressureAngleDeg, 'pressure angle', 20),
      profileShift: optional(data.profileShift, 'profile shift', 0),
      // The root fillet rounds into the root circle without moving it, so
      // the tip and root circles are all the clearance check needs.
      addendum: optional(data.addendum, 'addendum', 1),
      dedendum: optional(data.dedendum, 'dedendum', 1.25),
      backlash: optional(data.backlash, 'backlash', 0),
      helixAngleDeg: helix,
      hand: data.hand ?? 'right',
      herringbone: helix !== 0 && data.herringbone === true,
      faceWidth: value(data.faceWidth, 'face width'),
      phaseDeg: optional(data.phaseDeg, 'phase', 0),
      frame
    };
  } catch (error) {
    return refusal(
      'gear-mesh:unresolved',
      error instanceof Error ? error.message : `${gear.name} cannot be read.`
    );
  }
}
