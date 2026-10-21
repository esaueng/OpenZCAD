import { AlertTriangle } from 'lucide-react';
import type { DiagnosticRow } from '../../lib/diagnosticsRows';
import type { ModelPanelSource } from './modelPanelProps';

export type DiagnosticsPanelProps = Pick<ModelPanelSource, 'warnings'>;

/** The Diagnostics header count, and the rail button's badge. */
export function diagnosticCount(warnings: readonly DiagnosticRow[]): number {
  return warnings.length;
}

export function DiagnosticsPanel({ warnings }: DiagnosticsPanelProps) {
  if (warnings.length === 0) {
    return <p className="muted sidebar-hint">No warnings in this model.</p>;
  }
  return (
    <>
      {warnings.map((warning) => (
        <p key={warning.key} className="diagnostic-row" title={warning.detail}>
          <AlertTriangle size={12} aria-hidden="true" />
          <span>
            {warning.featureName ? (
              <strong>{warning.featureName}: </strong>
            ) : null}
            {warning.message}
          </span>
        </p>
      ))}
    </>
  );
}
