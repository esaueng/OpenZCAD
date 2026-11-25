import { expect, it, vi } from 'vitest';
import { maintainEncryptedShareLinks } from './backgroundShareLinkUpkeep';

const { maintainShareLinks, ctx } = vi.hoisted(() => ({
  maintainShareLinks: vi.fn(),
  ctx: { groups: { account: { userId: 'owner' } } }
}));

vi.mock('./encryptedProjects', () => ({
  encryptedShareLinks: async () => ({ ctx, hasPasskey: () => false })
}));
vi.mock('./shareLinks', () => ({ maintainShareLinks }));

it('runs link upkeep for each project once, past one that fails', async () => {
  maintainShareLinks.mockImplementation(async (_ctx, projectId: string) => {
    if (projectId === 'proj_down') throw new Error('Share head unavailable');
    return { head: null, projectId };
  });
  const results = await maintainEncryptedShareLinks([
    'proj_down',
    'proj_a',
    'proj_a'
  ]);
  expect(maintainShareLinks.mock.calls).toEqual([
    [ctx, 'proj_down'],
    [ctx, 'proj_a']
  ]);
  expect(results).toEqual([
    { projectId: 'proj_down', error: 'Share head unavailable' },
    { projectId: 'proj_a', upkeep: { head: null, projectId: 'proj_a' } }
  ]);
});

it('stops before the next project once the session ended', async () => {
  maintainShareLinks.mockReset();
  maintainShareLinks.mockResolvedValue({ head: null });
  let current = true;
  maintainShareLinks.mockImplementationOnce(async () => {
    current = false;
    return { head: null };
  });
  const results = await maintainEncryptedShareLinks(['proj_a', 'proj_b'], {
    isCurrent: () => current
  });
  expect(results.map((result) => result.projectId)).toEqual(['proj_a']);
  expect(await maintainEncryptedShareLinks([])).toEqual([]);
});
