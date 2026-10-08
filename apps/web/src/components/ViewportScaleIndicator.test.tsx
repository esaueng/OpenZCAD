import { act, render, screen } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ViewportGridReadout,
  ViewportScaleIndicator,
  type SketchGridReadoutSink,
  type ViewportScaleSink
} from './ViewportScaleIndicator';

describe('ViewportScaleIndicator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('strokes the rule in the viewport colours, not the themed chrome ones', () => {
    // The light theme turns the chrome text dark; the viewport stays dark.
    const tokens: Record<string, string> = {
      '--color-text': '#111111',
      '--color-text-muted': '#222222',
      '--color-accent': '#333333',
      '--color-viewport-text': '#eeeeee',
      '--color-viewport-text-muted': '#dddddd',
      '--color-preselect': '#cccccc'
    };
    const computed = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) =>
      element instanceof HTMLCanvasElement
        ? ({
            getPropertyValue: (name: string) => tokens[name] ?? ''
          } as unknown as CSSStyleDeclaration)
        : computed(element, pseudo)
    );
    const strokes: string[] = [];
    const context = {
      setTransform() {},
      clearRect() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() {
        strokes.push(String(this.strokeStyle));
      },
      strokeStyle: '' as unknown,
      lineWidth: 1,
      lineCap: 'butt'
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D
    );
    const sinkRef: MutableRefObject<ViewportScaleSink | null> = {
      current: null
    };
    render(<ViewportScaleIndicator scaleSinkRef={sinkRef} units="mm" />);

    act(() => sinkRef.current?.({ value: 10, widthPx: 120 }));

    expect(strokes.length).toBeGreaterThan(0);
    expect(new Set(strokes)).toEqual(
      new Set(['#eeeeee', '#dddddd', '#cccccc'])
    );
  });

  it('is one named image, not a live region that reads every zoom step', () => {
    // The value was an <output>, a polite status announcing a bare "50 mm"
    // on each step, while the descriptive label sat on a role-less div.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const sinkRef: MutableRefObject<ViewportScaleSink | null> = {
      current: null
    };
    render(<ViewportScaleIndicator scaleSinkRef={sinkRef} units="mm" />);

    act(() => sinkRef.current?.({ value: 10, widthPx: 120 }));

    expect(
      screen.getByRole('img', {
        name: 'Viewport scale at the camera focus plane: 10 mm'
      })
    ).toBeVisible();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

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
