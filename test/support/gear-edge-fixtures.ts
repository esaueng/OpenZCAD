import { expect } from 'vitest';
import {
  addPrimitiveFeature,
  chamferEdges,
  createProjectDocument,
  filletEdges,
  gearBody,
  listFeaturesInOrder,
  type GearInput
} from '@openzcad/document-core';
import type { ExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type DerivedState,
  type EdgeTopology,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';

export type EdgeModifierKind = 'fillet' | 'chamfer';

/**
 * A gear edge's name from the roles of the two faces it lies between, as
 * `exact-gear-edges` builds it: `between('cap.end', 'collar.end')`.
 */
export function between(first: string, second: string): string {
  const names = [`gear.face.${first}`, `gear.face.${second}`].sort();
  return `gear.edge.between.${names[0]}|${names[1]}`;
}

export function edgeNamed(
  body: BodyRepresentation,
  lineageName: string
): EdgeTopology {
  const edges = body.topology!.edges.filter(
    (edge) => edge.reference?.lineageName === lineageName
  );
  expect(edges, lineageName).toHaveLength(1);
  return edges[0]!;
}

/** The edges a pick can land on: all but the seams of closed faces. */
export function featureEdges(body: BodyRepresentation): EdgeTopology[] {
  return body.topology!.edges.filter((edge) => edge.displayRole !== 'seam');
}

/** Each named edge's hash by its name. */
export function edgeNames(body: BodyRepresentation): Record<string, number> {
  return Object.fromEntries(
    body
      .topology!.edges.filter((edge) => edge.reference)
      .map((edge) => [edge.reference!.lineageName, edge.hash])
  );
}

export interface GearOnBoss {
  document: ProjectDocument;
  /** The body the teeth leave. */
  bodyId: BodyId;
  body: BodyRepresentation;
  gearId: FeatureId;
  blankId: FeatureId;
}

/** Teeth on a cylinder standing on the XY plane (Ø22 × 12 unless given). */
export async function teethOnBoss(
  adapter: ExactKernelAdapter,
  gear: Partial<GearInput>,
  blank: { radius: number; height: number } = { radius: 11, height: 12 }
): Promise<GearOnBoss> {
  const base = addPrimitiveFeature(
    createProjectDocument('Shaft', toUserId('user_gear_edges')),
    { name: 'Blank', primitiveKind: 'cylinder', dimensions: blank }
  );
  const blankBodyId = base.bodyOrder[0]!;
  const wall = (await adapter.syncDocument(base)).bodyRepresentations[
    blankBodyId
  ]!.topology!.faces.find(
    (face) => face.geometry?.surfaceType === 'cylinder'
  )!;
  const cut = gearBody(base, {
    name: 'Teeth',
    gearType: 'external',
    sizing: 'module',
    teeth: 20,
    targetBodyId: blankBodyId,
    faceHash: wall.hash,
    ...(wall.reference ? { faceReference: wall.reference } : {}),
    ...gear
  });
  const derived = await adapter.syncDocument(cut.document);
  expect(derived.warnings).toEqual([]);
  const features = listFeaturesInOrder(cut.document);
  return {
    document: cut.document,
    bodyId: cut.bodyId,
    body: derived.bodyRepresentations[cut.bodyId]!,
    gearId: features.find((feature) => feature.data.featureKind === 'gear')!
      .featureId,
    blankId: features.find((feature) => feature.name === 'Blank')!.featureId
  };
}

/** A fillet or chamfer on one edge, picked as the workspace picks it. */
export function modifyEdge(
  kind: EdgeModifierKind,
  document: ProjectDocument,
  targetBodyId: BodyId,
  edge: EdgeTopology,
  size: number
): { document: ProjectDocument; bodyId: BodyId } {
  expect(edge.reference, 'the picked edge carries a name').toBeDefined();
  return (kind === 'fillet' ? filletEdges : chamferEdges)(document, {
    name: 'Edge break',
    targetBodyId,
    edgeHashes: [edge.hash],
    edgeReferences: [edge.reference!],
    size
  });
}

/**
 * The volume a fillet of radius `size`, or a 45° chamfer of that setback,
 * takes off a square circular rim of radius `radius`: a boss's rim
 * (`outer`) or a bore's (`inner`).
 */
export function rimCut(
  kind: EdgeModifierKind,
  radius: number,
  size: number,
  side: 'outer' | 'inner'
): number {
  const sign = side === 'outer' ? -1 : 1;
  if (kind === 'chamfer') {
    return Math.PI * size ** 2 * (radius + (sign * size) / 3);
  }
  // The corner a quarter round leaves: a square less a quarter disc, its
  // centroid measured from the arc's centre.
  const area = size ** 2 * (1 - Math.PI / 4);
  const centroid = size / (6 * (1 - Math.PI / 4));
  return 2 * Math.PI * (radius + sign * (size - centroid)) * area;
}

/**
 * The modifier built on the rim it was given: no warning, exactly the
 * material a blend of that size takes off a rim of that radius, and its one
 * blend face (a torus for a fillet, a cone for a chamfer) at `z`.
 */
export function expectRimBlend(
  derived: DerivedState,
  step: string,
  ids: { gear: BodyId; modified: BodyId },
  blend: {
    kind: EdgeModifierKind;
    radius: number;
    size: number;
    side: 'outer' | 'inner';
    z: number;
  }
): void {
  expect(derived.warnings, step).toEqual([]);
  const gear = derived.bodyRepresentations[ids.gear]!;
  const modified = derived.bodyRepresentations[ids.modified]!;
  expect(gear.volume - modified.volume, step).toBeCloseTo(
    rimCut(blend.kind, blend.radius, blend.size, blend.side),
    3
  );
  const faces = modified.topology!.faces.filter(
    (face) =>
      face.geometry?.surfaceType === (blend.kind === 'fillet' ? 'torus' : 'cone')
  );
  expect(faces, step).toHaveLength(1);
  expect(
    Math.abs(faces[0]!.geometry!.center.z - blend.z),
    step
  ).toBeLessThanOrEqual(blend.size + 1e-6);
}
