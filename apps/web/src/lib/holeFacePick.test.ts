import { describe, expect, it } from 'vitest';
import {
  toBodyId,
  type BodyTopology,
  type TopologySelection
} from '@openzcad/shared';
import { resolveFormFaceBox, resolveFormFacePick } from './holeFacePick';

const bodyId = toBodyId('plate');
const selection: TopologySelection = {
  bodyId,
  kind: 'face',
  topologyId: 'top',
  hash: 42
};
const topology: BodyTopology = {
  edges: [],
  faces: [
    {
      topologyId: 'top',
      hash: 42,
      triangleStart: 0,
      triangleCount: 2,
      geometry: {
        surfaceType: 'plane',
        area: 100,
        center: { x: 0, y: 0, z: 0 }
      }
    }
  ]
};

describe('Hole viewport face picking', () => {
  it('accepts the current planar face and keeps its exact identity', () => {
    expect(resolveFormFacePick('hole', bodyId, selection, topology)).toEqual({
      ok: true,
      selection,
      pick: { bodyId, hash: 42 }
    });
  });

  it.each([
    [null, topology, 'planar face'],
    [{ ...selection, kind: 'edge' as const }, topology, 'planar face'],
    [
      { ...selection, bodyId: toBodyId('other') },
      topology,
      'current target body'
    ],
    [{ ...selection, hash: 43 }, topology, 'no longer available'],
    [selection, undefined, 'no longer available'],
    [
      selection,
      {
        ...topology,
        faces: [
          {
            ...topology.faces[0]!,
            geometry: {
              surfaceType: 'cylinder' as const,
              area: 100,
              center: { x: 0, y: 0, z: 0 }
            }
          }
        ]
      },
      'must be planar'
    ]
  ])(
    'refuses an unsuitable pick without substituting a different face',
    (pick, currentTopology, reason) => {
      const result = resolveFormFacePick('hole', bodyId, pick, currentTopology);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain(reason);
    }
  );
});

describe('Form viewport face picking for shell, draft and thicken', () => {
  const cylinderTopology: BodyTopology = {
    ...topology,
    faces: [
      {
        ...topology.faces[0]!,
        geometry: {
          surfaceType: 'cylinder',
          area: 100,
          center: { x: 0, y: 0, z: 0 }
        }
      }
    ]
  };

  it('lets shell and thicken take any exact face, planar or not', () => {
    for (const operation of ['shell', 'thicken'] as const) {
      expect(
        resolveFormFacePick(operation, bodyId, selection, cylinderTopology)
      ).toMatchObject({ ok: true, pick: { bodyId, hash: 42 } });
    }
  });

  it('keeps draft on planar faces and names the operation in its refusal', () => {
    const result = resolveFormFacePick(
      'draft',
      bodyId,
      selection,
      cylinderTopology
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/^Draft: only planar faces/);
  });

  it('refuses a pick on another body for every face-collecting form', () => {
    for (const operation of ['hole', 'shell', 'draft', 'thicken'] as const) {
      const result = resolveFormFacePick(
        operation,
        bodyId,
        { ...selection, bodyId: toBodyId('other') },
        topology
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('current target body');
    }
  });
});

describe('a box sweep into a face-collecting card', () => {
  const plate: BodyTopology = {
    edges: [],
    faces: [
      topology.faces[0]!,
      {
        topologyId: 'side',
        hash: 43,
        triangleStart: 2,
        triangleCount: 2,
        geometry: {
          surfaceType: 'plane',
          area: 20,
          center: { x: 0, y: 0, z: 0 }
        }
      },
      {
        topologyId: 'bore',
        hash: 44,
        triangleStart: 4,
        triangleCount: 8,
        geometry: {
          surfaceType: 'cylinder',
          area: 30,
          center: { x: 0, y: 0, z: 0 }
        }
      }
    ]
  };
  const face = (topologyId: string, hash: number, body = bodyId) => ({
    bodyId: body,
    kind: 'face' as const,
    topologyId,
    hash
  });
  const swept = [
    face('top', 42),
    face('side', 43),
    face('bore', 44),
    face('elsewhere', 99, toBodyId('other'))
  ];

  it('hands Shell every face on its body', () => {
    expect(resolveFormFaceBox('shell', bodyId, swept, plate)).toEqual({
      ok: true,
      pick: { bodyId, hash: 42, hashes: [42, 43, 44] },
      added: 3,
      skipped: 1
    });
  });

  it('hands Draft only the planar ones', () => {
    expect(resolveFormFaceBox('draft', bodyId, swept, plate)).toMatchObject({
      ok: true,
      pick: { hashes: [42, 43] },
      added: 2,
      skipped: 2
    });
  });

  it('gives a one-face card a sweep only when it took one face', () => {
    expect(
      resolveFormFaceBox('thicken', bodyId, [face('bore', 44)], plate)
    ).toEqual({ ok: true, pick: { bodyId, hash: 44 }, added: 1, skipped: 0 });
    const refused = resolveFormFaceBox('hole', bodyId, swept, plate);
    expect(refused.ok).toBe(false);
    if (!refused.ok)
      expect(refused.reason).toBe(
        'Hole takes one face: click it, or box just that face.'
      );
  });

  it('says why when nothing in the box is usable', () => {
    const refused = resolveFormFaceBox(
      'draft',
      bodyId,
      [face('bore', 44)],
      plate
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toMatch(/^Draft: only planar/);
  });
});
