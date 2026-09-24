import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Three from 'three';
import { toBodyId, type BodyRepresentation } from '@openzcad/shared';

/** Stands in for WebGL, which happy-dom does not have. */
const fake = vi.hoisted(() => {
  const state = {
    created: 0,
    disposed: 0,
    contextsLost: 0,
    lost: false
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
    render() {}
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
  return { state, FakeRenderer };
});

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof Three>();
  return { ...actual, WebGLRenderer: fake.FakeRenderer };
});

const { renderThumbnailFrame } = await import('./partThumbnail');

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
    Object.assign(fake.state, { created: 0, disposed: 0, contextsLost: 0 });
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
  });

  it('replaces the renderer once the browser takes its context away', () => {
    fake.state.lost = true;

    expect(renderThumbnailFrame([triangle()])).toBe(
      'data:image/webp;base64,card'
    );

    expect(fake.state.created).toBe(1);
    expect(fake.state.disposed).toBe(1);
  });

  it('does not create a context for a document with nothing to draw', () => {
    fake.state.lost = true;

    expect(renderThumbnailFrame([])).toBeNull();

    expect(fake.state.created).toBe(0);
  });
});
