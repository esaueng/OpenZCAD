import type { ProjectDocument } from '@openzcad/shared';
import { ProjectSharingError } from '@openzcad/persistence';

/**
 * How a link without history keeps its frozen model in D1 (migration 0065,
 * `project_share_links.frozen_document`): the document's JSON, gzipped,
 * as base64 text. One D1 value holds at most 2,000,000 bytes, so a model
 * that does not fit is refused rather than truncated.
 */
export const MAX_FROZEN_SHARE_STORED_CHARS = 1_900_000;

async function streamBytes(
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodeFrozenShareDocument(
  document: ProjectDocument
): Promise<string> {
  const packed = await streamBytes(
    new Blob([JSON.stringify(document)])
      .stream()
      .pipeThrough(new CompressionStream('gzip'))
  );
  if (Math.ceil(packed.byteLength / 3) * 4 > MAX_FROZEN_SHARE_STORED_CHARS)
    throw new ProjectSharingError(
      'SHARE_LINK_SNAPSHOT_TOO_LARGE',
      'This model is too large to share without its history.'
    );
  let binary = '';
  for (let offset = 0; offset < packed.byteLength; offset += 0x8000)
    binary += String.fromCharCode(...packed.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

export async function decodeFrozenShareDocument(
  stored: string
): Promise<unknown> {
  const binary = atob(stored);
  const packed = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    packed[index] = binary.charCodeAt(index);
  const text = new TextDecoder().decode(
    await streamBytes(
      new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))
    )
  );
  return JSON.parse(text) as unknown;
}
