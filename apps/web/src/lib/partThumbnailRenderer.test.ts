import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Three from 'three';
import {
  addSketchFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toBodyId, toUserId, type BodyRepresentation } from '@openzcad/shared';
import { preloadDocumentFonts } from './textFonts';

/** Stands in for WebGL, which happy-dom does not have. */
const fake = vi.hoisted(() => {
  const state = {
    created: 0,
    disposed: 0,
    contextsLost: 0,
    environments: 0,
    lost: false,
    draw: null as { objects: string[]; direction: number[] } | null
  };
  class FakeRenderer {
    domElement = { toDataURL: () => 'data:image/webp;base64,card' };
    constructor() {
      state.created += 1;
      state.lost = false;
    }
    setPixelRatio() {}
    setSize() {}
    setClearColor() {}
    render(scene: Three.Scene, camera: Three.Camera) {
      const objects: string[] = [];
      scene.traverse((object) => objects.push(object.type));
      state.draw = {
        objects,
        direction: camera.getWorldDirection(camera.position.clone()).toArray()
      };
    }
    getContext() {
      return { isContextLost: () => state.lost };
    }
    dispose() {
      state.disposed += 1;
    }
    forceContextLoss() {
      state.contextsLost += 1;
    }
  }
  class FakePmrem {
    fromScene() {
      state.environments += 1;
      return { texture: { dispose() {} } };
    }
    dispose() {}
  }
  return { state, FakeRenderer, FakePmrem };
});

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof Three>();
  return {
    ...actual,
    WebGLRenderer: fake.FakeRenderer,
    PMREMGenerator: fake.FakePmrem
  };
});

vi.mock('./textFonts', () => ({
  preloadDocumentFonts: vi.fn().mockResolvedValue(undefined)
}));

const { renderPartThumbnail, renderThumbnailFrame } =
  await import('./partThumbnail');

function triangle(): BodyRepresentation {
  return {
    bodyId: toBodyId('body_card'),
    name: 'Card',
    source: 'primitive',
    mesh: {
      kind: 'mesh',
      vertices: Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0]),
      indices: Uint32Array.from([0, 1, 2])
    },
    faceCount: 1,
    color: '#334455',
    consumed: false,
    exportableStep: true,
    volume: 0,
    bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 } }
  };
}

describe('renderThumbnailFrame', () => {
  beforeEach(() => {
    fake.state.lost = true; // force a fresh renderer per test
    renderThumbnailFrame([triangle()]);
    Object.assign(fake.state, {
      created: 0,
      disposed: 0,
      contextsLost: 0,
      environments: 0,
      draw: null
    });
  });

  it('draws every card with one kept renderer', () => {
    // A renderer per card cost a context and a full set of shader links on
    // every idle capture, blocking the main thread mid-gesture on software GL.
    expect(renderThumbnailFrame([triangle()])).toBe(
      'data:image/webp;base64,card'
    );
    expect(renderThumbnailFrame([triangle()])).toBe(
      'data:image/webp;base64,card'
    );

    expect(fake.state.created).toBe(0);
    expect(fake.state.disposed).toBe(0);
    expect(fake.state.contextsLost).toBe(0);
    // The studio environment is baked with the renderer, not per card.
    expect(fake.state.environments).toBe(0);
  });

  it('replaces the renderer once the browser takes its context away', () => {
    fake.state.lost = true;

    expect(renderThumbnailFrame([triangle()])).toBe(
      'data:image/webp;base64,card'
    );

    expect(fake.state.created).toBe(1);
    expect(fake.state.disposed).toBe(1);
    expect(fake.state.environments).toBe(1);
  });

  it('does not create a context for a document with nothing to draw', () => {
    fake.state.lost = true;

    expect(renderThumbnailFrame([])).toBeNull();

    expect(fake.state.created).toBe(0);
  });

  it('frames open curves and points head-on when there are no live body meshes', () => {
    const { document } = addSketchFeature(
      createProjectDocument('Sketch', toUserId('owner')),
      {
        name: 'Sketch',
        planeRef: { type: 'canonical', plane: 'YZ', offset: 25 },
        objects: [
          { objectKind: 'line', x1: 0, y1: 0, x2: 20, y2: 10 },
          { objectKind: 'point', x: 10, y: 15 }
        ]
      }
    );
    expect(
      renderThumbnailFrame([{ ...triangle(), consumed: true }], document)
    ).toContain('data:image/webp');
    expect(fake.state.draw?.objects).toEqual([
      'Scene',
      'Group',
      'Line2',
      'Points'
    ]);
    expect(fake.state.draw?.direction[0]).toBeCloseTo(-1);

    renderThumbnailFrame([triangle()], document);
    expect(fake.state.draw?.objects).not.toContain('Line2');
    expect(fake.state.draw?.objects).not.toContain('Points');
  });

  it('preloads sketch fonts when the body has no mesh triangles', async () => {
    const { document } = addSketchFeature(
      createProjectDocument('Sketch', toUserId('owner')),
      {
        name: 'Sketch',
        objects: [{ objectKind: 'line', x1: 0, y1: 0, x2: 20, y2: 10 }]
      }
    );
    const body = triangle();
    body.mesh.indices = new Uint32Array();

    expect(await renderPartThumbnail([body], document)).toContain(
      'data:image/webp'
    );
    expect(preloadDocumentFonts).toHaveBeenCalledWith(document);
  });
});
