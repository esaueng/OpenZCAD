import type { MeshImportFormat } from '@openzcad/kernel-adapter/mesh-import-formats';

export interface MeshImportWorkerRequest {
  type: 'import';
  requestId: string;
  format: MeshImportFormat;
  file: File;
}

export type MeshImportWorkerResult =
  | {
      type: 'result';
      requestId: string;
      ok: true;
      /** Packed for `postMessage`, unpacked by the client. */
      vertices: Float64Array;
      indices: Uint32Array;
      triangleCount: number;
    }
  | {
      type: 'result';
      requestId: string;
      ok: false;
      error: string;
    };

/**
 * One mesh file read into triangles, in a worker that lives for that one file.
 *
 * The translator and the kernel it hands the arena document to are both
 * synchronous WASM: a hostile file that takes minutes cannot be interrupted,
 * only terminated with its worker. Running it here rather than in the
 * workspace geometry worker also keeps the parse's heap away from the kernel
 * holding the open document, and lets a cancelled import release both at once.
 */
self.onmessage = async (event: MessageEvent<MeshImportWorkerRequest>) => {
  const request = event.data;
  if (request.type !== 'import') {
    return;
  }
  try {
    const { importMeshFile } = await import('@openzcad/kernel-adapter/exact');
    const mesh = await importMeshFile(
      request.format,
      new Uint8Array(await request.file.arrayBuffer())
    );
    const vertices = Float64Array.from(mesh.vertices);
    const indices = Uint32Array.from(mesh.indices);
    const result: MeshImportWorkerResult = {
      type: 'result',
      requestId: request.requestId,
      ok: true,
      vertices,
      indices,
      triangleCount: mesh.triangleCount
    };
    self.postMessage(result, { transfer: [vertices.buffer, indices.buffer] });
  } catch (error) {
    const result: MeshImportWorkerResult = {
      type: 'result',
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : 'Mesh import failed.'
    };
    self.postMessage(result);
  }
};

export {};
