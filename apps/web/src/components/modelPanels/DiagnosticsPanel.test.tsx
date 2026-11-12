import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type { DiagnosticRow } from '../../lib/diagnosticsRows';
import { DiagnosticsPanel, diagnosticCount } from './DiagnosticsPanel';

describe('DiagnosticsPanel', () => {
  it('says so when there are no warnings', () => {
    // An independent panel can be opened from the rail with nothing in it.
    expect(diagnosticCount([])).toBe(0);
    const { container } = render(<DiagnosticsPanel warnings={[]} />);
    expect(container.querySelector('.diagnostic-row')).toBeNull();
    expect(screen.getByText('No warnings in this model.')).toBeVisible();
  });

  it('lists each warning under the feature it names', () => {
    const warnings: DiagnosticRow[] = [
      {
        key: 'fillet',
        featureName: 'Fillet 1',
        message: 'The radius is too large for this edge.',
        detail: 'BRepFilletAPI failed'
      },
      { key: 'loose', featureName: null, message: 'A sketch is open.' }
    ];
    const { container } = render(<DiagnosticsPanel warnings={warnings} />);
    expect(diagnosticCount(warnings)).toBe(2);
    const rows = container.querySelectorAll('.diagnostic-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(
      'Fillet 1: The radius is too large for this edge.'
    );
    expect(rows[0]).toHaveAttribute('title', 'BRepFilletAPI failed');
    expect(rows[1]?.querySelector('strong')).toBeNull();
    expect(screen.getByText('A sketch is open.')).toBeInTheDocument();
  });

  it('notes steps with fragile selections without counting them as warnings', () => {
    const box = addPrimitiveFeature(
      createProjectDocument('Fragile', toUserId('user_fragile_panel')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 18, depth: 24 }
      }
    );
    const { document } = filletEdges(box, {
      name: 'Fillet 2',
      targetBodyId: box.bodyOrder[0]!,
      edgeHashes: [11],
      size: 1
    });
    const { container } = render(
      <DiagnosticsPanel warnings={[]} document={document} />
    );
    expect(container.querySelector('.diagnostic-row')).toBeNull();
    expect(screen.getByText('No warnings in this model.')).toBeVisible();
    expect(
      screen.getByText('1 step uses a fragile selection.')
    ).toHaveAttribute(
      'title',
      'Fillet 2: these picks have no stable name and may need re-picking if earlier steps change.'
    );
    render(<DiagnosticsPanel warnings={[]} document={box} />);
    expect(screen.getAllByText(/fragile selection/)).toHaveLength(1);
  });
});
