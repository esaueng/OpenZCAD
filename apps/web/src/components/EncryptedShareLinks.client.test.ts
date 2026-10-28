import { expect, it, vi } from 'vitest';
import { pageEncryptedShareLinkClient } from './EncryptedShareLinks';

const { createShareLink } = vi.hoisted(() => ({ createShareLink: vi.fn() }));

vi.mock('../lib/e2ee/encryptedProjects', () => ({
  encryptedShareLinks: async () => ({
    ctx: { groups: { account: { userId: 'owner' } } }
  })
}));
vi.mock('../lib/e2ee/shareLinks', () => ({
  createShareLink,
  maintainShareLinks: async () => {
    throw new Error('Share work unavailable');
  },
  shareWorkFor: () => ({
    read: async () => {
      throw new Error('Share work unavailable');
    }
  }),
  listShareLinks: async () => ({
    isOwner: true,
    delegation: {},
    links: [
      {
        shareId: 'old-link',
        mode: 'view',
        url: null,
        status: 'active',
        expiresAt: 123
      }
    ]
  }),
  delegationNeedsRenewal: () => false
}));

it.each([
  { pending: ['authority'], message: /needs your confirmation/ },
  { pending: ['snapshot'], message: /model is not published yet/ },
  { pending: ['authority', 'snapshot'], message: /needs your confirmation/ }
])(
  'does not offer a newly created link with pending $pending work',
  async ({ pending, message }) => {
    createShareLink.mockResolvedValueOnce({
      url: 'https://app.example/#share=a.b.c',
      pending
    });
    await expect(
      pageEncryptedShareLinkClient.create('project', 'view')
    ).rejects.toThrow(message);
  }
);

it('offers a newly created link once its authority and model are published', async () => {
  const url = 'https://app.example/#share=a.b.c';
  createShareLink.mockResolvedValueOnce({ url, pending: [] });
  await expect(
    pageEncryptedShareLinkClient.create('project', 'view')
  ).resolves.toEqual({ url });
});

it('returns the share view and warning when upkeep and journal reads are unavailable', async () => {
  await expect(
    pageEncryptedShareLinkClient.list('project')
  ).resolves.toMatchObject({
    links: [{ shareId: 'old-link', status: 'active' }],
    retired: [],
    removalNotice: null,
    removalLinks: [],
    problem: 'Share work unavailable'
  });
});
