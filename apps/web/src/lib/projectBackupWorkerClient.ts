import type { UserId } from '@openzcad/shared';
import { MAX_PROJECT_BACKUP_BYTES, type ProjectBackup } from './projectBackup';
import type { ProjectBackupWorkerResult } from '../worker/projectBackupWorker';
/** Restore parsing and cloning run away from the UI, with a hard termination deadline. */
export function restoreProjectInWorker(
  file: File,
  ownerUserId: UserId
): Promise<ProjectBackup> {
  if (file.size > MAX_PROJECT_BACKUP_BYTES)
    return Promise.reject(
      new Error('Project backup exceeds the 256 MB limit.')
    );
  const worker = new Worker(
    new URL('../worker/projectBackupWorker.ts', import.meta.url),
    { type: 'module' }
  );
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.terminate();
      callback();
    };
    const timeout = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error('Project restore exceeded the 120 second time limit.')
          )
        ),
      120_000
    );
    worker.onerror = () =>
      finish(() => reject(new Error('Project restore worker failed.')));
    worker.onmessageerror = () =>
      finish(() =>
        reject(new Error('Project restore returned unreadable data.'))
      );
    worker.onmessage = (event: MessageEvent<ProjectBackupWorkerResult>) =>
      finish(() => {
        if (event.data.ok) resolve(event.data.backup);
        else reject(new Error(event.data.error));
      });
    try {
      worker.postMessage({ file, ownerUserId });
    } catch (error) {
      finish(() =>
        reject(
          error instanceof Error
            ? error
            : new Error('Project restore could not start.')
        )
      );
    }
  });
}
