import type { ProjectDocument } from '@openzcad/shared';
import type { SourceBlobDeleteInput } from './localProjectStore';
import {
  importSourceChecksums,
  sourceBlobClaimExpired,
  sourceBlobClaimHolds,
  type SourceBlobClaim
} from './sourceBlobClaims';
import {
  LOCAL_PROJECT_BLOB_STORE as BLOB_STORE,
  LOCAL_PROJECT_CLAIM_STORE as CLAIM_STORE,
  LOCAL_PROJECT_DATABASE_NAME,
  LOCAL_PROJECT_DATABASE_VERSION,
  LOCAL_PROJECT_DOCUMENT_STORE as DOCUMENT_STORE
} from './localProjectSchema';

interface SourceBlobClaimRecord extends SourceBlobClaim {
  claimKey: string;
}

function claimKey(checksumSha256: string, claimId: string): string {
  return `${checksumSha256}:${claimId}`;
}

function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('Local project storage failed.'));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(
      LOCAL_PROJECT_DATABASE_NAME,
      LOCAL_PROJECT_DATABASE_VERSION
    );
    // Cleanup is reached only after the import path settled the schema. Never
    // let this secondary entry point perform a partial upgrade on its own.
    request.onupgradeneeded = () => request.transaction?.abort();
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB unavailable.'));
  });
}

function scopedTransaction<T>(
  storeNames: readonly string[],
  action: (store: (name: string) => IDBObjectStore) => Promise<T>
): Promise<T> {
  return openDatabase().then(async (database) => {
    const transaction = database.transaction([...storeNames], 'readwrite');
    const committed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      const fail = () =>
        reject(transaction.error ?? new Error('Local project storage failed.'));
      transaction.onerror = fail;
      transaction.onabort = fail;
    });
    committed.catch(() => undefined);
    try {
      const value = await action((name) => transaction.objectStore(name));
      await committed;
      return value;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // Already settled; the original error remains the report.
      }
      throw error;
    } finally {
      database.close();
    }
  });
}

/** Walks a store inside the caller's transaction, stopping when asked. */
function forEachRecord<T>(
  store: IDBObjectStore,
  visit: (value: T) => boolean | void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = store.openCursor();
    request.onsuccess = () => {
      try {
        const cursor = request.result;
        if (!cursor || visit(cursor.value as T) === false) {
          resolve();
          return;
        }
        cursor.continue();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    request.onerror = () =>
      reject(request.error ?? new Error('Local project storage failed.'));
  });
}

/** The atomic, device-wide proof and deletion behind refused-import cleanup. */
export function run(input: SourceBlobDeleteInput): Promise<boolean> {
  const { checksumSha256 } = input;
  const ownClaimId = input.claimId ?? null;
  const now = input.now ?? Date.now();
  return scopedTransaction(
    [DOCUMENT_STORE, BLOB_STORE, CLAIM_STORE],
    async (store) => {
      const claims = store(CLAIM_STORE);
      let claimed = false;
      const expiredClaimKeys: string[] = [];
      await forEachRecord<SourceBlobClaimRecord>(claims, (claim) => {
        if (sourceBlobClaimHolds(claim, { checksumSha256, ownClaimId, now })) {
          claimed = true;
          return false;
        }
        if (
          claim.claimId !== ownClaimId &&
          sourceBlobClaimExpired(claim, now)
        ) {
          expiredClaimKeys.push(claim.claimKey);
        }
        return true;
      });
      for (const expiredClaimKey of expiredClaimKeys) {
        await settled(claims.delete(expiredClaimKey));
      }
      if (claimed) {
        return false;
      }

      let referenced = false;
      await forEachRecord<ProjectDocument>(
        store(DOCUMENT_STORE),
        (document) => {
          if (importSourceChecksums(document).has(checksumSha256)) {
            referenced = true;
            return false;
          }
          return true;
        }
      );
      if (referenced) {
        return false;
      }

      if (ownClaimId !== null) {
        await settled(claims.delete(claimKey(checksumSha256, ownClaimId)));
      }
      await settled(store(BLOB_STORE).delete(checksumSha256));
      return true;
    }
  );
}
