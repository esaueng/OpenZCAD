import type { BodyId, ProjectDocument } from '@openzcad/shared';
import type { KernelAdapter } from '@openzcad/kernel-adapter';

export interface ParsedStepMetadata {
  name: string;
  products: string[];
  colors: string[];
}

export async function parseStepMetadata(
  kernel: KernelAdapter,
  fileName: string,
  text: string
): Promise<ParsedStepMetadata> {
  return kernel.importStep({ fileName, text });
}

export async function exportBodiesToStep(
  kernel: KernelAdapter,
  document: ProjectDocument,
  bodyIds: BodyId[]
): Promise<string> {
  return kernel.exportStep(document, bodyIds);
}

