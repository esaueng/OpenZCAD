import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';

/**
 * Binary PLY mesh export through the existing export job. The writer is the
 * pinned kernel's `exportPly` — probed to emit `format binary_little_endian
 * 1.0` with one merged vertex/face stream honouring body placement — run on
 * the same millimetre-scaled solids and deflection as STL/3MF, then through
 * the same zero-area sanitize path. Every assertion below reads the file
 * back with a small independent parser written for this test, and checks it
 * against the STL export of the same body.
 */
describe('binary PLY mesh export', () => {
  let adapter: ExactKernelAdapter;
  const kernel = async () => {
    adapter ??= await createExactKernelAdapter();
    return adapter;
  };

  /** Minimal binary little-endian PLY reader: header plus xyz/faces only. */
  const parsePly = (bytes: Uint8Array) => {
    const marker = 'end_header\n';
    const ascii = new TextDecoder().decode(bytes.subarray(0, 1024));
    const headerEnd = ascii.indexOf(marker);
    expect(headerEnd).toBeGreaterThanOrEqual(0);
    const header = ascii.slice(0, headerEnd + marker.length);
    const headerLength = new TextEncoder().encode(header).length;
    const vertexCount = Number(header.match(/element vertex (\d+)/)?.[1]);
    const faceCount = Number(header.match(/element face (\d+)/)?.[1]);
    expect(Number.isInteger(vertexCount)).toBe(true);
    expect(Number.isInteger(faceCount)).toBe(true);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const vertices: [number, number, number][] = [];
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const base = headerLength + vertex * 24;
      vertices.push([
        view.getFloat32(base, true),
        view.getFloat32(base + 4, true),
        view.getFloat32(base + 8, true)
      ]);
    }
    const faces: [number, number, number][] = [];
    let offset = headerLength + vertexCount * 24;
    for (let face = 0; face < faceCount; face++) {
      const corners = view.getUint8(offset);
      offset += 1;
      expect(corners).toBe(3);
      faces.push([
        view.getInt32(offset, true),
        view.getInt32(offset + 4, true),
        view.getInt32(offset + 8, true)
      ]);
      offset += 12;
    }
    expect(offset).toBe(bytes.length);
    return { header, vertexCount, faceCount, vertices, faces };
  };

  const parseBinaryStl = (bytes: Uint8Array) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const facets = view.getUint32(80, true);
    expect(bytes.length).toBe(84 + facets * 50);
    const vertices: [number, number, number][] = [];
    for (let facet = 0; facet < facets; facet++) {
      for (let corner = 0; corner < 3; corner++) {
        const base = 84 + facet * 50 + 12 + corner * 12;
        vertices.push([
          view.getFloat32(base, true),
          view.getFloat32(base + 4, true),
          view.getFloat32(base + 8, true)
        ]);
      }
    }
    return { facets, vertices };
  };

  const boundsOf = (vertices: readonly [number, number, number][]) => {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const vertex of vertices) {
      for (let axis = 0; axis < 3; axis++) {
        expect(Number.isFinite(vertex[axis])).toBe(true);
        min[axis] = Math.min(min[axis]!, vertex[axis]!);
        max[axis] = Math.max(max[axis]!, vertex[axis]!);
      }
    }
    return { min, max };
  };

  function boxDocument(name = 'Box') {
    let document = createProjectDocument(name, toUserId('user_ply'));
    document = addPrimitiveFeature(document, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 20, depth: 30 }
    });
    return document;
  }

  it('writes binary little-endian PLY with the STL triangle count', async () => {
    const exact = await kernel();
    const document = boxDocument();
    const bodyId = document.bodyOrder.at(-1)!;
    const ply = await exact.exportMesh(document, [bodyId], {
      format: 'ply',
      deflection: 0.08
    });
    const parsed = parsePly(ply);
    expect(parsed.header).toContain('format binary_little_endian 1.0');
    expect(parsed.header).toMatch(/element vertex \d+/);
    expect(parsed.header).toMatch(/element face \d+/);
    const stl = parseBinaryStl(
      await exact.exportMesh(document, [bodyId], {
        format: 'stl-binary',
        deflection: 0.08
      })
    );
    expect(parsed.faceCount).toBe(stl.facets);
    expect(parsed.faceCount).toBe(12);
    for (const face of parsed.faces) {
      for (const index of face) {
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(parsed.vertexCount);
      }
      expect(new Set(face).size).toBe(3);
    }
  }, 120_000);

  it('matches the STL bounding box within 1e-6', async () => {
    const exact = await kernel();
    const document = boxDocument();
    const bodyId = document.bodyOrder.at(-1)!;
    const ply = parsePly(
      await exact.exportMesh(document, [bodyId], {
        format: 'ply',
        deflection: 0.08
      })
    );
    const stl = parseBinaryStl(
      await exact.exportMesh(document, [bodyId], {
        format: 'stl-binary',
        deflection: 0.08
      })
    );
    const plyBounds = boundsOf(ply.vertices);
    const stlBounds = boundsOf(stl.vertices);
    for (let axis = 0; axis < 3; axis++) {
      expect(
        Math.abs(plyBounds.min[axis]! - stlBounds.min[axis]!)
      ).toBeLessThan(1e-6);
      expect(
        Math.abs(plyBounds.max[axis]! - stlBounds.max[axis]!)
      ).toBeLessThan(1e-6);
    }
    expect(plyBounds.min).toEqual([0, 0, 0]);
    expect(plyBounds.max).toEqual([10, 20, 30]);
  }, 120_000);

  it('preserves placement of a translated and rotated body', async () => {
    const exact = await kernel();
    let document = boxDocument('Moved');
    const bodyId = document.bodyOrder.at(-1)!;
    document = transformBody(document, {
      name: 'Move',
      targetBodyId: bodyId,
      rotationDeg: { x: 0, y: 0, z: 90 },
      translation: { x: 100, y: 0, z: 0 }
    }).document;
    const ply = parsePly(
      await exact.exportMesh(document, [bodyId], {
        format: 'ply',
        deflection: 0.08
      })
    );
    const stl = parseBinaryStl(
      await exact.exportMesh(document, [bodyId], {
        format: 'stl-binary',
        deflection: 0.08
      })
    );
    expect(ply.faceCount).toBe(stl.facets);
    const plyBounds = boundsOf(ply.vertices);
    const stlBounds = boundsOf(stl.vertices);
    for (let axis = 0; axis < 3; axis++) {
      expect(
        Math.abs(plyBounds.min[axis]! - stlBounds.min[axis]!)
      ).toBeLessThan(1e-6);
      expect(
        Math.abs(plyBounds.max[axis]! - stlBounds.max[axis]!)
      ).toBeLessThan(1e-6);
    }
    // The 90° turn swaps the 10/20 extents whatever it turns about, and the
    // 100 mm shift must be in the file — an unplaced export would sit at the
    // origin with (10, 20, 30) extents.
    const extents = plyBounds.max.map(
      (max, axis) => max - plyBounds.min[axis]!
    );
    expect(extents[0]!).toBeCloseTo(20, 6);
    expect(extents[1]!).toBeCloseTo(10, 6);
    expect(extents[2]!).toBeCloseTo(30, 6);
    expect(plyBounds.min[0]).toBeGreaterThan(50);
  }, 120_000);

  it('exports the selected bodies only, like STL', async () => {
    const exact = await kernel();
    let document = boxDocument('Two boxes');
    document = addPrimitiveFeature(document, {
      name: 'Second',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 20, depth: 30 }
    });
    const [first, second] = document.bodyOrder;
    const single = parsePly(
      await exact.exportMesh(document, [first!], {
        format: 'ply',
        deflection: 0.08
      })
    );
    const both = parsePly(
      await exact.exportMesh(document, [first!, second!], {
        format: 'ply',
        deflection: 0.08
      })
    );
    expect(single.faceCount).toBe(12);
    expect(both.faceCount).toBe(2 * single.faceCount);
    const singleStl = parseBinaryStl(
      await exact.exportMesh(document, [second!], {
        format: 'stl-binary',
        deflection: 0.08
      })
    );
    expect(single.faceCount).toBe(singleStl.facets);
    await expect(
      exact.exportMesh(document, [], { format: 'ply', deflection: 0.08 })
    ).rejects.toThrow(/at least one body/);
  }, 120_000);

  it('exports millimetres from an inch document, like STL', async () => {
    const exact = await kernel();
    let document = createProjectDocument('Cube', toUserId('user_ply'));
    document = { ...document, units: 'inch' };
    document = addPrimitiveFeature(document, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 20 }
    });
    const bodyId = document.bodyOrder.at(-1)!;
    const ply = parsePly(
      await exact.exportMesh(document, [bodyId], {
        format: 'ply',
        deflection: 0.08
      })
    );
    const bounds = boundsOf(ply.vertices);
    // 20 inches reinterpreted as 508 mm on disk: units are a label on the
    // numbers, and only the export converts.
    for (let axis = 0; axis < 3; axis++) {
      expect(bounds.min[axis]!).toBeCloseTo(0, 6);
      expect(bounds.max[axis]!).toBeCloseTo(508, 6);
    }
  }, 120_000);

  it('refines tessellation with the same deflection control as STL', async () => {
    const exact = await kernel();
    let document = createProjectDocument('Shaft', toUserId('user_ply'));
    document = addPrimitiveFeature(document, {
      name: 'Shaft',
      primitiveKind: 'cylinder',
      dimensions: { radius: 5, height: 20 }
    });
    const bodyId = document.bodyOrder.at(-1)!;
    const draft = parsePly(
      await exact.exportMesh(document, [bodyId], {
        format: 'ply',
        deflection: 0.2
      })
    );
    const fine = parsePly(
      await exact.exportMesh(document, [bodyId], {
        format: 'ply',
        deflection: 0.02
      })
    );
    expect(draft.faceCount).toBeGreaterThan(0);
    expect(fine.faceCount).toBeGreaterThan(draft.faceCount);
  }, 120_000);
});
