import {
  createProjectDocument,
  importStepBody,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  persistedDocumentBytes,
  toBodyId,
  toUserId,
  type ProjectDocument,
  type ProjectSummary
} from '@openzcad/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  describeProject,
  formatProjectBytes,
  loadProjectProperties
} from './projectProperties';

function document() {
  return createProjectDocument('Bracket 🦆', toUserId('user_test'), 'inch');
}

function summary(document: ProjectDocument): ProjectSummary {
  return {
    projectId: document.projectId,
    name: document.name,
    updatedAt: document.derived.updatedAt,
    documentVersion: document.version,
    revisionCount: document.checkpoints.length
  };
}

describe('project properties', () => {
  it('reports UTF-8 model bytes without the derived geometry and leaves the document unchanged', () => {
    const doc = document();
    doc.derived.exportableBodyIds = Array.from({ length: 10_000 }, () =>
      toBodyId('derived-only')
    );
    const before = JSON.stringify(doc);
    expect(describeProject(doc, 'device')).toMatchObject({
      units: 'inch',
      documentBytes: persistedDocumentBytes(withoutDerivedProjection(doc)),
      bodies: 0,
      features: 0,
      sketches: 0,
      parameters: 0,
      savePoints: 1,
      startedAt: doc.revisions[0]!.createdAt,
      referencedSourceBytes: 0
    });
    expect(describeProject(doc, 'device').documentBytes).toBeLessThan(
      persistedDocumentBytes(doc)
    );
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('counts shared external import sources once without reading their bytes', () => {
    const input = {
      name: 'Source',
      artifactId: 'artifact_test',
      sourceName: 'assembly.step',
      stepSourceRef: {
        checksumSha256: 'a'.repeat(64),
        logicalBytes: 300_000_000,
        marker: 'openzcad-source-ref' as const,
        version: 1 as const,
        hashAlgorithm: 'sha256' as const
      }
    };
    let doc = importStepBody(document(), input).document;
    doc = importStepBody(doc, input).document;
    expect(describeProject(doc, 'device')).toMatchObject({
      bodies: 2,
      features: 2,
      referencedSourceBytes: 300_000_000
    });
  });

  it('does not call a trimmed history its creation date', () => {
    const doc = document();
    doc.revisions[0]!.reason = 'Manual save';
    doc.checkpoints = [];
    expect(describeProject(doc, 'device')).toMatchObject({
      startedAt: undefined,
      oldestSaveAt: doc.revisions[0]!.createdAt
    });
  });

  it('uses the branch date rather than the source project history for a branch', () => {
    const doc = document();
    doc.branchedFrom = {
      projectId: doc.projectId,
      revisionId: doc.revisions[0]!.revisionId,
      projectName: 'Source',
      checkpointReason: 'Before cut',
      branchedAt: '2026-09-29T12:00:00Z'
    };
    expect(describeProject(doc, 'device').startedAt).toBe(
      doc.branchedFrom.branchedAt
    );
  });

  it('uses a current local document without fetching the account', async () => {
    const doc = document();
    const loadAccount = vi.fn();
    expect(
      await loadProjectProperties(summary(doc), {
        loadLocal: vi.fn().mockResolvedValue(doc),
        loadAccount
      })
    ).toMatchObject({ source: 'device', olderDeviceCopy: false });
    expect(loadAccount).not.toHaveBeenCalled();
  });

  it('fetches the account when the listed version is newer than the local copy', async () => {
    const local = document();
    const account = { ...local, version: local.version + 1 };
    const loadAccount = vi.fn().mockResolvedValue(account);
    expect(
      await loadProjectProperties(summary(account), {
        loadLocal: vi.fn().mockResolvedValue(local),
        loadAccount
      })
    ).toMatchObject({ source: 'account', documentVersion: account.version });
    expect(loadAccount).toHaveBeenCalledWith(account.projectId);
  });

  it('labels an older device copy when the account cannot be reached', async () => {
    const doc = document();
    expect(
      await loadProjectProperties(
        { ...summary(doc), documentVersion: doc.version + 1 },
        {
          loadLocal: vi.fn().mockResolvedValue(doc),
          loadAccount: vi.fn().mockRejectedValue(new Error('Offline'))
        }
      )
    ).toMatchObject({ source: 'device', olderDeviceCopy: true });
  });

  it('can inspect an account-only project when local storage is unavailable', async () => {
    const doc = document();
    expect(
      await loadProjectProperties(summary(doc), {
        loadLocal: vi.fn().mockRejectedValue(new Error('Storage denied')),
        loadAccount: vi.fn().mockResolvedValue(doc)
      })
    ).toMatchObject({ source: 'account' });
    expect(
      await loadProjectProperties(summary(doc), {
        loadLocal: vi.fn().mockResolvedValue(null)
      })
    ).toBeNull();
  });

  it('formats byte sizes with binary units', () => {
    expect(formatProjectBytes(0)).toBe('0 B');
    expect(formatProjectBytes(1536)).toBe('1.5 KiB');
    expect(formatProjectBytes(1024 ** 2)).toBe('1 MiB');
  });
});
