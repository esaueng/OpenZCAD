import { resolveShaprImportLimits, type ShaprImportLimits } from './limits';
import { parseWorkspace269 } from './schema-v269';
import { openShaprDatabase } from './sqlite';
import type { ShaprImportIR } from './types';
import { extractShaprArchive } from './zip';

export interface ParseShaprProjectOptions {
  limits?: Partial<ShaprImportLimits>;
  signal?: AbortSignal;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('SHAPR import was cancelled.', 'AbortError');
  }
}

function hexDigest(bytes: Uint8Array): Promise<string> {
  const input = Uint8Array.from(bytes);
  return crypto.subtle
    .digest('SHA-256', input.buffer)
    .then((digest) =>
      [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
    );
}

export async function parseShaprProject(
  source: ArrayBuffer | Uint8Array,
  options: ParseShaprProjectOptions = {}
): Promise<ShaprImportIR> {
  const limits = resolveShaprImportLimits(options.limits);
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  throwIfAborted(options.signal);
  const checksumPromise = hexDigest(bytes);
  const extracted = extractShaprArchive(bytes, limits);
  throwIfAborted(options.signal);
  const database = await openShaprDatabase(
    extracted.workspace,
    limits.maxWorkspaceBytes
  );
  try {
    throwIfAborted(options.signal);
    const checksumSha256 = await checksumPromise;
    throwIfAborted(options.signal);
    return parseWorkspace269(
      database,
      extracted.inspection,
      bytes.byteLength,
      checksumSha256,
      limits
    );
  } finally {
    database.close();
  }
}
