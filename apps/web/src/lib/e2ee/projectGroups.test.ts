import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  toBase64Url,
  wrapKey,
  type VerifiedDeviceList
} from '@openzcad/crypto';
import type { E2eeProjectKeyWrap } from '@openzcad/shared';
import {
  allowKeySession,
  beginKeySessionTeardown,
  getKeySessionRevision
} from './keySession';
import type { MlsProjectSessions } from './mls/projectSessions';
import {
  ProjectGroupApiError,
  ProjectGroupError,
  catchUpProjectGroup,
  commitProjectGroup,
  createProjectGroup,
  createProjectGroupsApi,
  joinProjectGroup,
  projectKeyForEpoch,
  type ProjectGroupContext,
  type ProjectGroupsApi
} from './projectGroups';
import {
  cachedProjectKeyCount,
  forgetAllProjectKeys,
  forgetProjectKeys,
  rememberProjectKey,
  unlockedProjectKey
} from './unlockedProjectKeys';

const USER = 'user_unit';
const PROJECT = 'proj_unit';

afterEach(() => {
  forgetAllProjectKeys();
  allowKeySession(getKeySessionRevision());
  vi.restoreAllMocks();
});

const key = (fill: number) => new Uint8Array(32).fill(fill);

/** Only what the module reads of a list: its live devices. */
const list = (deviceIds: string[]) =>
  ({
    userId: USER,
    devices: deviceIds.map((deviceId) => ({ deviceId })),
    revoked: []
  }) as unknown as VerifiedDeviceList;

function unusedApi(): ProjectGroupsApi & { calls: string[] } {
  const calls: string[] = [];
  const fail = (name: string) => async () => {
    calls.push(name);
    throw new Error(`${name} must not be called`);
  };
  return {
    calls,
    group: fail('group'),
    createGroup: fail('createGroup'),
    commits: fail('commits'),
    submitCommit: fail('submitCommit'),
    leaves: fail('leaves'),
    keys: fail('keys'),
    archives: fail('archives')
  };
}

function context(
  api: ProjectGroupsApi,
  overrides: Partial<ProjectGroupContext> = {}
): ProjectGroupContext {
  return {
    api,
    sessions: {} as MlsProjectSessions,
    account: {
      userId: USER,
      list: list(['unit_laptop']),
      currentAccountKey: async () => ({
        key: key(9),
        generation: 2,
        keySequence: 4
      }),
      openAccountKey: async () => {
        throw new Error('no older key');
      }
    },
    device: null,
    ...overrides
  };
}

describe('project group API client', () => {
  it('names each route and keeps the refusal body', async () => {
    const seen: { url: string; method: string; body: unknown }[] = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body
          ? (JSON.parse(init.body as string) as unknown)
          : undefined
      });
      if (url.endsWith('/mls/commits') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            error: 'taken',
            code: 'EPOCH_TAKEN',
            winner: { epoch: 4, message: 'AQ' }
          }),
          { status: 409 }
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const api = createProjectGroupsApi(fetcher);
    await api.group('proj a');
    await api.commits(PROJECT, 3);
    await api.keys(PROJECT, { purpose: 'rejoin-psk', after: 2 });
    await api.archives(PROJECT, { keyEpoch: 0 });
    await api.leaves(PROJECT);
    const refused = await api
      .submitCommit(PROJECT, {
        epoch: 4,
        kind: 'commit',
        deviceId: 'd',
        message: 'AQ',
        groupInfo: 'AQ',
        wraps: [],
        archive: {
          keyEpoch: 5,
          envelope: 'AQ',
          wrappedVersionKey: 'AQ',
          signature: 'AQ',
          signerDeviceId: 'd'
        }
      })
      .catch((error: unknown) => error);
    expect(seen.map(({ url, method }) => `${method} ${url}`)).toEqual([
      'GET /api/e2ee/projects/proj%20a/mls/group-info',
      'GET /api/e2ee/projects/proj_unit/mls/commits?after=3',
      'GET /api/e2ee/projects/proj_unit/keys?purpose=rejoin-psk&after=2',
      'GET /api/e2ee/projects/proj_unit/keys/archives?keyEpoch=0',
      'GET /api/e2ee/projects/proj_unit/mls/leaves',
      'POST /api/e2ee/projects/proj_unit/mls/commits'
    ]);
    expect(refused).toBeInstanceOf(ProjectGroupApiError);
    expect(refused).toMatchObject({
      status: 409,
      code: 'EPOCH_TAKEN',
      body: { winner: { epoch: 4, message: 'AQ' } }
    });
  });

  it('reads a non-JSON answer as unavailable', async () => {
    const api = createProjectGroupsApi(
      async () => new Response('<html></html>', { status: 200 })
    );
    await expect(api.leaves(PROJECT)).rejects.toMatchObject({ status: 502 });
  });
});

describe('project keys', () => {
  it('opens a wrap made under an older account key through the history, then caches it', async () => {
    const older = key(5);
    const projectKey = key(42);
    const wrap: E2eeProjectKeyWrap = {
      keyEpoch: 3,
      purpose: 'project-key',
      accountKeyGeneration: 1,
      accountKeySequence: 2,
      wrapped: toBase64Url(
        await wrapKey(older, projectKey, {
          purpose: 'project-key',
          userId: USER,
          projectId: PROJECT,
          keyEpoch: 3
        })
      )
    };
    const keys = vi.fn(async () => ({ wraps: [wrap], more: false }));
    const openAccountKey = vi.fn(async () => new Uint8Array(older));
    const ctx = context(
      { ...unusedApi(), keys },
      {
        account: {
          ...context(unusedApi()).account,
          openAccountKey
        }
      }
    );
    expect(await projectKeyForEpoch(ctx, PROJECT, 3)).toEqual(projectKey);
    expect(openAccountKey).toHaveBeenCalledWith(1, 2);
    expect(keys).toHaveBeenCalledWith(PROJECT, {
      keyEpoch: 3,
      purpose: 'project-key'
    });
    // Cached: no second request.
    expect(await projectKeyForEpoch(ctx, PROJECT, 3)).toEqual(projectKey);
    expect(keys).toHaveBeenCalledTimes(1);
  });

  it('refuses a wrap moved to another epoch', async () => {
    const current = key(9);
    const wrapped = toBase64Url(
      await wrapKey(current, key(1), {
        purpose: 'project-key',
        userId: USER,
        projectId: PROJECT,
        keyEpoch: 1
      })
    );
    const api = {
      ...unusedApi(),
      keys: async () => ({
        wraps: [
          {
            keyEpoch: 2,
            purpose: 'project-key' as const,
            accountKeyGeneration: 2,
            accountKeySequence: 4,
            wrapped
          }
        ],
        more: false
      })
    };
    await expect(
      projectKeyForEpoch(context(api), PROJECT, 2)
    ).rejects.toThrow();
    expect(cachedProjectKeyCount()).toBe(0);
  });

  it('reports a missing key without inventing one', async () => {
    const api = {
      ...unusedApi(),
      keys: async () => ({ wraps: [], more: false })
    };
    await expect(
      projectKeyForEpoch(context(api), PROJECT, 7)
    ).rejects.toMatchObject({
      code: 'key-missing'
    });
  });
});

describe('leaf operations', () => {
  it('refuse a device the list does not certify before contacting the server', async () => {
    const api = unusedApi();
    const signing = {} as CryptoKey;
    for (const device of [
      null,
      {
        userId: USER,
        deviceId: 'read_only_tablet',
        signing: { privateKey: signing }
      },
      {
        userId: 'user_else',
        deviceId: 'unit_laptop',
        signing: { privateKey: signing }
      }
    ]) {
      const ctx = context(api, { device });
      for (const run of [
        createProjectGroup,
        joinProjectGroup,
        catchUpProjectGroup,
        commitProjectGroup
      ]) {
        const error = await run(ctx, PROJECT).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ProjectGroupError);
        expect(error).toMatchObject({ code: 'device-not-certified' });
      }
    }
    expect(api.calls).toEqual([]);
  });
});

describe('unlocked project keys', () => {
  it('keeps copies, refuses a second key for an epoch and zeroes on forget', () => {
    const original = key(7);
    rememberProjectKey(USER, PROJECT, 0, original);
    original.fill(0);
    const read = unlockedProjectKey(USER, PROJECT, 0)!;
    expect(read).toEqual(key(7));
    read.fill(1);
    expect(unlockedProjectKey(USER, PROJECT, 0)).toEqual(key(7));
    rememberProjectKey(USER, PROJECT, 0, key(7));
    expect(() => rememberProjectKey(USER, PROJECT, 0, key(8))).toThrow(
      'Two different project keys'
    );
    expect(() => rememberProjectKey(USER, PROJECT, -1, key(8))).toThrow();
    expect(() =>
      rememberProjectKey(USER, PROJECT, 1, new Uint8Array(16))
    ).toThrow();
    rememberProjectKey(USER, 'proj_other', 0, key(3));
    forgetProjectKeys(USER, PROJECT);
    expect(unlockedProjectKey(USER, PROJECT, 0)).toBeUndefined();
    expect(unlockedProjectKey(USER, 'proj_other', 0)).toEqual(key(3));
  });

  it('forgets every key when the key session is torn down', () => {
    rememberProjectKey(USER, PROJECT, 0, key(7));
    rememberProjectKey('user_two', PROJECT, 1, key(8));
    expect(cachedProjectKeyCount()).toBe(2);
    beginKeySessionTeardown();
    expect(cachedProjectKeyCount()).toBe(0);
    expect(unlockedProjectKey(USER, PROJECT, 0)).toBeUndefined();
  });
});
