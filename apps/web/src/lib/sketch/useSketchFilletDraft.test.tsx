import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument,
  findSketch
} from '@openzcad/document-core';
import { toUserId, type SketchObjectData } from '@openzcad/shared';
import { useSketchFilletDraft } from './useSketchFilletDraft';

function fixture(objects: SketchObjectData[]) {
  const { document, sketchId } = addSketchFeature(
    createProjectDocument('Synthetic fillet input', toUserId('user_fillet')),
    {
      name: 'Lines',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects
    }
  );
  return { document, sketch: findSketch(document, sketchId)! };
}

describe('sketch fillet catalog refusal', () => {
  it('shows the work-limit refusal without breaking the editor and clears it for another sketch', async () => {
    const dense = fixture(
      Array.from({ length: 1500 }, (_, i) => ({
        objectKind: 'line',
        x1: 0,
        y1: i * 10,
        x2: 0,
        y2: i * 10 + 1
      }))
    );
    const rectangle = fixture([
      { objectKind: 'line', x1: 0, y1: 0, x2: 20, y2: 0 },
      { objectKind: 'line', x1: 20, y1: 0, x2: 20, y2: 20 },
      { objectKind: 'line', x1: 20, y1: 20, x2: 0, y2: 20 },
      { objectKind: 'line', x1: 0, y1: 20, x2: 0, y2: 0 }
    ]);
    const scope = {};
    const setKeypad = vi.fn();
    const { result, rerender } = renderHook(
      ({ input }) =>
        useSketchFilletDraft(
          input.document,
          input.sketch,
          true,
          scope,
          false,
          false,
          setKeypad
        ),
      { initialProps: { input: dense } }
    );
    await waitFor(() =>
      expect(result.current.refusal).toContain(
        'This sketch has too many nearby endpoints to check safely.'
      )
    );
    expect(result.current.corners).toEqual([]);
    expect(result.current.canFinish).toBe(false);
    expect(result.current.loading).toBe(false);
    rerender({ input: rectangle });
    expect(result.current.refusal).toBeNull();
    expect(result.current.corners).toHaveLength(4);
  });
});
