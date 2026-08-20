import { beforeAll, describe, expect, it } from 'vitest';

import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges,
  holeBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import type {
  BodyId,
  DerivedState,
  FaceTopology,
  ProjectDocument
} from '@openzcad/shared';

let adapter: ExactKernelAdapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});

/** Parse a DXF text into [code, value] pairs. */
function pairs(text: string): Array<[number, string]> {
  const lines = text.split('\r\n').filter((l) => l.length > 0);
  const out: Array<[number, string]> = [];
  for (let i = 0; i < lines.length; i += 2) {
    out.push([Number(lines[i]), lines[i + 1]!]);
  }
  return out;
}

/** Group parsed pairs into entities within the ENTITIES section. */
function entities(text: string): Array<{ type: string; groups: Map<number, string[]> }> {
  const p = pairs(text);
  const startAt = p.findIndex(([c, v]) => c === 2 && v === 'ENTITIES');
  const out: Array<{ type: string; groups: Map<number, string[]> }> = [];
  let current: { type: string; groups: Map<number, string[]> } | undefined;
  for (const [code, value] of p.slice(startAt + 1)) {
    if (code === 0) {
      if (value === 'ENDSEC' || value === 'EOF') {
        break;
      }
      current = { type: value, groups: new Map() };
      out.push(current);
      continue;
    }
    if (current) {
      const bucket = current.groups.get(code) ?? [];
      bucket.push(value);
      current.groups.set(code, bucket);
    }
  }
  return out;
}

const num = (
  entity: { groups: Map<number, string[]> },
  code: number,
  index = 0
): number => Number(entity.groups.get(code)![index]);

function planarFaceWithNormal(
  derived: DerivedState,
  bodyId: BodyId,
  z: 1 | -1
): FaceTopology {
  const body = derived.bodyRepresentations[bodyId]!;
  const face = body.topology!.faces.find(
    (f) =>
      f.geometry?.surfaceType === 'plane' &&
      f.geometry.normal !== undefined &&
      Math.abs(f.geometry.normal.z - z) < 1e-9
  );
  expect(face, `body must expose a planar face with normal z=${z}`).toBeDefined();
  return face!;
}

function boxDocument(): { document: ProjectDocument; bodyId: BodyId } {
  const document = addPrimitiveFeature(
    createProjectDocument('DXF plate', toUserId('user_dxf')),
    {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 40, depth: 24, height: 10 }
    }
  );
  return { document, bodyId: document.bodyOrder[0]! };
}

describe('exportFaceDxf', () => {
  it('exports a box top face as four lines spanning the plate', async () => {
    const { document, bodyId } = boxDocument();
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const top = planarFaceWithNormal(derived, bodyId, 1);

    const text = await adapter.exportFaceDxf(document, {
      bodyId,
      faceHash: top.hash,
      ...(top.reference ? { faceReference: top.reference } : {})
    });

    const all = entities(text);
    expect(all.map((e) => e.type).sort()).toEqual(['LINE', 'LINE', 'LINE', 'LINE']);

    const xs: number[] = [];
    const ys: number[] = [];
    for (const line of all) {
      xs.push(num(line, 10), num(line, 11));
      ys.push(num(line, 20), num(line, 21));
    }
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    // The in-plane frame is deterministic but its axes may swap; the
    // outline's extents are the +z face's 40 x 10 regardless (the primitive
    // maps height to Y, so the z-normal caps are width x height).
    expect([spanX, spanY].sort((a, b) => a - b)).toEqual([10, 40]);
  });

  it('exports a bored face with the bore as a CIRCLE entity', async () => {
    const { document, bodyId } = boxDocument();
    const first = await adapter.syncDocument(document);
    const top = planarFaceWithNormal(first, bodyId, 1);
    const bored = holeBody(document, {
      name: 'Bore',
      targetBodyId: bodyId,
      faceHash: top.hash,
      ...(top.reference ? { faceReference: top.reference } : {}),
      style: 'simple',
      diameter: 8,
      depthMode: 'through',
      position: { u: 0, v: 0 }
    });
    const derived = await adapter.syncDocument(bored.document);
    expect(derived.warnings).toEqual([]);
    const boredTop = planarFaceWithNormal(derived, bored.bodyId, 1);

    const text = await adapter.exportFaceDxf(bored.document, {
      bodyId: bored.bodyId,
      faceHash: boredTop.hash,
      ...(boredTop.reference ? { faceReference: boredTop.reference } : {})
    });

    const all = entities(text);
    const lines = all.filter((e) => e.type === 'LINE');
    const circles = all.filter((e) => e.type === 'CIRCLE');
    expect(lines).toHaveLength(4);
    expect(circles).toHaveLength(1);
    expect(num(circles[0]!, 40)).toBeCloseTo(4, 9);
  });

  it('exports a corner-filleted face with quarter arcs, byte-stable', async () => {
    const { document, bodyId } = boxDocument();
    const first = await adapter.syncDocument(document);
    const body = first.bodyRepresentations[bodyId]!;
    const top = planarFaceWithNormal(first, bodyId, 1);
    const bottom = planarFaceWithNormal(first, bodyId, -1);
    const capHashes = new Set([top.hash, bottom.hash]);
    // The four vertical edges touch neither cap.
    const verticalEdges = body.topology!.edges.filter(
      (edge) =>
        edge.displayRole !== 'seam' &&
        (edge.adjacentFaceHashes ?? []).every((hash) => !capHashes.has(hash))
    );
    expect(verticalEdges).toHaveLength(4);

    const filleted = filletEdges(document, {
      name: 'Rounded corners',
      targetBodyId: bodyId,
      edgeHashes: verticalEdges.map((edge) => edge.hash),
      size: 3
    });
    const derived = await adapter.syncDocument(filleted.document);
    expect(derived.warnings).toEqual([]);
    const roundedTop = planarFaceWithNormal(derived, filleted.bodyId, 1);
    const selector = {
      bodyId: filleted.bodyId,
      faceHash: roundedTop.hash,
      ...(roundedTop.reference ? { faceReference: roundedTop.reference } : {})
    };

    const text = await adapter.exportFaceDxf(filleted.document, selector);
    const all = entities(text);
    const lines = all.filter((e) => e.type === 'LINE');
    const arcs = all.filter((e) => e.type === 'ARC');
    expect(lines).toHaveLength(4);
    expect(arcs).toHaveLength(4);
    for (const arc of arcs) {
      expect(num(arc, 40)).toBeCloseTo(3, 6);
      const sweep =
        (((num(arc, 51) - num(arc, 50)) % 360) + 360) % 360;
      // A corner fillet's rim is a quarter turn; the complement (270) is the
      // exact failure the kernel's span query exists to rule out.
      expect(sweep).toBeCloseTo(90, 6);
    }

    // Deterministic frame + span-true extraction: repeat export is identical.
    const again = await adapter.exportFaceDxf(filleted.document, selector);
    expect(again).toBe(text);
  });

  it('refuses non-planar faces', async () => {
    const { document, bodyId } = boxDocument();
    const first = await adapter.syncDocument(document);
    const top = planarFaceWithNormal(first, bodyId, 1);
    const bored = holeBody(document, {
      name: 'Bore',
      targetBodyId: bodyId,
      faceHash: top.hash,
      ...(top.reference ? { faceReference: top.reference } : {}),
      style: 'simple',
      diameter: 8,
      depthMode: 'through',
      position: { u: 0, v: 0 }
    });
    const derived = await adapter.syncDocument(bored.document);
    const wall = derived.bodyRepresentations[bored.bodyId]!.topology!.faces.find(
      (f) => f.geometry?.surfaceType === 'cylinder'
    );
    expect(wall).toBeDefined();
    await expect(
      adapter.exportFaceDxf(bored.document, {
        bodyId: bored.bodyId,
        faceHash: wall!.hash,
        ...(wall!.reference ? { faceReference: wall!.reference } : {})
      })
    ).rejects.toThrow(/planar/);
  });
});
