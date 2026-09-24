import { Copy, Download, SlidersHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ParameterNode } from '@openzcad/shared';
import { ParameterRow } from './ParameterRows';
import { Tooltip } from './Tooltip';

interface TweakPanelProps {
  parameters: ParameterNode[];
  parameterValues: Record<string, number>;
  canExport: boolean;
  modelError?: string | null;
  /** Name of the body the export will target, or null for "all bodies". */
  exportScope: string | null;
  onPreviewParameter?(name: string, expression: string | null): void;
  onSetParameter(
    name: string,
    expression: string
  ): void | Promise<string | null>;
  onViewActivityLog(): void;
  parameterMinimums?: Record<string, number>;
  onExportStep(): void;
  onOpenMeshExport(): void;
  /**
   * Present in a shared-link session: the visitor can fork the model into a
   * project of their own. Absent on an ordinary project, where the copy
   * affordances already live in the project shelf.
   */
  share: { onMakeCopy(): void } | null;
  /**
   * The parameter table's flyout: open to begin with — the knobs are what
   * Tweak is for — and remembered per device by the caller.
   */
  panelOpen: boolean;
  onTogglePanel(): void;
  /**
   * The parts list, shared with View mode: its rail button(s) go first on
   * this rail, and its list, when open, stands above the parameter table.
   */
  parts?: { buttons: ReactNode; list: ReactNode };
}

/**
 * Tweak mode's whole left side: a thin icon rail, the verb rail's twin, that
 * holds the parameter table's button and the export actions — and, in a
 * shared-link session, the way out into a copy of your own — with the table
 * itself as a flyout beside it. It shows nothing else on purpose. A visitor
 * who followed a link is here to turn the model's published knobs and
 * download the result, and every extra panel is a question they should
 * never have to answer.
 */
export function TweakPanel({
  parameters,
  parameterValues,
  parameterMinimums,
  canExport,
  modelError,
  exportScope,
  onSetParameter,
  onViewActivityLog,
  onPreviewParameter,
  onExportStep,
  onOpenMeshExport,
  share,
  panelOpen,
  onTogglePanel,
  parts
}: TweakPanelProps) {
  const exportTitle = (format: string) =>
    canExport
      ? `Export ${exportScope ?? 'all bodies'} as ${format}`
      : modelError
        ? 'Enter a valid parameter value before exporting'
        : 'The model has no body to export';
  return (
    <>
      <div className="tweak-rail" role="toolbar" aria-label="Tweak tools">
        {parts && (
          <>
            {parts.buttons}
            <span className="tweak-rail-divider" aria-hidden="true" />
          </>
        )}
        <Tooltip
          label="Parameters"
          description={
            panelOpen ? 'Hide the parameter table' : 'Show the parameter table'
          }
        >
          <button
            type="button"
            className={panelOpen ? 'active' : undefined}
            aria-label="Parameters"
            aria-expanded={panelOpen}
            onClick={onTogglePanel}
          >
            <SlidersHorizontal size={16} aria-hidden="true" />
          </button>
        </Tooltip>
        <span className="tweak-rail-divider" aria-hidden="true" />
        <Tooltip label="Export STEP" description={`${exportTitle('STEP')}`}>
          <button
            type="button"
            aria-label={`Export STEP — ${exportScope ?? 'all bodies'}`}
            disabled={!canExport}
            onClick={onExportStep}
          >
            <Download size={16} aria-hidden="true" />
          </button>
        </Tooltip>
        <Tooltip
          label="Export Mesh…"
          description={`${exportTitle('3MF or STL')}`}
        >
          <button
            type="button"
            aria-label="Export Mesh… — 3MF or STL"
            disabled={!canExport}
            onClick={onOpenMeshExport}
          >
            <Download size={16} aria-hidden="true" />
            <span className="tweak-rail-badge" aria-hidden="true">
              3D
            </span>
          </button>
        </Tooltip>
        {share && (
          <Tooltip
            label="Make a copy"
            description="Copy this shared model into a project of your own — parameters, history and all — and edit it in Build mode"
          >
            <button
              type="button"
              aria-label="Make a copy"
              onClick={share.onMakeCopy}
            >
              <Copy size={16} aria-hidden="true" />
            </button>
          </Tooltip>
        )}
      </div>
      <div className="tweak-flyouts">
        {parts?.list}
        {panelOpen && (
          <aside className="sidebar tweak-panel" aria-label="Parameters">
            <div className="sidebar-label">Parameters</div>
            <p className="muted tweak-panel-intro">
              Change a value and press Enter, or use an on/off toggle. The
              design itself stays locked.
            </p>
            {modelError && (
              <p className="parameter-feedback error" role="alert">
                {modelError} Enter a valid parameter value to rebuild the model.
              </p>
            )}
            <div className="param-list tweak-panel-params">
              {parameters.map((parameter) => (
                <div className="param-entry" key={parameter.parameterId}>
                  <ParameterRow
                    parameter={parameter}
                    value={parameterValues[parameter.name]}
                    minimum={parameterMinimums?.[parameter.name]}
                    onSet={onSetParameter}
                    onViewDetails={onViewActivityLog}
                    onPreview={onPreviewParameter}
                  />
                  {parameter.description && (
                    <p className="param-description-text">
                      {parameter.description}
                    </p>
                  )}
                </div>
              ))}
            </div>
            {parameters.length === 0 && (
              <p className="muted sidebar-hint">
                This model offers no parameters to adjust. Build mode is where
                they are defined and chosen.
              </p>
            )}
          </aside>
        )}
      </div>
    </>
  );
}
