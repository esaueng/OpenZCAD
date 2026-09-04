export {
  BrepKernel as RemusKernel,
  type FaceEvolutionPayloadV1
} from 'remus-wasm';
export type { RemusIo, StepImportResult } from 'remus-wasm-io';

import type { RemusIo as RemusIoInstance } from 'remus-wasm-io';

/**
 * The file-format translators (STEP, IGES, STL, 3MF, OBJ, PLY, glTF) ship as
 * their own WASM module so the kernel asset stays inside its size budget.
 * Bodies cross between the two as exact arena documents: an export takes
 * `kernel.serializeSolids(...)` bytes, an import returns bytes for
 * `kernel.deserializeSolids(...)`.
 *
 * The dynamic import keeps the module a separate lazy chunk: nothing fetches
 * it until a document actually imports or exports a file.
 */
let translators: RemusIoInstance | null = null;
let translatorsLoading: Promise<RemusIoInstance> | null = null;

export function loadRemusTranslators(): Promise<RemusIoInstance> {
  if (translators) {
    return Promise.resolve(translators);
  }
  translatorsLoading ??= import('remus-wasm-io').then(({ RemusIo }) => {
    translators = new RemusIo();
    return translators;
  });
  return translatorsLoading;
}

/**
 * The loaded translators for synchronous code paths (feature builders, export
 * callbacks). Every async entry point that can reach one of those paths awaits
 * {@link loadRemusTranslators} first; reaching here without it is a
 * programming error, not a recoverable state.
 */
export function remusTranslators(): RemusIoInstance {
  if (!translators) {
    throw new Error(
      'Remus file-format translators are not loaded; await loadRemusTranslators() first.'
    );
  }
  return translators;
}
