import { act } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import {
  appendRevision,
  createCheckpoint,
  createProjectDocument,
  importMeshBody
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { setup, box, rejectedSave } from './collaborationCheckpointTestHarness';
import { listLocalSaveStateIds, loadLocalSaveState } from './localProjectStore';

async function privateSnapshot(projectId: string) {
  for (const id of await listLocalSaveStateIds(projectId)) {
    const snapshot = await loadLocalSaveState(projectId, id);
    if (snapshot?.checkpoints.at(-1)?.reason === 'Private failed save')
      return snapshot;
  }
  throw new Error('The clicked named state was not stored on this device.');
}

function largeEdit(document: ProjectDocument) {
  const triangle = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  return importMeshBody(document, {
    name: 'Large buffered mesh',
    artifactId: 'artifact_owned',
    sourceName: 'large.stl',
    triangleCount: 30_000,
    vertices: Array.from(
      { length: 270_000 },
      (_, index) => triangle[index % 9]!
    ),
    indices: Array.from({ length: 90_000 }, (_, index) => index)
  }).document;
}

it.each([
  'ordinary edit',
  'oversized HTTP edit',
  'lease reacquisition',
  'Keep my version',
  'pending ACK and later named save'
] as const)(
  'keeps a failed named state private through %s while preserving its local snapshot',
  async (mode) => {
    const clicked = box(
      createProjectDocument('Private failed checkpoint', toUserId('owner')),
      'Clicked box'
    );
    const requests: Array<{
      document: ProjectDocument;
      checkpointReason?: string;
    }> = [];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const input = JSON.parse(
        init?.body as string
      ) as (typeof requests)[number];
      requests.push(input);
      if (input.checkpointReason === 'Private failed save')
        return new Response(
          JSON.stringify({
            type: 'error',
            code: 'internal',
            message: 'Checkpoint storage unavailable.'
          }),
          { status: 503 }
        );
      const document = input.checkpointReason
        ? createCheckpoint(
            appendRevision(input.document, input.checkpointReason),
            input.checkpointReason
          )
        : input.document;
      return new Response(
        JSON.stringify({ type: 'ack', version: document.version, document })
      );
    });
    vi.stubGlobal('fetch', fetch);
    const hook = setup(clicked);
    const error = await rejectedSave(
      hook.result.current.saveCheckpoint(
        clicked,
        'Private failed save',
        hook.options
      )
    );
    expect(error.message).toContain('The named save is stored on this device.');
    const local = await privateSnapshot(clicked.projectId);
    const privatePoint = local.checkpoints.at(-1)!;
    const privateRevision = local.revisions.at(-1)!;
    expect(local.nodes).toEqual(clicked.nodes);
    expect(local.commandLog).toEqual(clicked.commandLog);
    expect(local.editHistory).toEqual(clicked.editHistory);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const later =
      mode === 'oversized HTTP edit'
        ? largeEdit(hook.read())
        : box(hook.read(), 'Later box');
    if (mode === 'lease reacquisition')
      act(() => hook.socket.receive({ type: 'lease-lost', reason: 'expired' }));
    hook.edit(later);
    if (mode === 'Keep my version') {
      const remote = {
        ...box(clicked, 'Remote box'),
        version: later.version + 2
      };
      act(() => hook.socket.receive({ type: 'conflict', document: remote }));
      const keeping = hook.result.current.keepLocalVersion(remote.version);
      await act(async () => {
        await vi.dynamicImportSettled();
      });
      act(() =>
        hook.socket.receive({ type: 'ack', version: remote.version + 1 })
      );
      await keeping;
    } else {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      if (mode === 'lease reacquisition')
        act(() =>
          hook.socket.receive({
            type: 'lease-granted',
            lease: {
              projectId: clicked.projectId,
              leaseId: 'new_private_checkpoint_lease',
              clientId: sessionStorage.getItem(
                'openzcad-collaboration-client'
              )!,
              userId: toUserId('member'),
              expiresAt: Date.now() + 60_000
            }
          })
        );
    }
    const wireDocuments = [
      ...hook.socket.sent
        .filter((frame) => frame.type === 'document')
        .map((frame) => frame.document!),
      ...requests
        .filter((request) => !request.checkpointReason)
        .map((request) => request.document)
    ];
    expect(wireDocuments.length).toBeGreaterThan(0);
    for (const sent of wireDocuments) {
      expect(sent.checkpoints.map((point) => point.checkpointId)).not.toContain(
        privatePoint.checkpointId
      );
      expect(
        sent.revisions.map((revision) => revision.revisionId)
      ).not.toContain(privateRevision.revisionId);
      expect(sent.nodes).toEqual(later.nodes);
      expect(sent.commandLog).toEqual(later.commandLog);
      expect(sent.editHistory).toEqual(later.editHistory);
    }
    expect(hook.read().nodes).toEqual(later.nodes);
    expect(
      hook.read().checkpoints.map((point) => point.checkpointId)
    ).not.toContain(privatePoint.checkpointId);
    expect(
      (await loadLocalSaveState(clicked.projectId, privatePoint.checkpointId))
        ?.nodes
    ).toEqual(clicked.nodes);
    if (mode === 'pending ACK and later named save') {
      const saving = hook.result.current.saveCheckpoint(
        hook.read(),
        'Verified room save',
        hook.options
      );
      await act(async () => {
        await vi.dynamicImportSettled();
      });
      expect(fetch).toHaveBeenCalledOnce();
      act(() =>
        hook.socket.receive({
          type: 'ack',
          version: later.version,
          document: wireDocuments.at(-1)!
        })
      );
      let saved!: ProjectDocument;
      await act(async () => {
        saved = await saving;
      });
      expect(requests.at(-1)?.checkpointReason).toBe('Verified room save');
      expect(
        requests.at(-1)?.document.checkpoints.map((point) => point.checkpointId)
      ).not.toContain(privatePoint.checkpointId);
      expect(
        requests
          .at(-1)
          ?.document.revisions.map((revision) => revision.revisionId)
      ).not.toContain(privateRevision.revisionId);
      hook.edit(box(hook.read(), 'After verified checkpoint'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      const published = hook.socket.sent
        .filter((frame) => frame.type === 'document')
        .at(-1)!.document!;
      expect(published.checkpoints).toContainEqual(saved.checkpoints.at(-1));
      expect(published.revisions).toContainEqual(saved.revisions.at(-1));
      expect(
        published.checkpoints.map((point) => point.checkpointId)
      ).not.toContain(privatePoint.checkpointId);
      expect(
        published.revisions.map((revision) => revision.revisionId)
      ).not.toContain(privateRevision.revisionId);
      expect(
        await loadLocalSaveState(clicked.projectId, privatePoint.checkpointId)
      ).not.toBeNull();
    }
    hook.unmount();
  }
);
