import { inflateRawSync } from 'node:zlib';

/**
 * Every entry of a ZIP the exporters wrote, as text, read independently of
 * the library that wrote it (stored or deflated entries only).
 */
export function zipTextEntries(bytes: Uint8Array): Record<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  if (view.getUint32(end, true) !== 0x06054b50)
    throw new Error('Missing ZIP directory');
  const entries: Record<string, string> = {};
  let offset = view.getUint32(end + 16, true);
  for (let i = 0; i < view.getUint16(end + 10, true); i++) {
    if (view.getUint32(offset, true) !== 0x02014b50)
      throw new Error('Invalid ZIP entry');
    const length = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(
      bytes.subarray(offset + 46, offset + 46 + length)
    );
    const local = view.getUint32(offset + 42, true);
    const start =
      local +
      30 +
      view.getUint16(local + 26, true) +
      view.getUint16(local + 28, true);
    const body = bytes.subarray(
      start,
      start + view.getUint32(offset + 20, true)
    );
    const method = view.getUint16(offset + 10, true);
    if (method !== 0 && method !== 8)
      throw new Error('Unsupported ZIP compression');
    entries[name] = new TextDecoder().decode(
      method === 8 ? inflateRawSync(body) : body
    );
    offset +=
      46 +
      length +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
  }
  return entries;
}
