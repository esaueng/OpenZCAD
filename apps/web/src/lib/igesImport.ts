/**
 * I06: IGES import. The qualified subset (manifold solid B-rep objects,
 * type 186) is restated as exact STEP by the Remus translator and then
 * imported exactly as a STEP file is: the stored, archived and replayed
 * source is that STEP text, under the IGES file's name. Surface models and
 * entities outside the subset are refused by name before anything is stored.
 */
import { saveCadTextFile } from './desktopBridge';
import { observeWorker } from './diagnosticSignal';

import type { BodyId, ProjectDocument } from '@openzcad/shared';
import type { GeometryWorkerApi } from '../hooks/useGeometryWorker';
import type { IgesConversionResult } from '../worker/igesImportWorker';
import type { MeshExportJob } from './meshExportPackage';

export function isIgesFileName(name: string): boolean {
  return /\.(?:igs|iges)$/i.test(name);
}

/** The IGES file as the STEP file the import reads, keeping its name. */
export function igesAsStepFile(
  file: File,
  signal?: AbortSignal
): Promise<File> {
  const cancelled = () =>
    new DOMException('IGES conversion was cancelled.', 'AbortError');
  if (signal?.aborted) return Promise.reject(cancelled());
  const worker = observeWorker(
    new Worker(new URL('../worker/igesImportWorker.ts', import.meta.url), {
      type: 'module'
    })
  );
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      callback();
    };
    const deadline = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error('IGES conversion exceeded the 120 second time limit.')
          )
        ),
      120_000
    );
    const onAbort = () => finish(() => reject(cancelled()));
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onerror = () =>
      finish(() => reject(new Error('IGES conversion worker crashed.')));
    worker.onmessage = (event: MessageEvent<IgesConversionResult>) => {
      const result = event.data;
      finish(() => {
        if (result.ok)
          resolve(
            new File([Uint8Array.from(result.step)], file.name, {
              type: 'model/step',
              lastModified: file.lastModified
            })
          );
        else
          reject(new Error(`${file.name} was not imported: ${result.error}`));
      });
    };
    worker.postMessage(file);
  });
}

/**
 * I06: File › Export IGES, on this lazy module so the workspace's entry
 * chunk carries none of it. The shown (or selected) bodies as exact IGES
 * B-rep solids, in the export unit, through the same export job as STEP.
 */
export function exportIges(input: {
  target: {
    document: ProjectDocument;
    bodyIds: BodyId[];
    allShownBodies: boolean;
  };
  fileName: string;
  /** The open document's version and unit, for the archive record. */
  version: number;
  documentUnits: string;
  /** The unit to write. */
  units: ProjectDocument['units'];
  runExportJob(job: MeshExportJob): Promise<void>;
  exportModel: GeometryWorkerApi['exportModel'];
}): Promise<void> {
  const { target, fileName } = input;
  const contentType = 'model/iges';
  return input.runExportJob({
    fileName,
    label: 'IGES',
    kind: 'iges-export',
    contentType,
    metadata: {
      bodyIds: target.bodyIds.join(','),
      documentVersion: input.version,
      units: input.documentUnits
    },
    produce: async (options) => {
      const result = await input.exportModel(
        'iges',
        target.document,
        target.bodyIds,
        {
          ...options,
          ...(target.allShownBodies ? { allShownBodies: true } : {}),
          fileName,
          units: input.units
        }
      );
      if (!('text' in result)) {
        throw new Error('The IGES export returned no text.');
      }
      return {
        body: new Blob([result.text], { type: contentType }),
        save: () => saveCadTextFile(fileName, 'igs', result.text),
        warnings: result.warnings.length
      };
    }
  });
}
