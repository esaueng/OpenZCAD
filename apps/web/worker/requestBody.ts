/**
 * Read UTF-8 text without buffering past a route's decoded UTF-16 ceiling.
 * Keep JSON parsing, header prechecks and route-specific errors with callers.
 */
export async function readBoundedRequestText(
  request: Request,
  maxChars: number,
  tooLarge: () => never
): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let length = 0;
  const append = async (part: string) => {
    if (part.length > maxChars - length) {
      await reader.cancel().catch(() => undefined);
      tooLarge();
    }
    length += part.length;
    if (part) parts.push(part);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await append(decoder.decode(value, { stream: true }));
    }
    await append(decoder.decode());
    return parts.join('');
  } finally {
    reader.releaseLock();
  }
}

/** Read an encrypted frame only while its measured transport bytes fit. */
export async function readBoundedRequestBytes(
  request: Request,
  maxBytes: number,
  tooLarge: () => never
) {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maxBytes - length) {
        await reader.cancel().catch(() => undefined);
        tooLarge();
      }
      length += value.byteLength;
      parts.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return bytes;
  } finally {
    reader.releaseLock();
  }
}
