/**
 * L08 commenter links on end-to-end encrypted projects (plan decisions 2
 * and 3a): the owner's comment grant beside a link, visitors' unsigned
 * `share-comment` envelopes under the link's share key, members reading
 * them with the share keys they hold, and the owner hiding one. The
 * account stores ciphertext only, and the grant never enters the document's
 * link set, so older builds still open the project.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  exportPublicKey,
  generateSigningKeyPair,
  publicKeyHash,
  shareKeyHash,
  signShareCommentGrant,
  signShareDelegation,
  toBase64Url
} from '@openzcad/crypto';
import { createE2eeShareLinksApi } from '@openzcad/shared';
import worker from '../apps/web/worker/index';
import { handleEncryptedLinkComments } from '../apps/web/worker/e2eeShareComments';
import { shareLinkTokenHash } from '../apps/web/worker/e2eeShareLinks';
import {
  decodeContentBlobJob,
  decodeProjectEnvelopeJob
} from '../apps/web/src/lib/e2ee/decodeJobs';
import {
  listLinkComments,
  postLinkComment,
  sealShareComment,
  type LinkCommentsAccess
} from '../apps/web/src/lib/e2ee/shareComments';
import {
  loadEncryptedSharedProject,
  type SharedSnapshotLoaderDeps
} from '../apps/web/src/lib/e2ee/sharedSnapshotLoader';
import {
  allowShareLinkComments,
  allowShareLinkCommentsById,
  commentingShareLinks,
  createShareLink,
  listShareLinkComments,
  publishShareSnapshots,
  renewShareDelegation,
  revokeShareLinks
} from '../apps/web/src/lib/e2ee/shareLinks';
import { forgetAllProjectKeys } from '../apps/web/src/lib/e2ee/unlockedProjectKeys';
import { shareLinkFromHash } from '../apps/web/src/lib/projectShareLink';
import {
  createEncryptedComments,
  createEncryptedCommentsApi
} from '../apps/web/src/lib/e2ee/encryptedComments';
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

describe('comment request transport limits', () => {
  it('retains valid encrypted comments with split UTF-8 and ignored Unicode fields', async () => {
    const { srv, laptop, projectId, link } = await sharedWithLink();
    await allowShareLinkComments(laptop.shareLinks, projectId, {
      shareId: link.shareId,
      shareKey: link.fragment.shareKey
    });
    const access = (await openLink(srv, link.url))!.comments!;
    const baseFetch = visitorFetch(srv);
    const api = createE2eeShareLinksApi(async (input, init) => {
      if (init?.method !== 'POST') return baseFetch(input, init);
      if (typeof init.body !== 'string')
        throw new Error('Expected a JSON request body.');
      const text = JSON.stringify({
        ...JSON.parse(init.body),
        padding: '漢'.repeat(40_000)
      });
      const bytes = new TextEncoder().encode(text);
      expect(text.length).toBeLessThan(100_000);
      expect(bytes.length).toBeGreaterThan(100_000);
      let offset = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (offset === bytes.length) controller.close();
            else {
              const end = Math.min(bytes.length, offset + 997);
              controller.enqueue(bytes.slice(offset, end));
              offset = end;
            }
          }
        },
        { highWaterMark: 0 }
      );
      return baseFetch(input, { ...init, body, duplex: 'half' } as RequestInit);
    });
    await postLinkComment(api as never, access, 'Visitor', {
      anchor: PIN,
      text: 'Still encrypted'
    });
    expect(
      (await listLinkComments(api as never, access)).map((c) => c.text)
    ).toEqual(['Still encrypted']);
  });

  it.each([
    ['visitor path', undefined],
    ['visitor path', '1'],
    ['visitor header', undefined],
    ['visitor header', '1'],
    ['owner grant', undefined],
    ['owner grant', '1']
  ])(
    'bounds streamed comment bodies before EOF: %s, length %s',
    async (route, length) => {
      const { srv, laptop, projectId, link } = await sharedWithLink();
      await allowShareLinkComments(laptop.shareLinks, projectId, {
        shareId: link.shareId,
        shareKey: link.fragment.shareKey
      });
      const grants = rows(srv, 'SELECT * FROM e2ee_share_comment_grants');
      const state = { chunks: 0, cancelled: false };
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (state.chunks === 10) controller.close();
            else {
              state.chunks++;
              controller.enqueue(new Uint8Array(25_001).fill(32));
            }
          },
          cancel() {
            state.cancelled = true;
          }
        },
        { highWaterMark: 0 }
      );
      const grant = route === 'owner grant';
      const path = grant
        ? `/api/e2ee/projects/${projectId}/share-links/${link.shareId}/comment-grant`
        : route === 'visitor header'
          ? '/api/e2ee/share/comments'
          : `/api/e2ee/share/${link.fragment.token}/comments`;
      const response = await worker.fetch(
        new Request(`https://example.com${path}`, {
          method: grant ? 'PUT' : 'POST',
          headers: {
            'content-type': 'application/json',
            ...(grant ? { 'x-openzcad-development-user': owner.userId } : {}),
            ...(route === 'visitor header'
              ? { 'x-openzcad-share-token': link.fragment.token }
              : {}),
            ...(length ? { 'content-length': length } : {})
          },
          body,
          duplex: 'half'
        } as RequestInit),
        srv.env
      );
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({
        code: 'E2EE_REQUEST_TOO_LARGE'
      });
      expect(state.cancelled).toBe(true);
      expect(state.chunks).toBeLessThan(10);
      expect(body.locked).toBe(false);
      expect(rows(srv, 'SELECT * FROM e2ee_share_comments')).toHaveLength(0);
      expect(rows(srv, 'SELECT * FROM e2ee_share_comment_grants')).toEqual(
        grants
      );
    }
  );
});

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
      const access: LinkCommentsAccess = opened!.comments!;
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

      // A member replies to the visitor's thread in their own signed log,
      // and the merged view hangs the reply under it.
      const editorComments = createEncryptedComments({
        userId: member.account.userId,
        kit: editor.store.replaced,
        pins: editor.pins,
        api: createEncryptedCommentsApi((path, init) =>
          editor.fetcher(path, init)
        )
      });
      await editorComments.create(projectId, OWNER, 'Editor', {
        parentId: threadId,
        text: 'Member reply'
      });
      const merged = await editorComments.list(projectId, OWNER, read.comments);
      expect(
        merged.comments.find((c) => c.text === 'Member reply')
      ).toMatchObject({
        parentId: threadId,
        authorUserId: member.account.userId
      });

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

    it('drops a grant no current owner device signed, until the owner signs again', async () => {
      const { srv, laptop, member, projectId, link } = await sharedWithLink();
      await allowShareLinkComments(laptop.shareLinks, projectId, {
        shareId: link.shareId,
        shareKey: link.fragment.shareKey
      });
      const opened = await openLink(srv, link.url);
      const visitorApi = createE2eeShareLinksApi(visitorFetch(srv));
      await postLinkComment(visitorApi as never, opened!.comments!, 'Ada', {
        anchor: PIN,
        text: 'Before the device went'
      });
      // The grant's signer is no longer one of the owner's devices (removed):
      // stand in for that with a grant by a key the owner never listed.
      const gone = await generateSigningKeyPair(false);
      const goneRaw = await exportPublicKey(gone.publicKey);
      const stale = await signShareCommentGrant(gone.privateKey, {
        projectId,
        shareId: link.shareId,
        shareKeyHash: await shareKeyHash(link.fragment.shareKey),
        issuedAt: Date.now(),
        signerKeyHash: await publicKeyHash(goneRaw)
      });
      srv.db
        .prepare(
          'UPDATE e2ee_share_comment_grants SET grant_statement = ?, grant_signature = ? WHERE share_id = ?'
        )
        .run(
          toBase64Url(stale.statement),
          toBase64Url(stale.signature),
          link.shareId
        );
      const editor = page(srv, member);
      expect([
        ...(await commentingShareLinks(editor.shareLinks, projectId))
      ]).toEqual([]);
      expect(
        (await listShareLinkComments(editor.shareLinks, projectId)).leftOut
      ).toBe(1);

      // The owner allows comments again: the new grant replaces the old one.
      await allowShareLinkCommentsById(
        laptop.shareLinks,
        projectId,
        link.shareId
      );
      expect([
        ...(await commentingShareLinks(editor.shareLinks, projectId))
      ]).toEqual([link.shareId]);
      expect(
        (
          await listShareLinkComments(editor.shareLinks, projectId)
        ).comments.map((c) => c.text)
      ).toEqual(['Before the device went']);
    });

    it('lets the owner hide a comment, and ends with the link', async () => {
      const { srv, laptop, projectId, link } = await sharedWithLink();
      await allowShareLinkComments(laptop.shareLinks, projectId, {
        shareId: link.shareId,
        shareKey: link.fragment.shareKey
      });
      const opened = await openLink(srv, link.url);
      const visitorApi = createE2eeShareLinksApi(visitorFetch(srv));
      const access: LinkCommentsAccess = opened!.comments!;
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

      // A post let in just before the link's comments end (a forget that
      // finishes meanwhile) inserts nothing: the insert checks again.
      const sealed = await sealShareComment({
        projectId,
        shareId: link.shareId,
        shareKey: link.fragment.shareKey,
        keyEpoch: access.keyEpoch,
        epochBindingHash: access.epochBindingHash,
        schemaVersion: access.schemaVersion,
        authorName: 'Late',
        comment: { anchor: PIN, text: 'Racing the forget' },
        now: Date.now()
      });
      const db = srv.env.DB as D1Database;
      const racing = new Proxy(db, {
        get(target, key, receiver) {
          if (key !== 'prepare')
            return Reflect.get(target, key, receiver) as unknown;
          return (sql: string) => {
            if (sql.includes('INSERT INTO e2ee_share_comments')) {
              srv.db
                .prepare(
                  'DELETE FROM e2ee_share_comment_grants WHERE share_id = ?'
                )
                .run(link.shareId);
            }
            return target.prepare(sql);
          };
        }
      });
      const before = rows(
        srv,
        'SELECT comment_id FROM e2ee_share_comments'
      ).length;
      const raced = await handleEncryptedLinkComments(
        new Request(
          `https://example.com/api/e2ee/share/${link.fragment.token}/comments`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(sealed)
          }
        ),
        `/api/e2ee/share/${link.fragment.token}/comments`,
        racing,
        true,
        shareLinkTokenHash
      );
      expect(raced.status).toBe(404);
      expect(
        rows(srv, 'SELECT comment_id FROM e2ee_share_comments')
      ).toHaveLength(before);

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
