import { afterEach, describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch
} from '@openzcad/document-core';
import { setTextFontProvider } from '@openzcad/geometry';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';

let adapter: ExactKernelAdapter | null = null;
afterEach(() => {
  adapter?.dispose();
  adapter = null;
  setTextFontProvider(null);
});

function rectangleWithText(construction: boolean) {
  const sketch = addSketchFeature(
    createProjectDocument(
      'Construction label',
      toUserId('user_text_readiness')
    ),
    {
      name: 'Rectangle and label',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [
        {
          objectKind: 'rectangle',
          centerX: 0,
          centerY: 0,
          width: 6,
          height: 5
        },
        {
          objectKind: 'text',
          text: 'Label',
          fontFamily: 'open-sans',
          fontStyle: 'regular',
          size: 2,
          x: 10,
          y: 10,
          construction
        }
      ]
    }
  );
  return extrudeSketch(sketch.document, {
    name: 'Rectangle solid',
    sketchId: sketch.sketchId,
    distance: 5
  }).document;
}

describe('exact readiness with an unloaded text font', () => {
  it('retains a complete solid when only construction text needs the font', async () => {
    setTextFontProvider(null);
    adapter = await createExactKernelAdapter();
    const document = rectangleWithText(true);
    const first = await adapter.syncDocument(document);
    expect(first.warnings).toEqual([]);
    const bodies = Object.values(first.bodyRepresentations).filter(
      (body) => !body.consumed
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.volume).toBeCloseTo(150, 8);
    expect(adapter.hasTransientFailures(first)).toBe(false);
    const repeated = await adapter.syncDocument(document);
    expect(adapter.hasTransientFailures(repeated)).toBe(false);
    expect(Object.values(repeated.bodyRepresentations)).toHaveLength(1);
  });

  it('keeps ordinary missing-font text transient', async () => {
    setTextFontProvider(null);
    adapter = await createExactKernelAdapter();
    const result = await adapter.syncDocument(rectangleWithText(false));
    expect(adapter.hasTransientFailures(result)).toBe(true);
  });
});
