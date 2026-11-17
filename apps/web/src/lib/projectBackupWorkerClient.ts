import { observeWorker } from './diagnosticSignal';
import type { UserId } from '@openzcad/shared';
import { MAX_PROJECT_BACKUP_BYTES, type ProjectBackup } from './projectBackup';
import type { ProjectBackupWorkerResult } from '../worker/projectBackupWorker';
import { carryEncryptionRequirement } from './api';
/**
 * Restore parsing and cloning run away from the UI, with a hard termination
 * deadline. The copy comes back under a new project id: when this device
 * keeps the backup's own project encrypted, the copy keeps that requirement,
 * recorded durably before it resolves (so before the page saves it), or the
 * restore is refused (PR #1418).
 */
export function restoreProjectInWorker(
  file: File,
  ownerUserId: UserId
): Promise<ProjectBackup> {
  if (file.size > MAX_PROJECT_BACKUP_BYTES)
    return Promise.reject(
      new Error('Project backup exceeds the 256 MB limit.')
    );
  const worker = observeWorker(
    new Worker(new URL('../worker/projectBackupWorker.ts', import.meta.url), {
      type: 'module'
    })
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
        const result = event.data;
        if (!result.ok) {
          reject(new Error(result.error));
          return;
        }
        if (typeof result.sourceProjectId !== 'string') {
          reject(new Error('Project restore returned unreadable data.'));
          return;
        }
        try {
          carryEncryptionRequirement(
            result.sourceProjectId,
            result.backup.document.projectId,
            { account: false }
          );
        } catch (error) {
          reject(
            error instanceof Error
              ? error
              : new Error('Project restore could not be saved.')
          );
          return;
        }
        resolve(result.backup);
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
