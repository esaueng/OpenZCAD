import type { BodyRepresentation, ParameterNode } from '@openzcad/shared';
import type { ModelPanelSource } from './modelPanelProps';
import {
  AddParameterRow,
  ParameterRow,
  parameterTable
} from '../ParameterRows';
import { PrintClearanceRow } from '../PrintClearanceRow';

export type ParametersPanelProps = Pick<
  ModelPanelSource,
  | 'parameters'
  | 'parameterValues'
  | 'parameterMinimums'
  | 'onSetParameter'
  | 'onParameterAddRefused'
  | 'onSetParameterQuantity'
  | 'parameterQuantitySuggestions'
  | 'onViewActivityLog'
  | 'refusalReproductionFor'
  | 'onPreviewParameter'
  | 'onDeleteParameter'
  | 'onRenameParameter'
  | 'onExposeParameter'
  | 'onDescribeParameter'
  | 'exposedParameterNames'
  | 'onConfigureToggle'
  | 'printClearance'
  | 'onSetPrintClearance'
> &
  Partial<Pick<ModelPanelSource, 'units'>> & {
    /**
     * Every live body, for a toggle parameter's body picker. The Objects name
     * search never narrows it.
     */
    bodies: BodyRepresentation[];
  };

/** The Parameters header count. The panel always shows, empty or not. */
export function parameterCount(parameters: readonly ParameterNode[]): number {
  return parameters.length;
}

export function ParametersPanel({
  parameters,
  parameterValues,
  parameterMinimums,
  onSetParameter,
  onParameterAddRefused,
  onSetParameterQuantity,
  parameterQuantitySuggestions,
  onViewActivityLog,
  refusalReproductionFor,
  onPreviewParameter,
  onDeleteParameter,
  onRenameParameter,
  onExposeParameter,
  onDescribeParameter,
  exposedParameterNames,
  onConfigureToggle,
  printClearance,
  onSetPrintClearance,
  units = 'mm',
  bodies
}: ParametersPanelProps) {
  const table = parameterTable(parameters);
  return (
    <>
      <div className="param-list">
        {parameters.map((parameter) => (
          <ParameterRow
            readableName
            key={parameter.parameterId}
            parameter={parameter}
            value={parameterValues[parameter.name]}
            minimum={parameterMinimums?.[parameter.name]}
            onSet={onSetParameter}
            {...(onSetParameterQuantity
              ? { onSetQuantity: onSetParameterQuantity }
              : {})}
            suggestedQuantity={
              parameterQuantitySuggestions?.[parameter.name] ?? null
            }
            onViewDetails={onViewActivityLog}
            {...(refusalReproductionFor
              ? {
                  reproductionFor: (message: string) =>
                    refusalReproductionFor(parameter.name, message)
                }
              : {})}
            onPreview={onPreviewParameter}
            onDelete={onDeleteParameter}
            onRename={onRenameParameter}
            onExpose={onExposeParameter}
            exposedInTweak={exposedParameterNames.has(parameter.name)}
            onDescribe={onDescribeParameter}
            bodies={bodies}
            onConfigureToggle={onConfigureToggle}
            table={table}
          />
        ))}
        <AddParameterRow
          existingNames={parameters.map((parameter) => parameter.name)}
          onSet={onSetParameter}
          {...(onParameterAddRefused
            ? { onRefused: onParameterAddRefused }
            : {})}
          onConfigureToggle={onConfigureToggle}
          bodies={bodies}
        />
      </div>
      {parameters.length === 0 && (
        <p className="muted sidebar-hint">
          Name a value (<span className="mono">w = 30</span>) and use it in any
          feature field.
        </p>
      )}
      {printClearance && (
        <PrintClearanceRow
          clearance={printClearance}
          units={units}
          {...(onSetPrintClearance ? { onSet: onSetPrintClearance } : {})}
        />
      )}
    </>
  );
}
