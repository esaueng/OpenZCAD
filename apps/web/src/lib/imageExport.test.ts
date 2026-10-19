import { describe, expect, it } from 'vitest';
import { exportScope } from './exportScope';
import {
  IMAGE_EXPORT_MAX_PIXELS,
  initialImageSketchId,
  imageSizeProblem,
  viewImageScope
} from './imageExport';

const body = (bodyId: string, hidden = false) => ({
  bodyId,
  exportable: true,
  hidden,
  withheld: false
});

describe('imageSizeProblem', () => {
  it('accepts whole sizes within the side and pixel caps', () => {
    expect(imageSizeProblem(1920, 1080)).toBeNull();
    expect(imageSizeProblem(16, 16)).toBeNull();
  });

  it('refuses fractional, tiny, oversized and over-budget sizes by name', () => {
    expect(imageSizeProblem(100.5, 100)).toMatch(/whole pixel sizes/);
    expect(imageSizeProblem(8, 100)).toMatch(/from 16/);
    expect(imageSizeProblem(5000, 100, 4096)).toMatch(/to 4096/);
    expect(imageSizeProblem(8000, 8000)).toMatch(/megapixels/);
    expect(8000 * 8000).toBeGreaterThan(IMAGE_EXPORT_MAX_PIXELS);
  });
});

describe('viewImageScope', () => {
  it('draws a selected body alone, as the mesh export writes it alone', () => {
    const scope = exportScope([body('a'), body('b')], 'b', true);
    expect(viewImageScope(scope, 'Boss')).toEqual({
      bodyIds: ['b'],
      label: 'Boss'
    });
  });

  it('keeps a selected body whose history step failed: the view draws it', () => {
    const scope = exportScope(
      [body('a'), { ...body('b'), withheld: true }],
      'b',
      true
    );
    expect(scope.bodyIds).toEqual([]);
    expect(viewImageScope(scope, 'Boss')).toEqual({
      bodyIds: ['b'],
      label: 'Boss'
    });
  });

  it('draws the view otherwise, counting hidden bodies as left out', () => {
    // Whatever the mesh export's include-hidden choice, the view never draws
    // a hidden body, so the image reports it as left out either way.
    for (const includeHidden of [true, false]) {
      const scope = exportScope(
        [body('a'), body('b'), body('c', true)],
        null,
        includeHidden
      );
      expect(viewImageScope(scope, null)).toEqual({
        label: 'visible bodies (2, 1 hidden left out)'
      });
    }
    expect(viewImageScope(exportScope([body('a')], null, true), null)).toEqual({
      label: 'visible bodies (1)'
    });
  });

  it('names the current view when there are no bodies or no scope', () => {
    expect(viewImageScope(exportScope([], null, true), null).label).toBe(
      'the current view'
    );
    expect(viewImageScope(null, null).label).toBe('the current view');
  });
});

describe('initialImageSketchId', () => {
  it('prefers the edited sketch, then the selected one, then a picked profile', () => {
    expect(
      initialImageSketchId({ editing: 'e', selected: 's', profiles: ['p'] })
    ).toBe('e');
    expect(
      initialImageSketchId({ editing: null, selected: 's', profiles: ['p'] })
    ).toBe('s');
    expect(
      initialImageSketchId({ editing: null, selected: null, profiles: ['p'] })
    ).toBe('p');
    expect(
      initialImageSketchId({ editing: null, selected: null, profiles: [] })
    ).toBeNull();
  });
});
