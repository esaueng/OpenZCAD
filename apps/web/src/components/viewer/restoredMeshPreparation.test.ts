import { describe, expect, it } from 'vitest';
import { toBodyId, type GeometryBodyRepresentation } from '@openzcad/shared';
import { prepareBody } from './prepareBody';
import { RestoredMeshPreparation } from './restoredMeshPreparation';

function panel(): GeometryBodyRepresentation {
  return {
    bodyId: toBodyId('panel'),
    name: 'Panel',
    source: 'primitive',
    color: '#abcdef',
    consumed: false,
    exportableStep: true,
    faceCount: 2,
    bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } },
    mesh: {
      kind: 'mesh',
      vertices: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0),
      indices: Uint32Array.of(0, 1, 2, 2, 1, 3)
    },
    topology: {
      faces: [
        { topologyId: 'left', hash: 10, triangleStart: 0, triangleCount: 1 },
        { topologyId: 'right', hash: 11, triangleStart: 1, triangleCount: 1 }
      ],
      edges: [
        {
          topologyId: 'join',
          hash: 21,
          adjacentFaceHashes: [10, 11],
          points: [1, 0, 0, 0, 1, 0]
        }
      ]
    }
  };
}

describe('restoring prepared display meshes', () => {
  it('restores all display buffers after installation releases its staging wrapper', () => {
    const cache = new RestoredMeshPreparation();
    const original = panel();
    const prepared = prepareBody(original);
    expect(prepared.tangentIds).toEqual(new Set(['join']));
    cache.remember(original, prepared);
    delete prepared.geometry;
    const next = structuredClone(original);
    next.name = 'Restored panel';
    next.topology!.edges[0]!.points = [1, 0, 0, 0.5, 0.5, 0, 0, 1, 0];
    const hit = cache.restore(next);
    expect(hit).toEqual(prepareBody(next));
    delete hit!.geometry;
    expect(cache.restore(next)?.geometry).toBeDefined();
  });

  it('declines changes in every input used by shading and tangent classification', () => {
    const original = panel();
    const cache = new RestoredMeshPreparation();
    cache.remember(original, prepareBody(original));
    const changes: ((b: GeometryBodyRepresentation) => void)[] = [
      (b) => {
        b.source = 'helical-sweep';
      },
      (b) => {
        b.bodyId = toBodyId('other');
      },
      (b) => {
        b.mesh.vertices[0] = -0;
      },
      (b) => {
        b.mesh.indices[1] = 3;
      },
      (b) => {
        b.topology!.faces[1]!.triangleStart = 0;
      },
      (b) => {
        b.topology!.faces[0]!.hash = 20;
      },
      (b) => {
        b.topology!.edges[0]!.topologyId = 'new-edge';
      },
      (b) => {
        b.topology!.edges[0]!.adjacentFaceHashes = [10, 20];
      },
      (b) => {
        b.topology!.edges = [];
      }
    ];
    for (const change of changes) {
      const next = structuredClone(original);
      change(next);
      expect(cache.restore(next)).toBeUndefined();
    }
  });

  it('keeps the restored revision through a second edit and prioritizes the edited body', () => {
    const a = panel(),
      b = panel(),
      a1 = panel(),
      a2 = panel();
    b.bodyId = toBodyId('second panel');
    a1.mesh.vertices[0] = 1;
    a2.mesh.vertices[0] = 2;
    const cache = new RestoredMeshPreparation();
    for (const input of [a, b, a1]) cache.remember(input, prepareBody(input));
    expect(cache.restore(a)).toBeDefined();
    cache.remember(a2, prepareBody(a2));
    expect(cache.restore(a)).toBeDefined();
    expect(cache.restore(a1)).toBeUndefined();
  });
  it('evicts old meshes and counts the entire backing allocation of a subarray', () => {
    const cache = new RestoredMeshPreparation();
    const items = [panel(), panel(), panel()];
    items.forEach((item, i) => {
      item.mesh.vertices[0] = i;
      cache.remember(item, prepareBody(item));
    });
    expect(cache.restore(items[0]!)).toBeUndefined();
    expect(cache.restore(items[1]!)).toBeDefined();
    const large = panel();
    const view = new Float32Array(
      new ArrayBuffer(13 * 1024 * 1024),
      0,
      large.mesh.vertices.length
    );
    view.set(large.mesh.vertices);
    large.mesh.vertices = view;
    cache.remember(large, prepareBody(large));
    expect(cache.restore(large)).toBeUndefined();
    expect(cache.restore(items[2]!)).toBeDefined();
  });
});
