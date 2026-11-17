/**
 * I04: several mesh files from one export, as one ZIP: more than one format
 * (a batch of the export scope), one file per body, or an OBJ with its MTL.
 */
import { unzipSync, zipSync } from 'fflate';

import type { MeshExportDialogFormat } from '../components/ExportDialog';

/** What the export dialog asks for beyond one file of one format. */
export interface MeshExportPackage {
  /** One file per body in the scope, named after the body. */
  perBody?: boolean;
  /** More formats of the same scope and quality, beside the chosen one. */
  extraFormats?: MeshExportDialogFormat[];
  /** OBJ: write its body colours as an MTL beside it. */
  objMaterials?: boolean;
}

const EXTENSIONS: Record<MeshExportDialogFormat, string> = {
  '3mf': '3mf',
  'stl-binary': 'stl',
  stl: 'ascii.stl',
  obj: 'obj',
  glb: 'glb',
  ply: 'ply'
};

export interface MeshPackageResult {
  zip: Uint8Array;
  /** Every entry's name, in the order written. */
  names: string[];
  warnings: number;
}

type Written = { data: Uint8Array } | { text: string };

export async function packageMeshExport<Id>(input: {
  formats: readonly MeshExportDialogFormat[];
  scopes: readonly { bodyIds: Id[]; stem: string }[];
  objMaterials: boolean;
  write(
    format: MeshExportDialogFormat,
    bodyIds: Id[],
    extra: { objMaterials?: { stem: string } }
  ): Promise<Written & { warnings: readonly unknown[] }>;
}): Promise<MeshPackageResult> {
  const entries: Record<string, Uint8Array> = {};
  const names: string[] = [];
  let warnings = 0;
  const add = (name: string, data: Uint8Array) => {
    let unique = name;
    for (let copy = 2; unique in entries; copy += 1) {
      unique = name.replace(/(\.[^.]+)$/, ` ${copy}$1`);
    }
    entries[unique] = data;
    names.push(unique);
  };
  const formats = [...new Set(input.formats)];
  // Unique stems before anything is written: an OBJ names its MTL by stem,
  // so renaming a file after the fact would point it at another's library.
  const taken = new Set<string>();
  const scopes = input.scopes.map((scope) => {
    let stem = scope.stem;
    for (let copy = 2; taken.has(stem); copy += 1)
      stem = `${scope.stem} ${copy}`;
    taken.add(stem);
    return { ...scope, stem };
  });
  for (const scope of scopes) {
    for (const format of formats) {
      const withMaterials = format === 'obj' && input.objMaterials;
      const result = await input.write(
        format,
        scope.bodyIds,
        withMaterials ? { objMaterials: { stem: scope.stem } } : {}
      );
      warnings += result.warnings.length;
      const data =
        'data' in result ? result.data : new TextEncoder().encode(result.text);
      if (withMaterials) {
        // The OBJ arrives with its MTL as a ZIP of its own.
        for (const [name, file] of Object.entries(unzipSync(data))) {
          add(name, file);
        }
      } else {
        add(`${scope.stem}.${EXTENSIONS[format]}`, data);
      }
    }
  }
  return { zip: zipSync(entries), names, warnings };
}
