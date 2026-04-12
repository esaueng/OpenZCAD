import type { BodyId } from '@openzcad/shared';
import type { KernelAdapter } from '@openzcad/kernel-adapter';
import type { ProjectDocument } from '@openzcad/shared';

export interface ParsedStl {
  name: string;
  triangleCount: number;
  format: 'ascii' | 'binary';
}

export function parseStl(buffer: ArrayBuffer, fileName: string): ParsedStl {
  const bytes = new Uint8Array(buffer);
  const ascii = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 1024)));
  if (ascii.trimStart().startsWith('solid')) {
    const triangleCount = (ascii.match(/facet normal/g) ?? []).length;
    return {
      name: fileName,
      triangleCount,
      format: 'ascii'
    };
  }

  const headerBytes = new DataView(buffer);
  const triangleCount = buffer.byteLength >= 84 ? headerBytes.getUint32(80, true) : 0;
  return {
    name: fileName,
    triangleCount,
    format: 'binary'
  };
}

export async function exportBodiesToStl(
  kernel: KernelAdapter,
  document: ProjectDocument,
  bodyIds: BodyId[]
): Promise<string> {
  return kernel.exportStl(document, bodyIds);
}

