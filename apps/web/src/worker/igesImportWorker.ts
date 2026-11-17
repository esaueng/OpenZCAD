/**
 * I06: restate an IGES file's B-rep solids as the exact STEP text the import
 * then stores and reads, off the UI thread. A disposable worker makes the
 * synchronous translator call cancellable.
 */
export type IgesConversionResult =
  { ok: true; step: Uint8Array } | { ok: false; error: string };

self.onmessage = async (event: MessageEvent<File>) => {
  try {
    const { createExactKernelAdapter } =
      await import('@openzcad/kernel-adapter/exact');
    const adapter = await createExactKernelAdapter();
    try {
      const step = await adapter.igesAsStep(await event.data.arrayBuffer());
      const result: IgesConversionResult = { ok: true, step };
      self.postMessage(result, { transfer: [step.buffer] });
    } finally {
      adapter.dispose();
    }
  } catch (error) {
    const result: IgesConversionResult = {
      ok: false,
      error: error instanceof Error ? error.message : 'IGES conversion failed.'
    };
    self.postMessage(result);
  }
};
