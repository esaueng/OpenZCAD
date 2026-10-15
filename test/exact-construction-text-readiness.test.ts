import { afterEach, describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  findSketch,
  resolveParamValue
} from '@openzcad/document-core';
import {
  computeSketchProfileAnalysis,
  setTextFontProvider
} from '@openzcad/geometry';
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

function rectangleWithText(
  construction: boolean,
  selected?: 'entities' | 'region' | 'text' | 'both' | 'unknown-region',
  fontFamily = 'open-sans'
) {
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
          fontFamily,
          fontStyle: 'regular',
          size: 2,
          x: 10,
          y: 10,
          construction
        }
      ]
    }
  );
  const objects = findSketch(sketch.document, sketch.sketchId)!.objectIds;
  const rectangle = objects[0]!;
  const text = objects[1]!;
  const region =
    selected === 'region'
      ? computeSketchProfileAnalysis(
          [
            {
              id: rectangle,
              data: {
                objectKind: 'rectangle',
                centerX: 0,
                centerY: 0,
                width: 6,
                height: 5
              }
            }
          ],
          (value) =>
            resolveParamValue(
              value,
              {},
              'fixture dimension',
              sketch.document.units
            )
        ).profiles[0]!
      : selected === 'unknown-region'
        ? {
            profileId: 'unresolved-text-profile',
            regionFingerprint: 123,
            samplePoint: { x: 11, y: 11 },
            area: 1
          }
        : null;
  return extrudeSketch(sketch.document, {
    name: 'Rectangle solid',
    sketchId: sketch.sketchId,
    distance: 5,
    ...(selected === 'entities' || selected === 'text' || selected === 'both'
      ? {
          profiles: [
            {
              all: true,
              sourceEntityIds:
                selected === 'both'
                  ? [rectangle, text]
                  : [selected === 'text' ? text : rectangle]
            }
          ]
        }
      : region
        ? {
            profile: {
              profileId: region.profileId,
              regionFingerprint: region.regionFingerprint,
              samplePoint: region.samplePoint,
              sourceArea: region.area
            }
          }
        : {})
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

  it.each(['entities', 'region', undefined] as const)(
    'retains the complete selected rectangle when unrelated ordinary text has no font: %s',
    async (selected) => {
      setTextFontProvider(null);
      adapter = await createExactKernelAdapter();
      const document = rectangleWithText(false, selected);
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
    }
  );

  it.each(['text', 'both'] as const)(
    'keeps consumed ordinary missing-font text transient: %s',
    async (selected) => {
      setTextFontProvider(null);
      adapter = await createExactKernelAdapter();
      const result = await adapter.syncDocument(
        rectangleWithText(false, selected)
      );
      if (selected === 'text') {
        expect(result.warnings.some((warning) => /font/i.test(warning))).toBe(
          true
        );
        expect(Object.values(result.bodyRepresentations)).toHaveLength(0);
      } else {
        expect(Object.values(result.bodyRepresentations)).toHaveLength(1);
        expect(
          Object.values(result.bodyRepresentations)[0]!.volume
        ).toBeCloseTo(150, 8);
      }
      expect(adapter.hasTransientFailures(result)).toBe(true);
    }
  );
  it('keeps an unresolved identity-less text profile retryable', async () => {
    setTextFontProvider(null);
    adapter = await createExactKernelAdapter();
    const result = await adapter.syncDocument(
      rectangleWithText(false, 'unknown-region')
    );
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(Object.values(result.bodyRepresentations)).toHaveLength(0);
    expect(adapter.hasTransientFailures(result)).toBe(true);
  });

  it('keeps an unknown consumed font family a permanent document refusal', async () => {
    setTextFontProvider(null);
    adapter = await createExactKernelAdapter();
    const result = await adapter.syncDocument(
      rectangleWithText(false, 'text', 'unregistered-family')
    );
    expect(result.warnings.some((warning) => /font/i.test(warning))).toBe(true);
    expect(Object.values(result.bodyRepresentations)).toHaveLength(0);
    expect(adapter.hasTransientFailures(result)).toBe(false);
  });
});
