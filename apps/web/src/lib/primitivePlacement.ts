import {
  commandFactories,
  composeCommands,
  type AnyCommand
} from '@openzcad/command-system';
import {
  listFeaturesInOrder,
  numberedBodyName,
  numberedFeatureName
} from '@openzcad/document-core';
import {
  isFeatureSuppressed,
  type BodyId,
  type FeatureNode,
  type ParamValue,
  type ParametricVector3,
  type PrimitiveKind,
  type ProjectDocument,
  type Vector3,
  isInPlaceTransform
} from '@openzcad/shared';

/**
 * Which point of each primitive its Position row places.
 *
 * The kernel builds every primitive at a fixed point of its own: the box from
 * its corner (OCCT's `makeBox` grows along +X, +Y and +Z), the cylinder and
 * cone from the centre of their base, the sphere and torus about their
 * centre. Stored documents depend on that, so the convention stays; the card
 * says which point the numbers mean instead, because a box and a cylinder
 * both left at 0, 0, 0 otherwise put the cylinder's axis on the box's corner.
 */
export const PRIMITIVE_ANCHORS: Record<
  PrimitiveKind,
  { label: string; hint: string }
> = {
  box: {
    label: 'Corner',
    hint: 'The corner with the lowest X, Y and Z. The box grows along +X, +Y and +Z from it.'
  },
  cylinder: {
    label: 'Base center',
    hint: 'The center of the bottom face. The cylinder rises along +Z from it.'
  },
  cone: {
    label: 'Base center',
    hint: 'The center of the bottom face. The cone rises along +Z from it.'
  },
  sphere: {
    label: 'Center',
    hint: 'The center of the sphere.'
  },
  torus: {
    label: 'Center',
    hint: 'The center of the ring, which lies flat in the XY plane.'
  }
};

/**
 * Starting sizes for a new primitive.
 *
 * The box is the part; everything round is a feature you add to it, and the
 * defaults have to be able to say that. A round primitive is therefore sized
 * to fit inside the box's smallest footprint dimension (18) with clearance on
 * both sides, which is also the condition its booleans need: measured against
 * this box, a cylinder unions exactly up to radius 8 and facets from 9, where
 * its diameter reaches the box's depth and goes tangent to both faces. The
 * old radius 14 was a diameter of 28 against a depth of 18, so the first union
 * a new user attempted could not succeed at ANY position — the two shapes were
 * simply the wrong sizes for each other.
 *
 * Heights run past the box's 24 so a new solid protrudes rather than hiding
 * inside it: a boolean between two bodies you cannot both see is not a first
 * thing to meet.
 */
export const PRIMITIVE_FIELDS: Record<
  PrimitiveKind,
  { key: string; label: string; initial: string }[]
> = {
  // Labelled by what the dimension IS, not by the document key that carries
  // it. The keys are OCCT's makeBox(dx, dy, dz), so `depth` lands on Z — and Z
  // is up here, which made "Depth (Z)" the upright size and "Height (Y)" a
  // horizontal one, while the cylinder next door called its vertical extent
  // Height. Keys are untouched; only the human contract changes.
  box: [
    { key: 'width', label: 'Width (X)', initial: '30' },
    { key: 'height', label: 'Depth (Y)', initial: '18' },
    { key: 'depth', label: 'Height (Z)', initial: '24' }
  ],
  cylinder: [
    { key: 'radius', label: 'Radius', initial: '6' },
    { key: 'height', label: 'Height', initial: '28' }
  ],
  sphere: [{ key: 'radius', label: 'Radius', initial: '6' }],
  cone: [
    { key: 'bottomRadius', label: 'Bottom radius', initial: '6' },
    { key: 'topRadius', label: 'Top radius', initial: '2' },
    { key: 'height', label: 'Height', initial: '28' }
  ],
  torus: [
    { key: 'majorRadius', label: 'Ring radius', initial: '6' },
    { key: 'minorRadius', label: 'Tube radius', initial: '2' }
  ]
};

export const ORIGIN_POSITION: ParametricVector3 = { x: 0, y: 0, z: 0 };

const AXES = ['x', 'y', 'z'] as const;

function isOrigin(position: ParametricVector3): boolean {
  return AXES.every((axis) => position[axis] === 0);
}

function samePosition(
  left: ParametricVector3,
  right: ParametricVector3
): boolean {
  return AXES.every((axis) => left[axis] === right[axis]);
}

/**
 * A pure-translation Move directly after the primitive, on its body.
 *
 * The same rule the face-drag planner uses when it moves a box or cylinder
 * base (`shiftPrimitiveBase`): that Move is the primitive's own placement,
 * so its translation is where the anchor point sits. Anything rotated or
 * scaled, suppressed, or further down the history is a later edit, not the
 * placement, and a new placement goes in ahead of it.
 */
function isPlacement(
  candidate: FeatureNode | undefined,
  bodyId: BodyId
): candidate is FeatureNode & {
  data: Extract<FeatureNode['data'], { featureKind: 'transform' }>;
} {
  return (
    candidate !== undefined &&
    !isFeatureSuppressed(candidate) &&
    // A copy (M10) is a new body, never the source's placement.
    isInPlaceTransform(candidate.data) &&
    candidate.data.targetBodyId === bodyId &&
    (candidate.data.transform.scale ?? 1) === 1 &&
    Object.values(candidate.data.transform.rotationDeg).every(
      (value) => value === 0
    )
  );
}

export interface PrimitivePlacement {
  /** The placement Move, or null while the primitive sits where it was built. */
  feature: FeatureNode | null;
  /** Where the anchor point sits; the origin without a placement. */
  position: ParametricVector3;
}

export function primitivePlacement(
  document: ProjectDocument | null | undefined,
  primitive: FeatureNode
): PrimitivePlacement {
  if (!document || !primitive.bodyId) {
    return { feature: null, position: ORIGIN_POSITION };
  }
  const features = listFeaturesInOrder(document);
  const index = features.findIndex(
    (feature) => feature.featureId === primitive.featureId
  );
  const next = index >= 0 ? features[index + 1] : undefined;
  return isPlacement(next, primitive.bodyId)
    ? { feature: next, position: next.data.transform.translation }
    : { feature: null, position: ORIGIN_POSITION };
}

/**
 * Create a primitive, placed when its position is not the origin.
 *
 * At the origin this is exactly the command the card always built, so a
 * default Create stores the same single feature it did before. Elsewhere it
 * is one undo step: the primitive plus its placement Move. An in-place
 * placement on a plane not square to Z (U09) turns it in the same Move.
 * The current document resolves the body's number into the command payload,
 * so a placed primitive has the same name after undo, redo and replay. A
 * second "Box" in History is numbered "Box 2" the same way.
 */
export function createPrimitiveCommand(
  kind: PrimitiveKind,
  name: string,
  dimensions: Record<string, ParamValue>,
  position: ParametricVector3,
  document?: ProjectDocument | null,
  rotationDeg?: Vector3
): AnyCommand {
  const featureName = document ? numberedFeatureName(document, name) : name;
  const turned =
    rotationDeg !== undefined &&
    (rotationDeg.x !== 0 || rotationDeg.y !== 0 || rotationDeg.z !== 0);
  const add = commandFactories.addPrimitive({
    name: featureName,
    // Numbered from the name as given, as bodies always were: "Box 3" for a
    // third box even where History shows only "Box" and "Box 2".
    ...(document ? { bodyName: numberedBodyName(document, name) } : {}),
    primitiveKind: kind,
    dimensions
  });
  if (isOrigin(position) && !turned) return add;
  return composeCommands(add.label, [
    add,
    commandFactories.transformBody({
      name: `Place ${featureName}`,
      targetBodyId: add.payload.ids!.bodyId,
      translation: position,
      ...(turned ? { rotationDeg } : {})
    })
  ]);
}

/**
 * Apply a primitive card: its dimensions, and its position when that moved.
 *
 * A changed position rewrites the existing placement Move, or inserts one
 * directly after the primitive, so later features keep applying on top.
 * Without a document there is no history to place into, so only the
 * dimensions apply.
 */
export function applyPrimitiveCommand(
  document: ProjectDocument | null | undefined,
  primitive: FeatureNode,
  name: string,
  dimensions: Record<string, ParamValue>,
  position: ParametricVector3
): AnyCommand {
  const label = `Edit ${name}`;
  const update = commandFactories.updateFeature(
    { featureId: primitive.featureId, name, data: { dimensions } },
    label
  );
  const placement = primitivePlacement(document, primitive);
  if (
    !document ||
    !primitive.bodyId ||
    samePosition(placement.position, position)
  ) {
    return update;
  }
  if (placement.feature?.data.featureKind === 'transform') {
    return composeCommands(label, [
      update,
      commandFactories.updateFeature(
        {
          featureId: placement.feature.featureId,
          data: {
            transform: {
              ...placement.feature.data.transform,
              translation: position
            }
          }
        },
        label
      )
    ]);
  }
  const index = listFeaturesInOrder(document).findIndex(
    (feature) => feature.featureId === primitive.featureId
  );
  const move = commandFactories.transformBody({
    name: `Place ${name}`,
    targetBodyId: primitive.bodyId,
    translation: position
  });
  return composeCommands(label, [
    update,
    move,
    commandFactories.moveFeature({
      featureId: move.payload.ids!.featureId,
      toIndex: index + 1
    })
  ]);
}
