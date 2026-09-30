import {
  convertFreecadToStep,
  FREECAD_IMPORT_LIMITS
} from '@openzcad/io-freecad';
import { type UnitSystem } from '@openzcad/shared';
import occtWasmUrl from 'occt-wasm/dist/occt-wasm.wasm?url';

export type FreecadImportWorkerRequest = {
  requestId: string;
  file: File;
  units: UnitSystem;
};
export type FreecadImportWorkerResult =
  | { requestId: string; type: 'progress'; message: string }
  | {
      requestId: string;
      type: 'result';
      ok: true;
      stepBytes: ArrayBuffer;
      solidCount: number;
    }
  | { requestId: string; type: 'result'; ok: false; error: string };

self.onmessage = async (event: MessageEvent<FreecadImportWorkerRequest>) => {
  const { requestId, file, units } = event.data;
  try {
    if (file.size > FREECAD_IMPORT_LIMITS.maxArchiveBytes)
      throw new Error('FreeCAD import is limited to 32 MB.');
    const result = await convertFreecadToStep(
      new Uint8Array(await file.arrayBuffer()),
      {
        wasm: occtWasmUrl,
        onProgress: (message) =>
          self.postMessage({
            requestId,
            type: 'progress',
            message
          } satisfies FreecadImportWorkerResult)
      }
    );
    self.postMessage({
      requestId,
      type: 'progress',
      message: 'Checking exact rebuild and STEP export compatibility…'
    } satisfies FreecadImportWorkerResult);
    const { qualifyFreecadStep } =
      await import('../lib/freecadExactQualification');
    await qualifyFreecadStep(result.stepText, result.solidCount, units);
    const stepBytes = new TextEncoder().encode(result.stepText).buffer;
    self.postMessage(
      {
        requestId,
        type: 'result',
        ok: true,
        stepBytes,
        solidCount: result.solidCount
      } satisfies FreecadImportWorkerResult,
      { transfer: [stepBytes] }
    );
  } catch (error) {
    self.postMessage({
      requestId,
      type: 'result',
      ok: false,
      error:
        error instanceof Error ? error.message : 'FreeCAD conversion failed.'
    } satisfies FreecadImportWorkerResult);
  }
};
