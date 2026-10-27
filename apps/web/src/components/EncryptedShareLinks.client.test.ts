import { expect, it, vi } from 'vitest';
import { pageEncryptedShareLinkClient } from './EncryptedShareLinks';

vi.mock('../lib/e2ee/encryptedProjects', () => ({
  encryptedShareLinks: async () => ({ ctx: { groups: { account: { userId: 'owner' } } } })
}));
vi.mock('../lib/e2ee/shareLinks', () => ({
  maintainShareLinks: async () => { throw new Error('Share work unavailable'); },
  shareWorkFor: () => ({ read: async () => { throw new Error('Share work unavailable'); } }),
  listShareLinks: async () => ({
    isOwner: true,
    delegation: {},
    links: [{ shareId: 'old-link', mode: 'view', url: null, status: 'active', expiresAt: 123 }]
  }),
  delegationNeedsRenewal: () => false
}));

it('returns the share view and warning when upkeep and journal reads are unavailable', async () => {
  await expect(pageEncryptedShareLinkClient.list('project')).resolves.toMatchObject({
    links: [{ shareId: 'old-link', status: 'active' }],
    retired: [], removalNotice: null, removalLinks: [],
    problem: 'Share work unavailable'
  });
});
