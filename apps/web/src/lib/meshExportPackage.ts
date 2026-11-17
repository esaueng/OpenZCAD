/**
 * I04: several mesh files from one export, as one ZIP: more than one format
 * (a batch of the export scope), one file per body, or an OBJ with its MTL.
 */
import { unzipSync, zipSync } from 'fflate';

import { saveFile } from './saveFile';

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

/**
 * Mesh export of several files (I04), entirely on this lazy module: one
 * scope per body (named after the project and the body) or one for the
 * whole selection, every format of each, as one `<project>.zip`. The
 * bodies of a configuration not on screen are only known once it is built,
 * so splitting one is refused.
 */
export function exportMeshPackage<Id, Kind, State, Written>(input: {
  format: MeshExportDialogFormat;
  deflection: number;
  options: { angularTolerance?: number } & MeshExportPackage;
  target: {
    document: {
      nodes: Record<string, { kind: string; bodyId?: unknown; name: string }>;
    };
    bodyIds: Id[];
    allShownBodies?: boolean;
    rowName?: string | null;
  };
  kind: Kind;
  stemOf(name: string | null): string;
  units: string;
  setStatus(message: string): void;
  runExportJob(job: {
    fileName: string;
    label: string;
    kind: Kind;
    contentType: string;
    metadata: Record<string, string | number>;
    produce(options: {
      signal: AbortSignal;
      onState(state: State): void;
    }): Promise<{ body: Blob; save(): Promise<boolean>; warnings: number }>;
  }): Promise<void>;
  exportModel(
    format: MeshExportDialogFormat,
    document: never,
    bodyIds: Id[],
    options: Record<string, unknown>
  ): Promise<Written>;
}): void {
  const { perBody, extraFormats, objMaterials, ...tolerances } = input.options;
  const { target } = input;
  if (perBody && target.allShownBodies) {
    input.setStatus('Show this configuration to export one file per body.');
    return;
  }
  const stem = input.stemOf(target.rowName ?? null);
  const names = new Map<unknown, string>();
  for (const node of Object.values(target.document.nodes)) {
    if (node.kind === 'body') names.set(node.bodyId, node.name);
  }
  void input.runExportJob({
    fileName: `${stem}.zip`,
    label: 'Mesh package',
    kind: input.kind,
    contentType: 'application/zip',
    metadata: {
      bodyIds: target.bodyIds.join(','),
      format: [input.format, ...(extraFormats ?? [])].join(','),
      perBody: perBody ? 'yes' : 'no',
      deflectionMm: input.deflection
    },
    produce: async (jobOptions) => {
      const files = await packageMeshExport({
        formats: [input.format, ...(extraFormats ?? [])],
        scopes: perBody
          ? target.bodyIds.map((bodyId) => ({
              bodyIds: [bodyId],
              stem: `${stem}-${input.stemOf(names.get(bodyId) ?? String(bodyId))}`
            }))
          : [{ bodyIds: target.bodyIds, stem }],
        objMaterials: Boolean(objMaterials),
        write: (format, ids, extra) =>
          input.exportModel(format, target.document as never, ids, {
            deflection: input.deflection,
            ...tolerances,
            ...(target.allShownBodies ? { allShownBodies: true } : {}),
            units: input.units,
            ...extra,
            ...jobOptions
          }) as never
      });
      const body = new Blob([files.zip.slice()], { type: 'application/zip' });
      return {
        body,
        save: async () => (await saveFile(`${stem}.zip`, body)) !== 'cancelled',
        warnings: files.warnings
      };
    }
  });
}
