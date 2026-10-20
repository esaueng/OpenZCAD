import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { DiagnosticRow } from '../../lib/diagnosticsRows';
import { DiagnosticsPanel, diagnosticCount } from './DiagnosticsPanel';

describe('DiagnosticsPanel', () => {
  it('has nothing to show without warnings', () => {
    expect(diagnosticCount([])).toBe(0);
    const { container } = render(<DiagnosticsPanel warnings={[]} />);
    expect(container).toBeEmptyDOMElement();
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
});
