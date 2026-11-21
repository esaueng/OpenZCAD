import type { DisplayTessellation } from './display-tessellation';
import { patternKernelModule } from './pattern-kernel-module';

import {
  MAX_PATTERN_MESH_BYTES,
  type PatternMesh
} from './point-pattern-mesh-output';

interface MeshJob {
  id: number;
  solid: number;
  quality: DisplayTessellation;
  ready: Promise<void>;
  resolve: () => void;
  mesh?: PatternMesh;
  signal?: { isCancelled(): boolean };
}

const IDLE_MS = 15_000;
const RESPONSE_MS = 250;
const MAX_INPUT_BYTES = 384 * 1024;

export class PointPatternMeshWorker {
  private worker?: Worker;
  private job?: MeshJob;
  private sequence = 0;
  private retryAt = 0;

  get available(): boolean {
    return this.worker !== undefined && this.job === undefined;
  }
  private idleTimer?: ReturnType<typeof setTimeout>;
  private responseTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly stage: (mesh: PatternMesh) => void,
    private readonly createWorker = () =>
      new Worker(
        new URL('./point-pattern-tessellation.worker.ts', import.meta.url),
        { type: 'module' }
      )
  ) {}

  warm(): void {
    if (this.worker || performance.now() < this.retryAt) return;
    try {
      const worker = this.createWorker();
      this.worker = worker;
      worker.onmessage = ({
        data
      }: MessageEvent<{ id: number; mesh?: PatternMesh | null }>) => {
        if (this.worker !== worker || !this.job || data?.id !== this.job.id)
          return;
        const job = this.job;
        clearTimeout(this.responseTimer);
        const mesh = data.mesh;
        if (
          mesh &&
          !job.signal?.isCancelled() &&
          mesh.positions instanceof Float32Array &&
          mesh.indices instanceof Uint32Array &&
          mesh.faceOffsets instanceof Uint32Array &&
          mesh.positions.byteLength +
            mesh.indices.byteLength +
            mesh.faceOffsets.byteLength <=
            MAX_PATTERN_MESH_BYTES
        ) {
          job.mesh = mesh;
        } else {
          this.reset();
        }
        job.resolve();
        this.scheduleIdle();
      };
      worker.onerror = worker.onmessageerror = () => {
        if (this.worker === worker) this.failed();
      };
      try {
        worker.postMessage({ init: true, module: patternKernelModule() });
      } catch {
        worker.postMessage({ init: true });
      }
      this.scheduleIdle();
    } catch {
      this.failed();
    }
  }

  private scheduleIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.dispose(), IDLE_MS);
  }

  reset(): void {
    clearTimeout(this.responseTimer);
    this.job?.resolve();
    this.job = undefined;
  }

  private failed(): void {
    this.retryAt = performance.now() + IDLE_MS;
    this.dispose();
  }

  dispose(): void {
    this.reset();
    clearTimeout(this.idleTimer);
    this.worker?.terminate();
    this.worker = undefined;
  }

  start(
    solid: number,
    bytes: Uint8Array,
    quality: DisplayTessellation,
    signal?: MeshJob['signal']
  ): void {
    if (
      !this.worker ||
      this.job ||
      bytes.byteLength > MAX_INPUT_BYTES ||
      signal?.isCancelled()
    )
      return;
    let resolve!: () => void;
    const ready = new Promise<void>((done) => {
      resolve = done;
    });
    const job = { id: ++this.sequence, solid, quality, signal, ready, resolve };
    this.job = job;
    try {
      this.worker.postMessage(
        {
          id: job.id,
          bytes,
          options: [quality.linearDeflection, quality.angularDeflection]
        },
        [bytes.buffer]
      );
      this.scheduleIdle();
    } catch {
      this.failed();
    }
  }

  wait(solids: readonly number[]): Promise<void> | undefined {
    const job = this.job;
    if (
      !job ||
      job.mesh ||
      !solids.includes(job.solid) ||
      job.signal?.isCancelled()
    )
      return;
    clearTimeout(this.responseTimer);
    this.responseTimer = setTimeout(() => {
      if (this.job === job) this.failed();
    }, RESPONSE_MS);
    return job.ready;
  }

  take(solid: number, quality: DisplayTessellation): PatternMesh | undefined {
    const job = this.job;
    if (
      !job?.mesh ||
      job.solid !== solid ||
      job.signal?.isCancelled() ||
      job.quality.linearDeflection !== quality.linearDeflection ||
      job.quality.angularDeflection !== quality.angularDeflection
    )
      return;
    const mesh = job.mesh;
    this.reset();
    // Only prepare shading once measurement accepts this solid and quality.
    try {
      this.stage(mesh);
    } catch {
      /* Measurement can still use the exact mesh. */
    }
    return mesh;
  }
}
