import { describe, expect, it, vi } from 'vitest';
import {
  isAccountErasureReady,
  isProjectMeasurementStorageReady,
  isProjectObjectStorageReady
} from '../apps/web/worker/readiness';

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

describe('account erasure readiness', () => {
  it('requires the erasure fence and every write-safety trigger through 0015', async () => {
    const first = vi.fn(async () => ({ table_ready: 1, trigger_count: 25 }));
    const prepare = vi.fn((_query: string) => ({ first }));
    const db = {
      prepare
    } as unknown as D1Database;

    await expect(isAccountErasureReady(db)).resolves.toBe(true);
    const query: string | undefined = prepare.mock.calls[0]?.[0];
    expect(query).toContain('account_erasure_requests');
    expect(query).toContain('block_erasing_%');
  });

  it('fails closed when any erasure trigger is missing', async () => {
    const db = {
      prepare: vi.fn(() => ({
        first: vi.fn(async () => ({ table_ready: 1, trigger_count: 24 }))
      }))
    } as unknown as D1Database;
    await expect(isAccountErasureReady(db)).resolves.toBe(false);
  });
});

describe('project measurement storage readiness', () => {
  const ready = {
    table_ready: 1,
    columns_ready: 5,
    cascade_ready: 1,
    erasure_triggers: 2
  };

  it('requires the isolated table, cascade, and both erasure fences', async () => {
    const first = vi.fn(async () => ready);
    const prepare = vi.fn((query: string) => ({ first, query }));
    await expect(
      isProjectMeasurementStorageReady({ prepare } as unknown as D1Database)
    ).resolves.toBe(true);
    const query: string | undefined = prepare.mock.calls[0]?.[0];
    expect(query).toContain("pragma_table_info('project_measurements')");
    expect(query).toContain("pragma_foreign_key_list('project_measurements')");
    expect(query).toContain('block_erasing_measurement_update');
  });

  it('fails closed for a partial migration or query error', async () => {
    const partial = {
      prepare: vi.fn(() => ({
        first: vi.fn(async () => ({ ...ready, erasure_triggers: 1 }))
      }))
    } as unknown as D1Database;
    await expect(isProjectMeasurementStorageReady(partial)).resolves.toBe(
      false
    );
    const failed = {
      prepare: vi.fn(() => ({
        first: vi.fn(async () => {
          throw new Error('D1 unavailable');
        })
      }))
    } as unknown as D1Database;
    await expect(isProjectMeasurementStorageReady(failed)).resolves.toBe(false);
  });
});
