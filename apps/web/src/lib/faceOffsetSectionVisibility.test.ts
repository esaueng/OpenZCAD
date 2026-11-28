import { describe, expect, it } from 'vitest';
import type { BoundingBox } from '@openzcad/shared';
import {
  faceMeshBounds,
  offsetFaceExtents,
  sectionHidesFaceOffset,
  shownFaceOffset
} from './faceOffsetSectionVisibility';

// The +X side face of a 20 × 10 × 8 block: x = 20, y 0..10, z 0..8.
const sideFace: BoundingBox = {
  min: { x: 20, y: 0, z: 0 },
  max: { x: 20, y: 10, z: 8 }
};
const plusX = { x: 1, y: 0, z: 0 };
const plusZ = { x: 0, y: 0, z: 1 };
const still = {
  faces: [{ topologyId: 'side', bounds: sideFace, normal: plusX }],
  previewOffset: null
};

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
        {
          faces: [
            { topologyId: 'side', bounds: sideFace, normal: plusX },
            { topologyId: 'top', bounds: topFace, normal: plusZ }
          ],
          previewOffset: null
        },
        section
      )
    ).toBe(false);
    expect(
      sectionHidesFaceOffset(
        {
          faces: [
            { topologyId: 'side', bounds: sideFace, normal: plusX },
            { topologyId: 'top', bounds: topFace, normal: plusZ }
          ],
          previewOffset: null
        },
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
          faces: [
            {
              topologyId: 'side',
              bounds: { min: sideFace.min, max: { ...sideFace.max, z: NaN } },
              normal: plusX
            }
          ]
        },
        section
      )
    ).toBe(false);
  });
  it('moves each face of a set along its own normal', () => {
    // A 20 × 10 × 10 block: the top at z = 10, the handle on the +X side.
    // An XY cut at z = 11 keeps both; a +2 preview lifts the top to z = 12.
    const top: BoundingBox = {
      min: { x: 0, y: 0, z: 10 },
      max: { x: 20, y: 10, z: 10 }
    };
    const side: BoundingBox = {
      min: { x: 20, y: 0, z: 0 },
      max: { x: 20, y: 10, z: 10 }
    };
    const section = { plane: 'XY', offset: 11 } as const;
    const faces = [
      { topologyId: 'side', bounds: side, normal: plusX },
      { topologyId: 'top', bounds: top, normal: plusZ }
    ];
    expect(
      sectionHidesFaceOffset({ faces, previewOffset: null }, section)
    ).toBe(false);
    expect(sectionHidesFaceOffset({ faces, previewOffset: 2 }, section)).toBe(
      true
    );
    // Shifting every face along the handle's +X normal missed it.
    expect(
      sectionHidesFaceOffset(
        {
          faces: faces.map((face) => ({ ...face, normal: plusX })),
          previewOffset: 2
        },
        section
      )
    ).toBe(false);
  });

  it('keeps a fine tolerance for a face far from the origin across the cut', () => {
    // A 1 mm face at x = 1e6, spanning z 0..1, cut at z = 0.5.
    const far: BoundingBox = {
      min: { x: 1e6, y: 0, z: 0 },
      max: { x: 1e6, y: 1, z: 1 }
    };
    expect(
      sectionHidesFaceOffset(
        {
          faces: [{ topologyId: 'far', bounds: far, normal: plusX }],
          previewOffset: null
        },
        { plane: 'XY', offset: 0.5 }
      )
    ).toBe(true);
  });
});

describe('shownFaceOffset', () => {
  it('reads the frame the viewer draws, and nothing moved without one', () => {
    expect(shownFaceOffset({ offset: 2 })).toEqual({ previewOffset: 2 });
    expect(shownFaceOffset({ offset: 2, movedTopologyIds: ['top'] })).toEqual({
      previewOffset: 2,
      movedTopologyIds: ['top']
    });
    // A frame taken down (a refused whole rebuild clears the leading frame)
    // leaves the source body on screen, whatever the last whole preview was.
    expect(shownFaceOffset(null)).toEqual({ previewOffset: null });
    expect(shownFaceOffset({})).toEqual({ previewOffset: null });
  });
});

describe('a face set drag frame by frame', () => {
  // A 20 × 10 × 10 block's +Z top and +X side (x = 20), offset together;
  // a YZ cut at x = 21 keeps x ≤ 21.
  const top: BoundingBox = {
    min: { x: 0, y: 0, z: 10 },
    max: { x: 20, y: 10, z: 10 }
  };
  const side: BoundingBox = {
    min: { x: 20, y: 0, z: 0 },
    max: { x: 20, y: 10, z: 10 }
  };
  const faces = [
    { topologyId: 'side', bounds: side, normal: plusX },
    { topologyId: 'top', bounds: top, normal: plusZ }
  ];
  const section = { plane: 'YZ', offset: 21 } as const;
  const hides = (frame: Parameters<typeof shownFaceOffset>[0]) =>
    sectionHidesFaceOffset({ faces, ...shownFaceOffset(frame) }, section);

  it('keeps the faces a leading-plane frame has not moved in place', () => {
    // The +2 leading frame lifts the top alone: the side stays at x = 20.
    expect(hides({ offset: 2, movedTopologyIds: ['top'] })).toBe(false);
  });

  it('reports the whole frame once it moves the side into the cut', () => {
    expect(hides({ offset: 2 })).toBe(true);
    // A leading frame that moves the side is reported as well.
    expect(hides({ offset: 2, movedTopologyIds: ['side'] })).toBe(true);
  });

  it('goes quiet when a refusal takes the frame down', () => {
    expect(hides({ offset: 2 })).toBe(true);
    expect(hides(null)).toBe(false);
  });
});

describe('offsetFaceExtents', () => {
  // Triangle 0: the +X side (x = 5); triangle 1: the top (z = 7).
  const body = {
    mesh: {
      kind: 'mesh' as const,
      vertices: new Float32Array([
        5, 0, 0, 5, 2, 0, 5, 0, 7, 0, 0, 7, 5, 0, 7, 0, 2, 7
      ]),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5])
    },
    topology: {
      faces: [
        { topologyId: 'side', hash: 1, triangleStart: 0, triangleCount: 1 },
        {
          topologyId: 'top',
          hash: 2,
          triangleStart: 1,
          triangleCount: 1,
          geometry: { surfaceType: 'plane', normal: { x: 0, y: 0, z: 3 } }
        }
      ],
      edges: [],
      vertices: []
    }
  } as unknown as Parameters<typeof offsetFaceExtents>[0];

  it('gives the handle the handle normal and each set face its own', () => {
    const extents = offsetFaceExtents(body, {
      topologyId: 'side',
      normal: [1, 0, 0],
      offsetFaceSet: [{ topologyId: 'top' }]
    });
    expect(extents.map((extent) => extent.normal)).toEqual([plusX, plusZ]);
    expect(extents[1]!.bounds.min.z).toBe(7);
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
