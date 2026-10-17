import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { addDatumPlane, createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { SketchPlanePrompt } from './SketchPlanePrompt';

function documentWithResolvedDatum() {
  const { document, featureId } = addDatumPlane(
    createProjectDocument('Prompt', toUserId('user_sketch_prompt')),
    {
      name: 'Plane 1',
      definition: {
        kind: 'offset',
        source: { type: 'canonical', plane: 'XY', offset: 0 },
        offset: 10
      }
    }
  );
  return {
    featureId,
    document: {
      ...document,
      derived: {
        ...document.derived,
        datumFrames: {
          [featureId]: {
            origin: { x: 0, y: 0, z: 10 },
            u: { x: 1, y: 0, z: 0 },
            v: { x: 0, y: 1, z: 0 },
            normal: { x: 0, y: 0, z: 1 }
          }
        }
      }
    }
  };
}

describe('SketchPlanePrompt datum planes (R01-C)', () => {
  it('starts a sketch attached to a resolved datum by id', () => {
    const { document, featureId } = documentWithResolvedDatum();
    const onEnterSketch = vi.fn();
    render(
      <SketchPlanePrompt
        document={document}
        offsetText="0"
        onOffsetTextChange={vi.fn()}
        onPickPlane={vi.fn()}
        onEnterSketch={onEnterSketch}
        onCancel={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sketch on Plane 1' }));
    expect(onEnterSketch).toHaveBeenCalledWith(
      { type: 'datum', datumFeatureId: featureId },
      'Sketching on Plane 1 · Finish Sketch when done.'
    );
  });

  it('refuses a datum while an offset is typed, rather than dropping it', () => {
    const { document } = documentWithResolvedDatum();
    const onEnterSketch = vi.fn();
    render(
      <SketchPlanePrompt
        document={document}
        offsetText="5"
        onOffsetTextChange={vi.fn()}
        onPickPlane={vi.fn()}
        onEnterSketch={onEnterSketch}
        onCancel={vi.fn()}
      />
    );
    const datum = screen.getByRole('button', { name: 'Sketch on Plane 1' });
    expect(datum).toBeDisabled();
    expect(datum).toHaveAttribute(
      'title',
      expect.stringContaining('Set it to 0')
    );
    fireEvent.click(datum);
    expect(onEnterSketch).not.toHaveBeenCalled();
  });
});
