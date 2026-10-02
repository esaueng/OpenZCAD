import type { UnitSystem } from './index';

/**
 * Explicit density for mass-property display (ROADMAP F02).
 *
 * The kernel publishes geometric moments at unit density — `BodyMassProperties`
 * carries no material, and `BodyRepresentation.volume` is the better number
 * for `mass = density * volume` (see the type's own contract). This module is
 * the caller that knows what the part is made of: it turns a stored density
 * choice into physical mass and inertia in the document's own unit system.
 *
 * Pure arithmetic, no kernel calls: every conversion here is closed form and
 * covered against hand-computed values, so the Inspector renders these
 * without a second measurement pass.
 */

/** One material preset: density in kilograms per cubic metre (SI). */
export interface MaterialDensityPreset {
  id: string;
  label: string;
  densityKgPerM3: number;
}

/**
 * The shipped preset catalogue. Densities are nominal handbook values for
 * display arithmetic, not a material certification — a 6061 temper or an
 * infill percentage moves the real part, and the Custom entry exists for
 * exactly that reason.
 */
export const MATERIAL_DENSITY_PRESETS: readonly MaterialDensityPreset[] = [
  { id: 'steel', label: 'Steel', densityKgPerM3: 7850 },
  { id: 'aluminium-6061', label: 'Aluminium 6061', densityKgPerM3: 2700 },
  { id: 'stainless', label: 'Stainless', densityKgPerM3: 8000 },
  { id: 'brass', label: 'Brass', densityKgPerM3: 8500 },
  { id: 'titanium', label: 'Titanium', densityKgPerM3: 4430 },
  { id: 'abs', label: 'ABS', densityKgPerM3: 1040 },
  { id: 'pla', label: 'PLA', densityKgPerM3: 1240 },
  { id: 'petg', label: 'PETG', densityKgPerM3: 1270 },
  { id: 'nylon', label: 'Nylon', densityKgPerM3: 1150 },
  { id: 'oak', label: 'Oak', densityKgPerM3: 750 }
];

export function materialPresetById(id: string): MaterialDensityPreset | null {
  return MATERIAL_DENSITY_PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * Which density the mass display uses. `unit` is the historical default —
 * geometric moments with no material — so every existing display reads
 * exactly as it did until a preset is picked. Persisted per browser, keyed
 * by project (see `massDensityPreference` on the web side), never in the
 * document: storing it in-document is recorded follow-up work.
 */
export type MassDensitySelection =
  | { kind: 'unit' }
  | { kind: 'preset'; presetId: string }
  | { kind: 'custom'; densityKgPerM3: number };

export const UNIT_MASS_DENSITY_SELECTION: MassDensitySelection = {
  kind: 'unit'
};

/**
 * A custom density is only meaningful as a positive finite number. The upper
 * bound (100 000 kg/m³, ~4× osmium) catches unit slips — grams per cubic
 * centimetre typed as kilograms per cubic metre reads 1000× light rather
 * than refusing, but a value past any real material is refused instead of
 * silently publishing tonnes for a thimble.
 */
export const MAX_CUSTOM_DENSITY_KG_PER_M3 = 100_000;

export function parseCustomDensityKgPerM3(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_CUSTOM_DENSITY_KG_PER_M3
    ? value
    : null;
}

/**
 * Normalizes a stored selection the way the preference loader does: an
 * unknown preset id or an out-of-range custom density falls back to unit
 * density rather than to a neighbouring material, because a silently
 * substituted material publishes a wrong mass as data.
 */
export function normalizeMassDensitySelection(
  value: unknown
): MassDensitySelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return UNIT_MASS_DENSITY_SELECTION;
  }
  const candidate = value as Partial<MassDensitySelection> &
    Record<string, unknown>;
  if (candidate.kind === 'preset' && typeof candidate.presetId === 'string') {
    return materialPresetById(candidate.presetId)
      ? { kind: 'preset', presetId: candidate.presetId }
      : UNIT_MASS_DENSITY_SELECTION;
  }
  if (candidate.kind === 'custom') {
    const density = parseCustomDensityKgPerM3(candidate.densityKgPerM3);
    return density === null
      ? UNIT_MASS_DENSITY_SELECTION
      : { kind: 'custom', densityKgPerM3: density };
  }
  return UNIT_MASS_DENSITY_SELECTION;
}

/**
 * Resolves a selection to an SI density, or `null` for unit density.
 * `null` is not zero — it means "geometric moments, no material" — so
 * callers must keep the historical unit-density display rather than
 * multiplying by one.
 */
export function resolveDensityKgPerM3(
  selection: MassDensitySelection
): number | null {
  if (selection.kind === 'preset') {
    return materialPresetById(selection.presetId)?.densityKgPerM3 ?? null;
  }
  if (selection.kind === 'custom') {
    return parseCustomDensityKgPerM3(selection.densityKgPerM3);
  }
  return null;
}

/** Human-readable density line for the current selection, e.g. for a label. */
export function describeMassDensitySelection(
  selection: MassDensitySelection
): string {
  if (selection.kind === 'preset') {
    const preset = materialPresetById(selection.presetId);
    return preset
      ? `${preset.label} · ${preset.densityKgPerM3} kg/m³`
      : 'unit density';
  }
  if (selection.kind === 'custom') {
    const density = parseCustomDensityKgPerM3(selection.densityKgPerM3);
    return density === null ? 'unit density' : `Custom · ${density} kg/m³`;
  }
  return 'unit density';
}

/** Metres per document length unit. The inch follows the international definition. */
export const DOCUMENT_UNIT_TO_METRES: Record<UnitSystem, number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  inch: 0.0254
};

export const KG_PER_LB = 0.45359237;

/**
 * Physical mass of a body: density times the SI volume. `volumeDocumentUnits`
 * is `BodyRepresentation.volume`, in cubic document units.
 */
export function massKg(
  volumeDocumentUnits: number,
  units: UnitSystem,
  densityKgPerM3: number
): number {
  const metres = DOCUMENT_UNIT_TO_METRES[units];
  return densityKgPerM3 * volumeDocumentUnits * metres ** 3;
}

/**
 * One kernel inertia component (document_units^5 at unit density) in SI
 * (kg·m²). Linear in density like the mass: doubling the density doubles
 * every component, and the principal axes — directions — never move.
 */
export function inertiaSiKgM2(
  inertiaDocumentUnits5: number,
  units: UnitSystem,
  densityKgPerM3: number
): number {
  const metres = DOCUMENT_UNIT_TO_METRES[units];
  return densityKgPerM3 * inertiaDocumentUnits5 * metres ** 5;
}

export type DisplayMassUnit = 'g' | 'kg' | 'lb';

/**
 * Which mass unit a figure is shown in. Metric documents stay metric and
 * pick grams below one kilogram so a small steel bracket reads "62.8 g"
 * rather than "0.063 kg"; inch documents read pounds, the unit the rest of
 * the document already measures in.
 */
export function displayMassUnit(
  massKgValue: number,
  units: UnitSystem
): DisplayMassUnit {
  if (units === 'inch') {
    return 'lb';
  }
  return massKgValue < 1 ? 'g' : 'kg';
}

export function convertMass(massKgValue: number, to: DisplayMassUnit): number {
  switch (to) {
    case 'g':
      return massKgValue * 1000;
    case 'lb':
      return massKgValue / KG_PER_LB;
    case 'kg':
      return massKgValue;
  }
}

/** Short document length name for composed units (`in`, not `inch`). */
export function displayLengthName(units: UnitSystem): string {
  return units === 'inch' ? 'in' : units;
}

/**
 * The inertia unit belonging to a mass unit in this document's length unit:
 * `g·mm²`, `kg·mm²`, `kg·cm²`, `kg·m²`, `lb·in²`. Inertia is always shown
 * beside the mass it belongs to, in the same mass unit, so the two stay
 * consistent with each other at every density.
 */
export function displayInertiaUnit(
  massUnit: DisplayMassUnit,
  units: UnitSystem
): string {
  return `${massUnit}·${displayLengthName(units)}²`;
}

export function convertInertia(
  siKgM2: number,
  massUnit: DisplayMassUnit,
  units: UnitSystem
): number {
  const metres = DOCUMENT_UNIT_TO_METRES[units];
  const massKgPerUnit =
    massUnit === 'g' ? 0.001 : massUnit === 'lb' ? KG_PER_LB : 1;
  return siKgM2 / (massKgPerUnit * metres * metres);
}
