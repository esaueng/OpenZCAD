import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';

import type {
  UnitsConversionWorkerRequest,
  UnitsConversionWorkerResult
} from './unitsConversionWorker';

interface FakeWorkerScope {
  postMessage: ReturnType<
    typeof vi.fn<(result: UnitsConversionWorkerResult) => void>
  >;
  onmessage:
    ((event: MessageEvent<UnitsConversionWorkerRequest>) => void) | null;
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function startWorker(prepareUnitsConversion: ReturnType<typeof vi.fn>) {
  const scope: FakeWorkerScope = { postMessage: vi.fn(), onmessage: null };
  vi.stubGlobal('self', scope);
  vi.doMock('@openzcad/kernel-adapter/exact', () => ({
    prepareUnitsConversion
  }));
  vi.doMock('../lib/textFonts', () => ({
    preloadDocumentFonts: vi.fn(async () => undefined)
  }));
  await import('./unitsConversionWorker');
  return scope;
}

describe('stored-unit conversion worker', () => {
  const actor = toUserId('user_units_worker');
  const document = createProjectDocument('Units', actor, 'mm');

  it('posts the kernel preparation, with the source resolver and the actor', async () => {
    const preparation = {
      ok: false,
      sourceVersion: document.version,
      refusals: [
        {
          stage: 'references',
          code: 'missing-match',
          subject: 'Fillet 1 (feat_1)',
          field: 'edgeReferences.0',
          message: 'Fillet 1: no converted entity matches edgeReferences.0.'
        }
      ],
      warnings: []
    };
    const prepareUnitsConversion = vi.fn(async () => preparation);
    const scope = await startWorker(prepareUnitsConversion);
    scope.onmessage?.({
      data: {
        type: 'prepare',
        requestId: 'units-1',
        document,
        to: 'inch',
        actorUserId: actor
      }
    } as MessageEvent<UnitsConversionWorkerRequest>);
    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith({
        type: 'result',
        requestId: 'units-1',
        ok: true,
        preparation
      })
    );
    const [, to, options] = prepareUnitsConversion.mock.calls[0] as unknown as [
      unknown,
      string,
      { resolveSourceBytes: unknown; actorUserId: unknown }
    ];
    expect(to).toBe('inch');
    expect(typeof options.resolveSourceBytes).toBe('function');
    expect(options.actorUserId).toBe(actor);
  });

  it('reports a crash in the preparation as an error result', async () => {
    const scope = await startWorker(
      vi.fn(async () => {
        throw new Error('kernel exploded');
      })
    );
    scope.onmessage?.({
      data: { type: 'prepare', requestId: 'units-2', document, to: 'cm' }
    } as MessageEvent<UnitsConversionWorkerRequest>);
    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith({
        type: 'result',
        requestId: 'units-2',
        ok: false,
        error: 'kernel exploded'
      })
    );
  });
});
