/**
 * Move-face journals are read by the kernel's own events, not by output
 * position.
 *
 * `resolveOperationOutput(op, 'face', i)` is the op's `i`-th result face in
 * journal event order. On a box whose vertical edges are rounded, moving a
 * side face rebuilds the faces in an order that is not the source order, so
 * reading output `i` as "what source face `i` became" names a band after a
 * plane and a plane after another plane. The reader must pair every source
 * with a face on its own carrier.
 */
import { describe, expect, it } from 'vitest';
import { RemusKernel } from './remus-runtime';
import { moveFacesJournalFaceMap, samePoint } from './exact-lineage-builders';
import { faceWitnessOf } from './exact-witnesses';
import { quantizeCoordinate } from './topology-fingerprint';

function roundedBlock(kernel: RemusKernel) {
  const box = kernel.makeBox(20, 20, 10);
  const vertical = Array.from(kernel.getSolidEdges(box)).filter((edge) => {
    const [x0, y0, , x1, y1] = kernel.getEdgeVertices(edge);
    return x0 === x1 && y0 === y1;
  });
  expect(vertical).toHaveLength(4);
  return kernel.fillet(box, Uint32Array.from(vertical), 3);
}

/** The +x side plane of the rounded block. */
function sidePlane(kernel: RemusKernel, solid: number) {
  const sides = Array.from(kernel.getSolidFaces(solid)).filter(
    (face) =>
      kernel.getSurfaceType(face) === 'plane' &&
      kernel.getFaceNormal(face)[0]! > 0.5
  );
  expect(sides).toHaveLength(1);
  return sides[0]!;
}

function positionalReading(
  kernel: RemusKernel,
  op: number,
  sourceFaces: readonly number[]
) {
  return new Map(
    sourceFaces.map((source, index) => {
      const record = JSON.parse(
        kernel.resolveOperationOutput(op, 'face', index)
      ) as { entities?: { handle: number }[] };
      return [source, record.entities?.[0]?.handle] as const;
    })
  );
}

describe('moveFacesJournalFaceMap', () => {
  it('pairs every source face with the face the journal made of it', () => {
    const kernel = new RemusKernel();
    try {
      const block = roundedBlock(kernel);
      const side = sidePlane(kernel, block);
      const sourceFaces = Array.from(kernel.getSolidFaces(block));
      const { solid, op } = JSON.parse(
        kernel.moveFacesJournaled(block, Uint32Array.of(side), 1)
      ) as { solid: number; op: number };
      const resultFaces = Array.from(kernel.getSolidFaces(solid));

      const relation = moveFacesJournalFaceMap(
        kernel,
        op,
        sourceFaces,
        resultFaces
      );
      expect(relation).not.toBeNull();
      expect(relation!.conflictedSources.size).toBe(0);
      expect(relation!.faceMap.size).toBe(sourceFaces.length);
      expect(new Set(relation!.faceMap.values()).size).toBe(resultFaces.length);

      for (const [source, result] of relation!.faceMap) {
        const before = faceWitnessOf(kernel, source).analytic;
        const after = faceWitnessOf(kernel, result).analytic;
        expect(after.kind).toBe(before.kind);
        if (before.kind === 'plane' && after.kind === 'plane') {
          // Only the moved face changes its plane, and only its offset.
          expect(samePoint(after.normal, before.normal)).toBe(true);
          if (source !== side) expect(after.offset).toBe(before.offset);
          else expect(after.offset).not.toBe(before.offset);
        } else if (before.kind === 'cylinder' && after.kind === 'cylinder') {
          // A rounded corner keeps its axis direction and radius, and only
          // the two corners on the moved +x side travel with it, by 1 mm.
          expect(samePoint(after.axis, before.axis)).toBe(true);
          expect(after.radius).toBe(before.radius);
          const [x, y, z] = before.axisFoot;
          expect(after.axisFoot).toEqual([
            x > quantizeCoordinate(10) ? x + quantizeCoordinate(1) : x,
            y,
            z
          ]);
        } else {
          throw new Error(`Unexpected ${before.kind} face on the block.`);
        }
      }

      // The fixture still exercises the defect: read positionally, the
      // journal would have paired some source with another face.
      const positional = positionalReading(kernel, op, sourceFaces);
      expect(
        sourceFaces.filter(
          (source) => positional.get(source) !== relation!.faceMap.get(source)
        ).length
      ).toBeGreaterThan(0);
    } finally {
      kernel.free();
    }
  });

  it('leaves every face name as it found it', () => {
    const kernel = new RemusKernel();
    try {
      const block = roundedBlock(kernel);
      const side = sidePlane(kernel, block);
      const sourceFaces = Array.from(kernel.getSolidFaces(block));
      kernel.setFaceName(sourceFaces[0]!, 'kept');
      const { solid, op } = JSON.parse(
        kernel.moveFacesJournaled(block, Uint32Array.of(side), -1)
      ) as { solid: number; op: number };
      const resultFaces = Array.from(kernel.getSolidFaces(solid));
      expect(
        moveFacesJournalFaceMap(kernel, op, sourceFaces, resultFaces)
      ).not.toBeNull();
      expect(kernel.getFaceName(sourceFaces[0]!)).toBe('kept');
      for (const face of [...sourceFaces.slice(1), ...resultFaces]) {
        expect(kernel.getFaceName(face) ?? null).toBeNull();
      }
      // The journal stays continuous: name writes are not model mutations.
      expect(
        JSON.parse(kernel.resolveOperationOutput(op, 'face', 0))
      ).toMatchObject({ status: 'bound', provenance: 'construction' });
    } finally {
      kernel.free();
    }
  });
});
