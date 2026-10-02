import { describe, expect, it } from 'vitest';
import {
  convertInertia,
  convertMass,
  describeMassDensitySelection,
  displayInertiaUnit,
  displayLengthName,
  displayMassUnit,
  DOCUMENT_UNIT_TO_METRES,
  inertiaSiKgM2,
  KG_PER_LB,
  MATERIAL_DENSITY_PRESETS,
  materialPresetById,
  massKg,
  MAX_CUSTOM_DENSITY_KG_PER_M3,
  normalizeMassDensitySelection,
  parseCustomDensityKgPerM3,
  resolveDensityKgPerM3
} from '@openzcad/shared';

/**
 * Explicit density arithmetic (F02): presets, scaling and unit conversions.
 *
 * Pure closed forms — no kernel — so every expectation is hand-computed from
 * the definitions: mass = ρ·V in SI, inertia = ρ·I·L⁵ in SI, displayed in
 * the document's own length unit with a mass unit that keeps the figure
 * readable (g under a kilogram, lb in inch documents).
 */

describe('material presets', () => {
  it('ships the specified catalogue at the specified densities', () => {
    expect(
      new Map(
        MATERIAL_DENSITY_PRESETS.map((preset) => [
          preset.id,
          preset.densityKgPerM3
        ])
      )
    ).toEqual(
      new Map([
        ['steel', 7850],
        ['aluminium-6061', 2700],
        ['stainless', 8000],
        ['brass', 8500],
        ['titanium', 4430],
        ['abs', 1040],
        ['pla', 1240],
        ['petg', 1270],
        ['nylon', 1150],
        ['oak', 750]
      ])
    );
    for (const preset of MATERIAL_DENSITY_PRESETS) {
      expect(preset.densityKgPerM3).toBeGreaterThan(0);
      expect(materialPresetById(preset.id)).toEqual(preset);
    }
    expect(materialPresetById('unobtainium')).toBeNull();
  });
});

describe('selection normalization', () => {
  it('keeps unit density as the default for anything it does not recognize', () => {
    for (const stored of [
      undefined,
      null,
      'steel',
      7850,
      [],
      {},
      { kind: 'preset', presetId: 'unobtainium' },
      { kind: 'custom', densityKgPerM3: 0 },
      { kind: 'custom', densityKgPerM3: -12 },
      { kind: 'custom', densityKgPerM3: Number.NaN },
      { kind: 'custom', densityKgPerM3: Number.POSITIVE_INFINITY },
      { kind: 'custom', densityKgPerM3: MAX_CUSTOM_DENSITY_KG_PER_M3 + 1 }
    ]) {
      expect(normalizeMassDensitySelection(stored)).toEqual({ kind: 'unit' });
    }
    // A silently substituted neighbour would publish a wrong mass as data.
    expect(
      normalizeMassDensitySelection({ kind: 'preset', presetId: 'steel' })
    ).toEqual({ kind: 'preset', presetId: 'steel' });
    expect(
      normalizeMassDensitySelection({ kind: 'custom', densityKgPerM3: 7850 })
    ).toEqual({ kind: 'custom', densityKgPerM3: 7850 });
  });

  it('parses only positive finite custom densities within the bound', () => {
    expect(parseCustomDensityKgPerM3(7850)).toBe(7850);
    expect(parseCustomDensityKgPerM3(MAX_CUSTOM_DENSITY_KG_PER_M3)).toBe(
      MAX_CUSTOM_DENSITY_KG_PER_M3
    );
    for (const invalid of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '7850',
      null
    ]) {
      expect(parseCustomDensityKgPerM3(invalid)).toBeNull();
    }
  });

  it('resolves selections to SI density, or null for unit density', () => {
    expect(resolveDensityKgPerM3({ kind: 'unit' })).toBeNull();
    expect(resolveDensityKgPerM3({ kind: 'preset', presetId: 'steel' })).toBe(
      7850
    );
    // A preset id that no longer exists is not a material: back to unit.
    expect(
      resolveDensityKgPerM3({ kind: 'preset', presetId: 'unobtainium' })
    ).toBeNull();
    expect(
      resolveDensityKgPerM3({ kind: 'custom', densityKgPerM3: 1200 })
    ).toBe(1200);
    expect(
      resolveDensityKgPerM3({ kind: 'custom', densityKgPerM3: -5 })
    ).toBeNull();
  });

  it('describes each selection honestly, including a broken custom value', () => {
    expect(describeMassDensitySelection({ kind: 'unit' })).toBe('unit density');
    expect(
      describeMassDensitySelection({ kind: 'preset', presetId: 'steel' })
    ).toBe('Steel · 7850 kg/m³');
    expect(
      describeMassDensitySelection({ kind: 'custom', densityKgPerM3: 1200 })
    ).toBe('Custom · 1200 kg/m³');
    expect(
      describeMassDensitySelection({ kind: 'custom', densityKgPerM3: -5 })
    ).toBe('unit density');
  });
});

describe('mass scaling', () => {
  it('weighs a 20 mm steel cube at 62.8 g', () => {
    // 8000 mm³ = 8e-6 m³; × 7850 kg/m³ = 0.0628 kg.
    expect(massKg(8000, 'mm', 7850)).toBeCloseTo(0.0628, 10);
  });

  it('weighs a 1×2×3 inch steel block in pounds', () => {
    // 6 in³ = 6 × 0.0254³ m³ = 9.8322384e-5 m³; × 7850 = 0.7718307144 kg.
    const si = massKg(6, 'inch', 7850);
    expect(si).toBeCloseTo(0.7718307144, 10);
    expect(convertMass(si, 'lb')).toBeCloseTo(0.7718307144 / KG_PER_LB, 10);
    expect(convertMass(si, 'lb')).toBeCloseTo(1.7016, 4);
  });

  it('scales linearly with density and volume', () => {
    expect(massKg(8000, 'mm', 2 * 7850)).toBeCloseTo(
      2 * massKg(8000, 'mm', 7850),
      12
    );
    expect(massKg(2 * 8000, 'mm', 7850)).toBeCloseTo(
      2 * massKg(8000, 'mm', 7850),
      12
    );
  });

  it('agrees across equivalent volumes in every unit system', () => {
    // The same physical cube — 20 mm = 2 cm = 0.02 m — weighs the same.
    const fromMm = massKg(8000, 'mm', 7850);
    expect(massKg(8, 'cm', 7850)).toBeCloseTo(fromMm, 12);
    expect(massKg(8e-6, 'm', 7850)).toBeCloseTo(fromMm, 12);
    // And a 1-inch cube weighs what its 25.4 mm twin does.
    expect(massKg(1, 'inch', 7850)).toBeCloseTo(
      massKg(25.4 ** 3, 'mm', 7850),
      12
    );
  });

  it('pins the document-unit metre factors', () => {
    expect(DOCUMENT_UNIT_TO_METRES).toEqual({
      mm: 0.001,
      cm: 0.01,
      m: 1,
      inch: 0.0254
    });
  });
});

describe('inertia scaling', () => {
  it('reads a 20 mm steel cube at m·s²/6 in g·mm²', () => {
    // Geometric I = 8000·400/6 mm⁵ at unit density; × 7850 kg/m³ × 1e-15
    // (mm⁵→m⁵) = 4.186666…e-6 kg·m² = 4186.667 g·mm², which is also
    // m·s²/6 with m = 62.8 g, s = 20 mm — the two paths meet.
    const geometric = (8000 * 400) / 6;
    const si = inertiaSiKgM2(geometric, 'mm', 7850);
    expect(si).toBeCloseTo(4.1866666667e-6, 15);
    const massUnit = displayMassUnit(massKg(8000, 'mm', 7850), 'mm');
    expect(massUnit).toBe('g');
    expect(convertInertia(si, massUnit, 'mm')).toBeCloseTo(4186.6667, 4);
  });

  it('scales linearly with density; axes never enter the arithmetic', () => {
    const geometric = (8000 * 400) / 6;
    expect(inertiaSiKgM2(geometric, 'mm', 2 * 7850)).toBeCloseTo(
      2 * inertiaSiKgM2(geometric, 'mm', 7850),
      15
    );
  });

  it('agrees across equivalent unit systems', () => {
    const geometricMm = (8000 * 400) / 6;
    // 2 cm cube: I = 8·4/6 cm⁵. Same body, same steel.
    const fromMm = inertiaSiKgM2(geometricMm, 'mm', 7850);
    expect(inertiaSiKgM2((8 * 4) / 6, 'cm', 7850)).toBeCloseTo(fromMm, 15);
    expect(inertiaSiKgM2((8e-6 * 4e-4) / 6, 'm', 7850)).toBeCloseTo(fromMm, 12);
  });
});

describe('display units', () => {
  it('shows grams below a kilogram, kilograms above, pounds for inches', () => {
    expect(displayMassUnit(0.0628, 'mm')).toBe('g');
    expect(displayMassUnit(0.9999, 'cm')).toBe('g');
    expect(displayMassUnit(1, 'mm')).toBe('kg');
    expect(displayMassUnit(62.8, 'm')).toBe('kg');
    expect(displayMassUnit(0.0001, 'inch')).toBe('lb');
    expect(displayMassUnit(50, 'inch')).toBe('lb');
    expect(convertMass(1, 'g')).toBe(1000);
    expect(convertMass(1, 'kg')).toBe(1);
    expect(convertMass(KG_PER_LB, 'lb')).toBeCloseTo(1, 12);
  });

  it('composes inertia units from the mass and length units', () => {
    expect(displayInertiaUnit('g', 'mm')).toBe('g·mm²');
    expect(displayInertiaUnit('kg', 'mm')).toBe('kg·mm²');
    expect(displayInertiaUnit('kg', 'cm')).toBe('kg·cm²');
    expect(displayInertiaUnit('kg', 'm')).toBe('kg·m²');
    expect(displayInertiaUnit('lb', 'inch')).toBe('lb·in²');
    expect(displayLengthName('inch')).toBe('in');
    expect(displayLengthName('mm')).toBe('mm');
  });

  it('round-trips SI through the inch display pair', () => {
    // 1 kg·m² in lb·in²: / (0.45359237 × 0.0254²) = 3417.17….
    expect(convertInertia(1, 'lb', 'inch')).toBeCloseTo(
      1 / (KG_PER_LB * 0.0254 * 0.0254),
      8
    );
    // …and back: displayed × unit = SI.
    const displayed = convertInertia(4.1866666667e-6, 'g', 'mm');
    expect(displayed * 0.001 * 0.001 * 0.001).toBeCloseTo(4.1866666667e-6, 18);
  });
});
