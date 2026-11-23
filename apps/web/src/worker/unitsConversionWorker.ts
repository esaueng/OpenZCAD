import type { ProjectDocument, UnitSystem, UserId } from '@openzcad/shared';
import type { UnitsConversionPreparation } from '@openzcad/kernel-adapter/exact';

import { resolveExactSourceBytes } from '../lib/exactSourceResolver';
import { preloadDocumentFonts } from '../lib/textFonts';

export interface UnitsConversionWorkerRequest {
  type: 'prepare';
  requestId: string;
  document: ProjectDocument;
  to: UnitSystem;
  /** Whose undo history the estimate measures. */
  actorUserId?: UserId;
}

export type UnitsConversionWorkerResult =
  | {
      type: 'result';
      requestId: string;
      ok: true;
      preparation: UnitsConversionPreparation;
    }
  | {
      type: 'result';
      requestId: string;
      ok: false;
      error: string;
    };

/**
 * I03 phase 5: prepares one stored-unit conversion (the transform, three
 * cold rebuilds for reference re-capture and the oracles, the replay check
 * and the undo estimate) for exactly one request. Like the import rebuild
 * worker, it is disposable: the main thread terminates it to cancel, which
 * preempts synchronous wasm and frees the kernels without touching the
 * workspace geometry worker. Each worker is its own realm, so the
 * re-capture hook slot is never shared with another build.
 */
self.onmessage = async (event: MessageEvent<UnitsConversionWorkerRequest>) => {
  const request = event.data;
  if (request.type !== 'prepare') {
    return;
  }
  try {
    await preloadDocumentFonts(request.document);
    const { prepareUnitsConversion } =
      await import('@openzcad/kernel-adapter/exact');
    const preparation = await prepareUnitsConversion(
      request.document,
      request.to,
      {
        resolveSourceBytes: resolveExactSourceBytes,
        ...(request.actorUserId ? { actorUserId: request.actorUserId } : {})
      }
    );
    const result: UnitsConversionWorkerResult = {
      type: 'result',
      requestId: request.requestId,
      ok: true,
      preparation
    };
    self.postMessage(result);
  } catch (error) {
    const result: UnitsConversionWorkerResult = {
      type: 'result',
      requestId: request.requestId,
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : 'Checking the stored-unit conversion failed.'
    };
    self.postMessage(result);
  }
};

export {};
