import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
  addPrimitiveFeature,
  createProjectDocument,
  importStepBody
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type {
  BodyId,
  BodyRepresentation,
  DerivedState,
  ProjectDocument
} from '@openzcad/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DirectEditFixture } from './directEditFixture';
import { createProjectDiagnosticBundle } from './projectDiagnostics';
import {
  INTERACTION_DIAGNOSTICS_MAX_BYTES,
  INTERACTION_DIAGNOSTICS_MAX_ENTRIES,
  INTERACTION_DIAGNOSTIC_FORMAT,
  INTERACTION_DIAGNOSTIC_FORMAT_VERSION,
  buildDirectEditFixture,
  clearInteractionDiagnostics,
  createInteractionDiagnosticBundle,
  listInteractionDiagnostics,
  recordInteractionDiagnostic,
  type InteractionDiagnosticEntry
} from './interactionDiagnostics';

const KERNEL = {
  adapter: 'remus' as const,
  packageVersion: '0.0.0-test',
  sourceCommit: 'abc1234'
};

let factory: IDBFactory;

beforeEach(() => {
  factory = new IDBFactory();
});

function boxDocument(): { document: ProjectDocument; bodyId: BodyId } {
  const document = addPrimitiveFeature(
    createProjectDocument('Diagnostics', toUserId('user_diag')),
    {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 40, depth: 24, height: 10 }
    }
  );
  return { document, bodyId: document.bodyOrder[0]! };
}

/**
 * One body with a +z planar face and one straight edge. The mesh is empty
 * because the builder reads topology only — it never touches the projection.
 */
function boxDerived(bodyId: BodyId): DerivedState {
  const representation: BodyRepresentation = {
    bodyId,
    name: 'Plate Body',
    source: 'primitive',
    mesh: {
      kind: 'mesh',
      vertices: new Float32Array(),
      indices: new Uint32Array()
    },
    faceCount: 6,
    color: '#b0bec5',
    exportableStep: true,
    consumed: false,
    volume: 9600,
    bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 24, z: 10 } },
    topology: {
      faces: [
        {
          topologyId: 'face-top',
          hash: 111,
          triangleStart: 0,
          triangleCount: 2,
          geometry: {
            surfaceType: 'plane',
            area: 960,
            center: { x: 20, y: 12, z: 10 },
            normal: { x: 0, y: 0, z: 1 }
          }
        }
      ],
      edges: [
        {
          topologyId: 'edge-front-top',
          hash: 222,
          length: 40,
          points: [0, 0, 10, 20, 0, 10, 40, 0, 10]
        }
      ]
    }
  };
  return {
    bodyRepresentations: { [bodyId]: representation },
    exportableBodyIds: [bodyId],
    warnings: [],
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
}

function boxFixture(): DirectEditFixture {
  const { document, bodyId } = boxDocument();
  return buildDirectEditFixture({
    document,
    derived: boxDerived(bodyId),
    op: 'offset-face',
    targetBodyId: bodyId,
    face: { topologyId: 'face-top', hash: 111, hasReference: false },
    value: 2.5,
    outcome: 'refused',
    message: 'That face could not be found after the rebuild.',
    kernel: KERNEL,
    capturedAt: '2026-01-01T00:00:00.000Z'
  });
}

describe('buildDirectEditFixture', () => {
  it('captures a planar face pick on a native box document', () => {
    const { document, bodyId } = boxDocument();
    const fixture = buildDirectEditFixture({
      document,
      derived: boxDerived(bodyId),
      op: 'offset-face',
      targetBodyId: bodyId,
      face: { topologyId: 'face-top', hash: 111, hasReference: false },
      value: 2.5,
      outcome: 'refused',
      kernel: KERNEL,
      capturedAt: '2026-01-01T12:34:56.789Z'
    });

    expect(fixture.format).toBe('openzcad-direct-edit-fixture');
    expect(fixture.origin).toBe('captured');
    expect(fixture.name).toBe('offset-face-refused-20260101123456789');
    expect(fixture.documentOmitted).toBeUndefined();

    const sanitized = createProjectDiagnosticBundle(document, {
      remusVersion: KERNEL.packageVersion,
      remusCommit: KERNEL.sourceCommit
    }).document;
    expect(fixture.document).toEqual(sanitized);
    expect(fixture.document?.revisions).toEqual([]);
    expect(fixture.document?.checkpoints).toEqual([]);
    expect(fixture.document?.assets).toEqual({});
    expect(fixture.document?.derived.bodyRepresentations).toEqual({});
    expect(fixture.document?.projectId).toBe('project_diagnostic');
    expect(fixture.document?.projectId).not.toBe(document.projectId);

    expect(fixture.edit).toEqual({
      op: 'offset-face',
      targetBodyId: bodyId,
      face: {
        surfaceType: 'plane',
        center: { x: 20, y: 12, z: 10 },
        normal: { x: 0, y: 0, z: 1 },
        area: 960,
        hash: 111,
        hasReference: false
      },
      edges: undefined,
      value: 2.5
    });

    expect(fixture.observed.lineage).toBe('hash-only');
    expect(fixture.observed.producingFeatureKind).toBe('primitive');
    expect(fixture.observed.upstreamFeatureKinds).toEqual(['primitive']);
    expect(fixture.observed.documentVersion).toBe(document.version);
  });

  it('reports semantic lineage and resolves edges by hash', () => {
    const { document, bodyId } = boxDocument();
    const fixture = buildDirectEditFixture({
      document,
      derived: boxDerived(bodyId),
      op: 'fillet',
      targetBodyId: bodyId,
      edges: [{ hash: 222, hasReference: true }],
      value: 1,
      outcome: 'committed',
      kernel: KERNEL,
      capturedAt: '2026-01-01T00:00:00.000Z'
    });

    expect(fixture.observed.lineage).toBe('semantic');
    expect(fixture.edit.edges).toEqual([
      {
        center: { x: 20, y: 0, z: 10 },
        length: 40,
        hash: 222,
        hasReference: true
      }
    ]);
  });

  it('omits the document for an imported-step import but keeps the edit', () => {
    const imported = importStepBody(
      createProjectDocument('Imported', toUserId('user_diag')),
      {
        name: 'Imported assembly',
        artifactId: 'artifact_diag',
        sourceName: 'frame.step',
        stepText: 'ISO-10303-21;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n'
      }
    );

    const fixture = buildDirectEditFixture({
      document: imported.document,
      derived: boxDerived(imported.bodyId),
      op: 'offset-face',
      targetBodyId: imported.bodyId,
      face: { topologyId: 'face-top', hasReference: true },
      value: -1,
      outcome: 'preview-failed',
      kernel: KERNEL,
      capturedAt: '2026-01-01T00:00:00.000Z'
    });

    expect(fixture.document).toBeNull();
    expect(fixture.documentOmitted).toBe('imported-source');
    expect(fixture.edit.face?.surfaceType).toBe('plane');
    expect(fixture.edit.value).toBe(-1);
    expect(fixture.observed.upstreamFeatureKinds).toEqual(['imported-step']);
    expect(fixture.observed.lineage).toBe('semantic');
  });

  it('falls back without throwing when the pick no longer resolves', () => {
    const { document, bodyId } = boxDocument();
    const fixture = buildDirectEditFixture({
      document,
      derived: boxDerived(bodyId),
      op: 'offset-face',
      targetBodyId: 'body_missing',
      face: { topologyId: 'face-gone', hash: 999, hasReference: false },
      value: 3,
      outcome: 'refused',
      kernel: KERNEL,
      capturedAt: '2026-01-01T00:00:00.000Z'
    });

    expect(fixture.edit.face).toEqual({
      surfaceType: 'unknown',
      center: { x: 0, y: 0, z: 0 },
      hash: 999,
      hasReference: false
    });
    expect(fixture.observed.producingFeatureKind).toBeUndefined();
    expect(fixture.observed.lineage).toBe('hash-only');
  });
});

describe('interaction diagnostics storage', () => {
  it('keeps the newest entries when the count cap is exceeded', async () => {
    const base = boxFixture();
    for (let index = 0; index < 45; index += 1) {
      const stored = await recordInteractionDiagnostic(
        {
          ...base,
          name: `offset-face-refused-${String(index).padStart(3, '0')}`
        },
        factory
      );
      expect(stored).toBe(true);
    }

    const entries = await listInteractionDiagnostics(factory);
    expect(entries).toHaveLength(INTERACTION_DIAGNOSTICS_MAX_ENTRIES);
    expect(entries[0]?.fixture.name).toBe('offset-face-refused-005');
    expect(entries.at(-1)?.fixture.name).toBe('offset-face-refused-044');
    expect(entries[0]?.entryId).toBeLessThan(entries.at(-1)?.entryId ?? 0);
  });

  it('evicts on the byte cap before the count cap is reached', async () => {
    const base = boxFixture();
    const padding = 'x'.repeat(3 * 1024 * 1024);
    for (let index = 0; index < 4; index += 1) {
      await recordInteractionDiagnostic(
        {
          ...base,
          name: `offset-face-refused-${index}`,
          observed: { ...base.observed, detail: padding }
        },
        factory
      );
    }

    const entries = await listInteractionDiagnostics(factory);
    expect(entries.length).toBeLessThanOrEqual(2);
    expect(entries.length).toBeGreaterThan(0);
    const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    expect(total).toBeLessThanOrEqual(INTERACTION_DIAGNOSTICS_MAX_BYTES);
    expect(entries.at(-1)?.fixture.name).toBe('offset-face-refused-3');
  });

  it('clears the log', async () => {
    await recordInteractionDiagnostic(boxFixture(), factory);
    expect(await clearInteractionDiagnostics(factory)).toBe(true);
    expect(await listInteractionDiagnostics(factory)).toEqual([]);
  });

  it('degrades quietly when indexedDB is unavailable', async () => {
    const ambient = globalThis as { indexedDB?: IDBFactory };
    const original = ambient.indexedDB;
    ambient.indexedDB = undefined;
    try {
      expect(await recordInteractionDiagnostic(boxFixture())).toBe(false);
      expect(await listInteractionDiagnostics()).toEqual([]);
      expect(await clearInteractionDiagnostics()).toBe(false);
    } finally {
      ambient.indexedDB = original;
    }
  });
});

describe('createInteractionDiagnosticBundle', () => {
  it('summarizes outcomes, ops and lineage oldest first', () => {
    const base = boxFixture();
    const entries: InteractionDiagnosticEntry[] = [
      {
        entryId: 3,
        bytes: 30,
        fixture: {
          ...base,
          name: 'c',
          observed: {
            ...base.observed,
            outcome: 'committed',
            lineage: 'semantic'
          }
        }
      },
      {
        entryId: 1,
        bytes: 10,
        fixture: { ...base, name: 'a' }
      },
      {
        entryId: 2,
        bytes: 20,
        fixture: {
          ...base,
          name: 'b',
          edit: { ...base.edit, op: 'fillet' },
          observed: { ...base.observed, outcome: 'preview-failed' }
        }
      }
    ];

    const bundle = createInteractionDiagnosticBundle(
      entries,
      KERNEL,
      '2026-02-02T00:00:00.000Z'
    );

    expect(bundle.format).toBe(INTERACTION_DIAGNOSTIC_FORMAT);
    expect(bundle.formatVersion).toBe(INTERACTION_DIAGNOSTIC_FORMAT_VERSION);
    expect(bundle.capturedAt).toBe('2026-02-02T00:00:00.000Z');
    expect(bundle.fixtures.map((fixture) => fixture.name)).toEqual([
      'a',
      'b',
      'c'
    ]);
    expect(bundle.summary).toEqual({
      total: 3,
      byOutcome: {
        committed: 1,
        refused: 1,
        'preview-failed': 1,
        'preview-degraded': 0
      },
      byOp: { 'offset-face': 2, fillet: 1 },
      byLineage: { semantic: 1, 'hash-only': 2 }
    });
  });
});
