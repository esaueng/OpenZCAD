import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CommandManager,
  commandFactories,
  type AnyCommand
} from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges,
  listFeaturesInOrder,
  renameNode,
  setNodeMetadata
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type ProjectDocument
} from '@openzcad/shared';
import { LivePreview } from '../lib/livePreview';
import { PreviewRebuilds } from '../lib/previewRebuilds';
import { useDirectEditCommit } from './useDirectEditCommit';

function body(bodyId: BodyId, name: string): BodyRepresentation {
  return {
    bodyId,
    name,
    source: 'primitive',
    color: '#56b4e9',
    consumed: false,
    exportableStep: true,
    mesh: {
      kind: 'mesh',
      vertices: Float32Array.from([]),
      indices: Uint32Array.from([])
    },
    faceCount: 3,
    volume: 1,
    bbox: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 1, y: 1, z: 1 }
    }
  };
}

function filletedCylinder() {
  const cylinder = addPrimitiveFeature(
    createProjectDocument('Filleted drag', toUserId('user_filleted_drag')),
    {
      name: 'Cylinder',
      primitiveKind: 'cylinder',
      dimensions: { radius: 4.6, height: 12 }
    }
  );
  const sourceBodyId = cylinder.bodyOrder[0]!;
  const sourceFeature = listFeaturesInOrder(cylinder)[0]!;
  const fillet = filletEdges(cylinder, {
    name: 'Two rim fillet',
    targetBodyId: sourceBodyId,
    edgeHashes: [101, 202],
    size: 1
  });
  const filletFeature = listFeaturesInOrder(fillet.document).at(-1)!;
  return { cylinder, sourceBodyId, sourceFeature, fillet, filletFeature };
}

describe('direct manipulation commit', () => {
  it('commits one primitive history edit after validating its derived fillet', async () => {
    const { sourceBodyId, sourceFeature, fillet } = filletedCylinder();
    const manager = new CommandManager(fillet.document);
    const command = commandFactories.updateFeature(
      {
        featureId: sourceFeature.featureId,
        data: { dimensions: { radius: 6.4 } }
      },
      'Resize Cylinder Radius'
    );
    const onCommitted = vi.fn();
    const { result } = renderHook(() =>
      useDirectEditCommit({
        manager: () => manager,
        derive: async (
          candidate: ProjectDocument
        ): Promise<ProjectDocument['derived']> => ({
          bodyRepresentations: {
            [sourceBodyId]: body(sourceBodyId, 'Cylinder'),
            [fillet.bodyId]: body(fillet.bodyId, 'Two rim fillet')
          },
          exportableBodyIds: [fillet.bodyId],
          warnings: [],
          updatedAt: candidate.derived.updatedAt
        }),
        commit: (candidate) => {
          manager.execute(candidate);
          return true;
        },
        onValidationStart: vi.fn(),
        onValidationFailed: vi.fn(),
        onCommitted,
        onBusy: vi.fn(),
        onStatus: vi.fn()
      })
    );

    let applied = false;
    await act(async () => {
      applied = await result.current.run(
        command,
        fillet.bodyId,
        'Adjusted cylinder radius.',
        6.4,
        undefined,
        [
          { featureName: 'Cylinder', resultBodyId: sourceBodyId },
          { featureName: 'Two rim fillet', resultBodyId: fillet.bodyId }
        ]
      );
    });

    expect(applied).toBe(true);
    expect(onCommitted).toHaveBeenCalledWith(fillet.bodyId);
    expect(listFeaturesInOrder(manager.document)).toHaveLength(2);
    expect(listFeaturesInOrder(manager.document)[0]!.data).toMatchObject({
      dimensions: { radius: 6.4, height: 12 }
    });
    expect(manager.canUndo).toBe(true);
    const undone = manager.undo();
    expect(listFeaturesInOrder(undone)).toHaveLength(2);
    expect(listFeaturesInOrder(undone)[0]!.data).toMatchObject({
      dimensions: { radius: 4.6, height: 12 }
    });
  });

  it('reuses a preview rebuild only while the document is the one it measured', async () => {
    const { sourceBodyId, sourceFeature, fillet } = filletedCylinder();
    const manager = new CommandManager(fillet.document);
    const command = commandFactories.updateFeature(
      {
        featureId: sourceFeature.featureId,
        data: { dimensions: { radius: 6.4 } }
      },
      'Resize Cylinder Radius'
    );
    const derivedFor = (
      candidate: ProjectDocument
    ): ProjectDocument['derived'] => ({
      bodyRepresentations: {
        [sourceBodyId]: body(sourceBodyId, 'Cylinder'),
        [fillet.bodyId]: body(fillet.bodyId, 'Two rim fillet')
      },
      exportableBodyIds: [fillet.bodyId],
      warnings: [],
      updatedAt: candidate.derived.updatedAt
    });
    const derive = vi.fn(async (candidate: ProjectDocument) =>
      derivedFor(candidate)
    );
    const { result } = renderHook(() =>
      useDirectEditCommit({
        manager: () => manager,
        derive,
        commit: (candidate) => {
          manager.execute(candidate);
          return true;
        },
        onValidationStart: vi.fn(),
        onValidationFailed: vi.fn(),
        onCommitted: vi.fn(),
        onBusy: vi.fn(),
        onStatus: vi.fn()
      })
    );

    // Same project and version as the preview measured: no second rebuild.
    const precomputed = {
      baseProjectId: manager.document.projectId,
      baseVersion: manager.document.version,
      derived: derivedFor(manager.document)
    };
    let applied = false;
    await act(async () => {
      applied = await result.current.run(
        command,
        fillet.bodyId,
        'Adjusted cylinder radius.',
        6.4,
        undefined,
        undefined,
        precomputed
      );
    });
    expect(applied).toBe(true);
    expect(derive).not.toHaveBeenCalled();

    // The document moved on since the preview: the stale rebuild is ignored
    // and the commit is measured afresh.
    manager.undo();
    manager.execute(
      commandFactories.updateFeature(
        {
          featureId: sourceFeature.featureId,
          data: { dimensions: { height: 14 } }
        },
        'Resize Cylinder Height'
      )
    );
    await act(async () => {
      applied = await result.current.run(
        command,
        fillet.bodyId,
        'Adjusted cylinder radius.',
        6.4,
        undefined,
        undefined,
        precomputed
      );
    });
    expect(applied).toBe(true);
    expect(derive).toHaveBeenCalledTimes(1);
  });

  it('reports a downstream blend failure without changing document history', async () => {
    const { sourceBodyId, sourceFeature, fillet, filletFeature } =
      filletedCylinder();
    const manager = new CommandManager(fillet.document);
    const before = structuredClone(manager.document);
    const command = commandFactories.updateFeature(
      {
        featureId: sourceFeature.featureId,
        data: { dimensions: { radius: 0.5 } }
      },
      'Resize Cylinder Radius'
    );
    const onValidationFailed = vi.fn();
    const onStatus = vi.fn();
    const { result } = renderHook(() =>
      useDirectEditCommit({
        manager: () => manager,
        derive: async (
          candidate: ProjectDocument
        ): Promise<ProjectDocument['derived']> => ({
          bodyRepresentations: {
            [sourceBodyId]: body(sourceBodyId, 'Cylinder')
          },
          exportableBodyIds: [sourceBodyId],
          warnings: [
            'Feature "Two rim fillet": Fillet could not be created on 2 selected edges with radius 1.'
          ],
          updatedAt: candidate.derived.updatedAt
        }),
        commit: vi.fn(() => true),
        onValidationStart: vi.fn(),
        onValidationFailed,
        onCommitted: vi.fn(),
        onBusy: vi.fn(),
        onStatus
      })
    );

    let applied = true;
    await act(async () => {
      applied = await result.current.run(
        command,
        fillet.bodyId,
        'Adjusted cylinder radius.',
        0.5,
        undefined,
        [
          {
            featureName: 'Cylinder',
            featureId: sourceFeature.featureId,
            resultBodyId: sourceBodyId
          },
          {
            featureName: 'Two rim fillet',
            featureId: filletFeature.featureId,
            resultBodyId: fillet.bodyId
          }
        ]
      );
    });

    expect(applied).toBe(false);
    expect(manager.document).toEqual(before);
    expect(manager.canUndo).toBe(false);
    // The refusal names the existing feature that could not be rebuilt, so the
    // panel can offer to open it rather than describing it in prose.
    expect(onValidationFailed).toHaveBeenCalledWith(
      {
        message:
          'Fillet could not be created on 2 selected edges with radius 1.',
        culprit: {
          featureId: filletFeature.featureId,
          featureName: 'Two rim fillet'
        }
      },
      0.5
    );
    // One owner per diagnostic: the running command shows the rejection at the
    // handle that caused it, and the status line is not handed a second copy
    // that can go stale while the value moves on.
    expect(
      onStatus.mock.calls
        .flat()
        .filter((message) =>
          String(message).includes('Fillet could not be created')
        )
    ).toEqual([]);
  });

  it('ignores an unrelated suppressed feature with the same name as a validation target', async () => {
    const { sourceBodyId, sourceFeature, fillet, filletFeature } =
      filletedCylinder();
    let document = renameNode(fillet.document, {
      nodeId: sourceFeature.id,
      name: 'Shared name'
    });
    document = renameNode(document, {
      nodeId: filletFeature.id,
      name: 'Shared name'
    });
    document = setNodeMetadata(document, {
      nodeId: filletFeature.id,
      metadata: { suppressed: true }
    });
    const manager = new CommandManager(document);
    const command = commandFactories.updateFeature(
      {
        featureId: sourceFeature.featureId,
        data: { dimensions: { radius: 6.4 } }
      },
      'Resize Cylinder Radius'
    );
    const suppression =
      'Feature "Shared name": Suppressed; skipped during exact rebuild.';
    const onValidationFailed = vi.fn();
    const { result } = renderHook(() =>
      useDirectEditCommit({
        manager: () => manager,
        derive: async (
          candidate: ProjectDocument
        ): Promise<ProjectDocument['derived']> => ({
          bodyRepresentations: {
            [sourceBodyId]: body(sourceBodyId, 'Shared name')
          },
          exportableBodyIds: [sourceBodyId],
          warnings: [suppression],
          featureWarnings: [
            {
              featureId: filletFeature.featureId,
              featureName: 'Shared name',
              message: suppression,
              kind: 'suppressed'
            }
          ],
          updatedAt: candidate.derived.updatedAt
        }),
        commit: (candidate) => {
          manager.execute(candidate);
          return true;
        },
        onValidationStart: vi.fn(),
        onValidationFailed,
        onCommitted: vi.fn(),
        onBusy: vi.fn(),
        onStatus: vi.fn()
      })
    );

    let applied = false;
    await act(async () => {
      applied = await result.current.run(
        command,
        sourceBodyId,
        'Adjusted cylinder radius.',
        6.4,
        undefined,
        [
          {
            featureName: 'Shared name',
            featureId: sourceFeature.featureId,
            resultBodyId: sourceBodyId
          }
        ]
      );
    });

    expect(applied).toBe(true);
    expect(onValidationFailed).not.toHaveBeenCalled();
    expect(listFeaturesInOrder(manager.document)[0]!.data).toMatchObject({
      dimensions: { radius: 6.4, height: 12 }
    });
  });
});

type Derived = ProjectDocument['derived'];

/**
 * The radius drag as App wires it: one LivePreview whose frames start their
 * rebuild through PreviewRebuilds, and a release that commits from the
 * published frame, else the frame still rebuilding, else its own rebuild.
 * Every rebuild — preview or commit — is one entry in `syncs`, standing in
 * for one exact syncDocument in the serialised geometry worker.
 */
function radiusDrag(options: { expectedFrameMs?: () => number } = {}) {
  const { sourceBodyId, sourceFeature, fillet } = filletedCylinder();
  const manager = new CommandManager(fillet.document);
  const syncs: {
    document: ProjectDocument;
    resolve(): void;
    reject(error: Error): void;
  }[] = [];
  const derivedFor = (candidate: ProjectDocument): Derived => ({
    bodyRepresentations: {
      [sourceBodyId]: body(sourceBodyId, 'Cylinder'),
      [fillet.bodyId]: body(fillet.bodyId, 'Two rim fillet')
    },
    exportableBodyIds: [fillet.bodyId],
    warnings: [],
    updatedAt: candidate.derived.updatedAt
  });
  const sync = (document: ProjectDocument) =>
    new Promise<Derived>((resolve, reject) => {
      syncs.push({
        document,
        resolve: () => resolve(derivedFor(document)),
        reject
      });
    });
  const resize = (radius: number) =>
    commandFactories.updateFeature(
      { featureId: sourceFeature.featureId, data: { dimensions: { radius } } },
      'Resize Cylinder Radius'
    );
  interface Candidate {
    radius: number;
    command: AnyCommand;
    document: ProjectDocument;
    baseProjectId: ProjectDocument['projectId'];
    baseVersion: number;
  }
  const rebuilds = new PreviewRebuilds<Derived>(() => Date.now());
  let published: { candidate: Candidate; derived: Derived } | null = null;
  const preview = new LivePreview<Candidate, Derived>({
    build: (radius) => {
      const base = manager.document;
      const command = resize(radius);
      return {
        radius,
        command,
        document: command.apply(base),
        baseProjectId: base.projectId,
        baseVersion: base.version
      };
    },
    derive: (candidate) =>
      rebuilds.start(candidate, () => sync(candidate.document), 'body'),
    publish: (frame) => {
      published = frame
        ? { candidate: frame.document, derived: frame.derived }
        : null;
    },
    publishIntermediate: true,
    continueAfterSlow: true,
    minIntervalMs: 100,
    slowSettleMs: 300,
    now: () => Date.now(),
    ...(options.expectedFrameMs
      ? { expectedFrameMs: options.expectedFrameMs }
      : {})
  });
  const commitDerive = vi.fn(sync);
  const committed: Derived[] = [];
  const { result } = renderHook(() =>
    useDirectEditCommit({
      manager: () => manager,
      derive: commitDerive,
      commit: (command, derived) => {
        manager.execute(command);
        committed.push(derived);
        return true;
      },
      onValidationStart: () => preview.stop(),
      onValidationFailed: vi.fn(),
      onCommitted: () => preview.clear(),
      onBusy: vi.fn(),
      onStatus: vi.fn()
    })
  );
  const targets = [
    { featureName: 'Cylinder', resultBodyId: sourceBodyId },
    { featureName: 'Two rim fillet', resultBodyId: fillet.bodyId }
  ];
  /** Mirrors handleCylinderRadiusCommit. */
  function release(radius: number): Promise<boolean> {
    const live = manager.document;
    const reuse = rebuilds.reusable(
      published,
      preview.running?.document,
      (candidate) =>
        candidate.radius === radius &&
        candidate.baseProjectId === live.projectId &&
        candidate.baseVersion === live.version
    );
    return result.current.run(
      reuse?.candidate.command ?? resize(radius),
      fillet.bodyId,
      'Adjusted cylinder radius.',
      radius,
      undefined,
      targets,
      reuse
        ? {
            baseProjectId: reuse.candidate.baseProjectId,
            baseVersion: reuse.candidate.baseVersion,
            derived: reuse.derived
          }
        : undefined
    );
  }
  const radiusOf = (document: ProjectDocument) => {
    const data = listFeaturesInOrder(document)[0]!.data;
    return data.featureKind === 'primitive' ? data.dimensions.radius : null;
  };
  return {
    manager,
    preview,
    syncs,
    commitDerive,
    committed,
    release,
    radiusOf,
    published: () => published
  };
}

describe('releasing a slow live preview', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('derives once when released at the value still rebuilding', async () => {
    vi.useFakeTimers();
    const drag = radiusDrag();
    drag.preview.request(6.4);
    expect(drag.syncs).toHaveLength(1);

    let applied: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      applied = drag.release(6.4);
      await vi.advanceTimersByTimeAsync(1_000);
    });
    // The commit waits on the preview's own rebuild rather than queuing the
    // same edit behind it.
    expect(drag.commitDerive).not.toHaveBeenCalled();
    expect(drag.syncs).toHaveLength(1);

    await act(async () => {
      drag.syncs[0]!.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
    await expect(applied).resolves.toBe(true);
    expect(drag.syncs).toHaveLength(1);
    expect(drag.committed).toHaveLength(1);
    expect(drag.radiusOf(drag.manager.document)).toBe(6.4);
    // Released, so the late frame never published over the commit.
    expect(drag.published()).toBeNull();
  });

  it('queues no preview ahead of the release on a body known to be slow', async () => {
    vi.useFakeTimers();
    const drag = radiusDrag({ expectedFrameMs: () => 12_000 });
    for (let step = 1; step <= 18; step += 1) {
      drag.preview.request(4.6 + step / 10);
      await vi.advanceTimersByTimeAsync(16);
    }

    let applied: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      applied = drag.release(6.4);
      await vi.advanceTimersByTimeAsync(1_000);
    });
    // The only rebuild is the release's own: no stale frame ahead of it.
    expect(drag.syncs).toHaveLength(1);
    expect(drag.commitDerive).toHaveBeenCalledTimes(1);
    await act(async () => {
      drag.syncs[0]!.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
    await expect(applied).resolves.toBe(true);
    expect(drag.radiusOf(drag.manager.document)).toBe(6.4);
  });

  it('still rebuilds a different value behind the first frame of an unknown body', async () => {
    // The residual cost, pinned so it is not mistaken for fixed: the worker
    // cannot drop the frame it started for 4.7, and 6.4 is another edit.
    vi.useFakeTimers();
    const drag = radiusDrag();
    for (let step = 1; step <= 18; step += 1) {
      drag.preview.request(4.6 + step / 10);
      await vi.advanceTimersByTimeAsync(16);
    }
    expect(drag.syncs).toHaveLength(1);
    expect(drag.preview.running?.value).toBeCloseTo(4.7, 9);

    let applied: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      applied = drag.release(6.4);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(drag.commitDerive).toHaveBeenCalledTimes(1);
    expect(drag.syncs).toHaveLength(2);
    await act(async () => {
      drag.syncs[0]!.resolve();
      drag.syncs[1]!.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await expect(applied).resolves.toBe(true);
    // Released, so nothing more was queued after the stale frame landed.
    expect(drag.syncs).toHaveLength(2);
  });

  it('commits a finished preview without rebuilding, as before', async () => {
    vi.useFakeTimers();
    const drag = radiusDrag();
    drag.preview.request(6.4);
    await act(async () => {
      drag.syncs[0]!.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
    const shown = drag.published();
    expect(shown?.candidate.radius).toBe(6.4);

    let applied = false;
    await act(async () => {
      applied = await drag.release(6.4);
    });
    expect(applied).toBe(true);
    expect(drag.commitDerive).not.toHaveBeenCalled();
    expect(drag.syncs).toHaveLength(1);
    // The very rebuild the preview showed is the one committed.
    expect(drag.committed).toEqual([shown!.derived]);
    expect(drag.committed[0]).toBe(shown!.derived);
  });

  it('rebuilds afresh when the shared rebuild fails outright', async () => {
    vi.useFakeTimers();
    const drag = radiusDrag();
    drag.preview.request(6.4);
    let applied: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      applied = drag.release(6.4);
      drag.syncs[0]!.reject(new Error('Geometry worker restarted.'));
      await vi.advanceTimersByTimeAsync(0);
    });
    // A worker failure says nothing about the edit: the commit asks again.
    expect(drag.commitDerive).toHaveBeenCalledTimes(1);
    expect(drag.syncs).toHaveLength(2);
    await act(async () => {
      drag.syncs[1]!.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
    await expect(applied).resolves.toBe(true);
  });
});
