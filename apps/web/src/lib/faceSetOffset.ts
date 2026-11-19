import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import {
  ownEntry,
  type BodyId,
  type BodyRepresentation,
  type FaceTopology,
  type OffsetFaceSnapshot,
  type ParamValue,
  type ProjectDocument,
  type TopologySelection,
  type Vector3
} from '@openzcad/shared';
import type { OffsetFaceSetMember } from './interaction/machine';
import { resolveSelectionTopology } from './selectionFeature';

/**
 * M07: a picked set of coplanar faces offset together, as one replayable
 * `offset-faces` direct edit. The set's Offset verb arms the single-face
 * offset handle on the last-picked face and carries the other faces with it;
 * this module checks the set, names its refusals, and builds the edit.
 */

/** The most faces one `offset-faces` edit takes (the kernel's own bound). */
export const MAX_OFFSET_SET_FACES = 64;

/**
 * Refusals for a set the workspace does not offset together, said before any
 * handle appears. A set whose faces do not all face the same way is refused
 * in the kernel's own words. Parallel faces at different heights the kernel
 * now chains (M07), but the workspace keeps them to one plane until its
 * shared handle and preview cover a chained move, so that refusal is the
 * workspace's own.
 */
export const OFFSET_SET_NOT_SAME_NORMAL =
  'Offset moves a set of faces together only when they all face the same way, and the selected faces face different directions. Offset them one at a time.';
export const OFFSET_SET_NOT_COPLANAR =
  'The selected faces are parallel but at different heights. Offsetting them together is not in the workspace yet; offset them one at a time.';

const NORMAL_TOLERANCE = 1e-6;

function dot(a: Vector3, b: Vector3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function unit(vector: Vector3): Vector3 | null {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  return length > 1e-12
    ? { x: vector.x / length, y: vector.y / length, z: vector.z / length }
    : null;
}

/** A planar face of the set, resolved on its body as it is now. */
interface ResolvedSetFace {
  face: FaceTopology;
  normal: Vector3;
}

/** The picked faces resolved on `body`, in pick order, or why they cannot be. */
function resolveSet(
  body: BodyRepresentation | undefined,
  selections: readonly TopologySelection[]
): ResolvedSetFace[] | string {
  if (selections.length < 2) {
    return 'Select two or more faces to offset them together.';
  }
  const bodyId = selections[0]!.bodyId;
  if (selections.some((selection) => selection.bodyId !== bodyId)) {
    return 'Faces on different bodies cannot be offset together. Select faces on one body.';
  }
  if (selections.length > MAX_OFFSET_SET_FACES) {
    return `Offset moves at most ${MAX_OFFSET_SET_FACES} faces together.`;
  }
  if (!body || body.consumed) return 'Select faces on a current body.';
  const resolved: ResolvedSetFace[] = [];
  for (const selection of selections) {
    const pick =
      selection.kind === 'face'
        ? resolveSelectionTopology(body, selection)
        : null;
    const face =
      pick?.kind === 'face'
        ? body.topology?.faces.find(
            (candidate) => candidate.topologyId === pick.topologyId
          )
        : undefined;
    if (!face?.geometry) {
      return 'A selected face is no longer on the model. Select the faces again.';
    }
    const normal =
      face.geometry.surfaceType === 'plane' && face.geometry.normal
        ? unit(face.geometry.normal)
        : null;
    if (!normal) {
      return 'Offset moves flat faces together. Select only flat faces.';
    }
    resolved.push({ face, normal });
  }
  if (
    new Set(resolved.map((entry) => entry.face.topologyId)).size !==
    resolved.length
  ) {
    return 'The same face is selected twice. Select the faces again.';
  }
  return resolved;
}

/**
 * Why the set's Offset verb cannot be offered at all (several bodies, a
 * curved face, too many faces), or null. A set that is flat but not one
 * plane is offered, and refused by name when it is chosen.
 */
export function faceSetOffsetUnavailable(
  document: ProjectDocument,
  selections: readonly TopologySelection[]
): string | null {
  const bodyId = selections[0]?.bodyId;
  const body = bodyId
    ? ownEntry(document.derived.bodyRepresentations, bodyId)
    : undefined;
  const resolved = resolveSet(body, selections);
  return typeof resolved === 'string' ? resolved : null;
}

/** The handle's face and the faces that move with it. */
export interface FaceSetOffsetStart {
  bodyId: BodyId;
  /** The last-picked face: the one shared handle sits on it. */
  face: FaceTopology;
  normal: Vector3;
  /** The other faces, in pick order. */
  members: OffsetFaceSetMember[];
}

/**
 * Checks a picked set for one plane and returns the face the shared handle
 * arms on (the last picked) with the rest. Throws the kernel's own refusal
 * for faces that face different ways or sit at different heights.
 */
export function faceSetOffsetStart(
  document: ProjectDocument,
  selections: readonly TopologySelection[]
): FaceSetOffsetStart {
  const bodyId = selections[0]?.bodyId;
  const body = bodyId
    ? ownEntry(document.derived.bodyRepresentations, bodyId)
    : undefined;
  const resolved = resolveSet(body, selections);
  if (typeof resolved === 'string') throw new Error(resolved);
  const handle = resolved[resolved.length - 1]!;
  const planeOffset = dot(handle.normal, handle.face.geometry!.center);
  const planeTolerance = Math.max(
    1e-6,
    Math.max(1, Math.abs(planeOffset)) * 1e-8
  );
  for (const entry of resolved) {
    if (dot(entry.normal, handle.normal) < 1 - NORMAL_TOLERANCE) {
      throw new Error(OFFSET_SET_NOT_SAME_NORMAL);
    }
    if (
      Math.abs(dot(handle.normal, entry.face.geometry!.center) - planeOffset) >
      planeTolerance
    ) {
      throw new Error(OFFSET_SET_NOT_COPLANAR);
    }
  }
  return {
    bodyId: bodyId!,
    face: handle.face,
    normal: handle.normal,
    members: resolved.slice(0, -1).map((entry) => ({
      topologyId: entry.face.topologyId,
      hash: entry.face.hash
    }))
  };
}

/** "Offset 3 faces": the History name of a face set's offset. */
export function offsetFacesName(count: number): string {
  return `Offset ${count} faces`;
}

function signedHundredths(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return `${rounded >= 0 ? '+' : ''}${rounded}`;
}

/** What a committed face set offset reports. */
export function offsetFacesCommitMessage(
  count: number,
  offset: number,
  units: string
): string {
  return `Offset ${count} faces by ${signedHundredths(offset)} ${units}.`;
}

function snapshot(face: FaceTopology): OffsetFaceSnapshot | null {
  const geometry = face.geometry;
  if (geometry?.surfaceType !== 'plane' || !geometry.normal) return null;
  return {
    faceHash: face.hash,
    ...(face.reference ? { faceReference: face.reference } : {}),
    sourceSurfaceType: 'plane',
    sourceArea: geometry.area,
    sourceCenter: geometry.center,
    sourceNormal: geometry.normal
  };
}

export interface OffsetFacesInput {
  document: ProjectDocument;
  bodyId: BodyId;
  /** The handle's face: the edit's first face. */
  face: Pick<FaceTopology, 'topologyId' | 'hash'>;
  members: readonly OffsetFaceSetMember[];
  /** Signed distance along the faces' shared outward normal. */
  offset: number;
  /** A typed expression to keep live in the document instead of the number. */
  exact?: ParamValue;
}

/**
 * The `offset-faces` edit for a face set: the handle's face first, then the
 * others as they were picked, each pinned as it is on the body now. Null
 * when a face no longer resolves on that body (a stale pick).
 */
export function buildOffsetFaces(input: OffsetFacesInput): AnyCommand | null {
  const body = ownEntry(
    input.document.derived.bodyRepresentations,
    input.bodyId
  );
  const faces = body?.topology?.faces ?? [];
  const find = (member: { topologyId: string; hash: number }) =>
    faces.find(
      (candidate) =>
        candidate.topologyId === member.topologyId &&
        candidate.hash === member.hash
    );
  const first = find(input.face);
  const firstSnapshot = first ? snapshot(first) : null;
  if (!firstSnapshot || input.members.length === 0) return null;
  const additionalFaces: OffsetFaceSnapshot[] = [];
  for (const member of input.members) {
    const face = find(member);
    const entry = face ? snapshot(face) : null;
    if (!entry) return null;
    additionalFaces.push(entry);
  }
  return commandFactories.directEditBody({
    name: offsetFacesName(additionalFaces.length + 1),
    targetBodyId: input.bodyId,
    operation: {
      kind: 'offset-faces',
      ...firstSnapshot,
      offset: input.exact ?? Math.round(input.offset * 1000) / 1000,
      additionalFaces
    }
  });
}
