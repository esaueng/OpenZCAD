import type { UserId } from '@openzcad/shared';
import {
  parseProjectBackup,
  readProjectBackupText,
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
    const backup = importProjectCopy(
      await parseProjectBackup(await readProjectBackupText(file)),
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
