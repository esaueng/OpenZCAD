import { describe, expect, it } from 'vitest';
import {
  createProjectDocument,
  duplicateProjectDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import { toBodyId, toUserId } from '@openzcad/shared';
import {
  restoreDuplicateDerivedProjection,
  selectProjectDocument,
  withMatchingLocalDerived
} from '../apps/web/src/lib/localProjectStore';

describe('local-first project resolution', () => {
  it('keeps newer local edits when the cloud copy is stale', () => {
    const remote = createProjectDocument('Bracket', toUserId('user_test'));
    const remoteRoot = remote.nodes[remote.rootNodeId];
    const local = {
      ...structuredClone(remote),
      name: 'Bracket edited here',
      version: remote.version + 2,
      nodes:
        remoteRoot?.kind === 'project'
          ? {
              ...remote.nodes,
              [remote.rootNodeId]: {
                ...remoteRoot,
                name: 'Bracket edited here'
              }
            }
          : remote.nodes,
      derived: { ...remote.derived, updatedAt: '2026-07-12T20:00:00.000Z' }
    };
    expect(selectProjectDocument(local, remote)).toBe(local);
  });

  it('does not attach stale local geometry to newer remote content', () => {
    const local = createProjectDocument('Bracket', toUserId('user_test'));
    local.derived.bodyRepresentations = {
      body_stale: { name: 'Stale body' }
    } as unknown as typeof local.derived.bodyRepresentations;
    const remote = structuredClone(local);
    remote.name = 'Remote edit';
    remote.version += 1;
    remote.derived.bodyRepresentations = {};

    expect(withMatchingLocalDerived(remote, local)).toBe(remote);
  });

  it('uses the newer remote copy and supports one-sided availability', () => {
    const local = createProjectDocument('Bracket', toUserId('user_test'));
    const remote = { ...structuredClone(local), version: local.version + 1 };
    expect(selectProjectDocument(local, remote)).toBe(remote);
    expect(selectProjectDocument(local, null)).toBe(local);
    expect(selectProjectDocument(null, remote)).toBe(remote);
  });
});

describe('duplicate project projections', () => {
  it('reuses the matching local source projection for a cloud duplicate', () => {
    const userId = toUserId('user_test');
    const bodyId = toBodyId('body_preview');
    const source = createProjectDocument('Bracket', userId);
    const bodyRepresentations = {
      [bodyId]: { name: 'Preview body' }
    } as unknown as typeof source.derived.bodyRepresentations;
    source.derived = {
      ...source.derived,
      bodyRepresentations,
      exportableBodyIds: [bodyId]
    };
    const cloudDuplicate = withoutDerivedProjection(
      duplicateProjectDocument(source, 'Bracket (copy)', userId)
    );

    const restored = restoreDuplicateDerivedProjection(cloudDuplicate, source);

    expect(restored.derived.bodyRepresentations).toBe(bodyRepresentations);
    expect(restored.derived.exportableBodyIds).toEqual([bodyId]);
    expect(restored.derived.updatedAt).toBe(cloudDuplicate.derived.updatedAt);
  });

  it('refuses a projection from a different source revision', () => {
    const userId = toUserId('user_test');
    const source = createProjectDocument('Bracket', userId);
    const cloudDuplicate = withoutDerivedProjection(
      duplicateProjectDocument(source, 'Bracket (copy)', userId)
    );
    const staleSource = structuredClone(source);
    staleSource.revisions = [];

    expect(restoreDuplicateDerivedProjection(cloudDuplicate, staleSource)).toBe(
      cloudDuplicate
    );
  });
});
