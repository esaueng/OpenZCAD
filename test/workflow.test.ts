import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories, replayCommands } from '@openzcad/command-system';
import { createProjectDocument, setNodeMetadata } from '@openzcad/document-core';
import { createMockKernelAdapter } from '@openzcad/kernel-adapter';
import { attachDerivedState } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  getBodyLoad,
  getBodyRole,
  getGenerateReadiness,
  getStepStates,
  getStudySettings,
  getWorkflowCounts,
  isReadyToGenerate,
  listBodies,
  loadMetadataPatch,
  roleMetadataPatch,
  studyMetadataPatch
} from '../apps/web/src/lib/workflow';
import {
  estimateGeometryVolumeMm3,
  runMockGenerativeStudy
} from '../apps/web/src/lib/generative';

const user = toUserId('user_test');

function box(name: string) {
  return commandFactories.addPrimitive({
    name,
    primitiveKind: 'box',
    dimensions: { width: 20, height: 10, depth: 10 }
  });
}

function setupStudyManager(): CommandManager {
  const manager = new CommandManager(createProjectDocument('GD Test', user));
  manager.execute(box('Design space'));
  manager.execute(box('Mount'));
  manager.execute(box('Anchor'));

  const [designBody, mountBody, anchorBody] = listBodies(manager.document);
  manager.execute(
    commandFactories.setNodeMetadata(
      { nodeId: mountBody!.id, metadata: roleMetadataPatch('preserve') },
      'Mark preserve'
    )
  );
  manager.execute(
    commandFactories.setNodeMetadata(
      { nodeId: anchorBody!.id, metadata: roleMetadataPatch('fixed') },
      'Mark fixed'
    )
  );
  manager.execute(
    commandFactories.setNodeMetadata(
      { nodeId: designBody!.id, metadata: loadMetadataPatch({ fx: 0, fy: -500, fz: 0 }) },
      'Apply load'
    )
  );
  manager.execute(
    commandFactories.setNodeMetadata(
      {
        nodeId: manager.document.rootNodeId,
        metadata: studyMetadataPatch({
          volumeFraction: 0.4,
          resolution: 'standard',
          objective: 'stiffness',
          confirmed: true
        })
      },
      'Apply study settings'
    )
  );
  return manager;
}

describe('node metadata command', () => {
  it('merges and deletes metadata keys', () => {
    let document = createProjectDocument('Meta', user);
    const rootId = document.rootNodeId;
    document = setNodeMetadata(document, {
      nodeId: rootId,
      metadata: { a: 1, b: 'two' }
    });
    expect(document.nodes[rootId]?.metadata).toEqual({ a: 1, b: 'two' });

    document = setNodeMetadata(document, { nodeId: rootId, metadata: { a: null, c: true } });
    expect(document.nodes[rootId]?.metadata).toEqual({ b: 'two', c: true });
  });

  it('throws for unknown nodes', () => {
    const document = createProjectDocument('Meta', user);
    expect(() =>
      setNodeMetadata(document, { nodeId: 'ent_missing', metadata: { a: 1 } })
    ).toThrow(/not found/);
  });

  it('replays and undoes like any other command', () => {
    const base = createProjectDocument('Meta replay', user);
    const manager = new CommandManager(base);
    manager.execute(box('Body'));
    const body = listBodies(manager.document)[0]!;
    manager.execute(
      commandFactories.setNodeMetadata(
        { nodeId: body.id, metadata: roleMetadataPatch('preserve') },
        'Mark preserve'
      )
    );
    expect(getBodyRole(listBodies(manager.document)[0]!)).toBe('preserve');

    const replayed = replayCommands(base, manager.document.commandLog);
    expect(getBodyRole(listBodies(replayed)[0]!)).toBe('preserve');

    manager.undo();
    expect(getBodyRole(listBodies(manager.document)[0]!)).toBeNull();
  });
});

describe('workflow state', () => {
  it('derives counts, readiness, and step states from the document', () => {
    const manager = setupStudyManager();
    const counts = getWorkflowCounts(manager.document);
    expect(counts).toMatchObject({
      bodies: 3,
      designBodies: 1,
      preserved: 1,
      fixed: 1,
      obstacles: 0,
      loaded: 1
    });

    expect(isReadyToGenerate(manager.document)).toBe(true);
    expect(getGenerateReadiness(manager.document).every((item) => item.done)).toBe(true);

    const states = getStepStates(manager.document, false);
    expect(states.model).toBe('complete');
    expect(states.preserve).toBe('complete');
    expect(states.constraints).toBe('complete');
    expect(states.loads).toBe('complete');
    expect(states.study).toBe('complete');
    expect(states.results).toBe('idle');
  });

  it('reads loads and study settings back with defaults', () => {
    const manager = setupStudyManager();
    const design = listBodies(manager.document)[0]!;
    expect(getBodyLoad(design)).toEqual({ fx: 0, fy: -500, fz: 0 });

    const settings = getStudySettings(manager.document);
    expect(settings).toEqual({
      volumeFraction: 0.4,
      resolution: 'standard',
      objective: 'stiffness',
      confirmed: true
    });

    const fresh = createProjectDocument('Defaults', user);
    expect(getStudySettings(fresh).confirmed).toBe(false);
    expect(getStudySettings(fresh).volumeFraction).toBe(0.4);
  });
});

describe('mock generative solver', () => {
  it('estimates primitive and composite volumes', () => {
    expect(
      estimateGeometryVolumeMm3({ kind: 'box', dimensions: { width: 2, height: 3, depth: 4 } })
    ).toBe(24);
    expect(
      estimateGeometryVolumeMm3({ kind: 'cylinder', dimensions: { radius: 1, height: 2 } })
    ).toBeCloseTo(2 * Math.PI);
    expect(
      estimateGeometryVolumeMm3({ kind: 'sphere', dimensions: { radius: 1 } })
    ).toBeCloseTo((4 / 3) * Math.PI);
  });

  it('produces deterministic, scored outcomes from the setup', () => {
    const manager = setupStudyManager();
    const kernel = createMockKernelAdapter();
    const document = attachDerivedState(
      manager.document,
      kernel.syncDocument(manager.document)
    );

    const first = runMockGenerativeStudy(document);
    const second = runMockGenerativeStudy(document);

    expect(first.outcomes).toHaveLength(4); // standard resolution
    expect(first.totalLoadN).toBe(500);
    expect(first.designVolumeMm3).toBeGreaterThan(0);
    expect(first.outcomes.map((o) => o.volumeFraction)).toEqual(
      second.outcomes.map((o) => o.volumeFraction)
    );
    for (const outcome of first.outcomes) {
      expect(outcome.volumeFraction).toBeGreaterThanOrEqual(0.05);
      expect(outcome.volumeFraction).toBeLessThanOrEqual(0.9);
      expect(outcome.massKg).toBeGreaterThan(0);
      expect(outcome.previewScale).toBeGreaterThan(0);
      expect(outcome.previewScale).toBeLessThanOrEqual(1);
      expect(outcome.score).toBeGreaterThanOrEqual(0);
      expect(outcome.score).toBeLessThanOrEqual(100);
    }
    // Sorted best-first.
    const scores = first.outcomes.map((outcome) => outcome.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('respects resolution outcome counts', () => {
    const manager = setupStudyManager();
    const kernel = createMockKernelAdapter();
    let document = attachDerivedState(manager.document, kernel.syncDocument(manager.document));
    document = setNodeMetadata(document, {
      nodeId: document.rootNodeId,
      metadata: studyMetadataPatch({
        volumeFraction: 0.4,
        resolution: 'fine',
        objective: 'mass',
        confirmed: true
      })
    });
    expect(runMockGenerativeStudy(document).outcomes).toHaveLength(6);
  });
});
