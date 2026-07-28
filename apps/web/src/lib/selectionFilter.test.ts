import { describe, expect, it } from 'vitest';
import {
  effectiveSelectionFilter,
  inferredSelectionFilter
} from './selectionFilter';

describe('a tool narrows picking to what it consumes', () => {
  it('sends the edge modifiers to edges', () => {
    expect(inferredSelectionFilter('fillet')).toBe('edge');
    expect(inferredSelectionFilter('chamfer')).toBe('edge');
  });

  it('sends the booleans and transforms to whole bodies', () => {
    for (const tool of [
      'union',
      'subtract',
      'intersect',
      'transform',
      'linear-pattern',
      'circular-pattern'
    ] as const) {
      expect(inferredSelectionFilter(tool)).toBe('body');
    }
  });

  it('sends Sketch to faces, since it attaches to one', () => {
    expect(inferredSelectionFilter('sketch')).toBe('face');
  });

  it('sends Extrude and Revolve to sketches', () => {
    expect(inferredSelectionFilter('extrude')).toBe('sketch');
    expect(inferredSelectionFilter('revolve')).toBe('sketch');
  });

  it('leaves picking alone for tools that place new geometry', () => {
    expect(inferredSelectionFilter('box')).toBe('any');
    expect(inferredSelectionFilter('cylinder')).toBe('any');
    expect(inferredSelectionFilter(null)).toBe('any');
  });
});

describe('a filter chosen by hand outranks the tool', () => {
  it('keeps the manual choice while a tool is armed', () => {
    expect(effectiveSelectionFilter('face', 'fillet')).toBe('face');
  });

  it('falls back to the tool once the manual choice is cleared', () => {
    expect(effectiveSelectionFilter(null, 'fillet')).toBe('edge');
  });

  it('lets a manual "any" defeat a tool that would narrow', () => {
    // Choosing Any is a decision, not an absence of one.
    expect(effectiveSelectionFilter('any', 'fillet')).toBe('any');
  });

  it('is any when nothing has an opinion', () => {
    expect(effectiveSelectionFilter(null, null)).toBe('any');
  });
});
