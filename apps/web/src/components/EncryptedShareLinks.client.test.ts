import { expect, it, vi } from 'vitest';
import {
  pageEncryptedShareLinkClient,
  snapshotProblem
} from './EncryptedShareLinks';

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
  {
    pending: ['authority'],
    needsConfirmation: true,
    problem: null,
    message: /needs your confirmation/
  },
  {
    pending: ['snapshot'],
    needsConfirmation: false,
    problem: 'Model upload unavailable',
    message: /sharing dialog to retry.*Model upload unavailable/
  },
  {
    pending: ['authority'],
    needsConfirmation: false,
    problem: 'Authority publication unavailable',
    message: /sharing dialog to retry.*Authority publication unavailable/
  },
  {
    pending: ['authority', 'snapshot'],
    needsConfirmation: true,
    problem: null,
    message: /needs your confirmation/
  }
])(
  'does not offer a newly created link with pending $pending work',
  async ({ pending, needsConfirmation, problem, message }) => {
    createShareLink.mockResolvedValueOnce({
      url: 'https://app.example/#share=a.b.c',
      pending,
      needsConfirmation,
      problem
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

it('reports a link snapshot the upkeep could not publish until one is published', () => {
  const none = { published: [], failed: [] };
  const failed = {
    published: [],
    failed: [{ shareId: 'link', reason: 'Snapshot unavailable' }]
  };
  expect(snapshotProblem(null)).toBeNull();
  expect(
    snapshotProblem({
      authorities: {
        issued: ['link'],
        current: [],
        needsConfirmation: [],
        failed: [],
        snapshots: failed
      },
      snapshots: none
    })
  ).toMatch(/could not be published.*Snapshot unavailable/);
  // The upkeep's later publication caught up.
  expect(
    snapshotProblem({
      authorities: {
        issued: ['link'],
        current: [],
        needsConfirmation: [],
        failed: [],
        snapshots: failed
      },
      snapshots: { published: ['link'], failed: [] }
    })
  ).toBeNull();
});
