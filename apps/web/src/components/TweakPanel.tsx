import { Copy, Download } from 'lucide-react';
import type { ParameterNode } from '@openzcad/shared';
import { ParameterRow } from './ParameterRows';

interface TweakPanelProps {
  parameters: ParameterNode[];
  parameterValues: Record<string, number>;
  canExport: boolean;
  /** Name of the body the export will target, or null for "all bodies". */
  exportScope: string | null;
  onSetParameter(name: string, expression: string): void;
  onExportStep(): void;
  onOpenMeshExport(): void;
  /**
   * Present in a shared-link session: the visitor can fork the model into a
   * project of their own. Absent on an ordinary project, where the copy
   * affordances already live in the project shelf.
   */
  share: { onMakeCopy(): void } | null;
}

/**
 * Tweak mode's whole side panel: the parameter table, the export actions, and
 * — in a shared-link session — the way out into a copy of your own. It shows
 * nothing else on purpose. A visitor who followed a link is here to turn the
 * model's published knobs and download the result, and every extra panel is a
 * question they should never have to answer.
 */
export function TweakPanel({
  parameters,
  parameterValues,
  canExport,
  exportScope,
  onSetParameter,
  onExportStep,
  onOpenMeshExport,
  share
}: TweakPanelProps) {
  const exportTitle = (format: string) =>
    canExport
      ? `Export ${exportScope ?? 'all bodies'} as ${format}`
      : 'The model has no body to export';
  return (
    <aside className="sidebar tweak-panel" aria-label="Parameters">
      <div className="sidebar-label">Parameters</div>
      <p className="muted tweak-panel-intro">
        Change a value and press Enter — the model rebuilds exactly. The design
        itself stays locked.
      </p>
      <div className="param-list tweak-panel-params">
        {parameters.map((parameter) => (
          <div className="param-entry" key={parameter.parameterId}>
            <ParameterRow
              parameter={parameter}
              value={parameterValues[parameter.name]}
              onSet={onSetParameter}
            />
            {parameter.description && (
              <p className="param-description-text">{parameter.description}</p>
            )}
          </div>
        ))}
      </div>
      {parameters.length === 0 && (
        <p className="muted sidebar-hint">
          This model offers no parameters to adjust. Build mode is where they
          are defined and chosen.
        </p>
      )}
      <div className="tweak-panel-actions">
        <button
          type="button"
          className="tweak-panel-action"
          disabled={!canExport}
          title={exportTitle('STEP')}
          onClick={onExportStep}
        >
          <Download size={13} aria-hidden="true" />
          <span>Export STEP</span>
          <small>{exportScope ?? 'all bodies'}</small>
        </button>
        <button
          type="button"
          className="tweak-panel-action"
          disabled={!canExport}
          title={exportTitle('3MF or STL')}
          onClick={onOpenMeshExport}
        >
          <Download size={13} aria-hidden="true" />
          <span>Export Mesh…</span>
          <small>3MF · STL</small>
        </button>
        {share && (
          <button
            type="button"
            className="tweak-panel-action"
            title="Copy this shared model into a project of your own — parameters, history and all"
            onClick={share.onMakeCopy}
          >
            <Copy size={13} aria-hidden="true" />
            <span>Make a copy</span>
            <small>edit in Build mode</small>
          </button>
        )}
      </div>
    </aside>
  );
}
