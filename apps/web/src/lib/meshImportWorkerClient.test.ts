import { afterEach, describe, expect, it, vi } from 'vitest';
import { MESH_IMPORT_POLICIES } from '@openzcad/kernel-adapter/mesh-import-formats';

import { importMeshFileInDisposableWorker } from './meshImportWorkerClient';
import type {
  MeshImportWorkerRequest,
  MeshImportWorkerResult
} from '../worker/meshImportWorker';

class FakeWorker {
  static created = 0;
  static latest: FakeWorker | null = null;

  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<MeshImportWorkerResult>) => void) | null =
    null;
  terminated = false;
  request: MeshImportWorkerRequest | null = null;

  constructor() {
    FakeWorker.created += 1;
    FakeWorker.latest = this;
  }

  postMessage(request: MeshImportWorkerRequest): void {
    this.request = request;
  }

  terminate(): void {
    this.terminated = true;
  }
}

/** A file that declares a size without allocating one. */
function fileOfSize(name: string, size: number): File {
  const file = new File([new Uint8Array(1)], name);
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

/** A worker reply, minus the envelope the client matches it by. */
type ReplyBody =
  | Omit<Extract<MeshImportWorkerResult, { ok: true }>, 'type' | 'requestId'>
  | Omit<Extract<MeshImportWorkerResult, { ok: false }>, 'type' | 'requestId'>;

function reply(worker: FakeWorker, result: ReplyBody): void {
  worker.onmessage?.({
    data: {
      type: 'result',
      requestId: worker.request!.requestId,
      ...result
    }
  } as MessageEvent<MeshImportWorkerResult>);
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.created = 0;
  FakeWorker.latest = null;
});

describe('mesh import worker client', () => {
  it('refuses an oversized file by its limit, before a worker exists', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const policy = MESH_IMPORT_POLICIES['3mf'];

    await expect(
      importMeshFileInDisposableWorker(
        fileOfSize('huge.3mf', policy.maxInputBytes + 1),
        '3mf',
        'mm'
      )
    ).rejects.toThrow('3MF import is limited to 32 MB');
    // The point of checking the declared size: nothing is read, and no worker
    // and no kernel are started to read it.
    expect(FakeWorker.created).toBe(0);
  });

  it('unpacks the triangles the worker transferred back', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const pending = importMeshFileInDisposableWorker(
      new File([new Uint8Array(4)], 'box.obj'),
      'obj',
      'mm'
    );
    const worker = FakeWorker.latest!;
    expect(worker.request?.format).toBe('obj');

    worker.onmessage?.({
      data: {
        type: 'result',
        requestId: 'mismatched-request',
        ok: true,
        vertices: Float64Array.of(9, 9, 9),
        indices: Uint32Array.of(0, 0, 0),
        triangleCount: 1
      }
    } as MessageEvent<MeshImportWorkerResult>);
    // A mismatched request id is ignored rather than resolved, so a stale
    // worker message cannot land another file's mesh in the document.
    expect(worker.terminated).toBe(false);

    reply(worker, {
      ok: true,
      vertices: Float64Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0),
      indices: Uint32Array.of(0, 1, 2),
      triangleCount: 1
    });

    // Plain arrays: the typed arrays are only how the mesh crossed the wire,
    // and the document stores numbers.
    await expect(pending).resolves.toEqual({
      vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      triangleCount: 1
    });
    expect(worker.terminated).toBe(true);
  });

  it('carries a declared source unit back to the caller', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const pending = importMeshFileInDisposableWorker(
      new File([new Uint8Array(4)], 'box.3mf'),
      '3mf',
      'mm'
    );
    const worker = FakeWorker.latest!;

    reply(worker, {
      ok: true,
      vertices: Float64Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0),
      indices: Uint32Array.of(0, 1, 2),
      triangleCount: 1,
      sourceUnit: 'inch'
    });

    // The vertices are already millimetres; the unit is what the import says
    // it converted from, and the status line is the only place a user can
    // learn that the file's own numbers were not adopted as written.
    await expect(pending).resolves.toEqual({
      vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      triangleCount: 1,
      sourceUnit: 'inch'
    });
  });

  it('terminates the worker when the import is cancelled', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const controller = new AbortController();
    const pending = importMeshFileInDisposableWorker(
      new File([new Uint8Array(4)], 'box.ply'),
      'ply',
      'mm',
      controller.signal
    );

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.latest?.terminated).toBe(true);
  });

  /**
   * The document's units reach the worker, because the import's rebuild check
   * runs at the scale the document stores.
   *
   * Before this the check always ran in millimetres. A 0.0002 mm plate then
   * passed it, was adopted at 1/1000 into a metre document, and collapsed on
   * the rebuild's sew — "Imported 12 triangles" in front of no body, which is
   * the exact failure the check exists to prevent.
   */
  it('sends the document units the import must check at', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const pending = importMeshFileInDisposableWorker(
      new File([new Uint8Array(4)], 'plate.obj'),
      'obj',
      'm'
    );
    const worker = FakeWorker.latest!;

    expect(worker.request?.units).toBe('m');

    reply(worker, {
      ok: false,
      error:
        'This OBJ file could not be imported as a body: Sewing this mesh ' +
        'changed its size, so the import was refused rather than publishing ' +
        'altered geometry.'
    });
    await expect(pending).rejects.toThrow('Sewing this mesh changed its size');
  });

  it('reports the refusal the worker sent, and terminates it', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const pending = importMeshFileInDisposableWorker(
      new File([new Uint8Array(4)], 'box.glb'),
      'glb',
      'mm'
    );
    const worker = FakeWorker.latest!;

    reply(worker, {
      ok: false,
      error: 'glTF binary import failed: parse error: not a GLB file'
    });

    await expect(pending).rejects.toThrow('not a GLB file');
    expect(worker.terminated).toBe(true);
  });
});
