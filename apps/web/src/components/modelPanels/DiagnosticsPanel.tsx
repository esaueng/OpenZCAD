import { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { DiagnosticRow } from '../../lib/diagnosticsRows';
import {
  fragileSelectionSteps,
  fragileSelectionSummary
} from '../../lib/fragileSelections';
import type { ModelPanelSource } from './modelPanelProps';

export type DiagnosticsPanelProps = Pick<
  ModelPanelSource,
  'warnings' | 'document'
>;

/** The Diagnostics header count, and the rail button's badge. */
export function diagnosticCount(warnings: readonly DiagnosticRow[]): number {
  return warnings.length;
}

export function DiagnosticsPanel({
  warnings,
  document
}: DiagnosticsPanelProps) {
  // A standing property of the saved picks, not a rebuild warning: it is
  // neither counted in the badge nor listed as a row.
  const fragile = useMemo(() => {
    if (!document) return null;
    const steps = fragileSelectionSteps(document);
    const summary = fragileSelectionSummary(steps);
    return summary
      ? {
          summary,
          detail: `${steps.map((step) => step.featureName).join(', ')}: these picks have no stable name and may need re-picking if earlier steps change.`
        }
      : null;
  }, [document]);
  const fragileHint = fragile ? (
    <p className="muted sidebar-hint" title={fragile.detail}>
      {fragile.summary}
    </p>
  ) : null;
  if (warnings.length === 0) {
    return (
      <>
        <p className="muted sidebar-hint">No warnings in this model.</p>
        {fragileHint}
      </>
    );
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
      {fragileHint}
    </>
  );
}
