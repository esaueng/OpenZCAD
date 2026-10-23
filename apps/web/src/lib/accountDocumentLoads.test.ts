import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { api, isProjectDocumentUnavailableError } from './api';
import { desktopFetch } from './desktopBridge';

vi.mock('./desktopBridge', () => ({ desktopFetch: vi.fn() }));
afterEach(() => vi.clearAllMocks());

function serve(document: unknown) {
  vi.mocked(desktopFetch).mockResolvedValue(
    new Response(JSON.stringify(document), {
      headers: { 'content-type': 'application/json' }
    })
  );
}

const valid = addPrimitiveFeature(
  createProjectDocument('Loaded', toUserId('owner')),
  {
    name: 'Box',
    primitiveKind: 'box',
    dimensions: { width: 1, height: 1, depth: 1 }
  }
);

/**
 * ADR-024 Phase 1: the account stores and serves documents unread, so the
 * browser refuses a loaded version it cannot open. The refusal is the
 * unreadable-account-copy error, which keeps the device copy open and
 * autosave waiting, rather than replacing either copy with the bad one.
 */
describe('account document loads', () => {
  it.each(['project', 'revision'] as const)(
    'refuses a %s this browser cannot open as an unreadable account copy',
    async (kind) => {
      serve({ ...valid, objectFolders: 'folders' });
      const load =
        kind === 'project'
          ? api.loadProject(valid.projectId)
          : api.loadRevision(valid.projectId, 'rev_1');
      const error = await load.then(
        () => null,
        (caught: unknown) => caught
      );
      expect(isProjectDocumentUnavailableError(error)).toBe(true);
      expect((error as Error).message).toMatch(
        /cannot be opened here: .*objectFolders/
      );
    }
  );

  it('opens a valid or older account document the way loads always have', async () => {
    serve(valid);
    expect(await api.loadProject(valid.projectId)).toMatchObject({
      projectId: valid.projectId,
      featureOrder: valid.featureOrder
    });
    const { schemaVersion: _schema, ...unversioned } = valid;
    serve(unversioned);
    const loaded = (await api.loadRevision(
      valid.projectId,
      'rev_1'
    )) as ProjectDocument;
    expect(loaded.featureOrder).toEqual(valid.featureOrder);
    expect(typeof loaded.schemaVersion).toBe('number');
  });
});
