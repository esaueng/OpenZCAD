import { AlertTriangle } from 'lucide-react';
import type { DiagnosticRow } from '../../lib/diagnosticsRows';
import type { SidebarProps } from '../Sidebar';

export type DiagnosticsPanelProps = Pick<SidebarProps, 'warnings'>;

/** The Diagnostics header count. The panel hides while it is zero. */
export function diagnosticCount(warnings: readonly DiagnosticRow[]): number {
  return warnings.length;
}

export function DiagnosticsPanel({ warnings }: DiagnosticsPanelProps) {
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
