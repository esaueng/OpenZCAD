import { describe, expect, it, vi } from 'vitest';
import { E2EE_MIGRATION_LEASE_HEADER } from '@openzcad/shared';
import { ApiError } from '../api';
import {
  createProjectMigrationsApi,
  withMigrationLease
} from './projectMigrationsApi';

const LEASE = 'L'.repeat(43);
const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

describe('project migrations API', () => {
  it('names each route and the lease where the Worker reads it', async () => {
    const fetcher = vi.fn(async (_path: string, _init?: RequestInit) =>
      ok({ migration: null })
    );
    const api = createProjectMigrationsApi(fetcher);
    await api.start(
      'proj_a/b',
      { direction: 'encrypt', deviceId: 'dev_1' },
      null
    );
    await api.renew('proj_a', LEASE);
    await api.cutover('proj_a', LEASE);
    await api.abandon('proj_a');
    await api.purge('proj_a');
    await api.status('proj_a', LEASE);
    const calls = fetcher.mock.calls.map(([path, init]) => ({
      path,
      method: init?.method,
      lease: (init?.headers as Record<string, string>)[
        E2EE_MIGRATION_LEASE_HEADER
      ],
      body: init?.body
    }));
    expect(calls).toEqual([
      {
        path: '/api/e2ee/projects/proj_a%2Fb/migration',
        method: 'POST',
        lease: undefined,
        body: JSON.stringify({ direction: 'encrypt', deviceId: 'dev_1' })
      },
      {
        path: '/api/e2ee/projects/proj_a/migration/lease',
        method: 'POST',
        lease: LEASE,
        body: undefined
      },
      {
        path: '/api/e2ee/projects/proj_a/migration/cutover',
        method: 'POST',
        lease: LEASE,
        body: undefined
      },
      {
        path: '/api/e2ee/projects/proj_a/migration/abandon',
        method: 'POST',
        lease: undefined,
        body: undefined
      },
      {
        path: '/api/e2ee/projects/proj_a/migration/purge',
        method: 'POST',
        lease: undefined,
        body: undefined
      },
      {
        path: '/api/e2ee/projects/proj_a/migration',
        method: 'GET',
        lease: LEASE,
        body: undefined
      }
    ]);
  });

  it('turns refusals into ApiErrors with the Worker’s code', async () => {
    const api = createProjectMigrationsApi(
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: 'Another device is encrypting this project.',
              code: 'E2EE_MIGRATION_LEASED',
              deviceId: 'dev_2'
            }),
            { status: 409 }
          )
      )
    );
    const error = await api.cutover('proj_a', LEASE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'E2EE_MIGRATION_LEASED'
    });
  });

  it('adds the lease to every request a wrapped fetcher sends', async () => {
    const fetcher = vi.fn(async (_path: string, _init?: RequestInit) => ok({}));
    const leased = withMigrationLease(fetcher, LEASE);
    await leased('/api/e2ee/projects/p/document', {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' }
    });
    await leased('/api/e2ee/projects/p/info', {
      headers: new Headers({ accept: 'application/json' })
    });
    await leased('/api/e2ee/projects/p/mls/leaves');
    expect(fetcher.mock.calls.map(([, init]) => init?.headers)).toEqual([
      {
        'content-type': 'application/octet-stream',
        [E2EE_MIGRATION_LEASE_HEADER]: LEASE
      },
      { accept: 'application/json', [E2EE_MIGRATION_LEASE_HEADER]: LEASE },
      { [E2EE_MIGRATION_LEASE_HEADER]: LEASE }
    ]);
    expect(fetcher.mock.calls[0]![1]!.method).toBe('PUT');
  });
});
