import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { toArtifactId, toUserId } from '@openzcad/shared';
import {
  PROJECT_DIAGNOSTIC_FORMAT,
  PROJECT_DIAGNOSTIC_FORMAT_VERSION,
  createProjectDiagnosticBundle
} from '../apps/web/src/lib/projectDiagnostics';

const BUILD = {
  brepkitVersion: '2.129.0',
  brepkitCommit: 'c5dc0dc2980edb4fb06a77a1e7517f2e97165395'
};
const CAPTURED_AT = '2026-07-30T12:00:00.000Z';

describe('project diagnostic export', () => {
  it('keeps native feature geometry while removing account and cloud metadata', () => {
    const manager = new CommandManager(
      createProjectDocument('Private project', toUserId('user_private'))
    );
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: 20, height: 40 }
      })
    );
    manager.execute(
      commandFactories.setNodeMetadata({
        nodeId: manager.document.rootNodeId,
        metadata: { privateNote: 'remove-me' }
      })
    );
    const bodyId = manager.document.bodyOrder[0]!;
    manager.commitDerivedState({
      bodyRepresentations: {
        [bodyId]: {
          bodyId,
          name: 'Cylinder Body',
          source: 'primitive',
          mesh: {
            kind: 'mesh',
            vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
            indices: [0, 1, 2]
          },
          faceCount: 3,
          color: '#00ff00',
          exportableStep: true,
          consumed: false,
          volume: 100,
          bbox: {
            min: { x: -20, y: -20, z: 0 },
            max: { x: 20, y: 20, z: 40 }
          }
        }
      },
      exportableBodyIds: [bodyId],
      warnings: ['captured warning'],
      updatedAt: '2026-07-30T11:59:00.000Z'
    });

    const originalProjectId = manager.document.projectId;
    const bundle = createProjectDiagnosticBundle(
      manager.document,
      BUILD,
      CAPTURED_AT
    );
    const serialized = JSON.stringify(bundle);
    const root = bundle.document.nodes[bundle.document.rootNodeId];

    expect(bundle).toMatchObject({
      format: PROJECT_DIAGNOSTIC_FORMAT,
      formatVersion: PROJECT_DIAGNOSTIC_FORMAT_VERSION,
      capturedAt: CAPTURED_AT,
      kernel: {
        adapter: 'brepkit',
        packageVersion: BUILD.brepkitVersion,
        sourceCommit: BUILD.brepkitCommit
      }
    });
    expect(bundle.document.projectId).toBe('project_diagnostic');
    expect(bundle.document.ownerUserId).toBe('user_diagnostic');
    expect(root?.kind).toBe('project');
    if (root?.kind === 'project') {
      expect(root.projectId).toBe('project_diagnostic');
      expect(root.metadata).toBeUndefined();
    }
    expect(bundle.document.revisions).toEqual([]);
    expect(bundle.document.checkpoints).toEqual([]);
    expect(bundle.document.assets).toEqual({});
    expect(bundle.document.derived.bodyRepresentations).toEqual({});
    expect(bundle.document.commandLog).toHaveLength(1);
    expect(bundle.document.commandLog[0]?.kind).toBe('primitive.add');
    expect(bundle.document.commandLog[0]?.timestamp).toBe(
      '1970-01-01T00:00:00.000Z'
    );
    expect(bundle.observedResult).toMatchObject({
      warnings: ['captured warning'],
      bodies: [
        {
          bodyId,
          faceCount: 3,
          volume: 100,
          consumed: false
        }
      ]
    });
    expect(serialized).not.toContain(originalProjectId);
    expect(serialized).not.toContain('user_private');
    expect(serialized).not.toContain('remove-me');
    expect(serialized).not.toContain('"vertices"');
  });

  it('refuses imported sources until their embedded metadata can be sanitized', () => {
    const manager = new CommandManager(
      createProjectDocument('Imported', toUserId('user_private'))
    );
    manager.execute(
      commandFactories.importStep({
        name: 'Vendor part',
        artifactId: toArtifactId('artifact_private'),
        sourceName: 'customer-secret.step',
        stepText: 'ISO-10303-21;END-ISO-10303-21;'
      })
    );

    expect(() =>
      createProjectDiagnosticBundle(manager.document, BUILD, CAPTURED_AT)
    ).toThrow(
      'Diagnostic export currently supports native parametric documents only.'
    );
  });

  it('refuses a deleted import that remains in command history', () => {
    const manager = new CommandManager(
      createProjectDocument('Imported', toUserId('user_private'))
    );
    manager.execute(
      commandFactories.importStep({
        name: 'Vendor part',
        artifactId: toArtifactId('artifact_private'),
        sourceName: 'customer-secret.step',
        stepText: 'ISO-10303-21;END-ISO-10303-21;'
      })
    );
    manager.execute(
      commandFactories.deleteFeature({
        featureId: manager.document.featureOrder[0]!
      })
    );
    expect(manager.document.featureOrder).toEqual([]);

    expect(() =>
      createProjectDiagnosticBundle(manager.document, BUILD, CAPTURED_AT)
    ).toThrow(/native parametric documents only/);
  });
});
