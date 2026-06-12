import type { BodyId } from '@openzcad/shared';
import type { KernelAdapter } from '@openzcad/kernel-adapter';
import type { ProjectDocument } from '@openzcad/shared';

export interface ParsedStl {
  name: string;
  triangleCount: number;
  format: 'ascii' | 'binary';
}

const BINARY_STL_HEADER_BYTES = 84;
const BINARY_STL_TRIANGLE_BYTES = 50;

export function parseStl(buffer: ArrayBuffer, fileName: string): ParsedStl {
  // A binary STL is an 80-byte header, a uint32 triangle count, then 50 bytes
  // per triangle. The "solid" prefix alone is unreliable (binary exporters may
  // emit it too), so an exact size match takes precedence.
  if (buffer.byteLength >= BINARY_STL_HEADER_BYTES) {
    const declared = new DataView(buffer).getUint32(80, true);
    if (
      BINARY_STL_HEADER_BYTES + declared * BINARY_STL_TRIANGLE_BYTES ===
      buffer.byteLength
    ) {
      return { name: fileName, triangleCount: declared, format: 'binary' };
    }
  }

  const bytes = new Uint8Array(buffer);
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 512)));
  if (head.trimStart().toLowerCase().startsWith('solid')) {
    // Count facets across the whole file, not just the first kilobyte.
    const text = new TextDecoder().decode(bytes);
    const triangleCount = (text.match(/facet normal/g) ?? []).length;
    return { name: fileName, triangleCount, format: 'ascii' };
  }

  const triangleCount =
    buffer.byteLength >= BINARY_STL_HEADER_BYTES
      ? new DataView(buffer).getUint32(80, true)
      : 0;
  return { name: fileName, triangleCount, format: 'binary' };
}

export async function exportBodiesToStl(
  kernel: KernelAdapter,
  document: ProjectDocument,
  bodyIds: BodyId[]
): Promise<string> {
  return kernel.exportStl(document, bodyIds);
}

