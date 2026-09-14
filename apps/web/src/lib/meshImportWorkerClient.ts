import {
  MESH_IMPORT_POLICIES,
  meshImportTooLargeMessage,
  type MeshImportFormat
} from '@openzcad/kernel-adapter/mesh-import-formats';

export {
  meshImportFormatForFileName,
  type MeshImportFormat
} from '@openzcad/kernel-adapter/mesh-import-formats';

import { describeWorkerFailure } from './workerFailure';
import { isChunkLoadError } from './staleChunk';

import type {
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
 */
export function importMeshFileInDisposableWorker(
  file: File,
  format: MeshImportFormat,
  signal?: AbortSignal
): Promise<ImportedMeshFile> {
  if (file.size > MESH_IMPORT_POLICIES[format].maxInputBytes) {
    return Promise.reject(
      new Error(meshImportTooLargeMessage(format, file.size))
    );
  }
  if (signal?.aborted) {
    return Promise.reject(abortError());
  }
  const worker = new Worker(
    new URL('../worker/meshImportWorker.ts', import.meta.url),
    { type: 'module' }
  );
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      callback();
    };
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
        finish(() =>
          resolve({
            // The document holds a mesh as plain arrays; the typed arrays are
            // only how it crossed `postMessage`.
            vertices: Array.from(result.vertices),
            indices: Array.from(result.indices),
            triangleCount: result.triangleCount,
            ...(result.sourceUnit === undefined
              ? {}
              : { sourceUnit: result.sourceUnit })
          })
        );
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
      type: 'import',
      requestId,
      format,
      file
    };
    worker.postMessage(request);
  });
}
