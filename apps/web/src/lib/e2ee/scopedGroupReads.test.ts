import { describe, expect, it, vi } from 'vitest';
import type { ProjectGroupsApi } from './projectGroups';
import {
  SCOPED_READ_MAX_AGE_MS,
  withScopedGroupReads
} from './scopedGroupReads';

function fakeApi() {
  let leaves = 0;
  const api = {
    group: vi.fn(async () => ({ group: { epoch: 1 } })),
    leaves: vi.fn(async () => ({ leaves: [{ n: ++leaves }] })),
    authority: vi.fn(async () => ({ authority: null })),
    commits: vi.fn(async (_projectId: string, after: number) => ({
      commits: after < 1 ? [{ epoch: 1 }] : [],
      more: false
    })),
    archives: vi.fn(async () => ({ archives: [] })),
    submitCommit: vi.fn(async () => ({})),
    saveAuthority: vi.fn(async () => ({ authority: null }))
  };
  return api as typeof api & ProjectGroupsApi;
}

describe('withScopedGroupReads', () => {
  it('sends a repeated read once inside a scope and every time outside one', async () => {
    const raw = fakeApi();
    const { api, scope } = withScopedGroupReads(raw);
    await api.leaves('p');
    await api.leaves('p');
    expect(raw.leaves).toHaveBeenCalledTimes(2);

    raw.leaves.mockClear();
    await scope(async () => {
      const [a, b] = await Promise.all([api.leaves('p'), api.leaves('p')]);
      expect(await api.leaves('p')).toEqual(a);
      expect(b).toEqual(a);
      await api.leaves('other');
    });
    expect(raw.leaves.mock.calls).toEqual([['p'], ['other']]);

    // The scope's answers end with it.
    await api.leaves('p');
    expect(raw.leaves).toHaveBeenCalledTimes(3);
  });

  it('gives each caller its own copy of a shared answer', async () => {
    const { api, scope } = withScopedGroupReads(fakeApi());
    await scope(async () => {
      const first = await api.leaves('p');
      (first.leaves as unknown[]).push('changed');
      expect((await api.leaves('p')).leaves).toHaveLength(1);
    });
  });

  it('reads again after a write, a Commit or a failed read', async () => {
    const raw = fakeApi();
    const { api, scope } = withScopedGroupReads(raw);
    await scope(async () => {
      await api.leaves('p');
      await api.submitCommit('p', {} as never);
      await api.leaves('p');
      expect(raw.leaves).toHaveBeenCalledTimes(2);

      // A Commits read with nothing new keeps the answers.
      await api.commits('p', 1);
      await api.leaves('p');
      expect(raw.leaves).toHaveBeenCalledTimes(2);
      // One that returns Commits does not: the group moved on.
      await api.commits('p', 0);
      await api.leaves('p');
      expect(raw.leaves).toHaveBeenCalledTimes(3);

      // Other reads leave the answers alone.
      await api.archives('p');
      await api.leaves('p');
      expect(raw.leaves).toHaveBeenCalledTimes(3);

      raw.authority.mockRejectedValueOnce(new Error('503'));
      await expect(api.authority!('p')).rejects.toThrow('503');
      await api.authority!('p');
      await api.leaves('p');
      expect(raw.authority).toHaveBeenCalledTimes(2);
      expect(raw.leaves).toHaveBeenCalledTimes(4);
    });
  });

  it('reads again once an answer is older than the limit, even in a scope', async () => {
    const raw = fakeApi();
    let now = 0;
    const { api, scope } = withScopedGroupReads(raw, () => now);
    await scope(async () => {
      await api.group('p');
      now = SCOPED_READ_MAX_AGE_MS;
      await api.group('p');
      expect(raw.group).toHaveBeenCalledTimes(1);
      now = SCOPED_READ_MAX_AGE_MS + 1;
      await api.group('p');
      expect(raw.group).toHaveBeenCalledTimes(2);
    });
  });

  it('keeps optional methods absent when the API has none', () => {
    const { api } = withScopedGroupReads({
      group: vi.fn(),
      leaves: vi.fn()
    } as unknown as ProjectGroupsApi);
    expect(api.authority).toBeUndefined();
    expect(api.resetGroup).toBeUndefined();
  });
});
