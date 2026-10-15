/** Download a shared source without letting a stalled connection hold the open. */
export async function readSharedSourceBytes(
  url: string,
  sourceName: string,
  fetcher: typeof fetch,
  maxBytes: number,
  idleMs: number
): Promise<Uint8Array<ArrayBuffer> | null> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Error(
    `The shared source file for "${sourceName}" stopped downloading. Try opening this link again.`
  );
  let progressed!: () => void;
  const expired = new Promise<never>((_, reject) => {
    progressed = () => {
      if (controller.signal.aborted) return;
      clearTimeout(idle);
      idle = setTimeout(() => {
        // Abort alone cannot release a transport that ignores its signal.
        reject(stalled);
        controller.abort();
        void reader?.cancel().catch(() => undefined);
      }, idleMs);
    };
    progressed();
  });
  const download = (async () => {
    const response = await fetcher(url, {
      credentials: 'omit',
      signal: controller.signal
    });
    if (controller.signal.aborted) {
      void response.body?.cancel().catch(() => undefined);
      throw stalled;
    }
    progressed();
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(
        `The shared source file for "${sourceName}" is unavailable. Ask the owner to save its source file to their account.`
      );
    }
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.byteLength > 0) progressed();
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => undefined);
          return null;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (controller.signal.aborted) throw stalled;
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  })();
  try {
    return await Promise.race([download, expired]);
  } finally {
    clearTimeout(idle);
  }
}
