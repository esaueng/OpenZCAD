import { act, render, screen } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ViewportGridReadout,
  ViewportScaleIndicator,
  scaleRulePlacement,
  type SketchGridReadoutSink,
  type ViewportScaleSink
} from './ViewportScaleIndicator';

describe('ViewportScaleIndicator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  {
    it('keeps unchanged label nodes and bitmap dimensions while the rule changes length', () => {
      const clearRect = vi.fn();
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
        setTransform() {},
        clearRect,
        beginPath() {},
        moveTo() {},
        lineTo() {},
        stroke() {}
      } as unknown as CanvasRenderingContext2D);
      const sinkRef: MutableRefObject<ViewportScaleSink | null> = {
        current: null
      };
      render(<ViewportScaleIndicator scaleSinkRef={sinkRef} units="mm" />);
      act(() => sinkRef.current?.({ value: 10, widthPx: 120.1 }));
      const root = screen.getByTestId('viewport-scale-indicator');
      const canvas = screen.getByTestId<HTMLCanvasElement>(
        'viewport-scale-rule'
      );
      const value = root.querySelector('output')!;
      const text = value.firstChild;
      const observer = new MutationObserver(() => undefined);
      observer.observe(root, {
        attributes: true,
        childList: true,
        subtree: true
      });
      clearRect.mockClear();
      act(() => sinkRef.current?.({ value: 10, widthPx: 120.2 }));
      const mutations = observer.takeRecords();
      observer.disconnect();
      expect(value.firstChild).toBe(text);
      expect(
        mutations.filter((mutation) => mutation.type === 'childList')
      ).toEqual([]);
      expect(mutations.filter((mutation) => mutation.target === root)).toEqual(
        []
      );
      expect(
        mutations.filter((mutation) =>
          ['width', 'height'].includes(mutation.attributeName ?? '')
        )
      ).toEqual([]);
      expect(clearRect).toHaveBeenLastCalledWith(
        0,
        0,
        canvas.width,
        canvas.height
      );
      act(() => sinkRef.current?.({ value: 20, widthPx: 140 }));
      expect(value).toHaveTextContent('20 mm');
      expect(root).toHaveAccessibleName(
        'Viewport scale at the model center plane: 20 mm'
      );
    });

    it('draws the rule upright: its length is its height', () => {
      const transforms: number[][] = [];
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
        setTransform: (...args: number[]) => transforms.push(args),
        clearRect() {},
        beginPath() {},
        moveTo() {},
        lineTo() {},
        stroke() {}
      } as unknown as CanvasRenderingContext2D);
      const sinkRef: MutableRefObject<ViewportScaleSink | null> = {
        current: null
      };
      render(<ViewportScaleIndicator scaleSinkRef={sinkRef} units="mm" />);
      act(() => sinkRef.current?.({ value: 10, widthPx: 120 }));

      const canvas = screen.getByTestId<HTMLCanvasElement>(
        'viewport-scale-rule'
      );
      // 18px across the rule, 120px along it.
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      expect([canvas.width, canvas.height]).toEqual([
        Math.round(18 * ratio),
        Math.round(120 * ratio)
      ]);
      expect(canvas.style.getPropertyValue('--viewport-scale-length')).toBe(
        '120px'
      );
      expect(transforms.at(-1)?.[0]).toBe(ratio);
    });
  }

  it('keeps the bottom-left corner, shortening or stepping aside for the rail', () => {
    const corner = { left: 10, bottom: 832 };
    const bar = { left: 190, top: 798, right: 710, bottom: 832 };
    // No rail: the full rule in the corner.
    expect(scaleRulePlacement(corner, 60, null, bar)).toEqual({
      left: 10,
      bottom: 832,
      maxLengthPx: 200
    });
    // 1000 x 842: the rail ends at 640 and the rule takes the room under it.
    const rail = { left: 10, top: 253, right: 50, bottom: 640 };
    expect(scaleRulePlacement(corner, 60, rail, bar)).toEqual({
      left: 10,
      bottom: 832,
      maxLengthPx: 184
    });
    // A taller rail leaves a stub's worth: the rule stands beside it.
    expect(
      scaleRulePlacement(corner, 60, { ...rail, bottom: 780 }, bar)
    ).toEqual({ left: 60, bottom: 832, maxLengthPx: 200 });
    // A short window caps the rule at the stage's height, never below 32px.
    expect(
      scaleRulePlacement({ left: 10, bottom: 150 }, 60, null, null)
    ).toEqual({ left: 10, bottom: 150, maxLengthPx: 90 });
    expect(
      scaleRulePlacement({ left: 10, bottom: 70 }, 60, null, null)
    ).toEqual({ left: 10, bottom: 70, maxLengthPx: 32 });
  });

  it('stands on the search bar and its status row where the bar reaches the corner', () => {
    // A phone: beside the rail the value would run under the bar at 116.
    const rail = { left: 10, top: 178, right: 50, bottom: 565 };
    const bar = { left: 116, top: 596, right: 310, bottom: 630 };
    expect(
      scaleRulePlacement({ left: 10, bottom: 630 }, 110, rail, bar)
    ).toEqual({ left: 60, bottom: 548, maxLengthPx: 200 });
    // A sheet docked across the foot caps the rule as the rail does.
    expect(
      scaleRulePlacement({ left: 10, bottom: 834 }, 110, null, bar, {
        left: 10,
        top: 520,
        right: 380,
        bottom: 744
      })
    ).toEqual({ left: 10, bottom: 834, maxLengthPx: 82 });
    // The bar clear of the corner leaves the rule on the stage's foot.
    expect(
      scaleRulePlacement({ left: 10, bottom: 630 }, 110, null, bar)
    ).toEqual({ left: 10, bottom: 630, maxLengthPx: 200 });
  });

  it('strokes the rule in the stage ink, not the chrome text colours', () => {
    // The rule sits straight on the stage, so it follows the stage's ink
    // rather than the chrome's, which can differ from it.
    const tokens: Record<string, string> = {
      '--color-text': '#111111',
      '--color-text-muted': '#222222',
      '--color-accent': '#333333',
      '--color-stage-ink': '#eeeeee',
      '--color-stage-ink-muted': '#dddddd',
      '--color-preselect': '#cccccc'
    };
    const computed = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      (element, pseudo) =>
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
        name: 'Viewport scale at the model center plane: 10 mm'
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
