import { JsonComplexityGuard, type UserId } from '@openzcad/shared';
import {
  MAX_PROJECT_BACKUP_BYTES,
  parseProjectBackup,
  importProjectCopy,
  type ProjectBackup
} from '../lib/projectBackup';
export type ProjectBackupWorkerResult =
  { ok: true; backup: ProjectBackup } | { ok: false; error: string };
self.onmessage = async (
  event: MessageEvent<{ file: File; ownerUserId: UserId }>
) => {
  try {
    const { file, ownerUserId } = event.data;
    if (file.size > MAX_PROJECT_BACKUP_BYTES)
      throw new Error('Project backup exceeds the 256 MB limit.');
    const reader = file.stream().getReader();
    const decoder = new TextDecoder();
    const structure = new JsonComplexityGuard(72, 2_000_000);
    const chunks: string[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_PROJECT_BACKUP_BYTES)
          throw new Error('Project backup exceeds the 256 MB limit.');
        const text = decoder.decode(chunk.value, { stream: true });
        structure.consume(text);
        chunks.push(text);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    chunks.push(decoder.decode());
    const backup = importProjectCopy(
      await parseProjectBackup(chunks.join('')),
      ownerUserId
    );
    self.postMessage({ ok: true, backup } satisfies ProjectBackupWorkerResult);
  } catch (error) {
    self.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : 'Invalid project backup.'
    } satisfies ProjectBackupWorkerResult);
  }
};
