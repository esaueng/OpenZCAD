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
 * M07: a picked set of flat faces offset together as one replayable
 * `offset-faces` direct edit. The set's Offset verb arms the single-face
 * offset handle on the last-picked face and carries the other faces with it;
 * this module checks the set, names its refusals, and builds the edit. Faces
 * on several planes (a slot's floor and the top beside it, a pocket's floor
 * and its walls) are a chained move: the kernel moves them one plane at a
 * time, and each face moves along its own normal by the one distance. Only
 * faces that face opposite ways are refused.
 */

/** The most faces one `offset-faces` edit takes (the kernel's own bound). */
export const MAX_OFFSET_SET_FACES = 64;

/**
 * The refusal for a set two of whose faces face opposite ways, said before
 * any handle appears, in the kernel's own words.
 */
export const OFFSET_SET_OPPOSITE_NORMALS =
  'The selected faces face opposite ways, so one offset would thicken one and thin the other. Offset them separately.';

/** The kernel's cosine for two normals facing one way (or opposite ways). */
const NORMAL_TOLERANCE = 1e-6;

export function dot(a: Vector3, b: Vector3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function unit(vector: Vector3): Vector3 | null {
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
 * Checks a picked set and returns the face the shared handle arms on (the
 * last picked) with the rest. Throws the kernel's own refusal when any two
 * faces face opposite ways. Faces on several planes, parallel or facing
 * different directions, arm: they are a chained move (see
 * `faceSetOffsetChain.ts`).
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
  for (const [index, a] of resolved.entries()) {
    for (const b of resolved.slice(index + 1)) {
      if (dot(a.normal, b.normal) <= NORMAL_TOLERANCE - 1) {
        throw new Error(OFFSET_SET_OPPOSITE_NORMALS);
      }
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
export function setFaces(
  input: FaceSetOffsetFacesInput
): FaceTopology[] | null {
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

export function snapshot(face: FaceTopology): OffsetFaceSnapshot | null {
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
  ambiguousRim?: 'chamfer' | 'draft';
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
      ...(input.ambiguousRim ? { ambiguousRim: input.ambiguousRim } : {}),
      ...firstSnapshot,
      offset: input.exact ?? Math.round(input.offset * 1000) / 1000,
      additionalFaces
    }
  });
}
