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
 * M07: a picked set of faces that all face the same way, offset together as
 * one replayable `offset-faces` direct edit. The set's Offset verb arms the
 * single-face offset handle on the last-picked face and carries the other
 * faces with it; this module checks the set, names its refusals, and builds
 * the edit. Faces on parallel planes at different heights (a slot's floor
 * and the top beside it) are a chained move: the kernel moves them one plane
 * at a time, and each face moves along its own normal by the one distance.
 */

/** The most faces one `offset-faces` edit takes (the kernel's own bound). */
export const MAX_OFFSET_SET_FACES = 64;

/**
 * The refusal for a set whose faces do not all face the same way, said
 * before any handle appears, in the kernel's own words.
 */
export const OFFSET_SET_NOT_SAME_NORMAL =
  'Offset moves a set of faces together only when they all face the same way, and the selected faces face different directions. Offset them one at a time.';

/**
 * Two faces of a set lie on one plane when their heights along the shared
 * normal differ by no more than this: the kernel's own fixed plane
 * tolerance (`DIRECT_EDIT_TOLERANCE`), never one scaled by the body's
 * distance from the origin.
 */
const PLANE_TOLERANCE = 1e-6;

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
 * curved face, too many faces), or null. A flat set whose faces face
 * different ways is offered, and refused by name when it is chosen.
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
 * Checks that a picked set all faces one way and returns the face the shared
 * handle arms on (the last picked) with the rest. Throws the kernel's own
 * refusal for faces that face different ways. Parallel faces at different
 * heights arm: they are a chained move (see `faceSetOffsetLead`).
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
  for (const entry of resolved) {
    if (dot(entry.normal, handle.normal) < 1 - NORMAL_TOLERANCE) {
      throw new Error(OFFSET_SET_NOT_SAME_NORMAL);
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

/** The faces an armed set names, as they are on its body now. */
export interface FaceSetOffsetFacesInput {
  document: ProjectDocument;
  bodyId: BodyId;
  /** The handle's face. */
  face: Pick<FaceTopology, 'topologyId' | 'hash'>;
  members: readonly OffsetFaceSetMember[];
}

/**
 * The armed set's planar faces on its body now, the handle's face first and
 * then the others in pick order; null when one no longer resolves.
 */
function setFaces(input: FaceSetOffsetFacesInput): FaceTopology[] | null {
  const body = ownEntry(
    input.document.derived.bodyRepresentations,
    input.bodyId
  );
  const faces = body?.topology?.faces ?? [];
  const result: FaceTopology[] = [];
  for (const member of [input.face, ...input.members]) {
    const face = faces.find(
      (candidate) =>
        candidate.topologyId === member.topologyId &&
        candidate.hash === member.hash
    );
    if (
      face?.geometry?.surfaceType !== 'plane' ||
      !face.geometry.normal ||
      !unit(face.geometry.normal)
    ) {
      return null;
    }
    result.push(face);
  }
  return result;
}

/**
 * The faces of an armed set grouped by the plane they lie on, in the order
 * the kernel's chained move takes them: the plane the move leads with first
 * (the outermost for a positive offset, the innermost for a negative one),
 * the faces of a plane in the set's own order. One group is one plane: a
 * coplanar set, which needs no chain. Null when a face no longer resolves.
 */
export function faceSetOffsetPlanes(
  input: FaceSetOffsetFacesInput,
  offset: number
): FaceTopology[][] | null {
  const faces = setFaces(input);
  if (!faces) return null;
  const axis = unit(faces[0]!.geometry!.normal!)!;
  const height = (face: FaceTopology) => dot(axis, face.geometry!.center);
  const sorted = faces
    .map((face, order) => ({ face, order }))
    .sort((a, b) => height(a.face) - height(b.face) || a.order - b.order);
  const groups: { face: FaceTopology; order: number }[][] = [];
  for (const entry of sorted) {
    const last = groups.at(-1);
    if (
      last &&
      Math.abs(height(entry.face) - height(last.at(-1)!.face)) <=
        PLANE_TOLERANCE
    ) {
      last.push(entry);
    } else {
      groups.push([entry]);
    }
  }
  if (offset > 0) groups.reverse();
  return groups.map((group) =>
    group.sort((a, b) => a.order - b.order).map((entry) => entry.face)
  );
}

/**
 * Where each face of an armed set sits and which way it moves, for its
 * direction tick: every face of the set, in pick order with the handle's
 * face last, at its centre on its own outward unit normal. Empty when a
 * face no longer resolves.
 */
export function faceSetOffsetTicks(
  input: FaceSetOffsetFacesInput
): { point: Vector3; normal: Vector3 }[] {
  const faces = setFaces(input);
  if (!faces) return [];
  const [handle, ...members] = faces;
  return [...members, handle!].map((face) => ({
    point: face.geometry!.center,
    normal: unit(face.geometry!.normal!)!
  }));
}

/**
 * A chained set's drag preview of its leading plane alone (M07): the faces
 * the chain moves first, at `offset`, on the source body. Its kernel move is
 * the chain's own first step, so a drag can show it from a prepared move
 * every frame while the whole chain is rebuilt at a coarse rate. Display
 * only: it never authors a commit, which replays the whole set. Null for a
 * set on one plane (nothing to chain) or a face that no longer resolves.
 */
export function buildOffsetFaceSetLead(
  input: FaceSetOffsetFacesInput & { offset: number }
): AnyCommand | null {
  const planes = faceSetOffsetPlanes(input, input.offset);
  if (!planes || planes.length < 2) return null;
  const [first, ...rest] = planes[0]!;
  const firstSnapshot = snapshot(first!);
  if (!firstSnapshot) return null;
  const offset = Math.round(input.offset * 1000) / 1000;
  if (rest.length === 0) {
    // One face leads: the same move as an `offset-face` of it.
    return commandFactories.directEditBody({
      name: offsetFacesName(planes.flat().length),
      targetBodyId: input.bodyId,
      operation: { kind: 'offset-face', ...firstSnapshot, offset }
    });
  }
  const additionalFaces: OffsetFaceSnapshot[] = [];
  for (const face of rest) {
    const entry = snapshot(face);
    if (!entry) return null;
    additionalFaces.push(entry);
  }
  return commandFactories.directEditBody({
    name: offsetFacesName(planes.flat().length),
    targetBodyId: input.bodyId,
    operation: {
      kind: 'offset-faces',
      ...firstSnapshot,
      offset,
      additionalFaces
    }
  });
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
  /** Signed distance along each face's own outward normal. */
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
