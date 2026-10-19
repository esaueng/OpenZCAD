import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { assertClientSavePoint } from '@openzcad/persistence';
import { toUserId, type SaveRevisionRequest } from '@openzcad/shared';
import { api } from './api';
import { desktopFetch } from './desktopBridge';

vi.mock('./desktopBridge', () => ({ desktopFetch: vi.fn() }));
afterEach(() => vi.clearAllMocks());

describe('a named account save (ADR-024 Phase 1)', () => {
  it('sends a save point the account accepts as minted', async () => {
    const document = createProjectDocument('Bracket', toUserId('owner'));
    vi.mocked(desktopFetch).mockResolvedValue(new Response('{}'));
    await api.saveRevision({
      projectId: document.projectId,
      reason: '  Before machining  ',
      expectedVersion: document.version,
      document
    });
    const sent = JSON.parse(
      vi.mocked(desktopFetch).mock.calls[0]![1]!.body as string
    ) as SaveRevisionRequest;
    expect(sent.reason).toBe('Before machining');
    expect(sent.document.version).toBe(document.version);
    expect(sent.document.revisions.slice(0, -1)).toEqual(document.revisions);
    expect(
      assertClientSavePoint(sent.document, {
        revisionId: sent.savedRevisionId!,
        reason: sent.reason
      }).reason
    ).toBe('Before machining');
  });
});
