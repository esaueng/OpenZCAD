import {
  addPrimitiveFeature,
  createProjectDocument,
  directEditBody,
  filletEdges,
  holeBody,
  setParameter
} from '@openzcad/document-core';
import type { ExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId, type BodyRepresentation } from '@openzcad/shared';

/** Authored synthetic part; no imported or user-owned geometry. */
export const STEPPED_BORE_PARAMETERS = {
  radius: 18,
  height: 24,
  recess_offset: -3,
  recess_diameter: 13,
  entry_round: 0.6,
  shoulder_round: 0.6,
  bore_round: 0.6,
  outside_round: 0.8
};

export async function steppedBore(
  adapter: ExactKernelAdapter,
  values: Partial<typeof STEPPED_BORE_PARAMETERS> = {}
) {
  const p = { ...STEPPED_BORE_PARAMETERS, ...values };
  let document = createProjectDocument(
    'Stepped bore replay',
    toUserId('local')
  );
  for (const [name, value] of Object.entries(p))
    document = setParameter(document, { name, expression: String(value) });
  document = addPrimitiveFeature(document, {
    name: 'Blank',
    primitiveKind: 'cylinder',
    dimensions: { radius: 'radius', height: 'height' }
  });
  let bodyId = document.bodyOrder[0]!;
  async function body(): Promise<BodyRepresentation> {
    const derived = await adapter.syncDocument(document);
    if (derived.warnings.length) throw new Error(derived.warnings.join('\n'));
    return derived.bodyRepresentations[bodyId]!;
  }
  const cap = (await body()).topology!.faces.find(
    (f) => f.reference?.lineageName === 'primitive.cylinder.face.cap.end'
  )!;
  const drilled = holeBody(document, {
    name: 'Stepped bore',
    targetBodyId: bodyId,
    faceHash: cap.hash,
    faceReference: cap.reference,
    style: 'counterbore',
    diameter: 4,
    depthMode: 'through',
    counterboreDiameter: 9,
    counterboreDepth: 4,
    position: { u: 0, v: 0 },
    positionAnchor: 'centroid'
  });
  document = drilled.document;
  bodyId = drilled.bodyId;
  const shoulder = (await body()).topology!.faces.find(
    (f) =>
      f.geometry?.surfaceType === 'plane' &&
      Math.abs(f.geometry.center.z - (p.height - 4)) < 1e-6
  )!;
  const g = shoulder.geometry!;
  document = directEditBody(document, {
    name: 'Recess depth',
    targetBodyId: bodyId,
    operation: {
      kind: 'offset-face',
      faceHash: shoulder.hash,
      sourceSurfaceType: 'plane',
      sourceArea: g.area,
      sourceCenter: g.center,
      sourceNormal: g.normal!,
      offset: 'recess_offset'
    }
  }).document;
  const wall = (await body()).topology!.faces.find(
    (f) =>
      f.geometry?.surfaceType === 'cylinder' &&
      Math.abs(f.geometry.diameter! - 9) < 1e-6
  )!;
  const w = wall.geometry!;
  document = directEditBody(document, {
    name: 'Recess width',
    targetBodyId: bodyId,
    operation: {
      kind: 'resize-through-hole',
      faceHash: wall.hash,
      sourceDiameter: w.diameter!,
      sourceAxisStart: w.axisStart!,
      sourceAxisEnd: w.axisEnd!,
      diameter: 'recess_diameter'
    }
  }).document;
  async function round(
    name: string,
    radius: string,
    select: (b: BodyRepresentation) => number[]
  ) {
    const hashes = select(await body());
    if (!hashes.length) throw new Error(`No authored edges for ${name}`);
    const rounded = filletEdges(document, {
      name,
      targetBodyId: bodyId,
      edgeHashes: hashes,
      size: radius
    });
    document = rounded.document;
    bodyId = rounded.bodyId;
  }
  const circleAt = (b: BodyRepresentation, radius: number, top: boolean) => {
    const edges = b.topology!.edges.filter(
      (e) =>
        e.displayRole !== 'seam' &&
        e.curve?.circle &&
        Math.abs(e.curve.circle.radius - radius) < 1e-6
    );
    const z = (e: (typeof edges)[number]) => e.curve!.circle!.center.z;
    edges.sort((a, b) => (top ? z(b) - z(a) : z(a) - z(b)));
    return edges.length ? [edges[0]!.hash] : [];
  };
  await round('Entry round', 'entry_round', (b) =>
    circleAt(b, p.recess_diameter / 2, true)
  );
  await round('Shoulder round', 'shoulder_round', (b) =>
    circleAt(b, p.recess_diameter / 2, false)
  );
  await round('Bore round', 'bore_round', (b) => circleAt(b, 2, true));
  await round('Remaining rounds', 'outside_round', (b) =>
    b.topology!.edges.filter((e) => e.displayRole !== 'seam').map((e) => e.hash)
  );
  return {
    document,
    bodyId,
    derived: await adapter.syncDocument(document)
  };
}
