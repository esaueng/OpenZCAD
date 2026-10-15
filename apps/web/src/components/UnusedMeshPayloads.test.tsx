import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { InMemoryPersistenceService } from '@openzcad/persistence';
import {
  toArtifactId,
  toAssetId,
  toUserId,
  type ArtifactRecord,
  type ProjectDocument
} from '@openzcad/shared';
import { describe, expect, it, vi } from 'vitest';
import UnusedMeshPayloads, {
  type UnusedMeshPayloadsProps
} from './UnusedMeshPayloads';

function payload(
  document: ProjectDocument,
  artifactId = 'artifact_unused'
): ArtifactRecord {
  return {
    artifactId: toArtifactId(artifactId),
    projectId: document.projectId,
    kind: 'mesh-payload',
    name: `${artifactId}.stl.ozmesh`,
    objectKey: '',
    contentType: 'application/vnd.openzcad.mesh-payload',
    bytes: 128,
    metadata: {},
    createdAt: '2026-01-01T00:00:00.000Z'
  };
}

function fixture() {
  const manager = new CommandManager(
    createProjectDocument('Cleanup', toUserId('user_cleanup'))
  );
  const artifact = payload(manager.document);
  const transport = {
    listArtifacts: vi.fn<UnusedMeshPayloadsProps['transport']['listArtifacts']>(
      async () => ({ artifacts: [artifact] })
    ),
    discardMeshPayload: vi.fn<
      UnusedMeshPayloadsProps['transport']['discardMeshPayload']
    >(async () => ({ deleted: false }))
  };
  const props: UnusedMeshPayloadsProps = {
    document: manager.document,
    getDocument: () => manager.document,
    transport
  };
  return { manager, artifact, transport, props };
}

function importPayload(manager: CommandManager, artifact: ArtifactRecord) {
  manager.execute(
    commandFactories.importMesh({
      name: 'Referenced mesh',
      artifactId: artifact.artifactId,
      sourceName: 'scan.stl',
      triangleCount: 1,
      meshPayloadRef: {
        marker: 'openzcad-source-ref',
        version: 1,
        hashAlgorithm: 'sha256',
        checksumSha256: '0'.repeat(64),
        logicalBytes: 128
      }
    })
  );
}

describe('manual unused mesh cleanup', () => {
  it.each(['current', 'undo', 'redo'] as const)(
    'keeps sources held by %s geometry out of manual removal',
    async (state) => {
      const { manager, artifact, transport, props } = fixture();
      importPayload(manager, artifact);
      if (state === 'undo') {
        const feature = Object.values(manager.document.nodes).find(
          (node) =>
            node.kind === 'feature' && node.data.featureKind === 'imported-mesh'
        );
        if (!feature || feature.kind !== 'feature')
          throw new Error('Missing mesh fixture');
        manager.execute(
          commandFactories.deleteFeature({ featureId: feature.featureId })
        );
      } else if (state === 'redo') manager.undo();
      expect(
        Object.values(manager.document.nodes).some(
          (node) =>
            node.kind === 'feature' &&
            node.data.featureKind === 'imported-mesh' &&
            node.data.artifactId === artifact.artifactId
        )
      ).toBe(state === 'current');
      const unused = payload(manager.document, 'artifact_orphan');
      const other = createProjectDocument('Other', toUserId('user_cleanup'));
      transport.listArtifacts.mockResolvedValue({
        artifacts: [
          artifact,
          unused,
          payload(other),
          {
            ...artifact,
            artifactId: toArtifactId('artifact_other_kind'),
            name: 'other.step',
            kind: 'step-import'
          }
        ]
      });
      render(<UnusedMeshPayloads {...props} document={manager.document} />);
      await screen.findByRole('button', {
        name: /Remove unused mesh data: artifact_orphan/
      });
      expect(
        screen.queryByRole('button', { name: /artifact_unused/ })
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /other.step/ })
      ).not.toBeInTheDocument();
      expect(screen.getAllByRole('button')).toHaveLength(1);
      expect(transport.discardMeshPayload).not.toHaveBeenCalled();
    }
  );

  it.each(['stl-import', 'mesh-import'] as const)(
    'recovers failed cleanup of an unused %s original after reopening File',
    async (kind) => {
      const service = new InMemoryPersistenceService();
      const owner = toUserId('user_original_cleanup');
      const { document } = await service.createProject(owner, {
        name: 'Original cleanup'
      });
      const body = new Uint8Array([1, 2, 3]);
      const { session } = await service.createUploadSession(owner, {
        projectId: document.projectId,
        fileName: 'scan.stl',
        kind,
        contentType: 'model/stl'
      });
      await service.putUpload(owner, session.uploadSessionId, body.buffer);
      await service.finalizeArtifact(owner, {
        projectId: document.projectId,
        uploadSessionId: session.uploadSessionId,
        artifactId: session.artifactId
      });
      const transport: UnusedMeshPayloadsProps['transport'] = {
        listArtifacts: vi.fn<
          UnusedMeshPayloadsProps['transport']['listArtifacts']
        >(async (projectId) => service.listArtifacts(owner, projectId)),
        discardMeshPayload: vi.fn<
          UnusedMeshPayloadsProps['transport']['discardMeshPayload']
        >(async (projectId, artifactId, originalKind) =>
          service.discardMeshPayload(owner, projectId, artifactId, originalKind)
        )
      };
      vi.mocked(transport.discardMeshPayload).mockRejectedValueOnce(
        new Error('Original cleanup unavailable')
      );
      const props = { document, getDocument: () => document, transport };
      const view = render(<UnusedMeshPayloads {...props} />);
      const remove = await screen.findByRole('button', {
        name: 'Remove unused imported file: scan.stl'
      });
      fireEvent.click(remove);
      await waitFor(() =>
        expect(
          screen.getByRole('status', { name: 'Mesh cleanup' })
        ).toHaveTextContent('Original cleanup unavailable')
      );
      expect(remove).toBeEnabled();
      expect(await service.getStorageUsage(owner)).toMatchObject({
        artifactBytes: body.length,
        artifactCount: 1
      });
      view.unmount();
      render(<UnusedMeshPayloads {...props} />);
      const retry = await screen.findByRole('button', {
        name: 'Remove unused imported file: scan.stl'
      });
      fireEvent.click(retry);
      await waitFor(() => expect(retry).not.toBeInTheDocument());
      expect(transport.discardMeshPayload).toHaveBeenLastCalledWith(
        document.projectId,
        session.artifactId,
        kind
      );
      expect(await service.getStorageUsage(owner)).toMatchObject({
        artifactBytes: 0,
        artifactCount: 0
      });
      expect(
        await service.downloadArtifact(owner, session.artifactId)
      ).toBeNull();
    }
  );

  it.each(['current', 'undo'] as const)(
    'keeps an original referenced by a %s project asset out of removal',
    async (state) => {
      const { props, artifact, transport } = fixture();
      artifact.kind = 'stl-import';
      artifact.name = 'scan.stl';
      const assetId = toAssetId('asset_original');
      const asset = {
        assetId,
        artifactId: artifact.artifactId,
        name: artifact.name,
        kind: 'stl-source' as const,
        storage: 'remote' as const,
        contentType: 'model/stl',
        createdAt: artifact.createdAt
      };
      const document: ProjectDocument = {
        ...props.document,
        assets: state === 'current' ? { [assetId]: asset } : {},
        ...(state === 'undo'
          ? {
              editHistory: {
                schemaVersion: 1 as const,
                projectId: props.document.projectId,
                actorUserId: props.document.ownerUserId,
                entries: [
                  {
                    id: 'asset_undo',
                    label: 'Remove original',
                    changes: [
                      {
                        kind: 'value' as const,
                        field: 'assets' as const,
                        key: assetId,
                        before: asset
                      }
                    ]
                  }
                ],
                cursor: 1,
                trimmed: 0
              }
            }
          : {})
      };
      transport.listArtifacts.mockResolvedValue({
        artifacts: [
          artifact,
          {
            ...artifact,
            artifactId: toArtifactId('artifact_unreferenced_original'),
            name: 'unused.stl'
          }
        ]
      });
      render(
        <UnusedMeshPayloads
          {...props}
          document={document}
          getDocument={() => document}
        />
      );
      await screen.findByRole('button', {
        name: 'Remove unused imported file: unused.stl'
      });
      expect(
        screen.queryByRole('button', {
          name: 'Remove unused imported file: scan.stl'
        })
      ).not.toBeInTheDocument();
      expect(transport.discardMeshPayload).not.toHaveBeenCalled();
    }
  );

  it('updates only the captured project listing after confirmed removal', async () => {
    const { props, artifact, transport } = fixture();
    artifact.kind = 'stl-import';
    artifact.name = 'scan.stl';
    const onRemove = vi.fn<NonNullable<UnusedMeshPayloadsProps['onRemove']>>();
    render(<UnusedMeshPayloads {...props} onRemove={onRemove} />);
    const remove = await screen.findByRole('button', {
      name: 'Remove unused imported file: scan.stl'
    });
    fireEvent.click(remove);
    await waitFor(() => expect(remove).toBeEnabled());
    expect(onRemove).not.toHaveBeenCalled();
    transport.discardMeshPayload.mockRejectedValueOnce(new Error('Offline'));
    fireEvent.click(remove);
    await waitFor(() =>
      expect(
        screen.getByRole('status', { name: 'Mesh cleanup' })
      ).toHaveTextContent('Offline')
    );
    expect(onRemove).not.toHaveBeenCalled();
    transport.discardMeshPayload.mockResolvedValueOnce({ deleted: true });
    fireEvent.click(remove);
    await waitFor(() => expect(remove).not.toBeInTheDocument());
    expect(onRemove).toHaveBeenCalledOnce();
    const otherProject = createProjectDocument(
      'Other',
      toUserId('user_cleanup')
    );
    const foreign = { ...artifact, projectId: otherProject.projectId };
    const retained = {
      ...artifact,
      artifactId: toArtifactId('artifact_retained')
    };
    expect(onRemove.mock.calls[0]![0]([artifact, foreign, retained])).toEqual([
      foreign,
      retained
    ]);
  });

  it.each(['retained', 'offline'] as const)(
    'keeps a %s server refusal visible for an explicit retry',
    async (failure) => {
      const { artifact, transport, props } = fixture();
      if (failure === 'offline')
        transport.discardMeshPayload.mockRejectedValueOnce(
          new Error('Connection unavailable')
        );
      render(<UnusedMeshPayloads {...props} />);
      const remove = await screen.findByRole('button', {
        name: /Remove unused mesh data:/
      });
      fireEvent.click(remove);
      await waitFor(() => expect(remove).toBeEnabled());
      expect(
        screen.getByRole('status', { name: 'Mesh cleanup' })
      ).toHaveTextContent(
        failure === 'offline'
          ? 'Connection unavailable'
          : 'still used by stored project history'
      );
      expect(remove).toBeInTheDocument();
      transport.discardMeshPayload.mockResolvedValueOnce({ deleted: true });
      fireEvent.click(remove);
      await waitFor(() => expect(remove).not.toBeInTheDocument());
      expect(transport.discardMeshPayload.mock.calls).toEqual([
        [props.document.projectId, artifact.artifactId],
        [props.document.projectId, artifact.artifactId]
      ]);
    }
  );

  it.each(['reference restored', 'project replaced'] as const)(
    'rechecks the live document when %s after the listing loads',
    async (change) => {
      const { manager, artifact, transport, props } = fixture();
      let live = manager.document;
      render(<UnusedMeshPayloads {...props} getDocument={() => live} />);
      const remove = await screen.findByRole('button', {
        name: /Remove unused mesh data:/
      });
      if (change === 'reference restored') {
        importPayload(manager, artifact);
        live = manager.document;
      } else live = createProjectDocument('Other', toUserId('user_cleanup'));
      fireEvent.click(remove);
      expect(transport.discardMeshPayload).not.toHaveBeenCalled();
      expect(
        screen.getByRole('status', { name: 'Mesh cleanup' })
      ).toHaveTextContent('in use and was kept');
    }
  );

  it('does not publish a late removal response into a different project', async () => {
    const { transport, props } = fixture();
    let complete!: (value: { deleted: boolean }) => void;
    transport.discardMeshPayload.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      })
    );
    const view = render(
      <UnusedMeshPayloads key={props.document.projectId} {...props} />
    );
    fireEvent.click(
      await screen.findByRole('button', { name: /Remove unused mesh data:/ })
    );
    const next = fixture();
    next.artifact.name = 'other.stl.ozmesh';
    view.rerender(
      <UnusedMeshPayloads key={next.props.document.projectId} {...next.props} />
    );
    await screen.findByRole('button', { name: /other.stl/ });
    complete({ deleted: true });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /other.stl/ })).toBeEnabled()
    );
    expect(
      screen.queryByText('Unused mesh data removed.')
    ).not.toBeInTheDocument();
    expect(next.transport.discardMeshPayload).not.toHaveBeenCalled();
  });
});
