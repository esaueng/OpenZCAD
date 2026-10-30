import {
  listFeaturesInOrder,
  type FeatureUpdateInput
} from '@openzcad/document-core';
import {
  FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY,
  FEATURE_SUPPRESSED_METADATA_KEY,
  isDatumPlaneRef,
  isFeatureSuppressed,
  isInPlaceTransform,
  type EdgeTopologyReferenceV5,
  type BodyId,
  type FaceTopologyReferenceV5,
  type ProjectDocument,
  type FeatureData,
  type FeatureId,
  type FeatureNode,
  type ParamValue,
  type ParametricVector3,
  type SketchId,
  type SketchProfileReference,
  type SketchSectionReference,
  type Vector3
} from '@openzcad/shared';
import { featureHistory, featureResultBodyIds } from '../featureHistory';
import { holePositionAxes } from '../holePositionAxes';
import type { RevolveAxisCandidate } from './revolve';
import {
  IN_PLACE_TOOL_SPECS,
  type BodyPick,
  type CurvePick,
  type EdgePick,
  type FacePick,
  type ResolvedInPlaceRequest,
  type InPlaceToolId,
  type PlanePick,
  type ProfilePick
} from './tools';

/**
 * Editing a feature in place (U09 phase 7).
 *
 * A History row re-arms the command that made the feature, seeded from what
 * it stores: its picks fill the slots, its numbers the handles (a typed
 * expression stays typed), its choices the Options. Whatever the command
 * cannot show — a hole's stored position, a draft's typed pull — stays as
 * stored until the user changes it, so Done on an untouched edit writes the
 * feature back as it was. Done commits through `updateFeature`, as the cards
 * did, so replay and collaboration see the same patch.
 */

/** What the command needs to resolve a stored feature against the model. */
export interface InPlaceEditContext {
  evaluate(value: ParamValue): number | null;
  /** A stored region reference, found in its sketch, or null. */
  profile(
    sketchId: SketchId,
    reference: SketchProfileReference
  ): ProfilePick | null;
  /** A sketch's first region, for a revolve that stores no profile. */
  firstRegion(sketchId: SketchId): number | null;
  /**
   * A stored face, by its lineage reference first (an upstream edit can
   * change the hash and keep the face) and then its hash.
   */
  face(
    bodyId: BodyId,
    hash: number,
    reference?: FaceTopologyReferenceV5
  ): FacePick | null;
  /** Any planar face of a body, for a command any face names. */
  anyFace(bodyId: BodyId): FacePick | null;
  /**
   * A body's edge by its stored identity (its lineage name when it has one,
   * else its hash), with where its handles stand.
   */
  edge(
    bodyId: BodyId,
    hash: number,
    reference?: EdgeTopologyReferenceV5
  ): EdgePick | null;
  /** Whether a sketch still has this curve, as a path can take it. */
  curve(sketchId: SketchId, entityId: string): boolean;
  body(bodyId: BodyId): BodyPick | null;
  /**
   * Later in-place steps on the edited feature's body, in history order:
   * the model shows the body after them too.
   */
  laterTransforms?: readonly FeatureData[];
  /**
   * Whether a later direct edit reshapes the edited feature's body: the
   * model's body then cannot be taken back to the one before the feature.
   */
  laterReshapes?: boolean;
  /**
   * Whether a datum plane is one the feature may stand on: it still exists
   * (unsuppressed) and comes before the feature in history.
   */
  datumPlaneUsable?(featureId: FeatureId): boolean;
  /** A body's display mesh vertices (x, y, z, …), for its exact box. */
  bodyVertices?(bodyId: BodyId): ArrayLike<number> | null;
  /** A datum axis's line, for a turn the model shows already made. */
  datumAxis?(
    featureId: FeatureId
  ): { origin: Vector3; direction: Vector3 } | null;
}

export interface InPlaceEditSeed {
  featureId: FeatureId;
  nodeId: string;
  name: string;
  data: FeatureData;
  /** The body a valid preview must still build. */
  resultBodyId: BodyId | undefined;
  /** Bodies the feature itself makes, which it can never take as input. */
  ownBodyIds: BodyId[];
  slots: {
    profiles: ProfilePick[];
    axisId: string | null;
    path: CurvePick[];
    guide: CurvePick[];
    faces: FacePick[];
    bodies: BodyPick[];
    plane: PlanePick | null;
    edges: EdgePick[];
  };
  values: Record<string, number>;
  raws: Record<string, string>;
  /** Values the feature stores, which no suggested default may replace. */
  touched: string[];
  options: Record<string, string>;
  /** Axis lines only the stored feature has (a helix's typed axis). */
  axes: RevolveAxisCandidate[];
  /** Choices only the stored feature has ("As saved"), by option id. */
  choices: Record<string, { value: string; label: string }[]>;
  /** Options an edit may not change (a copy's ownership of its body). */
  lockedOptions: string[];
  /** What could not be restored and must be picked again, if anything. */
  notice: string | null;
  /**
   * A scale whose body a later direct edit reshapes: its box is only
   * approximate, so its factor is typed on a chip rather than dragged.
   */
  reshapedLater?: true;
}

/**
 * The in-place tool that edits a stored feature, or null for one that still
 * edits in its card (a Move, whose gizmo is its editor).
 */
export function inPlaceToolForFeature(data: FeatureData): InPlaceToolId | null {
  switch (data.featureKind) {
    case 'revolve':
    case 'loft':
    case 'sweep':
    case 'helical-sweep':
    case 'hole':
    case 'shell':
    case 'thicken':
    case 'solid-offset':
    case 'draft':
    case 'mirror':
    case 'split':
    case 'fillet':
    case 'chamfer':
      return data.featureKind;
    case 'gear':
      return data.targetBodyId === undefined ? 'gear' : 'gear-teeth';
    case 'boolean':
      return data.operation;
    case 'pattern':
      return `${data.patternKind}-pattern`;
    case 'transform': {
      const { translation, rotationDeg, scale } = data.transform;
      // Only a pure scale or a pure turn about a datum axis is that tool's
      // feature; anything that also moves the body is a Move.
      if (!zeroVector(translation) || !zeroVector(rotationDeg)) return null;
      if (data.axisRotation && scale === undefined) return 'axis-rotate';
      if (scale !== undefined && !data.axisRotation) return 'scale';
      return null;
    }
    default:
      return null;
  }
}

function zeroVector(vector: ParametricVector3): boolean {
  return [vector.x, vector.y, vector.z].every(
    (value) => value === 0 || value === '0'
  );
}

/** The command and its seed for a stored feature; null when none edits it. */
export function inPlaceEditSeed(
  feature: FeatureNode,
  ctx: InPlaceEditContext
): { tool: InPlaceToolId; seed: InPlaceEditSeed } | null {
  const data = feature.data;
  const tool = inPlaceToolForFeature(data);
  if (!tool) return null;
  const spec = IN_PLACE_TOOL_SPECS[tool];
  const seed: InPlaceEditSeed = {
    featureId: feature.featureId,
    nodeId: feature.id,
    name: feature.name,
    data,
    resultBodyId:
      feature.bodyId ??
      ('targetBodyId' in data ? data.targetBodyId : undefined),
    ownBodyIds: [
      ...(feature.bodyId ? [feature.bodyId] : []),
      ...(data.featureKind === 'split' ? [data.secondBodyId] : [])
    ],
    slots: {
      profiles: [],
      axisId: null,
      path: [],
      guide: [],
      faces: [],
      bodies: [],
      plane: null,
      edges: []
    },
    values: Object.fromEntries(spec.values.map((v) => [v.id, v.initial])),
    raws: {},
    touched: [],
    options: Object.fromEntries(
      (spec.options ?? []).map((option) => [option.id, option.initial])
    ),
    axes: [],
    choices: {},
    lockedOptions: [],
    notice: null
  };
  const missing: string[] = [];
  const value = (id: string, stored: ParamValue | undefined) => {
    if (stored === undefined) return;
    seed.touched.push(id);
    if (typeof stored === 'number') {
      seed.values[id] = stored;
      return;
    }
    seed.raws[id] = stored;
    const number = ctx.evaluate(stored);
    if (number !== null) seed.values[id] = number;
  };
  const repick: string[] = [];
  /** An ordered list's resolved entries, as {@link keptInOrder} keeps them. */
  const inOrder = <T>(entries: readonly (T | null)[], what: string): T[] => {
    const { kept, cleared } = keptInOrder(entries);
    if (cleared) repick.push(what);
    return kept;
  };
  const profile = (section: SketchSectionReference) => {
    const pick = ctx.profile(section.sketchId, section.profile);
    if (pick) seed.slots.profiles.push(pick);
    else missing.push('profile');
  };
  const faces = (
    bodyId: BodyId,
    hashes: readonly number[],
    references?: readonly FaceTopologyReferenceV5[]
  ) => {
    for (const [index, hash] of hashes.entries()) {
      // References run beside the hashes only when there is one per face.
      const reference =
        references?.length === hashes.length ? references[index] : undefined;
      const face = ctx.face(bodyId, hash, reference);
      if (face) seed.slots.faces.push(face);
      else missing.push('face');
    }
  };
  const body = (bodyId: BodyId) => {
    const picked = ctx.body(bodyId);
    if (picked) {
      seed.slots.bodies.push(picked);
      return;
    }
    // A body with no shape to measure: one a single-body command takes is
    // still named (any pick replaces it).
    seed.slots.bodies.push({
      bodyId,
      min: { x: 0, y: 0, z: 0 },
      max: { x: 0, y: 0, z: 0 }
    });
  };

  switch (data.featureKind) {
    case 'revolve': {
      if (data.profile) {
        profile({ sketchId: data.sketchId, profile: data.profile });
      } else {
        // Stored before profiles were: the sketch's first object, kept so.
        seed.slots.profiles.push({
          sketchId: data.sketchId,
          reference: { all: true, sourceEntityIds: [] },
          regionFingerprint: ctx.firstRegion(data.sketchId) ?? 0,
          implicit: true
        });
      }
      seed.slots.axisId = data.axisRef
        ? `datum:${data.axisRef.datumFeatureId}`
        : `sketch-${data.axis}`;
      value('angle', data.angleDeg ?? 360);
      break;
    }
    case 'loft': {
      seed.slots.profiles.push(
        ...inOrder(
          data.sections.map((section) => {
            const pick = ctx.profile(section.sketchId, section.profile);
            if (!pick) missing.push('profile');
            return pick;
          }),
          'sections'
        )
      );
      seed.options.shape = data.mode;
      if (data.endPoint) {
        // Its apex as stored, each coordinate on its own chip.
        seed.options.end = 'point';
        value('apexX', data.endPoint.x);
        value('apexY', data.endPoint.y);
        value('apexZ', data.endPoint.z);
      }
      break;
    }
    case 'sweep': {
      profile(data.profile);
      // Only curves the sketch still has: a deleted one would hold the slot
      // with a reference nothing can build, and the edit says to pick again.
      const curves = (
        sketchId: SketchId,
        entityIds: readonly string[],
        what: 'path' | 'guide'
      ) =>
        inOrder(
          entityIds.map((entityId) => {
            if (ctx.curve(sketchId, entityId)) return { sketchId, entityId };
            missing.push(what);
            return null;
          }),
          what
        );
      seed.slots.path = curves(data.path.sketchId, data.path.entityIds, 'path');
      seed.slots.guide = data.guide
        ? curves(data.guide.sketchId, data.guide.entityIds, 'guide')
        : [];
      seed.options.mode = data.mode;
      break;
    }
    case 'helical-sweep': {
      profile(data.profile);
      const origin = evaluated(data.axisOrigin, ctx);
      const direction = evaluated(data.axisDirection, ctx);
      if (origin && direction) {
        seed.axes.push({
          id: 'saved',
          label: 'Its saved axis',
          origin,
          direction,
          choice: { saved: true }
        });
        seed.slots.axisId = 'saved';
      } else {
        missing.push('axis');
      }
      // The stored axis on the typed chips too, for changing one part of it.
      for (const axis of ['x', 'y', 'z'] as const) {
        value(`axisO${axis.toUpperCase()}`, data.axisOrigin[axis]);
        value(`axisD${axis.toUpperCase()}`, data.axisDirection[axis]);
      }
      value('radius', data.radius);
      value('pitch', data.pitch);
      value('turns', data.turns);
      break;
    }
    case 'hole': {
      const face = ctx.face(
        data.targetBodyId,
        data.faceHash,
        data.faceReference
      );
      if (face) {
        // Its stored position is kept even when it does not resolve now;
        // the handles then stand on the face's anchor.
        const point =
          holeWorldPosition(face, data, ctx) ?? face.centroid ?? face.center;
        seed.slots.faces.push({
          ...face,
          ...(point ? { point } : {}),
          savedPosition: true
        });
      } else {
        missing.push('face');
      }
      value('diameter', data.diameter);
      value('depth', data.depth);
      value('counterboreDiameter', data.counterboreDiameter);
      value('counterboreDepth', data.counterboreDepth);
      value('countersinkDiameter', data.countersinkDiameter);
      value('countersinkAngleDeg', data.countersinkAngleDeg);
      // The stored position on the typed chips too, for setting it exactly.
      value('positionU', data.position.u);
      value('positionV', data.position.v);
      seed.options.depthMode = data.depthMode;
      seed.options.style = data.style;
      break;
    }
    case 'gear': {
      const pitchValue =
        data.sizing === 'diametral-pitch'
          ? 'diametralPitch'
          : data.sizing === 'circular-pitch'
            ? 'circularPitch'
            : 'module';
      seed.options.sizing = data.sizing;
      value(pitchValue, data.pitch);
      value('teeth', data.teeth);
      value('pressureAngleDeg', data.pressureAngleDeg);
      value('profileShift', data.profileShift);
      value('backlash', data.backlash);
      value('phaseDeg', data.phaseDeg);
      value('helixAngleDeg', data.helixAngleDeg);
      if (data.hand) seed.options.hand = data.hand;
      if (data.herringbone) seed.options.helix = 'herringbone';
      if (data.targetBodyId !== undefined) {
        const face =
          typeof data.faceHash === 'number'
            ? ctx.face(data.targetBodyId, data.faceHash, data.faceReference)
            : null;
        if (face) seed.slots.faces.push(face);
        else missing.push('face');
        seed.options.side = data.gearType === 'internal' ? 'inside' : 'outside';
        seed.options.fit = data.fit ?? 'keep-diameter';
        break;
      }
      seed.options.gearType = data.gearType;
      value('mateTeeth', data.mateTeeth);
      value('shaftAngleDeg', data.shaftAngleDeg);
      value('faceWidth', data.faceWidth);
      value('boreDiameter', data.boreDiameter);
      value('rimDiameter', data.rimDiameter);
      // The stored placement as a saved plane: kept as stored, expressions
      // and all, until another plane is picked.
      const resolved = (vector: ParametricVector3 | undefined) => {
        if (!vector) return null;
        const x = ctx.evaluate(vector.x);
        const y = ctx.evaluate(vector.y);
        const z = ctx.evaluate(vector.z);
        return x === null || y === null || z === null ? null : { x, y, z };
      };
      const origin = resolved(data.origin);
      const normal = resolved(data.axis);
      if (origin && normal && data.origin && data.axis) {
        const text = (vector: ParametricVector3) => ({
          x: String(vector.x),
          y: String(vector.y),
          z: String(vector.z)
        });
        seed.slots.plane = {
          kind: 'saved',
          origin,
          normal,
          fields: { origin: text(data.origin), normal: text(data.axis) }
        };
      } else {
        missing.push('plane');
      }
      break;
    }
    case 'shell':
      faces(
        data.targetBodyId,
        data.openingFaceHashes,
        data.openingFaceReferences
      );
      value('thickness', data.thickness);
      break;
    case 'thicken':
      faces(
        data.targetBodyId,
        [data.faceHash],
        data.faceReference ? [data.faceReference] : undefined
      );
      value('thickness', data.thickness);
      break;
    case 'solid-offset': {
      // Any face names the body; its first planar one carries the handle.
      const face = ctx.anyFace(data.targetBodyId);
      if (face) seed.slots.faces.push(face);
      else missing.push('face');
      value('distance', data.distance);
      break;
    }
    case 'draft': {
      faces(data.targetBodyId, data.faceHashes, data.faceReferences);
      value('angle', data.angleDeg);
      // A preset pull is its preset; any other is typed, part by part, as
      // stored. The hinge was worked out from a choice the feature does not
      // store, so it opens typed too.
      seed.options.pull = presetPull(data.pullDirection) ?? 'custom';
      seed.options.neutral = 'custom';
      for (const axis of ['x', 'y', 'z'] as const) {
        value(`pull${axis.toUpperCase()}`, data.pullDirection[axis]);
        value(`neutral${axis.toUpperCase()}`, data.neutralPoint[axis]);
      }
      break;
    }
    case 'mirror':
    case 'split': {
      body(data.targetBodyId);
      if (isDatumPlaneRef(data.plane)) {
        // A datum plane gone, or now after the feature, is not restored:
        // the slot asks for another, as a clicked one would be refused.
        if (ctx.datumPlaneUsable?.(data.plane.datumFeatureId) === false) {
          missing.push('plane');
        } else {
          seed.slots.plane = {
            kind: 'datum',
            featureId: data.plane.datumFeatureId
          };
        }
      } else {
        // A plane stored by its numbers opens typed, each on its own chip,
        // expressions and all: the way it was given is the way it is edited.
        seed.options.planeMode = 'typed';
        for (const axis of ['x', 'y', 'z'] as const) {
          value(`planeO${axis.toUpperCase()}`, data.plane.origin[axis]);
          value(`planeN${axis.toUpperCase()}`, data.plane.normal[axis]);
        }
      }
      value('offset', 0);
      if (data.featureKind === 'split') {
        seed.options.keepOriginal = data.keepOriginal ? 'yes' : 'no';
      }
      break;
    }
    case 'boolean': {
      // A body with no shape to measure is left for a new pick: in a list
      // nothing could click it back out.
      seed.slots.bodies.push(
        ...inOrder(
          data.targetBodyIds.map((bodyId) => {
            const picked = ctx.body(bodyId);
            if (!picked) missing.push('body');
            return picked;
          }),
          'bodies'
        )
      );
      seed.options.operation = data.operation;
      seed.options.keepOriginals = data.keepOriginals ?? 'none';
      break;
    }
    case 'transform': {
      const picked = ctx.body(data.targetBodyId);
      if (tool === 'scale') {
        value('factor', data.transform.scale);
        // The pivot as stored: typed, part by part, or (absent) the origin.
        const pivot = data.transform.pivot;
        seed.options.pivot = pivot ? 'typed' : 'origin';
        if (pivot) {
          value('pivotX', pivot.x);
          value('pivotY', pivot.y);
          value('pivotZ', pivot.z);
        }
        // The box shown is the body's after the scale: the handle works on
        // the body before it, about the pivot the feature stores.
        const factor = seed.values.factor ?? 1;
        // A copy leaves its source as it was, but a later in-place step may
        // still have moved it: the box is taken back through those alone.
        seed.slots.bodies.push(
          picked && factor > 0
            ? inPlaceEditBodyBox(
                picked,
                data,
                ctx,
                ctx.laterTransforms ?? [],
                !isFeatureSuppressed(feature)
              )
            : (picked ?? {
                bodyId: data.targetBodyId,
                min: { x: 0, y: 0, z: 0 },
                max: { x: 0, y: 0, z: 0 }
              })
        );
      } else if (data.axisRotation) {
        seed.slots.axisId = `datum:${data.axisRotation.axis.datumFeatureId}`;
        value('angle', data.axisRotation.angleDeg);
        // The model shows the body turned: the angle's rig works from the
        // body before the turn (a copy's source was never turned by it, but
        // may have been by a later step).
        seed.slots.bodies.push(
          picked
            ? inPlaceEditBodyBox(
                picked,
                data,
                ctx,
                ctx.laterTransforms ?? [],
                !isFeatureSuppressed(feature)
              )
            : (picked ?? {
                bodyId: data.targetBodyId,
                min: { x: 0, y: 0, z: 0 },
                max: { x: 0, y: 0, z: 0 }
              })
        );
      } else {
        body(data.targetBodyId);
      }
      // A copy owns its own body: an edit cannot turn it into a Move, or
      // back, so the choice is shown as it is and not offered.
      seed.options.copy = data.copy ? 'yes' : 'no';
      seed.lockedOptions.push('copy');
      break;
    }
    case 'fillet':
    case 'chamfer': {
      // The stored edge set, in its order, each with the lineage name it was
      // stored with (or none): an untouched edit writes the same set back.
      const named = data.edgeReferences?.length === data.edgeHashes.length;
      data.edgeHashes.forEach((hash, index) => {
        const stored = named ? data.edgeReferences![index]! : undefined;
        const edge = ctx.edge(data.targetBodyId, hash, stored);
        // An edge that no longer resolves is left out, as a face or a path
        // curve is: a click then picks its replacement rather than adding
        // to a set nothing can build.
        if (!edge) {
          missing.push('edge');
          return;
        }
        const { reference: _current, ...placed } = edge;
        // Placed where the edge is now (found by name if its hash moved),
        // but stored back as it was stored.
        seed.slots.edges.push({
          ...placed,
          hash,
          ...(stored ? { reference: stored } : {})
        });
      });
      if (data.featureKind === 'fillet') {
        value('radius', data.radius);
        if (data.endRadius !== undefined) {
          value('endRadius', data.endRadius);
          seed.options.law = data.radiusLaw ?? 'linear';
        } else {
          seed.options.law = 'constant';
        }
      } else {
        value('distance', data.distance);
        if (data.angleDeg !== undefined) {
          value('angle', data.angleDeg);
          seed.options.shape = 'angle';
        } else if (data.distance2 !== undefined) {
          value('distance2', data.distance2);
          seed.options.shape = 'two';
        } else {
          seed.options.shape = 'equal';
        }
      }
      break;
    }
    case 'pattern': {
      body(data.targetBodyId);
      value('count', data.count);
      if (data.patternKind === 'linear') {
        value('spacing', data.spacing);
        if (data.direction) {
          // Its repeat vector as stored, each part on its own chip.
          seed.options.axis = 'custom';
          value('dirX', data.direction.x);
          value('dirY', data.direction.y);
          value('dirZ', data.direction.z);
        } else {
          seed.options.axis = data.axis;
        }
      } else if (data.patternKind === 'circular') {
        value('angle', data.angleDeg);
        // Stored as a total: a switch to Fixed step starts from the step the
        // copies stand at now.
        const total = seed.values.angle;
        const count =
          typeof data.count === 'number'
            ? data.count
            : ctx.evaluate(data.count);
        if (total !== undefined && count !== null && count >= 2) {
          seed.values.step =
            Math.abs(Math.abs(total) - 360) <= 1e-9
              ? total / count
              : total / (count - 1);
        }
        seed.slots.axisId = data.axisRef
          ? `datum:${data.axisRef.datumFeatureId}`
          : `world-${data.axis}`;
      } else {
        value('spacing', data.spacing);
        // Absent, the second spacing and count follow the first's (the
        // tool's defaults), not a copy of them that an edit would leave
        // behind.
        value('spacing2', data.spacing2);
        value('count2', data.count2);
        seed.options.axis = data.axis;
        seed.options.axis2 = data.axis2 ?? 'y';
      }
      break;
    }
    default:
      return null;
  }
  if (tool === 'scale' && ctx.laterReshapes) {
    seed.reshapedLater = true;
    seed.notice = `${feature.name}: a later edit reshapes this body · type the factor on its chip.`;
  }
  if (missing.length > 0) {
    const what = [...new Set(missing)].join(' and ');
    seed.notice =
      repick.length > 0
        ? `${feature.name}: its saved ${what} no longer resolves · pick its ${repick.join(' and ')} again, in order.`
        : `${feature.name}: its saved ${what} no longer resolves · pick it again.`;
  }
  return { tool, seed };
}

function evaluated(
  vector: ParametricVector3,
  ctx: InPlaceEditContext
): Vector3 | null {
  const x = ctx.evaluate(vector.x);
  const y = ctx.evaluate(vector.y);
  const z = ctx.evaluate(vector.z);
  return x === null || y === null || z === null ? null : { x, y, z };
}

const PRESET_PULLS: Record<string, [number, number, number]> = {
  '+Z': [0, 0, 1],
  '-Z': [0, 0, -1],
  '+X': [1, 0, 0],
  '-X': [-1, 0, 0],
  '+Y': [0, 1, 0],
  '-Y': [0, -1, 0]
};

/** The Options preset a stored pull is, written as plain numbers; else null. */
function presetPull(pull: ParametricVector3): string | null {
  const stored = [pull.x, pull.y, pull.z];
  if (!stored.every((part) => typeof part === 'number')) return null;
  for (const [name, preset] of Object.entries(PRESET_PULLS)) {
    if (preset.every((part, index) => part === stored[index])) return name;
  }
  return null;
}

/** Where a stored hole stands on its face, in world space. */
/** Where a stored hole stands on `face`: its saved position, in the world. */
export function holeWorldPosition(
  face: FacePick,
  data: Extract<FeatureData, { featureKind: 'hole' }>,
  ctx: Pick<InPlaceEditContext, 'evaluate'>
): Vector3 | null {
  const anchor =
    data.positionAnchor === 'centroid'
      ? (face.centroid ?? face.center)
      : (face.center ?? face.centroid);
  const axes = face.normal ? holePositionAxes(face.normal) : null;
  const u = ctx.evaluate(data.position.u);
  const v = ctx.evaluate(data.position.v);
  if (!anchor || !axes || u === null || v === null) return null;
  return {
    x: anchor.x + axes.u.x * u + axes.v.x * v,
    y: anchor.y + axes.u.y * u + axes.v.y * v,
    z: anchor.z + axes.u.z * u + axes.v.z * v
  };
}

/** `point` turned `angleDeg` about `line` (Rodrigues). */
function turnPoint(
  point: Vector3,
  line: { origin: Vector3; direction: Vector3 },
  angleDeg: number
): Vector3 {
  const length = Math.hypot(
    line.direction.x,
    line.direction.y,
    line.direction.z
  );
  if (!(length > 0)) return point;
  const k = {
    x: line.direction.x / length,
    y: line.direction.y / length,
    z: line.direction.z / length
  };
  const angle = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const v = {
    x: point.x - line.origin.x,
    y: point.y - line.origin.y,
    z: point.z - line.origin.z
  };
  const dot = k.x * v.x + k.y * v.y + k.z * v.z;
  const cross = {
    x: k.y * v.z - k.z * v.y,
    y: k.z * v.x - k.x * v.z,
    z: k.x * v.y - k.y * v.x
  };
  return {
    x: line.origin.x + v.x * cos + cross.x * sin + k.x * dot * (1 - cos),
    y: line.origin.y + v.y * cos + cross.y * sin + k.y * dot * (1 - cos),
    z: line.origin.z + v.z * cos + cross.z * sin + k.z * dot * (1 - cos)
  };
}

function boxCorners(body: BodyPick): Vector3[] {
  return [0, 1, 2, 3, 4, 5, 6, 7].map((bits) => ({
    x: bits & 1 ? body.max.x : body.min.x,
    y: bits & 2 ? body.max.y : body.min.y,
    z: bits & 4 ? body.max.z : body.min.z
  }));
}

/** The box around `points`, rounded off float noise (never a −0). */
function boxOf(bodyId: BodyId, points: readonly Vector3[]): BodyPick {
  const round = (value: number) => Math.round(value * 1e9) / 1e9 + 0;
  const extreme = (
    axis: 'x' | 'y' | 'z',
    pick: (...values: number[]) => number
  ) => round(pick(...points.map((point) => point[axis])));
  return {
    bodyId,
    min: {
      x: extreme('x', Math.min),
      y: extreme('y', Math.min),
      z: extreme('z', Math.min)
    },
    max: {
      x: extreme('x', Math.max),
      y: extreme('y', Math.max),
      z: extreme('z', Math.max)
    }
  };
}

const AXIS_DIRECTIONS = {
  x: { x: 1, y: 0, z: 0 },
  y: { x: 0, y: 1, z: 0 },
  z: { x: 0, y: 0, z: 1 }
} as const;

/**
 * The `updateFeature` patch an edit's request writes, for every request but
 * a face operation's and a fillet's or chamfer's (App runs those through the
 * cards' own builders, `modelingFeatureUpdate` and `edgeModifierCommand`). Keys the command does not show are left out, so
 * the patch keeps them as stored. A picked axis is the datum App adds for it
 * first (`resolveNewAxis`).
 */
export function inPlaceFeatureUpdate(
  seed: Pick<InPlaceEditSeed, 'featureId' | 'name' | 'data'>,
  request: Exclude<
    ResolvedInPlaceRequest,
    { tool: 'modeling' | 'edge-modifier' }
  >
): FeatureUpdateInput | null {
  const { featureId, name, data: saved } = seed;
  switch (request.tool) {
    case 'revolve': {
      if (saved.featureKind !== 'revolve') return null;
      const datum =
        'datumFeatureId' in request.axis ? request.axis.datumFeatureId : null;
      // A stored angle cannot be cleared, so a full turn is written as 360
      // once one is stored; a revolve that never had one keeps it absent.
      const angle =
        request.angleDeg ?? (saved.angleDeg === undefined ? undefined : 360);
      const clear = [
        ...(datum ? [] : ['axisRef']),
        ...(request.profile === undefined && saved.profile !== undefined
          ? ['profile']
          : [])
      ];
      return {
        featureId,
        name,
        data: {
          featureKind: 'revolve',
          sketchId: request.sketchId,
          // A datum axis leaves the sketch axis it replaces as stored.
          ...('axis' in request.axis ? { axis: request.axis.axis } : {}),
          ...(datum
            ? { axisRef: { type: 'datum-axis', datumFeatureId: datum } }
            : {}),
          ...(angle === undefined ? {} : { angleDeg: angle }),
          ...(request.profile ? { profile: request.profile } : {})
        },
        ...(clear.length > 0 ? { clearData: clear } : {})
      };
    }
    case 'loft':
      return {
        featureId,
        name,
        data: {
          featureKind: 'loft',
          sections: request.sections,
          mode: request.mode,
          ...(request.endPoint ? { endPoint: request.endPoint } : {})
        },
        ...(request.endPoint ? {} : { clearData: ['endPoint'] })
      };
    case 'sweep':
      return {
        featureId,
        name,
        data: {
          featureKind: 'sweep',
          profile: request.profile,
          path: {
            sketchId: request.path.sketchId,
            entityIds: request.path.entityIds
          } as Extract<FeatureData, { featureKind: 'sweep' }>['path'],
          mode: request.mode,
          ...(request.guide
            ? {
                guide: {
                  sketchId: request.guide.sketchId,
                  entityIds: request.guide.entityIds
                } as Extract<FeatureData, { featureKind: 'sweep' }>['path']
              }
            : {})
        },
        ...(request.guide ? {} : { clearData: ['guide'] })
      };
    case 'gear': {
      if (saved.featureKind !== 'gear') return null;
      // Optional fields the edit no longer sets go back to their defaults.
      const optional = [
        'pitch',
        'pressureAngleDeg',
        'profileShift',
        'backlash',
        'phaseDeg',
        'helixAngleDeg',
        'hand',
        'herringbone',
        'mateTeeth',
        'shaftAngleDeg',
        'xDirection',
        'boreDiameter',
        'rimDiameter',
        'fit'
      ] as const;
      const clear = optional.filter(
        (key) => saved[key] !== undefined && request.gear[key] === undefined
      );
      return {
        featureId,
        name,
        data: { featureKind: 'gear', ...request.gear },
        ...(clear.length > 0 ? { clearData: [...clear] } : {})
      };
    }
    case 'helical-sweep':
      return {
        featureId,
        name,
        data: {
          featureKind: 'helical-sweep',
          profile: request.profile,
          axisOrigin: request.axisOrigin,
          axisDirection: request.axisDirection,
          radius: request.radius,
          pitch: request.pitch,
          turns: request.turns
        }
      };
    case 'boolean':
      return {
        featureId,
        name,
        data: {
          featureKind: 'boolean',
          operation: request.operation,
          targetBodyIds: request.targetBodyIds,
          ...(request.keepOriginals
            ? { keepOriginals: request.keepOriginals }
            : {})
        },
        // M11: consuming every input is the absent field.
        ...(request.keepOriginals ? {} : { clearData: ['keepOriginals'] })
      };
    case 'transform': {
      if (saved.featureKind !== 'transform') return null;
      // The stored transform stands; the edit changes a scale's factor and
      // pivot (the origin is the absent one) or a turn.
      const { pivot: _pivot, ...unpivoted } = saved.transform;
      return {
        featureId,
        name,
        data: {
          featureKind: 'transform',
          targetBodyId: request.targetBodyId,
          transform:
            request.scale !== undefined
              ? {
                  ...unpivoted,
                  scale: request.scale,
                  ...(request.pivot ? { pivot: request.pivot } : {})
                }
              : saved.transform,
          ...(request.axisRotation
            ? { axisRotation: request.axisRotation }
            : {})
        }
      };
    }
    case 'pattern': {
      if (saved.featureKind !== 'pattern') return null;
      // A stored repeat vector cannot be cleared: choosing a world axis
      // instead writes that axis as the vector.
      const direction =
        request.direction ??
        (saved.direction && request.patternKind === 'linear'
          ? { ...AXIS_DIRECTIONS[request.axis] }
          : undefined);
      return {
        featureId,
        name,
        data: {
          featureKind: 'pattern',
          targetBodyId: request.targetBodyId,
          patternKind: request.patternKind,
          count: request.count,
          // A datum axis leaves the world axis it replaces as stored.
          ...(request.patternKind === 'circular' && request.axisRef
            ? {}
            : { axis: request.axis }),
          ...(request.spacing !== undefined
            ? { spacing: request.spacing }
            : {}),
          ...(request.angleDeg !== undefined
            ? { angleDeg: request.angleDeg }
            : {}),
          ...(direction ? { direction } : {}),
          // A grid's second direction left absent reads as Y, its spacing
          // and count as the first's: while the edit still says so, it stays
          // absent, so an untouched Done writes the pattern back as stored.
          ...(request.axis2 !== undefined &&
          !(saved.axis2 === undefined && request.axis2 === 'y')
            ? { axis2: request.axis2 }
            : {}),
          // A second spacing or count still following the first is not in
          // the request (see the grid tool), so it stays absent.
          ...(request.spacing2 !== undefined
            ? { spacing2: request.spacing2 }
            : {}),
          ...(request.count2 !== undefined ? { count2: request.count2 } : {}),
          ...(request.axisRef ? { axisRef: request.axisRef } : {})
        },
        // R01: the world axis is the absent datum axis.
        ...(request.axisRef || request.patternKind !== 'circular'
          ? {}
          : { clearData: ['axisRef'] })
      };
    }
    default:
      // A datum or a picture edits in its own card, not in place.
      return null;
  }
}

/**
 * The sketches a feature was built from, as it stores them: an edit shows
 * them even when a saved pick no longer resolves, since that is when the
 * replacement has to be clicked.
 */
export function inPlaceEditSourceSketchIds(data: FeatureData): SketchId[] {
  switch (data.featureKind) {
    case 'revolve':
      return [data.sketchId];
    case 'loft':
      return data.sections.map((section) => section.sketchId);
    case 'sweep':
      return [
        data.profile.sketchId,
        data.path.sketchId,
        ...(data.guide ? [data.guide.sketchId] : [])
      ];
    case 'helical-sweep':
      return [data.profile.sketchId];
    // The in-place Extrude edits an extrude (U09): its profile's sketch.
    case 'extrude':
      return [data.sketchId];
    default:
      return [];
  }
}

/** Features that reshape the one body they take, adding no other's material. */
const SINGLE_LINEAGE_KINDS = new Set<FeatureData['featureKind']>([
  'fillet',
  'chamfer',
  'hole',
  'shell',
  'draft',
  'thicken',
  'solid-offset',
  'split',
  'transform',
  'mirror',
  'pattern',
  'direct-edit'
]);

function bodyInputs(data: FeatureData): BodyId[] {
  if ('targetBodyIds' in data) return [...data.targetBodyIds];
  return 'targetBodyId' in data && data.targetBodyId ? [data.targetBodyId] : [];
}

/**
 * The bodies an edited feature's result became: its own, and every body a
 * later feature built from them. `mixed` are those another body's material
 * joined on the way (a union, an extrude added into it), whose faces may
 * have come from that other body; `pure` are the rest.
 */
export function inPlaceEditLineage(
  document: ProjectDocument,
  featureId: FeatureId,
  ownBodyIds: readonly BodyId[]
): { pure: Set<BodyId>; mixed: Set<BodyId> } {
  const history = featureHistory(document);
  const pure = new Set<BodyId>(ownBodyIds);
  const mixed = new Set<BodyId>();
  const feature = history.features.find(
    (candidate) => candidate.featureId === featureId
  );
  if (!feature) return { pure, mixed };
  for (const bodyId of featureResultBodyIds(feature)) pure.add(bodyId);
  for (const later of history.downstream(featureId)) {
    const inputs = bodyInputs(later.data);
    const fromLineage = inputs.filter(
      (bodyId) => pure.has(bodyId) || mixed.has(bodyId)
    );
    // Built from the result only through a sketch or a datum: not its body.
    if (fromLineage.length === 0) continue;
    const joined =
      !SINGLE_LINEAGE_KINDS.has(later.data.featureKind) ||
      fromLineage.length < inputs.length ||
      fromLineage.some((bodyId) => mixed.has(bodyId));
    for (const bodyId of featureResultBodyIds(later)) {
      (joined ? mixed : pure).add(bodyId);
    }
  }
  return { pure, mixed };
}

/**
 * A transform written to change nothing (a Scale of 1, a Move of zero, a
 * turn of 0°): its body stands where it was. A stored expression may say
 * otherwise, so only plain zeros and ones count.
 */
function isIdentityTransform(data: FeatureData): boolean {
  if (data.featureKind !== 'transform') return false;
  const zero = (part: ParamValue) => part === 0 || part === '0';
  const still = (vector: ParametricVector3) =>
    zero(vector.x) && zero(vector.y) && zero(vector.z);
  const { translation, rotationDeg, scale } = data.transform;
  return (
    still(translation) &&
    still(rotationDeg) &&
    (scale === undefined || scale === 1 || scale === '1') &&
    (!data.axisRotation || zero(data.axisRotation.angleDeg))
  );
}

/**
 * The bodies a later feature moved from where `featureId` made them: a
 * transform (in place or a copy), a mirror, a pattern, and anything built
 * on one of those. A click on one of them does not land where the edited
 * feature's own face stands, so a hole edit cannot take its point.
 */
export function inPlaceEditMovedBodies(
  document: ProjectDocument,
  featureId: FeatureId
): Set<BodyId> {
  const history = featureHistory(document);
  const moving = new Set<FeatureId>();
  const moved = new Set<BodyId>();
  for (const later of history.downstream(featureId)) {
    // A suppressed step moved nothing: its body is shown where it was.
    if (isFeatureSuppressed(later)) continue;
    const kind = later.data.featureKind;
    if (
      (kind === 'transform' && !isIdentityTransform(later.data)) ||
      kind === 'mirror' ||
      kind === 'pattern' ||
      [...(history.parents.get(later.featureId) ?? [])].some((parent) =>
        moving.has(parent)
      )
    ) {
      moving.add(later.featureId);
      for (const bodyId of featureResultBodyIds(later)) moved.add(bodyId);
    }
  }
  return moved;
}

/**
 * An ordered list (a loft's sections, a path, a boolean's inputs) with its
 * unresolved entries as null. A new pick is appended, so the list is kept
 * only while every gap is at its end; a gap before a kept entry would put
 * its replacement out of place, so the whole list is cleared to be picked
 * again in order.
 */
export function keptInOrder<T>(entries: readonly (T | null)[]): {
  kept: T[];
  cleared: boolean;
} {
  const gap = entries.indexOf(null);
  if (gap === -1) return { kept: entries as T[], cleared: false };
  if (entries.slice(gap).some((entry) => entry !== null)) {
    return { kept: [], cleared: true };
  }
  return { kept: entries.slice(0, gap) as T[], cleared: false };
}

/**
 * The features after a transform that may act on its body: downstream of
 * it, or for a copy (which never republishes its source) after it in
 * history.
 */
function laterOnTransformBody(
  current: ProjectDocument,
  feature: FeatureNode
): FeatureNode[] {
  // A copy does not republish its source, so the source's later steps are
  // not downstream of it: they are those after it in history.
  if (feature.data.featureKind === 'transform' && feature.data.copy) {
    const order = listFeaturesInOrder(current);
    return order.slice(
      order.findIndex(
        (candidate) => candidate.featureId === feature.featureId
      ) + 1
    );
  }
  return featureHistory(current).downstream(feature.featureId);
}

/**
 * The in-place moves and scales after `feature` on the body it edits, in
 * history order: the model shows that body after them.
 */
export function laterInPlaceSteps(
  current: ProjectDocument,
  feature: FeatureNode
): FeatureData[] {
  const data = feature.data;
  if (data.featureKind !== 'transform') return [];
  return laterOnTransformBody(current, feature).flatMap((later) =>
    isInPlaceTransform(later.data) &&
    later.data.targetBodyId === data.targetBodyId &&
    !isFeatureSuppressed(later)
      ? [later.data]
      : []
  );
}

/**
 * Whether a later direct edit republishes a transform's body reshaped, so
 * the model's body cannot be taken back to the one before the transform.
 */
export function laterDirectEdit(
  current: ProjectDocument,
  feature: FeatureNode
): boolean {
  const data = feature.data;
  if (data.featureKind !== 'transform') return false;
  return laterOnTransformBody(current, feature).some(
    (later) =>
      later.data.featureKind === 'direct-edit' &&
      later.data.targetBodyId === data.targetBodyId &&
      !isFeatureSuppressed(later)
  );
}

/**
 * The in-place moves and scales of `bodyId` after `feature` in history: a
 * body an edit is retargeted to is shown after them, and the edited
 * feature acts on it before them.
 */
export function laterStepsOnBody(
  document: ProjectDocument,
  feature: FeatureNode,
  bodyId: BodyId
): FeatureData[] {
  const order = listFeaturesInOrder(document);
  return order
    .slice(
      order.findIndex(
        (candidate) => candidate.featureId === feature.featureId
      ) + 1
    )
    .flatMap((later) =>
      isInPlaceTransform(later.data) &&
      later.data.targetBodyId === bodyId &&
      !isFeatureSuppressed(later)
        ? [later.data]
        : []
    );
}

/**
 * Whether an unsuppressed direct edit of `bodyId` comes after `feature` in
 * history: a body an edit is retargeted to then cannot be taken back to the
 * one the feature acts on.
 */
export function laterDirectEditOnBody(
  document: ProjectDocument,
  feature: FeatureNode,
  bodyId: BodyId
): boolean {
  const order = listFeaturesInOrder(document);
  return order
    .slice(
      order.findIndex(
        (candidate) => candidate.featureId === feature.featureId
      ) + 1
    )
    .some(
      (later) =>
        later.data.featureKind === 'direct-edit' &&
        later.data.targetBodyId === bodyId &&
        !isFeatureSuppressed(later)
    );
}

/** A hole's step sizes, which an absent value derives from its bore. */
const HOLE_STEP_KEYS: readonly string[] = [
  'counterboreDiameter',
  'counterboreDepth',
  'countersinkDiameter',
  'countersinkAngleDeg'
];

/**
 * A hole edit's update with the step sizes it never stored left out, unless
 * the user has set them since: an absent size follows the bore, and storing
 * the size it derives today would pin it there.
 */
export function keepAbsentHoleSteps(
  update: FeatureUpdateInput,
  saved: FeatureData,
  touched: readonly string[]
): FeatureUpdateInput {
  if (saved.featureKind !== 'hole') return update;
  const stored = saved as unknown as Record<string, unknown>;
  return {
    ...update,
    data: Object.fromEntries(
      Object.entries(update.data as Record<string, unknown>).filter(
        ([key]) =>
          !HOLE_STEP_KEYS.includes(key) ||
          stored[key] !== undefined ||
          touched.includes(key)
      )
    )
  };
}

/**
 * The box an edit's body slot holds for `box`, the body as the model shows
 * it: as it is, except under an in-place transform (a scale, a turn about an
 * axis), whose handle works on the body before it (a copy's source is shown
 * as it was). Later in-place transforms of the same body (`later`, in
 * history order) are taken back first, since the model shows the body after
 * them too. With the body's vertices (`ctx.bodyVertices`) the box is exact;
 * from its box alone, a turn gives a box that still holds the body.
 */
export function inPlaceEditBodyBox(
  box: BodyPick,
  data: FeatureData,
  ctx: Pick<InPlaceEditContext, 'evaluate' | 'datumAxis' | 'bodyVertices'>,
  later: readonly FeatureData[] = [],
  /** The feature's own transform is in the body shown (not suppressed). */
  shownWithOwn = true
): BodyPick {
  if (data.featureKind !== 'transform') return box;
  // A copy never transformed its source: only the later steps are undone.
  const own = shownWithOwn && !data.copy;
  // The body's own vertices where it publishes them: taken back through a
  // turn they give its true box, where a turned box's corners only give a
  // box around it.
  const vertices = ctx.bodyVertices?.(box.bodyId);
  let points: Vector3[] = [];
  if (vertices && vertices.length >= 3) {
    for (let index = 0; index + 2 < vertices.length; index += 3) {
      points.push({
        x: vertices[index]!,
        y: vertices[index + 1]!,
        z: vertices[index + 2]!
      });
    }
  } else {
    points = boxCorners(box);
  }
  // Newest first: the later steps, then the feature's own.
  if (later.length === 0 && !own) return box;
  const steps = [...[...later].reverse(), ...(own ? [data] : [])];
  for (const step of steps) {
    points = undoTransformPoints(points, step, ctx) ?? points;
  }
  return boxOf(box.bodyId, points);
}

/**
 * Points before an in-place transform: each taken back through the
 * authored move (x ↦ s·R(x − p) + p + t, R the ZYX turn), then through a
 * turn about a datum axis, which the transform makes first. Null when a
 * part cannot be read (an unresolved expression, an axis not built).
 */
function undoTransformPoints(
  points: readonly Vector3[],
  step: FeatureData,
  ctx: Pick<InPlaceEditContext, 'evaluate' | 'datumAxis'>
): Vector3[] | null {
  if (step.featureKind !== 'transform' || step.copy) return null;
  const turn = evaluated(step.transform.rotationDeg, ctx as InPlaceEditContext);
  const move = evaluated(step.transform.translation, ctx as InPlaceEditContext);
  const factor =
    step.transform.scale === undefined ? 1 : ctx.evaluate(step.transform.scale);
  if (!turn || !move || factor === null || !(factor > 0)) return null;
  const pivot = (step.transform.pivot &&
    evaluated(step.transform.pivot, ctx as InPlaceEditContext)) ?? {
    x: 0,
    y: 0,
    z: 0
  };
  let axisTurn: {
    line: { origin: Vector3; direction: Vector3 };
    angle: number;
  } | null = null;
  if (step.axisRotation) {
    const line = ctx.datumAxis?.(step.axisRotation.axis.datumFeatureId);
    const angle = ctx.evaluate(step.axisRotation.angleDeg);
    if (!line || angle === null) return null;
    axisTurn = { line, angle };
  }
  const [rx, ry, rz] = [turn.x, turn.y, turn.z].map(
    (degrees) => (degrees * Math.PI) / 180
  ) as [number, number, number];
  const [ca, sa, cb, sb, cc, sc] = [
    Math.cos(rx),
    Math.sin(rx),
    Math.cos(ry),
    Math.sin(ry),
    Math.cos(rz),
    Math.sin(rz)
  ];
  // R = Rz·Ry·Rx, row by row, as the kernel's transform builds it.
  const rotation = [
    [cc * cb, cc * sb * sa - sc * ca, cc * sb * ca + sc * sa],
    [sc * cb, sc * sb * sa + cc * ca, sc * sb * ca - cc * sa],
    [-sb, cb * sa, cb * ca]
  ];
  const back = (point: Vector3): Vector3 => {
    const v = [
      (point.x - pivot.x - move.x) / factor,
      (point.y - pivot.y - move.y) / factor,
      (point.z - pivot.z - move.z) / factor
    ];
    // Rᵀ·v: a rotation's inverse is its transpose.
    const column = (index: number) =>
      rotation[0]![index]! * v[0]! +
      rotation[1]![index]! * v[1]! +
      rotation[2]![index]! * v[2]!;
    const unmoved = {
      x: column(0) + pivot.x,
      y: column(1) + pivot.y,
      z: column(2) + pivot.z
    };
    return axisTurn
      ? turnPoint(unmoved, axisTurn.line, -axisTurn.angle)
      : unmoved;
  };
  return points.map(back);
}

/**
 * `document` with `featureId` built even if suppressed: an edit of a
 * suppressed feature previews what it would build, so the same exact
 * rebuild that refuses a bad value when it is turned back on refuses it
 * now. Only the preview: the edit itself leaves the feature suppressed.
 */
export function withFeatureBuilt(
  document: ProjectDocument,
  featureId: FeatureId
): ProjectDocument {
  const node = Object.values(document.nodes).find(
    (candidate) =>
      candidate.kind === 'feature' && candidate.featureId === featureId
  );
  if (!node || node.kind !== 'feature' || !isFeatureSuppressed(node)) {
    return document;
  }
  const {
    [FEATURE_SUPPRESSED_METADATA_KEY]: _suppressed,
    [FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY]: _rolledBack,
    ...metadata
  } = node.metadata ?? {};
  return {
    ...document,
    nodes: { ...document.nodes, [node.id]: { ...node, metadata } }
  };
}
