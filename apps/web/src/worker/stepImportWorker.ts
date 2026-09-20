export type StepImportInspectionResult =
  { ok: true; solidIndices: number[] } | { ok: false; error: string };

/** Discover actual accepted solids off the UI thread, using the rebuild's reader. */
self.onmessage = async (event: MessageEvent<File>) => {
  try {
    const { createExactKernelAdapter } =
      await import('@openzcad/kernel-adapter/exact');
    const adapter = await createExactKernelAdapter();
    try {
      const inspection = await adapter.inspectStep(
        await event.data.arrayBuffer()
      );
      const result: StepImportInspectionResult = {
        ok: true,
        solidIndices: inspection.solidIndices
      };
      self.postMessage(result);
    } finally {
      adapter.dispose();
    }
  } catch (error) {
    const result: StepImportInspectionResult = {
      ok: false,
      error: error instanceof Error ? error.message : 'STEP inspection failed.'
    };
    self.postMessage(result);
  }
};
