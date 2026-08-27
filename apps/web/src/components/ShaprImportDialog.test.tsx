import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ShaprImportIR } from '@openzcad/io-shapr';

import { ShaprImportDialog } from './ShaprImportDialog';

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
    bytes: 1,
    entries: 1,
    workspaceBytes: 1,
    checksumSha256: 'a'.repeat(64)
  },
  historyNodeCount: 2,
  sketches: [],
  operations: [
    {
      sourceNodeId: 1,
      sourceType: 2,
      name: 'Extrusion 01',
      token: 'Extrude',
      kind: 'extrude',
      status: 'candidate',
      propertyNodeIds: [],
      numericCandidates: [0.01],
      diagnostic: 'Candidate only.'
    }
  ],
  opaqueGeometry: {
    importedBodyCount: 1,
    importedPrototypeCount: 1,
    revisionBlockCount: 0,
    revisionDeltaCount: 0,
    importedPrototypeBytes: 0,
    revisionBlockBytes: 0,
    revisionDeltaBytes: 0,
    parasolidVersions: []
  },
  diagnostics: [],
  omittedPrivateData: []
};

describe('ShaprImportDialog', () => {
  it('labels semantic history as non-operative before apply', async () => {
    const onApply = vi.fn();
    render(
      <ShaprImportDialog
        shaprFileName="holder.shapr"
        stepFileName="holder.step"
        phase="preview"
        progress="Ready"
        error={null}
        inspection={{
          ir,
          stepChecksumSha256: 'b'.repeat(64),
          sanitizedStepFile: new File(['STEP'], 'holder.step')
        }}
        onCancel={() => undefined}
        onApply={onApply}
      />
    );

    expect(screen.getByText('Exact geometry is authoritative')).toBeVisible();
    expect(
      screen.getByText(/offers only exact planar face distances/)
    ).toBeVisible();
    expect(screen.getByText('candidate')).toBeVisible();
    await userEvent.click(
      screen.getByRole('button', { name: 'Import exact STEP + evidence' })
    );
    expect(onApply).toHaveBeenCalledOnce();
  });

  it('keeps apply disabled while parsing and cancels the worker preview', async () => {
    const onCancel = vi.fn();
    render(
      <ShaprImportDialog
        shaprFileName="holder.shapr"
        stepFileName="holder.step"
        phase="parsing"
        progress="Inspecting workspace…"
        error={null}
        inspection={null}
        onCancel={onCancel}
        onApply={() => undefined}
      />
    );

    expect(screen.getByRole('status')).toHaveTextContent(
      'Inspecting workspace'
    );
    expect(
      screen.getByRole('button', { name: 'Import exact STEP + evidence' })
    ).toBeDisabled();
    await userEvent.click(
      screen.getByRole('button', { name: 'Cancel preview' })
    );
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
