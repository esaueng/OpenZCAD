import { describe, expect, it, vi } from 'vitest';
import { isProjectObjectStorageReady } from '../apps/web/worker/readiness';

const readyRow = {
  project_columns: 3,
  revision_pointer: 1,
  document_objects_table: 1,
  storage_assets_table: 1,
  document_objects_index: 1,
  storage_assets_index: 1,
  pointer_indexes: 2
};

function database(row: typeof readyRow | null = readyRow) {
  const first = vi.fn(async () => row);
  return {
    db: {
      prepare: vi.fn(() => ({ first }))
    } as unknown as D1Database,
    first
  };
}

function bucket(): R2Bucket {
  return {
    put: vi.fn(),
    get: vi.fn(),
    delete: vi.fn()
  } as unknown as R2Bucket;
}

describe('R2 project storage readiness', () => {
  it('requires migration 0011 schema objects and a usable R2 binding', async () => {
    const { db, first } = database();
    await expect(isProjectObjectStorageReady(db, bucket())).resolves.toBe(true);
    expect(first).toHaveBeenCalledOnce();
  });

  it('fails closed for a partial migration', async () => {
    const { db } = database({ ...readyRow, storage_assets_table: 0 });
    await expect(isProjectObjectStorageReady(db, bucket())).resolves.toBe(
      false
    );
  });

  it('fails closed without R2 before querying D1', async () => {
    const { db, first } = database();
    await expect(isProjectObjectStorageReady(db, undefined)).resolves.toBe(
      false
    );
    expect(first).not.toHaveBeenCalled();
  });
});
