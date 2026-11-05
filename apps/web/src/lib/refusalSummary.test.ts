import { describe, expect, it } from 'vitest';
import type { BlendRefusalAdvice } from '@openzcad/shared';
import { refusalSummary } from './refusalSummary';

const structural = (
  operation: 'fillet' | 'chamfer',
  cause: Extract<BlendRefusalAdvice, { kind: 'structural' }>['cause'],
  edges = 1
): BlendRefusalAdvice => ({
  operation,
  edges,
  kind: 'structural',
  cause,
  reason: 'The modeling engine could not trim the cylindrical face beside it.'
});

describe('refusalSummary', () => {
  it('offers a size only when the ladder built it', () => {
    expect(
      refusalSummary(
        {
          message:
            'Fillet could not be created on 1 selected edge with radius 5. Try a smaller radius: radius 2.5 builds here.',
          advice: {
            operation: 'fillet',
            edges: 1,
            kind: 'smaller-size',
            size: 2.5,
            reason: 'Radius 5 is too large here; radius 2.5 builds.'
          }
        },
        'Fillet'
      )
    ).toEqual({
      status: 'not-built',
      headline: 'Radius too large',
      cause: 'Radius 5 is too large here; radius 2.5 builds.',
      trySize: 2.5,
      pickAnother: false
    });
  });

  it('offers no size when the sentence suggests one but the ladder did not build it', () => {
    const summary = refusalSummary(
      { message: 'Fillet could not be created. Try a smaller radius.' },
      'Fillet'
    );
    expect(summary.trySize).toBeUndefined();
    expect(summary.headline).toBe('Can’t round this edge here');
  });

  it('names a chamfer as a chamfer, never as rounding', () => {
    const summary = refusalSummary(
      {
        message: 'Chamfer could not be created.',
        advice: structural('chamfer', 'trim-face')
      },
      'Chamfer'
    );
    expect(summary.headline).toBe('Can’t chamfer this edge here');
    expect(summary.headline).not.toMatch(/round/i);
    expect(
      refusalSummary(
        {
          message: 'x',
          advice: {
            operation: 'chamfer',
            edges: 1,
            kind: 'smaller-size',
            size: 0.5,
            reason: 'Distance 1 is too large here; distance 0.5 builds.'
          }
        },
        'Chamfer'
      ).headline
    ).toBe('Distance too large');
  });

  it('reads a structural refusal from the verdict, not the sentence', () => {
    const summary = refusalSummary(
      {
        // The sentence even suggests a smaller value; the verdict wins.
        message: 'Fillet could not be created. Try a smaller radius.',
        advice: structural('fillet', 'trim-face-beside-blend', 3)
      },
      'Fillet'
    );
    expect(summary).toEqual({
      status: 'not-built',
      headline: 'Can’t round these edges here',
      cause:
        'The modeling engine could not trim the cylindrical face beside it.',
      pickAnother: true
    });
  });

  it.each([
    ['smooth-boundary', 'These faces already meet smoothly'],
    ['partial-revolve', 'Can’t chamfer a partial revolve yet'],
    ['shared-corner', 'Can’t chamfer these edges together'],
    ['edge-groups', 'Can’t chamfer these edges together']
  ] as const)('heads a %s refusal plainly', (cause, headline) => {
    expect(
      refusalSummary(
        {
          message: 'Chamfer could not be created.',
          advice: structural('chamfer', cause)
        },
        'Chamfer'
      ).headline
    ).toBe(headline);
  });

  it('names a refusal with no verdict by its command, never by its sentence', () => {
    expect(
      refusalSummary({ message: 'Offset removes the face.' }, 'Offset Face')
    ).toEqual({
      status: 'not-built',
      headline: 'Can’t move this face here',
      cause: 'Offset removes the face.',
      pickAnother: false
    });
    expect(
      refusalSummary({ message: 'Refused.' }, 'Resize Hole').headline
    ).toBe('Can’t resize this hole here');
    expect(refusalSummary({ message: 'Refused.' }, 'Loft').headline).toBe(
      'Loft can’t be built here'
    );
  });

  it('calls a vanished selection what it is', () => {
    expect(
      refusalSummary(
        {
          message:
            'The selected edge lineage no longer exists. Re-select the edges and re-create this feature.'
        },
        'Fillet'
      )
    ).toMatchObject({
      status: 'selection-changed',
      headline: 'Pick the edge or face again'
    });
  });
});
