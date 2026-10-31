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
    // F01: a through-all cut shows its extent, not the dormant distance.
    expect(
      featureValueSummary(
        feature({
          featureKind: 'extrude',
          distance: 12,
          operation: 'cut',
          endCondition: 'through-all',
          throughAllSide: 'forward'
        } as never),
        {},
        'mm'
      )
    ).toBe('Through all');
    expect(
      featureValueSummary(
        feature({
          featureKind: 'extrude',
          distance: 12,
          operation: 'cut',
          endCondition: 'through-all',
          throughAllSide: 'both'
        } as never),
        {},
        'mm'
      )
    ).toBe('Through all, both sides');
    // F01 (v29): to-face reads as its extent; a draft rides after it.
    expect(
      featureValueSummary(
        feature({
          featureKind: 'extrude',
          distance: 1,
          endCondition: 'to-face',
          toFace: {}
        } as never),
        {},
        'mm'
      )
    ).toBe('To face');
    expect(
      featureValueSummary(
        feature({
          featureKind: 'extrude',
          distance: 1,
          endCondition: 'to-face',
          toFace: {},
          draftAngleDeg: 3
        } as never),
        {},
        'mm'
      )
    ).toBe('To face · 3° draft');
    expect(
      featureValueSummary(
        feature({
          featureKind: 'extrude',
          distance: 12,
          draftAngleDeg: -2
        } as never),
        {},
        'mm'
      )
    ).toBe('12 mm · -2° draft');
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

  it('summarises a worm by its starts and a worm wheel by its worm', () => {
    const gear = (data: Partial<FeatureData>) =>
      feature({ featureKind: 'gear', ...data } as FeatureData);
    expect(
      featureValueSummary(gear({ gearType: 'worm', teeth: 1 }), {}, 'mm')
    ).toBe('Worm, 1 start');
    expect(
      featureValueSummary(gear({ gearType: 'worm', teeth: 3 }), {}, 'mm')
    ).toBe('Worm, 3 starts');
    expect(
      featureValueSummary(
        gear({ gearType: 'worm-wheel', teeth: 30, mateTeeth: 2 }),
        {},
        'mm'
      )
    ).toBe('30 teeth, worm wheel for 2-start worm');
    expect(
      featureValueSummary(
        gear({
          gearType: 'worm-wheel',
          teeth: 30,
          mateTeeth: 2,
          throated: true
        }),
        {},
        'mm'
      )
    ).toBe('30 teeth, throated worm wheel for 2-start worm');
    expect(
      featureValueSummary(
        gear({ gearType: 'enveloping-worm', teeth: 1, mateTeeth: 30 }),
        {},
        'mm'
      )
    ).toBe('Enveloping worm, 1 start, for 30-tooth wheel');
    expect(
      featureValueSummary(
        gear({ gearType: 'enveloping-wheel', teeth: 30, mateTeeth: 1 }),
        {},
        'mm'
      )
    ).toBe('30 teeth, enveloping wheel for 1-start worm');
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
