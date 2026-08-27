import type { ProjectDocument } from '@openzcad/shared';
import type { ExactKernelAdapter } from '@openzcad/kernel-adapter/exact';

import { resolveExactSourceBytes } from '../lib/exactSourceResolver';
import { preloadDocumentFonts } from '../lib/textFonts';

export interface ImportRebuildWorkerRequest {
  type: 'rebuild';
  requestId: string;
  document: ProjectDocument;
}

export type ImportRebuildWorkerResult =
  | {
      type: 'result';
      requestId: string;
      ok: true;
      derived: ProjectDocument['derived'];
    }
  | {
      type: 'result';
      requestId: string;
      ok: false;
      error: string;
    };

/**
 * One exact import validation lives for exactly one request. The main thread
 * can terminate this worker while synchronous wasm is rebuilding, releasing
 * its kernel and heap without disturbing the workspace geometry worker.
 */
self.onmessage = async (event: MessageEvent<ImportRebuildWorkerRequest>) => {
  const request = event.data;
  if (request.type !== 'rebuild') {
    return;
  }
  let exact: ExactKernelAdapter | undefined;
  try {
    await preloadDocumentFonts(request.document);
    const { createExactKernelAdapter } =
      await import('@openzcad/kernel-adapter/exact');
    exact = await createExactKernelAdapter({
      resolveSourceBytes: resolveExactSourceBytes
    });
    const result: ImportRebuildWorkerResult = {
      type: 'result',
      requestId: request.requestId,
      ok: true,
      derived: await exact.syncDocument(request.document)
    };
    self.postMessage(result);
  } catch (error) {
    const result: ImportRebuildWorkerResult = {
      type: 'result',
      requestId: request.requestId,
      ok: false,
      error:
        error instanceof Error ? error.message : 'Exact import rebuild failed.'
    };
    self.postMessage(result);
  } finally {
    exact?.dispose();
  }
};

export {};
