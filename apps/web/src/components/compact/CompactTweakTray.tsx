import {
  Check,
  Download,
  History,
  Minus,
  Plus,
  SlidersHorizontal,
  Table2
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ParameterNode, UnitSystem } from '@openzcad/shared';
import { useLengthReadout } from '../../lib/displayUnits';
import { formatNumber } from '../../lib/model';
import { parameterDisplayName } from '../../lib/parameterDisplayName';
import { NumericKeypad, type KeypadRequest } from '../NumericKeypad';
import { useCompactTray } from './compactSlots';
import {
  TrayPage,
  TrayRow,
  useTrayPagesLeaveWithTray,
  type TrayItem
} from './CompactTray';
import { useMeasurePage, type CompactMeasure } from './CompactViewTray';

/** Every format the Export mesh dialog offers, as Tweak's rail names them. */
const MESH_FORMATS = '3MF, STL, OBJ, glTF or PLY';

export interface CompactTweakTrayProps {
  /** Measure has no verb in Tweak's tray; a workbench opened by M shows. */
  measure: CompactMeasure;
  units: UnitSystem;
  parameters: readonly ParameterNode[];
  parameterValues: Record<string, number>;
  parameterMinimums?: Record<string, number>;
  modelError?: string | null;
  onPreviewParameter?(name: string, expression: string | null): void;
  onSetParameter(
    name: string,
    expression: string
  ): void | Promise<string | null>;
  configuration: {
    rows: readonly { id: string; name: string }[];
    activeRowId: string;
    /** Settles once the switch commits, is refused or is overtaken. */
    onActivate(rowId: string): void | Promise<unknown>;
  } | null;
  canExport: boolean;
  /** The body the export targets, or null for all bodies. */
  exportScope: string | null;
  exportWithheld?: string | null;
  exportUnavailableReason?: string | null;
  onExportStep(): void;
  onOpenMeshExport(): void;
  onViewActivityLog(): void;
  onStageCovered?(): void;
}

type TweakPage = 'parameters' | 'configuration' | 'export';

const PAGE_TITLES: Record<TweakPage, string> = {
  parameters: 'Parameters',
  configuration: 'Configuration',
  export: 'Export'
};

/** What a parameter's value is entered as on the keypad. */
function keypadUnitKind(parameter: ParameterNode): KeypadRequest['unitKind'] {
  return parameter.quantity === 'length'
    ? 'length'
    : parameter.quantity === 'angle'
      ? 'angle'
      : 'count';
}

/**
 * A stepper's step for a value: a tenth of its order of magnitude from ten
 * up, the order itself below (1 for 5 or 45, 10 for 150, 0.1 for 0.5).
 */
export function parameterStep(value: number): number {
  const magnitude = Math.abs(value);
  if (!(magnitude > 0) || !Number.isFinite(magnitude)) return 1;
  const order = 10 ** Math.floor(Math.log10(magnitude));
  return order >= 10 ? order / 10 : order;
}

/** `value` moved one step, without a float's tail. */
export function steppedParameter(value: number, direction: 1 | -1): number {
  return Number((value + direction * parameterStep(value)).toPrecision(12));
}

/** Whether an expression is a plain number a stepper can replace. */
function plainNumber(expression: string): boolean {
  const trimmed = expression.trim();
  return trimmed !== '' && Number.isFinite(Number(trimmed));
}

/**
 * An exposed parameter as a large row: its name, its value (tap for the
 * keypad), and − / + steppers. An on/off parameter is one switch. A value
 * set by an expression keeps its expression: the steppers leave it alone,
 * and the keypad opens on it.
 */
export function CompactParameterRow({
  parameter,
  value,
  minimum,
  units,
  scope,
  onSet,
  onPreview
}: {
  parameter: ParameterNode;
  value: number | undefined;
  minimum?: number;
  units: UnitSystem;
  scope: Record<string, number>;
  onSet(name: string, expression: string): void | Promise<string | null>;
  onPreview?(name: string, expression: string | null): void;
}) {
  const name = parameterDisplayName(parameter.name, parameter.description);
  const [keypadOpen, setKeypadOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submission = useRef(0);
  const anchorRef = useRef<
    ((point: { x: number; y: number } | null) => void) | null
  >(null);
  // A keypad draft previews in the model until it is applied or cancelled.
  // The keypad can also leave with its page (Back, Escape, the sheet
  // closing, another mode or the regular layout taking over): that leaving
  // cancels the draft too, as the keypad's own Cancel does, so no preview
  // outlives the keypad that typed it.
  const draftRef = useRef(false);
  const leaveDraftRef = useRef<() => void>(() => {});
  leaveDraftRef.current = () => {
    if (!draftRef.current) return;
    draftRef.current = false;
    onPreview?.(parameter.name, null);
  };
  useEffect(() => () => leaveDraftRef.current(), []);
  const readout = useLengthReadout(units);
  const converted = parameter.quantity === 'length' && readout.shown !== units;
  const shownValue =
    value === undefined
      ? '—'
      : formatNumber(converted ? readout.length(value) : value);
  const unit =
    parameter.quantity === 'length'
      ? converted
        ? readout.symbol
        : units === 'inch'
          ? 'in'
          : units
      : parameter.quantity === 'angle'
        ? '°'
        : null;

  async function set(expression: string) {
    const token = ++submission.current;
    setError(null);
    setPending(true);
    try {
      const refusal = await onSet(parameter.name, expression);
      if (token === submission.current) setError(refusal ?? null);
    } catch {
      if (token === submission.current) {
        setError('The parameter could not be updated.');
      }
    } finally {
      if (token === submission.current) setPending(false);
    }
  }

  if (parameter.toggle) {
    return (
      <li className="compact-param">
        <span className="compact-param-name">{name}</span>
        <button
          type="button"
          role="switch"
          className="compact-switch"
          aria-label={`Toggle ${parameter.name}`}
          aria-checked={value === 1}
          onClick={() => void set(value === 1 ? '0' : '1')}
        >
          <span aria-hidden="true" />
        </button>
      </li>
    );
  }

  const steppable = value !== undefined && plainNumber(parameter.expression);
  const step = (direction: 1 | -1) => {
    if (value === undefined) return;
    let next = steppedParameter(value, direction);
    if (minimum !== undefined && next < minimum) next = minimum;
    if (next === value) return;
    void set(String(next));
  };
  return (
    <li className="compact-param">
      <span className="compact-param-name">{name}</span>
      <div className="compact-param-controls">
        <button
          type="button"
          className="compact-round-button"
          aria-label={`Decrease ${parameter.name}`}
          disabled={
            !steppable ||
            pending ||
            (minimum !== undefined && value !== undefined && value <= minimum)
          }
          onClick={() => step(-1)}
        >
          <Minus size={20} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="compact-param-value"
          aria-label={`Edit ${parameter.name}`}
          aria-describedby={
            error ? `compact-param-error-${parameter.parameterId}` : undefined
          }
          aria-busy={pending || undefined}
          onClick={() => setKeypadOpen(true)}
        >
          <span className="compact-param-number">{shownValue}</span>
          {unit ? <span className="compact-param-unit">{unit}</span> : null}
        </button>
        <button
          type="button"
          className="compact-round-button"
          aria-label={`Increase ${parameter.name}`}
          disabled={!steppable || pending}
          onClick={() => step(1)}
        >
          <Plus size={20} aria-hidden="true" />
        </button>
      </div>
      {error ? (
        <p
          id={`compact-param-error-${parameter.parameterId}`}
          className="compact-param-error"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {keypadOpen ? (
        <NumericKeypad
          request={{
            kind: 'parameter',
            label: name,
            initial: parameter.expression,
            selectInitial: true,
            unitKind: keypadUnitKind(parameter)
          }}
          units={units}
          scope={scope}
          anchorRef={anchorRef}
          onPreview={(next, raw) => {
            draftRef.current = true;
            onPreview?.(parameter.name, raw ?? String(next));
          }}
          onCommit={(_next, raw) => {
            // Applying takes the draft over: cancelling it now would cancel
            // the edit's own check.
            draftRef.current = false;
            setKeypadOpen(false);
            void set(raw);
          }}
          onCancel={() => {
            setKeypadOpen(false);
            draftRef.current = true;
            leaveDraftRef.current();
          }}
        />
      ) : null}
    </li>
  );
}

function ParametersPage(props: CompactTweakTrayProps) {
  const {
    parameters,
    parameterValues,
    parameterMinimums,
    units,
    modelError,
    onSetParameter,
    onPreviewParameter
  } = props;
  return (
    <>
      {modelError ? (
        <p className="compact-page-note is-error" role="alert">
          {modelError}
        </p>
      ) : null}
      {parameters.length > 0 ? (
        <ul className="compact-param-list" aria-label="Parameters">
          {parameters.map((parameter) => (
            <CompactParameterRow
              key={parameter.parameterId}
              parameter={parameter}
              value={parameterValues[parameter.name]}
              minimum={parameterMinimums?.[parameter.name]}
              units={units}
              scope={parameterValues}
              onSet={onSetParameter}
              {...(onPreviewParameter ? { onPreview: onPreviewParameter } : {})}
            />
          ))}
        </ul>
      ) : (
        <p className="compact-page-note">No parameters to adjust.</p>
      )}
    </>
  );
}

function ConfigurationPage({
  configuration
}: {
  configuration: NonNullable<CompactTweakTrayProps['configuration']>;
}) {
  // The row last picked while its switch is pending shows as chosen, so
  // picking the model's row again (to cancel a slower switch) still reaches
  // onActivate, as in Tweak's picker.
  const [requested, setRequested] = useState<string | null>(null);
  const latest = useRef(0);
  const { activeRowId } = configuration;
  useEffect(() => {
    if (activeRowId === requested) setRequested(null);
  }, [activeRowId, requested]);
  const shown = requested ?? activeRowId;
  return (
    <ul className="compact-menu" aria-label="Configuration">
      {configuration.rows.map((row) => (
        <li key={row.id}>
          <button
            type="button"
            className="compact-menu-row"
            aria-pressed={shown === row.id}
            onClick={() => {
              if (row.id === shown) return;
              const request = ++latest.current;
              const pending = configuration.onActivate(row.id);
              if (!pending) {
                setRequested(null);
                return;
              }
              setRequested(row.id);
              const settle = () => {
                if (latest.current === request) setRequested(null);
              };
              pending.then(settle, settle);
            }}
          >
            <span className="compact-menu-label">{row.name}</span>
            {shown === row.id ? (
              <Check
                className="compact-menu-check"
                size={18}
                aria-hidden="true"
              />
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

function ExportPage(props: CompactTweakTrayProps) {
  const {
    canExport,
    exportScope,
    exportWithheld = null,
    exportUnavailableReason = null,
    modelError
  } = props;
  const reason = canExport
    ? exportWithheld
    : modelError
      ? 'Enter a valid parameter value before exporting.'
      : (exportWithheld ??
        exportUnavailableReason ??
        'The model has no body to export.');
  return (
    <>
      <ul className="compact-menu" aria-label="Export">
        <li>
          <button
            type="button"
            className="compact-menu-row"
            aria-label={`Export STEP — ${exportScope ?? 'all bodies'}`}
            disabled={!canExport}
            onClick={props.onExportStep}
          >
            <span className="compact-menu-icon" aria-hidden="true">
              <Download size={18} />
            </span>
            <span className="compact-menu-label" aria-hidden="true">
              STEP
            </span>
          </button>
        </li>
        <li>
          <button
            type="button"
            className="compact-menu-row"
            aria-label={`Export mesh… — ${MESH_FORMATS}`}
            disabled={!canExport}
            onClick={props.onOpenMeshExport}
          >
            <span className="compact-menu-icon" aria-hidden="true">
              <Download size={18} />
            </span>
            <span className="compact-menu-label" aria-hidden="true">
              Mesh
            </span>
          </button>
        </li>
        <li>
          <button
            type="button"
            className="compact-menu-row"
            aria-label="Activity log"
            onClick={props.onViewActivityLog}
          >
            <span className="compact-menu-icon" aria-hidden="true">
              <History size={18} />
            </span>
            <span className="compact-menu-label" aria-hidden="true">
              Activity
            </span>
          </button>
        </li>
      </ul>
      {reason ? <p className="compact-page-note">{reason}</p> : null}
    </>
  );
}

/**
 * Tweak in the compact workspace (U12 slice 7): Parameters, Configuration
 * and Export in the tray, each page in the sheet. A shared link's visitor
 * gets the same tray; every control runs the handler Tweak's rail runs.
 */
export function CompactTweakTray(props: CompactTweakTrayProps) {
  const tray = useCompactTray();
  const page = tray?.page ?? null;
  useMeasurePage(props.measure);
  useTrayPagesLeaveWithTray();
  const open = (key: TweakPage) => {
    if (page === key) tray?.closePage();
    else tray?.openPage(key, PAGE_TITLES[key]);
  };
  const { configuration } = props;
  const hasConfigurations = Boolean(configuration?.rows.length);
  const items: TrayItem[] = [
    {
      key: 'parameters',
      label: 'Parameters',
      icon: <SlidersHorizontal size={22} aria-hidden="true" />,
      onPress: () => open('parameters')
    },
    ...(hasConfigurations
      ? [
          {
            key: 'configuration',
            label: 'Configuration',
            icon: <Table2 size={22} aria-hidden="true" />,
            onPress: () => open('configuration')
          }
        ]
      : []),
    {
      key: 'export',
      label: 'Export',
      icon: <Download size={22} aria-hidden="true" />,
      onPress: () => open('export')
    }
  ];
  return (
    <>
      <TrayRow label="Tweak tools" items={items} page={page} />
      <TrayPage page="measure" onStageCovered={props.onStageCovered}>
        {props.measure.dock}
      </TrayPage>
      <TrayPage page="parameters" onStageCovered={props.onStageCovered}>
        <ParametersPage {...props} />
      </TrayPage>
      {configuration && hasConfigurations ? (
        <TrayPage page="configuration" onStageCovered={props.onStageCovered}>
          <ConfigurationPage configuration={configuration} />
        </TrayPage>
      ) : null}
      <TrayPage page="export">
        <ExportPage {...props} />
      </TrayPage>
    </>
  );
}
