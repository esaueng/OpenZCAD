import { observeWorker } from './diagnosticSignal';
import {
  MESH_IMPORT_POLICIES,
  meshImportTooLargeMessage,
  type MeshImportFormat
} from '@openzcad/kernel-adapter/mesh-import-formats';
import { MAX_SOURCE_IMPORT_BYTES, type UnitSystem } from '@openzcad/shared';

export {
  meshImportFormatForFileName,
  type MeshImportFormat
} from '@openzcad/kernel-adapter/mesh-import-formats';

import { describeWorkerFailure } from './workerFailure';
import { isChunkLoadError } from './staleChunk';

import type {
  MeshImportWorkerInput,
  MeshImportWorkerRequest,
  MeshImportWorkerResult
} from '../worker/meshImportWorker';

export interface ImportedMeshFile {
  /** Millimetres: a declared unit, when the format carries one, is applied. */
  vertices: number[];
  indices: number[];
  triangleCount: number;
  /** The unit the file declared, so the import can say what it converted. */
  sourceUnit?: string;
}

function abortError(): Error {
  const error = new Error('Mesh import was cancelled.');
  error.name = 'AbortError';
  return error;
}

/**
 * Reads one mesh file — 3MF, OBJ, glTF binary or PLY — in a disposable worker.
 *
 * The size ceiling is checked here, against the file's declared size, so an
 * oversized file is refused by name before a byte of it is read and before a
 * worker and a kernel exist to read it. Everything past that point is the
 * worker's, and termination is how it is cancelled: the translator and kernel
 * are synchronous WASM that no message can interrupt.
 *
 * `units` is the open document's, and it is required: the import runs the
 * document's own rebuild over the triangles before returning them, and that
 * rebuild sews at a tolerance derived from the numbers it is handed. Checking
 * millimetres on the way into a metre document passes files that then rebuild
 * to nothing.
 */
export function importMeshFileInDisposableWorker(
  file: File,
  format: MeshImportFormat,
  units: UnitSystem,
  signal?: AbortSignal
): Promise<ImportedMeshFile> {
  if (file.size > MESH_IMPORT_POLICIES[format].maxInputBytes) {
    return Promise.reject(
      new Error(meshImportTooLargeMessage(format, file.size))
    );
  }
  return readMeshInWorker({ type: 'import', file, format, units }, signal).then(
    ({ vertices, indices, triangleCount, sourceUnit }) => ({
      vertices: Array.from(vertices),
      indices: Array.from(indices),
      triangleCount,
      ...(sourceUnit === undefined ? {} : { sourceUnit })
    })
  );
}

/** STL is unitless and returns transferable geometry without starting Remus. */
export function importStlInDisposableWorker(file: File, signal: AbortSignal) {
  if (file.size > MAX_SOURCE_IMPORT_BYTES) {
    const limitMiB = MAX_SOURCE_IMPORT_BYTES / (1024 * 1024);
    return Promise.reject(
      new Error(
        `STL import is limited to ${limitMiB} MiB. Try binary STL for a smaller file.`
      )
    );
  }
  return readMeshInWorker({ type: 'import-stl', file }, signal).then(
    ({ vertices, indices, triangleCount, extent }) => ({
      name: file.name,
      vertices,
      indices,
      triangleCount,
      extent: extent ?? null
    })
  );
}

function readMeshInWorker(
  input: MeshImportWorkerInput,
  signal?: AbortSignal
): Promise<Extract<MeshImportWorkerResult, { ok: true }>> {
  if (signal?.aborted) {
    return Promise.reject(abortError());
  }
  const worker = observeWorker(
    new Worker(new URL('../worker/meshImportWorker.ts', import.meta.url), {
      type: 'module'
    })
  );
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      callback();
    };
    const deadline = setTimeout(
      () =>
        finish(() =>
          reject(new Error('Mesh import exceeded the 120 second time limit.'))
        ),
      120_000
    );
    const onAbort = () => finish(() => reject(abortError()));
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onerror = () => {
      finish(() => {
        void describeWorkerFailure('Mesh import worker crashed.').then(
          ({ message }) => reject(new Error(message))
        );
      });
    };
    worker.onmessageerror = () => {
      finish(() => reject(new Error('Mesh import returned unreadable data.')));
    };
    worker.onmessage = (event: MessageEvent<MeshImportWorkerResult>) => {
      const result = event.data;
      if (result.requestId !== requestId) {
        return;
      }
      if (result.ok) {
        finish(() => resolve(result));
      } else if (isChunkLoadError(result.error)) {
        finish(() => {
          void describeWorkerFailure(result.error).then(({ message }) =>
            reject(new Error(message))
          );
        });
      } else {
        finish(() => reject(new Error(result.error)));
      }
    };
    const request: MeshImportWorkerRequest = {
      ...input,
      requestId
    };
    worker.postMessage(request);
  });
}
