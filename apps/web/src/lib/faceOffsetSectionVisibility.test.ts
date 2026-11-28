import { describe, expect, it } from 'vitest';
import type { BoundingBox } from '@openzcad/shared';
import {
  faceMeshBounds,
  sectionHidesFaceOffset
} from './faceOffsetSectionVisibility';

// The +X side face of a 20 × 10 × 8 block: x = 20, y 0..10, z 0..8.
const sideFace: BoundingBox = {
  min: { x: 20, y: 0, z: 0 },
  max: { x: 20, y: 10, z: 8 }
};
const plusX = { x: 1, y: 0, z: 0 };
const still = { faces: [sideFace], normal: plusX, previewOffset: null };

describe('sectionHidesFaceOffset', () => {
  it('is silent when the cut keeps the whole face', () => {
    // XY at z = 12 cuts away z > 12; the face tops out at z = 8.
    expect(sectionHidesFaceOffset(still, { plane: 'XY', offset: 12 })).toBe(
      false
    );
    // YZ at x = 30 keeps x ≤ 30.
    expect(sectionHidesFaceOffset(still, { plane: 'YZ', offset: 30 })).toBe(
      false
    );
  });

  it('reports a cut through the face', () => {
    // XZ at y = 5 cuts away y > 5: the face's upper half.
    expect(sectionHidesFaceOffset(still, { plane: 'XZ', offset: 5 })).toBe(
      true
    );
    // XY at z = 4: the top half.
    expect(sectionHidesFaceOffset(still, { plane: 'XY', offset: 4 })).toBe(
      true
    );
  });

  it('reports a face the cut removes entirely', () => {
    expect(sectionHidesFaceOffset(still, { plane: 'YZ', offset: 10 })).toBe(
      true
    );
  });

  it('follows the kept side of a flipped cut', () => {
    // Flipped, YZ at x = 10 keeps x ≥ 10: the face stays whole.
    expect(
      sectionHidesFaceOffset(still, { plane: 'YZ', offset: 10, flipped: true })
    ).toBe(false);
    // Flipped XY at z = 4 keeps z ≥ 4: the face's lower half goes.
    expect(
      sectionHidesFaceOffset(still, { plane: 'XY', offset: 4, flipped: true })
    ).toBe(true);
  });

  it('counts a face lying in the cut plane as shown', () => {
    expect(sectionHidesFaceOffset(still, { plane: 'YZ', offset: 20 })).toBe(
      false
    );
    // Within the Float32 clipping slack of the plane, too.
    expect(
      sectionHidesFaceOffset(still, { plane: 'YZ', offset: 20 - 1e-6 })
    ).toBe(false);
  });

  it('reports a preview that moves the face into the cut', () => {
    const section = { plane: 'YZ', offset: 24 } as const;
    expect(sectionHidesFaceOffset(still, section)).toBe(false);
    expect(
      sectionHidesFaceOffset({ ...still, previewOffset: 3 }, section)
    ).toBe(false);
    expect(
      sectionHidesFaceOffset({ ...still, previewOffset: 6 }, section)
    ).toBe(true);
    // An inward preview stays on the kept side.
    expect(
      sectionHidesFaceOffset({ ...still, previewOffset: -6 }, section)
    ).toBe(false);
  });

  it('reports a face whose original place is cut while the preview is not', () => {
    // The cut keeps x ≤ 18; the preview pulls the face back to x = 15, but
    // the material the edit removes, up to x = 20, is still cut away.
    expect(
      sectionHidesFaceOffset(
        { ...still, previewOffset: -5 },
        { plane: 'YZ', offset: 18 }
      )
    ).toBe(true);
  });

  it('reports any face of a face set', () => {
    const topFace: BoundingBox = {
      min: { x: 0, y: 0, z: 8 },
      max: { x: 20, y: 10, z: 8 }
    };
    const section = { plane: 'XY', offset: 8.5 } as const;
    expect(
      sectionHidesFaceOffset(
        { faces: [sideFace, topFace], normal: plusX, previewOffset: null },
        section
      )
    ).toBe(false);
    expect(
      sectionHidesFaceOffset(
        { faces: [sideFace, topFace], normal: plusX, previewOffset: null },
        { plane: 'XZ', offset: 9 }
      )
    ).toBe(true);
  });

  it('stays silent without faces or with unreadable input', () => {
    const section = { plane: 'XY', offset: 4 } as const;
    expect(sectionHidesFaceOffset({ ...still, faces: [] }, section)).toBe(
      false
    );
    expect(
      sectionHidesFaceOffset(still, { plane: 'XY', offset: Number.NaN })
    ).toBe(false);
    expect(
      sectionHidesFaceOffset(
        {
          ...still,
          faces: [{ min: sideFace.min, max: { ...sideFace.max, z: NaN } }]
        },
        section
      )
    ).toBe(false);
  });
});

describe('faceMeshBounds', () => {
  // Two faces: triangle 0 on z = 0, triangle 1 on x = 5.
  const body = {
    mesh: {
      kind: 'mesh' as const,
      vertices: new Float32Array([
        0, 0, 0, 4, 0, 0, 0, 3, 0, 5, 0, 0, 5, 2, 0, 5, 0, 7
      ]),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5])
    },
    topology: {
      faces: [
        { topologyId: 'f0', hash: 1, triangleStart: 0, triangleCount: 1 },
        { topologyId: 'f1', hash: 2, triangleStart: 1, triangleCount: 1 }
      ],
      edges: [],
      vertices: []
    }
  } as unknown as Parameters<typeof faceMeshBounds>[0];

  it('boxes only the named face’s triangles', () => {
    expect(faceMeshBounds(body, 'f0')).toEqual({
      min: { x: 0, y: 0, z: 0 },
      max: { x: 4, y: 3, z: 0 }
    });
    expect(faceMeshBounds(body, 'f1')).toEqual({
      min: { x: 5, y: 0, z: 0 },
      max: { x: 5, y: 2, z: 7 }
    });
  });

  it('is null for an unknown face or a mesh that does not cover it', () => {
    expect(faceMeshBounds(body, 'missing')).toBeNull();
    expect(
      faceMeshBounds(
        {
          ...body,
          topology: {
            ...body.topology!,
            faces: [
              { topologyId: 'f2', hash: 3, triangleStart: 1, triangleCount: 4 }
            ]
          }
        },
        'f2'
      )
    ).toBeNull();
  });
});
