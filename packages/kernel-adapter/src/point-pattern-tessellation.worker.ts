import { MAX_PATTERN_MESH_BYTES } from './point-pattern-mesh-output';
import type { RemusKernel } from 'remus-wasm';
import { rememberPatternKernelModule } from './pattern-kernel-module';

type Request =
  | { init: true; module?: WebAssembly.Module }
  | { id: number; bytes: Uint8Array; options: [number, number] };

let bindings: Promise<{ RemusKernel: typeof RemusKernel }> | undefined;

function load(module?: WebAssembly.Module) {
  if (!bindings && module) rememberPatternKernelModule(module);
  return (bindings ??= import('remus-wasm'));
}

async function tessellate(data: Extract<Request, { id: number }>) {
  let kernel: RemusKernel | undefined;
  try {
    const { RemusKernel } = await load();
    kernel = new RemusKernel();
    const solids = kernel.deserializeSolids(data.bytes);
    if (solids.length !== 1)
      throw new Error('Expected one point pattern solid.');
    const mesh = kernel.tessellateSolidGroupedBinary(
      solids[0]!,
      ...data.options
    );
    try {
      const positions = mesh.takePositions(),
        indices = mesh.takeIndices(),
        faceOffsets = mesh.takeFaceOffsets();
      if (
        positions.byteLength + indices.byteLength + faceOffsets.byteLength >
        MAX_PATTERN_MESH_BYTES
      ) {
        self.postMessage({ id: data.id, mesh: null });
        return;
      }
      self.postMessage(
        { id: data.id, mesh: { positions, indices, faceOffsets } },
        [positions.buffer, indices.buffer, faceOffsets.buffer]
      );
    } finally {
      mesh.free();
    }
  } catch {
    self.postMessage({ id: data.id, mesh: null });
  } finally {
    kernel?.free();
  }
}

self.onmessage = ({ data }: MessageEvent<Request>) => {
  if ('init' in data) {
    void load(data.module).catch(() => {
      bindings = undefined;
    });
  } else {
    void tessellate(data);
  }
};
