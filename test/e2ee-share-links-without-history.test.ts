/**
 * L08: end-to-end encrypted share links without history (mode `frozen`).
 * The owner's and an editor's Node devices run the real share-link client
 * against the real Worker over SQLite, and a visitor runs the real loader.
 * What is checked: the visitor only ever receives the frozen solids, a save
 * from any device never republishes the project into such a link, and
 * Update replaces the model under the same URL.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  signProjectEnvelope,
  signShareDelegation,
  toBase64Url
} from '@openzcad/crypto';
import {
  frozenShareDocument,
  frozenShareDocumentProblem,
  isSharedWithoutHistory,
  listNodesByKind,
  sharedProjectSnapshotDocument
} from '@openzcad/document-core';
import type { ProjectDocument } from '@openzcad/shared';
import worker from '../apps/web/worker/index';
import type { ArchiveArtifactInput } from '../apps/web/src/lib/archiveArtifact';
import {
  decodeContentBlobJob,
  decodeProjectEnvelopeJob
} from '../apps/web/src/lib/e2ee/decodeJobs';
import {
  epochAuthenticatorForEpoch,
  projectKeyForEpoch
} from '../apps/web/src/lib/e2ee/projectGroups';
import {
  SharedLinkRefusal,
  loadEncryptedSharedProject,
  type SharedSnapshotLoaderDeps
} from '../apps/web/src/lib/e2ee/sharedSnapshotLoader';
import {
  ShareLinksError,
  createShareLink,
  listShareLinks,
  publishShareSnapshots,
  reissueShareLinks,
  renewShareDelegation,
  sealSnapshot,
  updateFrozenShareLink
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

const STEP = 'ISO-10303-21;\nEND-ISO-10303-21;\n';
const SECRET = 'secret-bracket';

let owner: Account;
let other: Account;

beforeAll(async () => {
  owner = await makeAccount(OWNER, ['owner_laptop']);
  other = await makeAccount(OTHER, ['other_laptop']);
});

afterEach(() => {
  forgetAllProjectKeys();
});

const accounts = () => [owner, other];
const othersOf = (account: Account) =>
  accounts().filter((candidate) => candidate !== account);
const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

const republish: DeviceOptions['onVersionWritten'] = (d, projectId, head) =>
  publishShareSnapshots(d.shareLinks, projectId, head);

const page = (srv: Server, d: Device) =>
  reload(srv, d, { members: othersOf(d.account), onVersionWritten: republish });

function withImport(
  document: ProjectDocument,
  artifactId: string,
  bytes: Uint8Array,
  name = 'Bracket source'
): ProjectDocument {
  const manager = new CommandManager(document);
  manager.execute(
    commandFactories.importStep({
      name,
      sourceName: `${SECRET}.step`,
      artifactId,
      stepSourceRef: {
        marker: 'openzcad-source-ref',
        version: 1,
        hashAlgorithm: 'sha256',
        checksumSha256: sha256(bytes),
        logicalBytes: bytes.byteLength
      }
    })
  );
  return manager.document;
}

/**
 * The owner's project, shared with OTHER as an editor: one STEP import held
 * as a content blob (history a visitor of a frozen link must never get),
 * and a confirmed delegation.
 */
async function project() {
  const shared = await sharedProject(accounts(), owner, other, 'editor');
  const laptop = page(shared.srv, shared.laptop);
  const step = new TextEncoder().encode(
    `ISO-10303-21;\nHEADER;\nFILE_NAME('${SECRET}');\n${'DATA;\n'.repeat(50)}END-ISO-10303-21;\n`
  );
  const input: ArchiveArtifactInput = {
    fileName: `${SECRET}.step`,
    contentType: 'model/step',
    kind: 'step-import',
    body: new Blob([step])
  };
  const blobId = await laptop.blobs.archive(shared.projectId, input);
  const document = withImport(shared.document, blobId, step);
  await laptop.store.saveProjectDocument({
    projectId: shared.projectId,
    expectedVersion: shared.document.version,
    document
  });
  await renewShareDelegation(laptop.shareLinks, (value) =>
    signShareDelegation(owner.identityPrivateKey, value)
  );
  return { ...shared, laptop, document, blobId, step };
}

const frozenOf = (document: ProjectDocument, bodyName = 'Plate') =>
  frozenShareDocument(document, [
    { name: bodyName, stepText: STEP, color: null, opacity: null }
  ]);

/** A visitor's browser: anonymous requests to the Worker, nothing else. */
function visitor(srv: Server) {
  const requests: string[] = [];
  const sources = new Map<string, Uint8Array>();
  const deps: SharedSnapshotLoaderDeps = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.pathname
            : input.url;
      requests.push(path);
      return worker.fetch(
        new Request(`https://example.com${path}`, init),
        srv.env
      );
    },
    decodeProjectEnvelope: (job) =>
      decodeProjectEnvelopeJob({ type: 'project-envelope', ...job }),
    decodeContentBlob: (job) =>
      decodeContentBlobJob({ type: 'content-blob', ...job }),
    loadSourceBlob: async (checksum) => sources.get(checksum) ?? null,
    putSourceBlob: async (bytes) => {
      sources.set(sha256(bytes), bytes);
    },
    idleMs: 5_000
  };
  return {
    requests,
    open: (url: string) =>
      loadEncryptedSharedProject(
        shareLinkFromHash(new URL(url).hash)!,
        () => true,
        deps
      )
  };
}

const featureNames = (document: ProjectDocument) =>
  listNodesByKind(document, 'feature').map((node) => node.name);

describe(
  'an encrypted share link without history',
  { timeout: 120_000 },
  () => {
    it('gives the visitor the frozen solids and nothing of the project', async () => {
      const { srv, laptop, projectId, document, blobId } = await project();
      const link = await createShareLink(
        laptop.shareLinks,
        projectId,
        'frozen',
        frozenOf(document)
      );
      expect(link).toMatchObject({
        mode: 'frozen',
        pending: [],
        problem: null
      });

      const browser = visitor(srv);
      const opened = await browser.open(link.url);
      expect(opened).toMatchObject({
        projectId,
        shareId: link.shareId,
        mode: 'view'
      });
      expect(isSharedWithoutHistory(opened!.document)).toBe(true);
      expect(frozenShareDocumentProblem(opened!.document)).toBeNull();
      expect(featureNames(opened!.document)).toEqual(['Plate']);
      const served = JSON.stringify(opened!.document);
      expect(served).not.toContain(SECRET);
      expect(served).not.toContain(blobId);
      // One request: the frozen model names no file of the project.
      expect(browser.requests).toEqual(['/api/e2ee/share']);

      // The server keeps the mode column's old values and marks the link.
      expect(
        rows(
          srv,
          'SELECT mode, history FROM e2ee_share_links WHERE share_id = ?',
          link.shareId
        )
      ).toEqual([{ mode: 'view', history: 0 }]);
      const view = await listShareLinks(laptop.shareLinks, projectId);
      expect(view.links).toMatchObject([
        { shareId: link.shareId, mode: 'frozen', status: 'active' }
      ]);
      // The stored snapshot names no content blob a visitor could ask for.
      const blob = await worker.fetch(
        new Request(`https://example.com/api/e2ee/share/blobs/${blobId}`, {
          headers: { 'x-openzcad-share-token': link.fragment.token }
        }),
        srv.env
      );
      expect(blob.status).toBe(404);
    });

    it('needs a frozen model, and refuses the project itself', async () => {
      const { laptop, projectId, document } = await project();
      await expect(
        createShareLink(laptop.shareLinks, projectId, 'frozen')
      ).rejects.toBeInstanceOf(ShareLinksError);
      await expect(
        createShareLink(laptop.shareLinks, projectId, 'frozen', document)
      ).rejects.toMatchObject({ code: 'frozen-model' });
      await expect(
        createShareLink(
          laptop.shareLinks,
          projectId,
          'view',
          frozenOf(document)
        )
      ).rejects.toMatchObject({ code: 'frozen-model' });
      expect(
        (await listShareLinks(laptop.shareLinks, projectId)).links
      ).toEqual([]);
    });

    it('keeps the frozen model through the owner’s and an editor’s saves', async () => {
      const { srv, laptop, member, projectId, document, step, blobId } =
        await project();
      const frozen = await createShareLink(
        laptop.shareLinks,
        projectId,
        'frozen',
        frozenOf(document)
      );
      const live = await createShareLink(laptop.shareLinks, projectId, 'view');
      const browser = visitor(srv);

      // The owner edits and saves: the save hook republishes every link.
      const mine = await laptop.store.loadProject(projectId);
      await laptop.store.saveProjectDocument({
        projectId,
        expectedVersion: mine.version,
        document: withImport(mine, blobId, step, 'Owner edit')
      });
      await Promise.all(laptop.shareWork);
      expect(featureNames((await browser.open(live.url))!.document)).toContain(
        'Owner edit'
      );
      const afterOwner = await browser.open(frozen.url);
      expect(featureNames(afterOwner!.document)).toEqual(['Plate']);
      expect(JSON.stringify(afterOwner!.document)).not.toContain(SECRET);

      // An editor's device saves too, and publishes with its own key.
      const editor = page(srv, member);
      const theirs = await editor.store.loadProject(projectId);
      await editor.store.saveProjectDocument({
        projectId,
        expectedVersion: theirs.version,
        document: withImport(theirs, blobId, step, 'Editor edit')
      });
      await Promise.all(editor.shareWork);
      expect(featureNames((await browser.open(live.url))!.document)).toContain(
        'Editor edit'
      );
      const afterEditor = await browser.open(frozen.url);
      expect(featureNames(afterEditor!.document)).toEqual(['Plate']);
      expect(frozenShareDocumentProblem(afterEditor!.document)).toBeNull();
    });

    it('republishes its own stored model, never the project, when forced', async () => {
      const { srv, laptop, member, projectId, document } = await project();
      const link = await createShareLink(
        laptop.shareLinks,
        projectId,
        'frozen',
        frozenOf(document)
      );
      const stored = () =>
        rows(
          srv,
          'SELECT snapshot_hash, signer_device_id FROM e2ee_share_snapshots WHERE share_id = ?',
          link.shareId
        )[0] as { snapshot_hash: string; signer_device_id: string };
      const first = stored();
      // As after a new statement or key epoch: every link is sealed again,
      // here by the editor's device.
      const editor = page(srv, member);
      const outcome = await publishShareSnapshots(
        editor.shareLinks,
        projectId,
        undefined,
        { republish: [link.shareId] }
      );
      expect(outcome).toEqual({ published: [link.shareId], failed: [] });
      expect(stored().snapshot_hash).not.toBe(first.snapshot_hash);
      expect(stored().signer_device_id).toBe('other_laptop');
      const opened = await visitor(srv).open(link.url);
      expect(featureNames(opened!.document)).toEqual(['Plate']);
      expect(frozenShareDocumentProblem(opened!.document)).toBeNull();
    });

    it('leaves the link unpublished when it has no model to republish', async () => {
      const { srv, laptop, projectId, document } = await project();
      const link = await createShareLink(
        laptop.shareLinks,
        projectId,
        'frozen',
        frozenOf(document)
      );
      srv.db
        .prepare('DELETE FROM e2ee_share_snapshots WHERE share_id = ?')
        .run(link.shareId);
      const outcome = await publishShareSnapshots(laptop.shareLinks, projectId);
      expect(outcome.published).toEqual([]);
      expect(outcome.failed).toMatchObject([{ shareId: link.shareId }]);
      expect(outcome.failed[0]!.reason).toMatch(/Update the link/);
      expect(await visitor(srv).open(link.url)).toBeNull();
      expect(
        (await listShareLinks(laptop.shareLinks, projectId)).links
      ).toMatchObject([{ mode: 'frozen', status: 'not-published' }]);
    });

    it('Update replaces the model under the same link', async () => {
      const { srv, laptop, projectId, document } = await project();
      const link = await createShareLink(
        laptop.shareLinks,
        projectId,
        'frozen',
        frozenOf(document)
      );
      const browser = visitor(srv);
      expect(featureNames((await browser.open(link.url))!.document)).toEqual([
        'Plate'
      ]);
      await updateFrozenShareLink(
        laptop.shareLinks,
        projectId,
        link.shareId,
        frozenOf(document, 'Plate v2')
      );
      expect(featureNames((await browser.open(link.url))!.document)).toEqual([
        'Plate v2'
      ]);
      // Never the project, and never a link that shares its history.
      await expect(
        updateFrozenShareLink(
          laptop.shareLinks,
          projectId,
          link.shareId,
          document
        )
      ).rejects.toMatchObject({ code: 'frozen-model' });
      const live = await createShareLink(laptop.shareLinks, projectId, 'view');
      await expect(
        updateFrozenShareLink(
          laptop.shareLinks,
          projectId,
          live.shareId,
          frozenOf(document)
        )
      ).rejects.toMatchObject({ code: 'link-not-found' });
      expect(featureNames((await browser.open(link.url))!.document)).toEqual([
        'Plate v2'
      ]);
    });

    it('is not opened by a visitor when its snapshot holds the project', async () => {
      const { srv, laptop, projectId, document } = await project();
      const link = await createShareLink(
        laptop.shareLinks,
        projectId,
        'frozen',
        frozenOf(document)
      );
      // A publisher that ignored the mode (no build does): the project's own
      // share projection, sealed and signed properly, under the frozen link.
      const head = await laptop.store.shareHead(projectId);
      const groups = laptop.shareLinks.groups;
      const sealed = await sealSnapshot({
        projectId,
        shareId: link.shareId,
        keyEpoch: head.keyEpoch,
        projectKey: await projectKeyForEpoch(groups, projectId, head.keyEpoch),
        authenticator: await epochAuthenticatorForEpoch(
          groups,
          projectId,
          head.keyEpoch
        ),
        shareKey: link.fragment.shareKey,
        head,
        document: sharedProjectSnapshotDocument(head.document),
        blobs: [],
        sign: (envelope) =>
          signProjectEnvelope(
            owner.devices.get('owner_laptop')!.signing.privateKey,
            envelope
          )
      });
      await laptop.shareLinks.api.putSnapshot(
        projectId,
        link.shareId,
        {
          signature: toBase64Url(sealed.signature),
          signerDeviceId: 'owner_laptop',
          wrappedForLinkVisitors: toBase64Url(sealed.forLinkVisitors),
          wrappedForMembers: toBase64Url(sealed.forMembers)
        },
        sealed.envelope
      );
      const error = await visitor(srv)
        .open(link.url)
        .then(
          () => null,
          (caught: unknown) => caught
        );
      expect(error).toBeInstanceOf(SharedLinkRefusal);
      expect((error as SharedLinkRefusal).reason).toBe('not-verified');
      // Nor does any member's browser seal it again: the link stays as it is
      // until the owner's Update.
      const outcome = await publishShareSnapshots(
        laptop.shareLinks,
        projectId,
        undefined,
        { republish: [link.shareId] }
      );
      expect(outcome.published).toEqual([]);
      expect(outcome.failed).toMatchObject([{ shareId: link.shareId }]);
    });

    it('reissues the link with the model it served', async () => {
      const { srv, laptop, projectId, document } = await project();
      const link = await createShareLink(
        laptop.shareLinks,
        projectId,
        'frozen',
        frozenOf(document)
      );
      const [reissued] = await reissueShareLinks(laptop.shareLinks, projectId, [
        { shareId: link.shareId, mode: 'frozen' }
      ]);
      expect(reissued).toMatchObject({ mode: 'frozen', pending: [] });
      expect(reissued!.shareId).not.toBe(link.shareId);
      const browser = visitor(srv);
      expect(await browser.open(link.url)).toBeNull();
      const opened = await browser.open(reissued!.url);
      expect(featureNames(opened!.document)).toEqual(['Plate']);
      expect(JSON.stringify(opened!.document)).not.toContain(SECRET);
    });
  }
);
