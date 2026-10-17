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

  it('summarises a datum offset as a length, unit suffix and all', () => {
    const datum = feature({
      featureKind: 'datum-plane',
      definition: {
        kind: 'offset',
        source: { type: 'canonical', plane: 'XY', offset: 0 },
        offset: '1 in',
        reverseNormal: true
      }
    });
    expect(featureValueSummary(datum, {}, 'mm')).toBe('25.4 mm flipped');
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

  it.each([
    ['mm', '50.8', '12.7', 'mm'],
    ['cm', '5.08', '1.27', 'cm'],
    ['inch', '2', '0.5', 'in']
  ] as const)(
    'summarizes authored extrusion units in a %s document',
    (units, distance, back, label) => {
      const data = {
        featureKind: 'extrude' as const,
        distance: '1 in + 25.4 mm'
      };
      expect(featureValueSummary(feature(data), {}, units)).toBe(
        `${distance} ${label}`
      );
      expect(
        featureValueSummary(feature({ ...data, symmetric: true }), {}, units)
      ).toBe(`${distance} ${label} symmetric`);
      expect(
        featureValueSummary(
          feature({ ...data, backDistance: '12.7 mm' }),
          {},
          units
        )
      ).toBe(`${distance} + ${back} ${label}`);
      expect(
        featureValueSummary(
          feature({ ...data, backDistance: '0 mm' }),
          {},
          units
        )
      ).toBe(`${distance} ${label}`);
      expect(
        featureValueSummary(
          feature({ featureKind: 'extrude', distance: 12, backDistance: 3 }),
          {},
          units
        )
      ).toBe(`12 + 3 ${label}`);
    }
  );

  it('keeps typed extrusion summaries fail-closed without dropping an invalid back distance', () => {
    expect(
      featureValueSummary(
        feature({ featureKind: 'extrude', distance: '12 mm' }),
        {},
        'mm'
      )
    ).toBe('12 mm');
    for (const invalid of ['missing + 1 mm', '30 deg', '(2 mm) * (3 mm)']) {
      expect(
        featureValueSummary(
          feature({ featureKind: 'extrude', distance: invalid }),
          {},
          'mm'
        )
      ).toBeNull();
      expect(
        featureValueSummary(
          feature({
            featureKind: 'extrude',
            distance: '12 mm',
            backDistance: invalid
          }),
          {},
          'mm'
        )
      ).toBeNull();
    }
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
