import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

/** Keep benchmark identity paired with the exact bytes passed to the browser. */
export async function benchmarkStepInput(
  source: string | { name: string; buffer: Buffer }
) {
  const input =
    typeof source === 'string'
      ? { name: basename(source), buffer: await readFile(source) }
      : source;
  return {
    ...input,
    sha256: createHash('sha256').update(input.buffer).digest('hex')
  };
}
