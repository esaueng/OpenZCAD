import type { StepStructure } from '@openzcad/kernel-adapter/exact';

export type StepImportInspectionResult =
  | {
      ok: true;
      solidIndices: number[];
      /** I02: present when the indices number the structure reader's solids. */
      structure?: StepStructure;
      /** I02: why the structure reader refused, when the flat one stood in. */
      structureRefusal?: string;
    }
  | { ok: false; error: string };

/** What the import asks: the file, and whether to read its product structure. */
export interface StepImportInspectionRequest {
  file: File;
  structure: boolean;
}

/** Discover actual accepted solids off the UI thread, using the rebuild's reader. */
self.onmessage = async (
  event: MessageEvent<File | StepImportInspectionRequest>
) => {
  const request =
    event.data instanceof File
      ? { file: event.data, structure: false }
      : event.data;
  try {
    const { discoverStepLayout } =
      await import('@openzcad/kernel-adapter/exact');
    const layout = await discoverStepLayout(
      await request.file.arrayBuffer(),
      request.structure
    );
    const result: StepImportInspectionResult = { ok: true, ...layout };
    self.postMessage(result);
  } catch (error) {
    const result: StepImportInspectionResult = {
      ok: false,
      error: error instanceof Error ? error.message : 'STEP inspection failed.'
    };
    self.postMessage(result);
  }
};
