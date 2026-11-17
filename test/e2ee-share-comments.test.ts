/**
 * L08 commenter links on end-to-end encrypted projects (plan decisions 2
 * and 3a): the owner's comment grant beside a link, visitors' unsigned
 * `share-comment` envelopes under the link's share key, members reading
 * them with the share keys they hold, and the owner hiding one. The
 * account stores ciphertext only, and the grant never enters the document's
 * link set, so older builds still open the project.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { signShareDelegation } from '@openzcad/crypto';
import { createE2eeShareLinksApi } from '@openzcad/shared';
import worker from '../apps/web/worker/index';
import {
  decodeContentBlobJob,
  decodeProjectEnvelopeJob
} from '../apps/web/src/lib/e2ee/decodeJobs';
import {
  listLinkComments,
  postLinkComment,
  type LinkCommentsAccess
} from '../apps/web/src/lib/e2ee/shareComments';
import {
  loadEncryptedSharedProject,
  type SharedSnapshotLoaderDeps
} from '../apps/web/src/lib/e2ee/sharedSnapshotLoader';
import {
  allowShareLinkComments,
  createShareLink,
  listShareLinkComments,
  publishShareSnapshots,
  renewShareDelegation,
  revokeShareLinks
} from '../apps/web/src/lib/e2ee/shareLinks';
import { forgetAllProjectKeys } from '../apps/web/src/lib/e2ee/unlockedProjectKeys';
import { shareLinkFromHash } from '../apps/web/src/lib/projectShareLink';
import {
  OTHER,
  OWNER,
  makeAccount,
  reload,
  rows,
  type Account,
  type Device,
  type DeviceOptions,
  type Server
} from './support/e2ee-documents';
import { sharedProject } from './support/e2ee-members';

const THIRD = 'user_third';
let owner: Account;
let other: Account;
let third: Account;

beforeAll(async () => {
  owner = await makeAccount(OWNER, ['owner_laptop']);
  other = await makeAccount(OTHER, ['other_laptop']);
  third = await makeAccount(THIRD, ['third_laptop']);
});

afterEach(() => {
  forgetAllProjectKeys();
});

const accounts = () => [owner, other, third];
const othersOf = (account: Account) =>
  accounts().filter((candidate) => candidate !== account);
const republish: DeviceOptions['onVersionWritten'] = (d, projectId, head) =>
  publishShareSnapshots(d.shareLinks, projectId, head);
const page = (srv: Server, d: Device) =>
  reload(srv, d, { members: othersOf(d.account), onVersionWritten: republish });

/** The visitor's network: anonymous requests, the token in a header. */
function visitorFetch(srv: Server): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const path =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.pathname
          : input.url;
    expect(path).toMatch(/^\/api\/e2ee\/share(\/blobs\/[^/]+|\/comments)?$/);
    expect(new Headers(init?.headers).get('x-openzcad-share-token')).toMatch(
      /^[A-Za-z0-9_-]{43}$/
    );
    expect(init?.credentials).toBe('omit');
    return worker.fetch(
      new Request(`https://example.com${path}`, init),
      srv.env
    );
  };
}

function visitorDeps(srv: Server): SharedSnapshotLoaderDeps {
  return {
    fetch: visitorFetch(srv),
    decodeProjectEnvelope: (job) =>
      decodeProjectEnvelopeJob({ type: 'project-envelope', ...job }),
    decodeContentBlob: (job) =>
      decodeContentBlobJob({ type: 'content-blob', ...job }),
    loadSourceBlob: async () => null,
    putSourceBlob: async () => undefined,
    idleMs: 5_000
  };
}

async function openLink(srv: Server, url: string) {
  return loadEncryptedSharedProject(
    shareLinkFromHash(new URL(url).hash)!,
    () => true,
    visitorDeps(srv)
  );
}

async function sharedWithLink() {
  const shared = await sharedProject(accounts(), owner, other, 'editor');
  const laptop = page(shared.srv, shared.laptop);
  await renewShareDelegation(laptop.shareLinks, (value) =>
    signShareDelegation(owner.identityPrivateKey, value)
  );
  const link = await createShareLink(
    laptop.shareLinks,
    shared.projectId,
    'view'
  );
  return { ...shared, laptop, link };
}

const PIN = {
  point: [1, 2, 3] as [number, number, number],
  documentVersion: 1
};

describe(
  'commenter links on encrypted projects (L08)',
  { timeout: 120_000 },
  () => {
    it('lets a granted link’s visitor comment under its share key, read by members as via link', async () => {
      const { srv, laptop, member, projectId, link } = await sharedWithLink();

      // Without a grant, the link opens read-only and takes no comments.
      const plain = await openLink(srv, link.url);
      expect(plain!.comments).toBeNull();
      const visitorApi = createE2eeShareLinksApi(visitorFetch(srv));
      expect(await visitorApi.linkComments!(link.fragment.token)).toBeNull();

      await allowShareLinkComments(laptop.shareLinks, projectId, {
        shareId: link.shareId,
        shareKey: link.fragment.shareKey
      });
      const opened = await openLink(srv, link.url);
      expect(opened!.comments).not.toBeNull();
      const access: LinkCommentsAccess = {
        projectId,
        shareId: link.shareId,
        ...opened!.comments!
      };
      const threadId = await postLinkComment(
        visitorApi as never,
        access,
        'Ada',
        { anchor: PIN, text: 'Secret note about the bore' }
      );
      await postLinkComment(visitorApi as never, access, 'Ada', {
        parentId: threadId,
        text: 'Secret follow-up'
      });

      const seen = await listLinkComments(visitorApi as never, access);
      expect(seen.map((c) => [c.authorName, c.text, c.parentId])).toEqual([
        ['Ada (via link)', 'Secret note about the bore', null],
        ['Ada (via link)', 'Secret follow-up', threadId]
      ]);
      expect(seen[0]!.anchor).toEqual(PIN);

      // A member opens them with the share key it holds, after checking the
      // grant against the owner's devices.
      const editor = page(srv, member);
      const read = await listShareLinkComments(editor.shareLinks, projectId);
      expect(read.leftOut).toBe(0);
      expect(read.comments.map((c) => c.text)).toEqual([
        'Secret note about the bore',
        'Secret follow-up'
      ]);
      expect(read.comments.every((c) => c.authorUserId === null)).toBe(true);

      // The account holds ciphertext only.
      const stored = JSON.stringify(
        rows(srv, 'SELECT * FROM e2ee_share_comments')
      );
      expect(stored).not.toContain('Secret');
      expect(stored).not.toContain('Ada');
      // And the grant is not a link-grant mode: the link stays a view link.
      expect(
        rows<{ mode: string }>(srv, 'SELECT mode FROM e2ee_share_links')
      ).toEqual([{ mode: 'view' }]);
    });

    it('takes a grant only from the owner, for a live link, signed by a certified owner device', async () => {
      const { srv, laptop, member, projectId, link } = await sharedWithLink();
      // An editor cannot grant comments.
      const editor = page(srv, member);
      await expect(
        allowShareLinkComments(editor.shareLinks, projectId, {
          shareId: link.shareId,
          shareKey: link.fragment.shareKey
        })
      ).rejects.toBeTruthy();
      // A grant for another share key is refused.
      await expect(
        allowShareLinkComments(laptop.shareLinks, projectId, {
          shareId: link.shareId,
          shareKey: new Uint8Array(32).fill(7)
        })
      ).rejects.toMatchObject({ status: 400 });
      expect(rows(srv, 'SELECT * FROM e2ee_share_comment_grants')).toEqual([]);
    });

    it('lets the owner hide a comment, and ends with the link', async () => {
      const { srv, laptop, projectId, link } = await sharedWithLink();
      await allowShareLinkComments(laptop.shareLinks, projectId, {
        shareId: link.shareId,
        shareKey: link.fragment.shareKey
      });
      const opened = await openLink(srv, link.url);
      const visitorApi = createE2eeShareLinksApi(visitorFetch(srv));
      const access: LinkCommentsAccess = {
        projectId,
        shareId: link.shareId,
        ...opened!.comments!
      };
      const hidden = await postLinkComment(
        visitorApi as never,
        access,
        'Spam',
        {
          anchor: PIN,
          text: 'Buy now'
        }
      );
      await postLinkComment(visitorApi as never, access, 'Ada', {
        anchor: PIN,
        text: 'Keep me'
      });
      await laptop.shareLinks.api.hideShareComment!(projectId, hidden);
      expect(
        (
          await listShareLinkComments(laptop.shareLinks, projectId)
        ).comments.map((c) => c.text)
      ).toEqual(['Keep me']);

      // A visitor's write refuses an envelope of another kind or project.
      const bogus = await worker.fetch(
        new Request('https://example.com/api/e2ee/share/comments', {
          method: 'POST',
          headers: {
            'x-openzcad-share-token': link.fragment.token,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            commentId: 'lcm_x',
            envelope: 'AAAA',
            wrappedVersionKey: 'AAAA'
          })
        }),
        srv.env
      );
      expect(bogus.status).toBe(400);

      // Revoked, the link takes no more comments and serves none.
      await revokeShareLinks(laptop.shareLinks, projectId, [link.shareId]);
      expect(await visitorApi.linkComments!(link.fragment.token)).toBeNull();
      await expect(
        postLinkComment(visitorApi as never, access, 'Ada', {
          anchor: PIN,
          text: 'Too late'
        })
      ).rejects.toMatchObject({ status: 404 });
    });
  }
);
