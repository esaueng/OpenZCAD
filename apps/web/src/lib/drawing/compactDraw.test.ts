import { describe, expect, it } from 'vitest';
import { startAnnotationTool, type AnnotationTool } from './annotationPicking';
import {
  COMPACT_ANNOTATION_GROUPS,
  COMPACT_ANNOTATION_WORDS,
  annotationToolStep,
  viewToolStep
} from './compactDraw';
import { ANNOTATION_TOOLS } from './toolKeys';

const point = {} as AnnotationTool['points'][number];
const edge = {} as AnnotationTool['edges'][number];

describe('compact Draw (U12 slice 9)', () => {
  it('groups every annotation tool once, in five groups', () => {
    expect(COMPACT_ANNOTATION_GROUPS.map((group) => group.id)).toEqual([
      'dimensions',
      'marks',
      'notes',
      'tables',
      'tolerances'
    ]);
    const grouped = COMPACT_ANNOTATION_GROUPS.flatMap((group) => group.tools);
    expect([...grouped].sort()).toEqual([...ANNOTATION_TOOLS].sort());
    expect(new Set(grouped).size).toBe(ANNOTATION_TOOLS.length);
  });

  it('labels each tool with one word', () => {
    for (const kind of ANNOTATION_TOOLS) {
      expect(COMPACT_ANNOTATION_WORDS[kind], kind).toMatch(/^\S+$/);
    }
  });

  it('names a running tool’s next pick in a word or two', () => {
    const horizontal = startAnnotationTool('horizontal');
    expect(annotationToolStep(horizontal)).toBe('Point 1');
    expect(annotationToolStep({ ...horizontal, points: [point] })).toBe(
      'Point 2'
    );
    expect(annotationToolStep({ ...horizontal, points: [point, point] })).toBe(
      'Place'
    );
    expect(annotationToolStep(startAnnotationTool('radius'))).toBe('Circle');
    expect(
      annotationToolStep({ ...startAnnotationTool('angle'), edges: [edge] })
    ).toBe('Edge 2');
    expect(annotationToolStep(startAnnotationTool('note'))).toBe('Leader');
    expect(annotationToolStep(startAnnotationTool('balloon'))).toBe('Edge');
    expect(annotationToolStep(startAnnotationTool('hole-table'))).toBe('View');
    expect(
      annotationToolStep({
        ...startAnnotationTool('radius', 'dann_x' as never),
        edges: [edge]
      })
    ).toBe('Done');
    for (const kind of ANNOTATION_TOOLS) {
      const step = annotationToolStep(startAnnotationTool(kind));
      expect(step.split(' ').length, kind).toBeLessThanOrEqual(2);
    }
  });

  it('names a view tool’s step', () => {
    expect(viewToolStep('section', { picked: false })).toBe('Line');
    expect(viewToolStep('section', { picked: true, freeSection: true })).toBe(
      'Side'
    );
    expect(viewToolStep('section', { picked: true })).toBe('Place');
    expect(viewToolStep('detail', { picked: false })).toBe('Circle');
    expect(viewToolStep('auxiliary', { picked: false })).toBe('Edge');
    expect(viewToolStep('auxiliary', { picked: true })).toBe('Place');
  });
});
