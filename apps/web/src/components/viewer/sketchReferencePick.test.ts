import { describe, expect, it } from 'vitest';
import type { BodyId } from '@openzcad/shared';
import type { PickCandidate } from '@openzcad/viewport';
import {
  isSketchReferenceSelection,
  sketchReferenceHoverApplies,
  sketchReferencePick,
  sketchToolTakesReference
} from './sketchReferencePick';

const topology = (
  kind: 'edge' | 'face' | 'body',
  topologyId: string,
  distance: number
): PickCandidate => ({
  kind,
  distance,
  hit: {} as PickCandidate['hit'],
  selection: { bodyId: 'b' as BodyId, kind, topologyId }
});

const sketchCurve = (distance: number): PickCandidate => ({
  kind: 'sketch',
  distance,
  hit: {} as PickCandidate['hit'],
  selection: null,
  sketchId: 's'
});

const region = (distance: number): PickCandidate => ({
  kind: 'region',
  distance,
  hit: {} as PickCandidate['hit'],
  selection: null
});

describe('isSketchReferenceSelection', () => {
  it('takes model edges and faces', () => {
    expect(isSketchReferenceSelection({ kind: 'edge' })).toBe(true);
    expect(isSketchReferenceSelection({ kind: 'face' })).toBe(true);
  });

  it('refuses whole bodies, sketch geometry and empty space', () => {
    expect(isSketchReferenceSelection({ kind: 'body' })).toBe(false);
    expect(isSketchReferenceSelection(null)).toBe(false);
    expect(isSketchReferenceSelection(undefined)).toBe(false);
  });
});

describe('sketchReferencePick', () => {
  it('returns the nearest edge or face, as the click takes it', () => {
    const stack = [topology('edge', 'e1', 1), topology('face', 'f1', 2)];
    expect(sketchReferencePick(stack)?.selection?.topologyId).toBe('e1');
  });

  it('passes over sketch curves and regions in front of a face', () => {
    const stack = [sketchCurve(0.5), region(0.6), topology('face', 'f1', 2)];
    expect(sketchReferencePick(stack)?.selection?.topologyId).toBe('f1');
  });

  it('finds nothing over sketch geometry, a whole body or empty space', () => {
    expect(sketchReferencePick([sketchCurve(1), region(2)])).toBeNull();
    expect(sketchReferencePick([topology('body', 'b', 1)])).toBeNull();
    expect(sketchReferencePick([])).toBeNull();
  });
});

describe('sketchReferenceHoverApplies', () => {
  it('previews only during a step that takes a reference', () => {
    expect(sketchToolTakesReference('project')).toBe(true);
    for (const tool of ['select', 'line', 'circle', null, undefined]) {
      expect(sketchToolTakesReference(tool)).toBe(false);
      expect(sketchReferenceHoverApplies(tool, 'mouse')).toBe(false);
    }
  });

  it('previews for a mouse or pen and never for touch', () => {
    expect(sketchReferenceHoverApplies('project', 'mouse')).toBe(true);
    expect(sketchReferenceHoverApplies('project', 'pen')).toBe(true);
    expect(sketchReferenceHoverApplies('project', undefined)).toBe(true);
    expect(sketchReferenceHoverApplies('project', 'touch')).toBe(false);
  });
});
