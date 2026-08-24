import { describe, expect, it } from 'vitest';
import type { ShaprImportIR } from '@openzcad/io-shapr';

import { shaprMigrationDraft } from './shaprMigration';

const ir: ShaprImportIR = {
  format: 'openzcad-shapr-ir',
  version: 1,
  schemaAdapter: 'workspace-269',
  schema: {
    workspaceSchemaVersion: 269,
    schemaVersion: 307_000,
    historyVersion: 100,
    projectVersion: 249_000
  },
  units: {
    source: 'metre-candidate',
    evidence: 'inferred',
    documentScaleCandidate: 1_000
  },
  archive: {
    bytes: 100,
    entries: 2,
    workspaceBytes: 80,
    checksumSha256: 'a'.repeat(64)
  },
  historyNodeCount: 1,
  sketches: [],
  operations: [
    {
      sourceNodeId: 1,
      sourceType: 2,
      name: 'Extrusion 01',
      token: 'Extrude',
      kind: 'extrude',
      status: 'candidate',
      propertyNodeIds: [2],
      numericCandidates: [0.01],
      diagnostic: 'Candidate only.'
    }
  ],
  opaqueGeometry: {
    importedBodyCount: 1,
    importedPrototypeCount: 1,
    revisionBlockCount: 1,
    revisionDeltaCount: 1,
    importedPrototypeBytes: 10,
    revisionBlockBytes: 20,
    revisionDeltaBytes: 30,
    parasolidVersions: ['38.1.207']
  },
  diagnostics: [],
  omittedPrivateData: ['paths', 'thumbnails']
};

describe('SHAPR migration persistence', () => {
  it('retains bounded semantic evidence and omits raw/private fields', () => {
    const draft = shaprMigrationDraft({
      ir,
      shaprFileName: '/Users/alice/private/project.shapr',
      stepFileName: 'C:\\Users\\alice\\project.step',
      stepChecksumSha256: 'b'.repeat(64),
      createdAt: '2026-08-24T12:00:00.000Z'
    });

    expect(draft.sourceName).toBe('project.shapr');
    expect(draft.companionStepName).toBe('project.step');
    expect(draft.operations[0]).toEqual({
      sourceNodeId: 1,
      name: 'Extrusion 01',
      kind: 'extrude',
      status: 'candidate',
      numericCandidates: [0.01],
      diagnostic: 'Candidate only.'
    });
    expect(JSON.stringify(draft)).not.toContain('38.1.207');
    expect(JSON.stringify(draft)).not.toContain('propertyNodeIds');
    expect(JSON.stringify(draft)).not.toContain('alice');
    expect(draft.privateDataOmitted).toBe(true);
  });
});
