import type { StepExportMetadata } from './step-export-metadata';

interface PreviousExport {
  key: string;
  solids: Uint8Array;
  text: string;
  timestampStart: number;
  timestampEnd: number;
}

const previous = new WeakMap<object, PreviousExport>();
const MAX_BYTES = 4 * 1024 * 1024;
const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z?$/;
// Match the finished writer's header, including a quoted filename containing
// doubled apostrophes. A changed writer layout simply skips reuse.
const FILE_TIME =
  /^FILE_NAME\('(?:[^'\r\n]|'')*', '(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z?)', \(''\), \(''\), 'Remus', 'OpenZCAD', ''\);$/m;

function sameSolids(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Reuse one completed export per kernel, after resolving the actual solids,
 * labels, assembly and PMI again. Only the FILE_NAME timestamp is volatile. */
export function repeatStepExport(
  kernel: object,
  projectId: string,
  units: string,
  solids: Uint8Array,
  metadata: StepExportMetadata,
  write: () => string
): string {
  const { timestamp, ...labels } = metadata;
  if (solids.length > MAX_BYTES || !ISO_SECONDS.test(timestamp)) return write();
  let cacheable = true;
  const key = JSON.stringify(
    [projectId, units, labels],
    (_key, value: unknown) => {
      if (
        typeof value === 'number' &&
        (!Number.isFinite(value) || Object.is(value, -0))
      ) {
        cacheable = false;
      }
      return value;
    }
  );
  if (!cacheable || solids.length + key.length * 2 > MAX_BYTES) return write();
  const hit = previous.get(kernel);
  if (hit?.key === key && sameSolids(solids, hit.solids)) {
    return (
      hit.text.slice(0, hit.timestampStart) +
      timestamp +
      hit.text.slice(hit.timestampEnd)
    );
  }

  const text = write();
  if (solids.length + (key.length + text.length) * 2 > MAX_BYTES) return text;
  const headerEnd = text.indexOf('\nDATA;\n');
  if (headerEnd < 0) return text;
  const field = FILE_TIME.exec(text.slice(0, headerEnd));
  if (field && field[1] === timestamp) {
    const start = field.index + field[0].lastIndexOf("'" + timestamp + "'") + 1;
    previous.set(kernel, {
      key,
      solids: solids.slice(),
      text,
      timestampStart: start,
      timestampEnd: start + timestamp.length
    });
  }
  return text;
}
