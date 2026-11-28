/**
 * What unit each mesh export format is written in, and how a reader of the
 * file can tell — the one wording the export dialog and a package's units
 * manifest share (#2095, #2369).
 *
 * The formats fall into three groups. glTF defines metres, so it is written in
 * metres whatever the export unit is. 3MF writes the export unit and declares
 * it in the package. STL, OBJ and PLY write the export unit and record it
 * nowhere: a consumer has to be told, and a package that mixes them with a
 * format that does declare its unit must not let the declared one speak for
 * them.
 *
 * Kept free of the package writer (and its ZIP library) so the dialog can use
 * it without loading either.
 */
import type { UnitSystem } from '@openzcad/shared';

/** Mirrors `MeshExportDialogFormat`; `stl` is ASCII. */
export type MeshExportUnitFormat =
  '3mf' | 'stl-binary' | 'stl' | 'obj' | 'glb' | 'ply';

export type MeshUnitTreatment = 'fixed' | 'declared' | 'unrecorded';

export const MESH_EXPORT_UNIT_NAMES: Record<UnitSystem, string> = {
  mm: 'millimeters',
  cm: 'centimeters',
  m: 'meters',
  inch: 'inches'
};

/** How a reader of the file learns its unit. */
export function meshUnitTreatment(
  format: MeshExportUnitFormat
): MeshUnitTreatment {
  return format === 'glb'
    ? 'fixed'
    : format === '3mf'
      ? 'declared'
      : 'unrecorded';
}

/** The unit a format's numbers are written in, for this export unit. */
export function meshWrittenUnit(
  format: MeshExportUnitFormat,
  units: UnitSystem
): UnitSystem {
  return format === 'glb' ? 'm' : units;
}

/** Whether the export-unit setting changes any file in this set. */
export function exportUnitsApply(
  formats: readonly MeshExportUnitFormat[]
): boolean {
  return formats.some((format) => meshUnitTreatment(format) !== 'fixed');
}

const DIALOG_LABELS: Record<MeshExportUnitFormat, string> = {
  '3mf': '3MF',
  'stl-binary': 'STL (binary)',
  stl: 'STL (ASCII)',
  obj: 'OBJ',
  glb: 'glTF (GLB)',
  ply: 'PLY (binary)'
};

function listed(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * The export dialog's scope line: what is exported, and in which unit each of
 * its formats is written. A single format keeps the sentence it always had;
 * a mixed package names every group, so an unrecorded unit is never hidden
 * behind a format that declares one, and the export unit is never hidden
 * behind glTF's metres.
 */
export function meshExportUnitsSentence(
  scopeLabel: string,
  formats: readonly MeshExportUnitFormat[],
  units: UnitSystem
): string {
  const unique = [...new Set(formats)];
  const unitName = MESH_EXPORT_UNIT_NAMES[units];
  const groups = {
    fixed: unique.filter((format) => meshUnitTreatment(format) === 'fixed'),
    declared: unique.filter(
      (format) => meshUnitTreatment(format) === 'declared'
    ),
    unrecorded: unique.filter(
      (format) => meshUnitTreatment(format) === 'unrecorded'
    )
  };
  if (groups.fixed.length === unique.length) {
    return `Exports ${scopeLabel} in meters, the unit glTF defines.`;
  }
  if (groups.fixed.length === 0 && units === 'mm') {
    return `Exports ${scopeLabel} in millimeters, ready for slicing.`;
  }
  if (unique.length === 1) {
    return groups.declared.length > 0
      ? `Exports ${scopeLabel} in ${unitName}, declared in the package.`
      : `Exports ${scopeLabel} in ${unitName}. The file does not record its unit.`;
  }
  const parts: string[] = [];
  if (groups.declared.length > 0) {
    parts.push(`3MF in ${unitName}, declared in the package`);
  }
  if (groups.unrecorded.length > 0) {
    const names = listed(
      groups.unrecorded.map((format) => DIALOG_LABELS[format])
    );
    parts.push(
      units === 'mm'
        ? `${names} in millimeters`
        : groups.unrecorded.length === 1
          ? `${names} in ${unitName}, which the file does not record`
          : `${names} in ${unitName}, which those files do not record`
    );
  }
  if (groups.fixed.length > 0) {
    parts.push('glTF (GLB) in meters, the unit glTF defines');
  }
  return `Exports ${scopeLabel}: ${parts.join('; ')}.`;
}

/** The manifest a mesh package carries, so its units survive the dialog. */
export const MESH_PACKAGE_UNITS_MANIFEST = 'units.txt';

/**
 * One line per file in a mesh package, naming the unit its numbers are in and
 * whether the file itself says so. STL, OBJ and PLY carry no unit of their
 * own; without this, a package's only record of theirs was the dialog that
 * wrote it.
 */
export function meshPackageUnitsManifest(
  entries: readonly { name: string; format: MeshExportUnitFormat }[],
  units: UnitSystem
): string {
  const lines = entries.map(({ name, format }) => {
    const unitName = MESH_EXPORT_UNIT_NAMES[meshWrittenUnit(format, units)];
    const treatment = meshUnitTreatment(format);
    return treatment === 'fixed'
      ? `${name}: ${unitName} (the unit glTF defines)`
      : treatment === 'declared'
        ? `${name}: ${unitName} (declared in the file)`
        : `${name}: ${unitName} (not recorded in the file)`;
  });
  return ['Length units of the files in this package.', '', ...lines, ''].join(
    '\n'
  );
}
