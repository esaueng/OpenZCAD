import { act, render, screen } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import { describe, expect, it } from 'vitest';
import {
  ViewportGridReadout,
  type SketchGridReadoutSink
} from './ViewportScaleIndicator';

describe('ViewportGridReadout', () => {
  it('writes the spacing beside the Grid word and hides without a grid', () => {
    const sinkRef: MutableRefObject<SketchGridReadoutSink | null> = {
      current: null
    };
    render(<ViewportGridReadout sinkRef={sinkRef} />);
    const segment = screen.getByTitle(/Sketch grid spacing/);
    expect(segment).not.toBeVisible();

    act(() => sinkRef.current?.('2 mm'));
    expect(segment).toBeVisible();
    // The sink carries the value alone; the word is markup the compact
    // readout trades for a glyph.
    expect(segment).toHaveTextContent('Grid 2 mm');

    act(() => sinkRef.current?.(null));
    expect(segment).not.toBeVisible();
  });
});
