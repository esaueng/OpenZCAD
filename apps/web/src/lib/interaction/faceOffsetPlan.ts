import { listFeaturesInOrder } from '@openzcad/document-core';
import {
  commandFactories,
  composeCommands,
  type AnyCommand
} from '@openzcad/command-system';
import { isFeatureSuppressed } from '@openzcad/shared';
import type {
  BodyId,
  FaceTopology,
  FeatureNode,
  ParamValue,
  ProjectDocument
} from '@openzcad/shared';
import {
  primitiveBoxFaceAncestor,
  primitiveCylinderCapAncestor
} from './cylinderPrimitiveAncestry';
import { extrudeCapAncestor } from './extrudeCapAncestry';

/**
 * What a planar face offset turns into.
 *
 * A face that resolves back to a primitive side by lineage becomes an edit
 * of that primitive's dimension — the modifiers downstream regenerate at the
 * new extent, which is what "make it taller" means once the rim carries a
 * blend. The far cap of an extrude likewise becomes an edit of its stored
 * distance, which is what keeps the extrude open after it lands: the same
 * handle keeps driving the same feature. Everything unproven becomes the
 * generic exact push/pull, which is still exact, just local to the picked
 * face.
 */
export type FaceOffsetPlan =
  | {
      kind: 'primitive-dimension';
      command: AnyCommand;
      primitive: FeatureNode;
      dimension: string;
      /** The dimension after the edit, evaluated. */
      value: number;
      preflightRejection?: string;
    }
  | {
      kind: 'extrude-distance';
      command: AnyCommand;
      feature: FeatureNode;
      /** The signed distance after the edit, evaluated. */
      value: number;
      preflightRejection?: string;
    }
  | { kind: 'direct-edit'; command: AnyCommand };

/** What the handle's "Total" readout adds the drag to, and in which sense. */
export interface FaceOffsetTotal {
  total: number;
  /** +1 when the drag adds to the total, -1 when it subtracts. */
  sense: 1 | -1;
}

export interface FaceOffsetPlanInput {
  document: ProjectDocument;
  bodyId: BodyId;
  face: FaceTopology;
  faceHash: number;
  /** Signed distance along the face's outward normal. */
  offset: number;
  /** A typed expression to keep live in the document instead of the number. */
  exact?: ParamValue;
}

const DIRECT_EDIT_NAME = 'Offset face';

function dimensionEdit(
  primitive: FeatureNode,
  dimension: string,
  offset: number,
  exact: ParamValue | undefined,
  label: string,
  emptyMessage: string,
  roundDimension = true
): FaceOffsetPlan | null {
  if (primitive.data.featureKind !== 'primitive') {
    return null;
  }
  const dimensions = primitive.data.dimensions;
  const current = dimensions[dimension];
  // The ancestry only resolves against a numeric dimension; narrowing here
  // keeps that guarantee visible instead of casting it away.
  if (typeof current !== 'number') {
    return null;
  }
  // The drag was measured along the side's outward normal, which is the
  // dimension's own axis whatever rigid placement it sits under, so the
  // gesture is a signed delta on the stored value. Composing a typed
  // expression keeps it live in the document.
  const value = current + offset;
  return {
    kind: 'primitive-dimension',
    command: commandFactories.updateFeature(
      {
        featureId: primitive.featureId,
        data: {
          dimensions: {
            ...dimensions,
            [dimension]:
              typeof exact === 'string'
                ? `${current} + (${exact})`
                : roundDimension
                  ? Math.round(value * 1000) / 1000
                  : value
          }
        }
      },
      label
    ),
    primitive,
    dimension,
    value,
    ...(value <= 0 ? { preflightRejection: emptyMessage } : {})
  };
}

/** Pure. Null when the face is not an exact plane or the offset is a no-op. */
export function planFaceOffset(
  input: FaceOffsetPlanInput
): FaceOffsetPlan | null {
  const { document, bodyId, face, faceHash, offset, exact } = input;
  const geometry = face.geometry;
  if (
    geometry?.surfaceType !== 'plane' ||
    !geometry.normal ||
    Math.abs(offset) <= 1e-9
  ) {
    return null;
  }

  const extrude = extrudeCapAncestor(
    document,
    bodyId,
    face.reference,
    faceHash
  );
  if (extrude) {
    const { feature, distance, sense } = extrude;
    const value = distance + sense * offset;
    return {
      kind: 'extrude-distance',
      command: commandFactories.updateFeature(
        {
          featureId: feature.featureId,
          data: {
            distance:
              typeof exact === 'string'
                ? `${distance} ${sense === 1 ? '+' : '-'} (${exact})`
                : Math.round(value * 1000) / 1000
          }
        },
        `Edit ${feature.name}`
      ),
      feature,
      value,
      // Through zero the extrusion would flip to the other side of its
      // sketch, which is a different operation, not a shorter one.
      ...(value * distance <= 0
        ? {
            preflightRejection:
              'That distance would leave the extrusion with no depth.'
          }
        : {})
    };
  }

  const cylinder = primitiveCylinderCapAncestor(
    document,
    bodyId,
    face.reference,
    faceHash
  );
  if (cylinder) {
    const localOffset = Math.round(offset * 1000) / 1000 / cylinder.scale;
    const localExact =
      typeof exact === 'string' && cylinder.scale !== 1
        ? `(${exact}) / ${cylinder.scale}`
        : exact;
    const plan = dimensionEdit(
      cylinder.primitive,
      'height',
      localOffset,
      localExact,
      'Resize Cylinder Height',
      'That distance would leave the cylinder with no height.',
      false
    );
    if (plan?.kind === 'primitive-dimension') {
      if (cylinder.side === 'start' && !plan.preflightRejection) {
        const primitive = cylinder.primitive;
        if (!primitive.bodyId) return null;
        const features = listFeaturesInOrder(document);
        const index = features.findIndex(
          (feature) => feature.featureId === primitive.featureId
        );
        const placement = features[index + 1];
        const shift: ParamValue =
          typeof localExact === 'string' ? `-(${localExact})` : -localOffset;
        const commands = [plan.command];
        // A local shift before every modifier and placement keeps the far cap
        // fixed even when the body has subsequently been rotated or scaled.
        if (
          placement &&
          !isFeatureSuppressed(placement) &&
          placement.data.featureKind === 'transform' &&
          placement.data.targetBodyId === primitive.bodyId &&
          (placement.data.transform.scale ?? 1) === 1 &&
          Object.values(placement.data.transform.rotationDeg).every(
            (value) => value === 0
          )
        ) {
          const transform = placement.data.transform;
          const z = transform.translation.z;
          commands.push(
            commandFactories.updateFeature(
              {
                featureId: placement.featureId,
                data: {
                  transform: {
                    ...transform,
                    translation: {
                      ...transform.translation,
                      z:
                        typeof z === 'number' && typeof shift === 'number'
                          ? z + shift
                          : `(${z}) + (${shift})`
                    }
                  }
                }
              },
              'Move Cylinder Base'
            )
          );
        } else {
          const move = commandFactories.transformBody({
            name: 'Move Cylinder Base',
            targetBodyId: primitive.bodyId,
            translation: { x: 0, y: 0, z: shift }
          });
          commands.push(
            move,
            commandFactories.moveFeature({
              featureId: move.payload.ids!.featureId,
              toIndex: index + 1
            })
          );
        }
        plan.command = composeCommands('Resize Cylinder Height', commands);
      }
      return { ...plan, value: plan.value * cylinder.scale };
    }
  }

  const box = primitiveBoxFaceAncestor(
    document,
    bodyId,
    face.reference,
    faceHash
  );
  // Only a max side moves under a dimension edit: the box grows from its
  // minimum corner, so a min-side drag would have to move the body as well
  // and keeps the local push/pull.
  if (box && box.side === 'max') {
    const plan = dimensionEdit(
      box.primitive,
      box.dimension,
      offset,
      exact,
      `Resize ${box.primitive.name} ${box.dimension}`,
      `That distance would leave the box with no ${box.dimension}.`
    );
    if (plan) {
      return plan;
    }
  }

  return {
    kind: 'direct-edit',
    command: commandFactories.directEditBody({
      name: DIRECT_EDIT_NAME,
      targetBodyId: bodyId,
      operation: {
        kind: 'offset-face',
        faceHash,
        ...(face.reference ? { faceReference: face.reference } : {}),
        sourceSurfaceType: 'plane',
        sourceArea: geometry.area,
        sourceCenter: geometry.center,
        sourceNormal: geometry.normal,
        offset: exact ?? Math.round(offset * 1000) / 1000
      }
    })
  };
}

/**
 * The stored value a face offset would edit, for the handle's "Total …"
 * readout; undefined when the offset is a local push/pull.
 */
export function faceOffsetBaseline(
  document: ProjectDocument,
  bodyId: BodyId,
  face: Pick<FaceTopology, 'reference'>,
  faceHash: number
): FaceOffsetTotal | undefined {
  const extrude = extrudeCapAncestor(
    document,
    bodyId,
    face.reference,
    faceHash
  );
  if (extrude) {
    return { total: extrude.distance, sense: extrude.sense };
  }
  const cylinder = primitiveCylinderCapAncestor(
    document,
    bodyId,
    face.reference,
    faceHash
  );
  const primitive =
    cylinder?.primitive.data.featureKind === 'primitive'
      ? { node: cylinder.primitive, dimension: 'height' }
      : (() => {
          const box = primitiveBoxFaceAncestor(
            document,
            bodyId,
            face.reference,
            faceHash
          );
          return box && box.side === 'max'
            ? { node: box.primitive, dimension: box.dimension }
            : null;
        })();
  if (!primitive || primitive.node.data.featureKind !== 'primitive') {
    return undefined;
  }
  const value = primitive.node.data.dimensions[primitive.dimension];
  return typeof value === 'number'
    ? { total: value * (cylinder?.scale ?? 1), sense: 1 }
    : undefined;
}
