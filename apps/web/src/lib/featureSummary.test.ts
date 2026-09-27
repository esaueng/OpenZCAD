import { describe, expect, it } from 'vitest';
import type { FeatureData, FeatureNode } from '@openzcad/shared';
import { featureValueSummary } from './featureSummary';

function feature(
  data: Partial<FeatureData> & Pick<FeatureData, 'featureKind'>
) {
  return { data } as unknown as FeatureNode;
}

describe('featureValueSummary', () => {
  it('reads a box as width × depth × height in document units', () => {
    const box = feature({
      featureKind: 'primitive',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 20, depth: 10 }
    });
    expect(featureValueSummary(box, {}, 'mm')).toBe('40 × 20 × 10 mm');
    expect(featureValueSummary(box, {}, 'inch')).toBe('40 × 20 × 10 in');
  });

  it('evaluates parameter expressions against the scope', () => {
    const cylinder = feature({
      featureKind: 'primitive',
      primitiveKind: 'cylinder',
      dimensions: { radius: 'cylinder_radius', height: 'cylinder_radius * 2' }
    });
    expect(featureValueSummary(cylinder, { cylinder_radius: 8 }, 'mm')).toBe(
      'r 8 · h 16 mm'
    );
  });

  it('shows nothing rather than a guess when a value does not evaluate', () => {
    const fillet = feature({ featureKind: 'fillet', radius: 'missing_param' });
    expect(featureValueSummary(fillet, {}, 'mm')).toBeNull();
  });

  it('names the extrude variants', () => {
    expect(
      featureValueSummary(
        feature({ featureKind: 'extrude', distance: 12 }),
        {},
        'mm'
      )
    ).toBe('12 mm');
    expect(
      featureValueSummary(
        feature({ featureKind: 'extrude', distance: 12, symmetric: true }),
        {},
        'mm'
      )
    ).toBe('12 mm symmetric');
    expect(
      featureValueSummary(
        feature({ featureKind: 'extrude', distance: 12, backDistance: 3 }),
        {},
        'cm'
      )
    ).toBe('12 + 3 cm');
    expect(
      featureValueSummary(
        feature({ featureKind: 'extrude', distance: 12, backDistance: 0 }),
        {},
        'mm'
      )
    ).toBe('12 mm');
  });

  it('treats an absent revolve angle as a full turn', () => {
    expect(
      featureValueSummary(feature({ featureKind: 'revolve' }), {}, 'mm')
    ).toBe('360°');
  });

  it('writes holes, fillets, chamfers and patterns compactly', () => {
    expect(
      featureValueSummary(
        feature({ featureKind: 'hole', diameter: 5, depthMode: 'through' }),
        {},
        'mm'
      )
    ).toBe('⌀ 5 mm through');
    expect(
      featureValueSummary(
        feature({
          featureKind: 'hole',
          diameter: 5,
          depthMode: 'blind',
          depth: 8
        }),
        {},
        'mm'
      )
    ).toBe('⌀ 5 × 8 mm');
    expect(
      featureValueSummary(
        feature({ featureKind: 'fillet', radius: 1, endRadius: 2.5 }),
        {},
        'mm'
      )
    ).toBe('r 1–2.5 mm');
    expect(
      featureValueSummary(
        feature({ featureKind: 'chamfer', distance: 1.5, angleDeg: 30 }),
        {},
        'mm'
      )
    ).toBe('1.5 mm × 30°');
    expect(
      featureValueSummary(
        feature({ featureKind: 'pattern', patternKind: 'grid', count: 3 }),
        {},
        'mm'
      )
    ).toBe('3 × 3');
    expect(
      featureValueSummary(
        feature({ featureKind: 'pattern', patternKind: 'linear', count: 4 }),
        {},
        'mm'
      )
    ).toBe('× 4');
  });

  it('returns null for kinds without one driving value', () => {
    expect(
      featureValueSummary(
        feature({ featureKind: 'boolean', operation: 'union' }),
        {},
        'mm'
      )
    ).toBeNull();
    expect(
      featureValueSummary(feature({ featureKind: 'sketch' }), {}, 'mm')
    ).toBeNull();
  });
});
