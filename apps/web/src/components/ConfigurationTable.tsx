import { useEffect, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import {
  MATERIAL_DENSITY_PRESETS,
  configurationColumnKey,
  type BodyRepresentation,
  type ConfigurationColumn,
  type ConfigurationRow,
  type ConfigurationSet,
  type FeatureNode,
  type MassDensitySelection,
  type ParameterNode
} from '@openzcad/shared';
import type { ConfigurationCellValue } from '@openzcad/document-core';

/**
 * What the table can do. Each action answers with a refusal, or null when
 * it landed. The table never changes the document itself.
 */
export interface ConfigurationActions {
  create(name: string): string | null | Promise<string | null>;
  remove(): string | null | Promise<string | null>;
  addRow(name: string): string | null | Promise<string | null>;
  renameRow(
    rowId: string,
    name: string
  ): string | null | Promise<string | null>;
  deleteRow(rowId: string): string | null | Promise<string | null>;
  addColumn(
    column: ConfigurationColumn
  ): string | null | Promise<string | null>;
  deleteColumn(
    column: ConfigurationColumn
  ): string | null | Promise<string | null>;
  setCell(
    rowId: string,
    column: ConfigurationColumn,
    value: ConfigurationCellValue
  ): string | null | Promise<string | null>;
  activate(rowId: string): string | null | Promise<string | null>;
}

export interface ConfigurationTableProps {
  /** The table, with the active row as the model holds it. */
  configurations: ConfigurationSet | undefined;
  parameters: readonly ParameterNode[];
  features: readonly FeatureNode[];
  bodies: readonly BodyRepresentation[];
  /** Absent when the model cannot be edited: the table is read-only. */
  actions?: ConfigurationActions;
}

function materialValue(selection: MassDensitySelection | undefined): string {
  if (!selection || selection.kind === 'unit') return 'unit';
  if (selection.kind === 'preset') return `preset:${selection.presetId}`;
  return 'custom';
}

function materialFrom(value: string): MassDensitySelection {
  return value.startsWith('preset:')
    ? { kind: 'preset', presetId: value.slice('preset:'.length) }
    : { kind: 'unit' };
}

function nextRowName(set: ConfigurationSet): string {
  const names = new Set(set.rows.map((row) => row.name.toLocaleLowerCase()));
  for (let index = set.rows.length + 1; ; index += 1) {
    const name = `Configuration ${index}`;
    if (!names.has(name.toLocaleLowerCase())) return name;
  }
}

/** A text cell that commits on Enter or blur and reverts on refusal. */
function TextCell({
  value,
  label,
  readOnly,
  onCommit
}: {
  value: string;
  label: string;
  readOnly: boolean;
  onCommit(value: string): Promise<boolean>;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = async () => {
    const text = draft.trim();
    if (text === value) return;
    if (!(await onCommit(text))) setDraft(value);
  };
  return (
    <input
      className="mono configuration-cell-input"
      value={draft}
      aria-label={label}
      spellCheck={false}
      readOnly={readOnly}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void commit();
        }
        if (event.key === 'Escape') setDraft(value);
      }}
    />
  );
}

/**
 * F06: the variant table, under the parameters. Rows are named
 * configurations; columns are parameters, feature suppression, body
 * visibility and material. The radio picks the active row.
 */
export function ConfigurationTable({
  configurations,
  parameters,
  features,
  bodies,
  actions
}: ConfigurationTableProps) {
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState('');
  const readOnly = !actions;

  async function run(
    action: () => string | null | Promise<string | null>
  ): Promise<boolean> {
    let refusal: string | null;
    try {
      refusal = await action();
    } catch (caught) {
      refusal =
        caught instanceof Error ? caught.message : 'That was not changed.';
    }
    setError(refusal);
    return refusal === null;
  }

  if (!configurations) {
    return (
      <div className="configuration-table">
        <div className="configuration-header">
          <span className="param-value">Configurations</span>
          {actions && (
            <button
              type="button"
              className="secondary"
              onClick={() => void run(() => actions.create('Default'))}
            >
              <Plus size={13} aria-hidden="true" /> Add configurations
            </button>
          )}
        </div>
        <p className="muted sidebar-hint">
          Save named variants of this model: parameter values, suppressed
          features, shown bodies and material.
        </p>
        {error && (
          <p className="parameter-feedback error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  const parameterById = new Map(
    parameters.map((parameter) => [parameter.parameterId, parameter])
  );
  const featureById = new Map(
    features.map((feature) => [feature.featureId, feature])
  );
  const bodyById = new Map(bodies.map((body) => [body.bodyId, body]));
  const columnTitle = (column: ConfigurationColumn): string => {
    switch (column.kind) {
      case 'parameter':
        return (
          parameterById.get(column.parameterId)?.name ?? 'Deleted parameter'
        );
      case 'suppression':
        return `${featureById.get(column.featureId)?.name ?? 'Deleted feature'} built`;
      case 'body':
        return `${bodyById.get(column.bodyId)?.name ?? 'Deleted body'} shown`;
      case 'material':
        return 'Material';
    }
  };
  const used = new Set(configurations.columns.map(configurationColumnKey));
  const candidate = (column: ConfigurationColumn, label: string) => ({
    column,
    label,
    key: configurationColumnKey(column)
  });
  const candidates = [
    ...parameters.map((parameter) =>
      candidate(
        { kind: 'parameter', parameterId: parameter.parameterId },
        `Parameter: ${parameter.name}`
      )
    ),
    ...features.map((feature) =>
      candidate(
        { kind: 'suppression', featureId: feature.featureId },
        `Suppress: ${feature.name}`
      )
    ),
    ...bodies.map((body) =>
      candidate({ kind: 'body', bodyId: body.bodyId }, `Show: ${body.name}`)
    ),
    candidate({ kind: 'material' }, 'Material')
  ].filter((entry) => !used.has(entry.key));

  const cell = (row: ConfigurationRow, column: ConfigurationColumn) => {
    const title = columnTitle(column);
    const label = `${title}, ${row.name}`;
    switch (column.kind) {
      case 'parameter':
        return (
          <TextCell
            value={row.parameters[column.parameterId] ?? ''}
            label={label}
            readOnly={readOnly}
            onCommit={(value) =>
              run(() => actions!.setCell(row.id, column, value))
            }
          />
        );
      case 'suppression':
        return (
          <input
            type="checkbox"
            aria-label={label}
            checked={row.suppressed[column.featureId] !== true}
            disabled={readOnly}
            onChange={(event) =>
              void run(() =>
                actions!.setCell(row.id, column, !event.target.checked)
              )
            }
          />
        );
      case 'body':
        return (
          <input
            type="checkbox"
            aria-label={label}
            checked={row.bodies[column.bodyId] === true}
            disabled={readOnly}
            onChange={(event) =>
              void run(() =>
                actions!.setCell(row.id, column, event.target.checked)
              )
            }
          />
        );
      case 'material':
        return (
          <select
            aria-label={label}
            value={materialValue(row.material)}
            disabled={readOnly}
            onChange={(event) =>
              void run(() =>
                actions!.setCell(
                  row.id,
                  column,
                  materialFrom(event.target.value)
                )
              )
            }
          >
            <option value="unit">None</option>
            {row.material?.kind === 'custom' && (
              <option value="custom">
                Custom ({row.material.densityKgPerM3} kg/m³)
              </option>
            )}
            {MATERIAL_DENSITY_PRESETS.map((preset) => (
              <option key={preset.id} value={`preset:${preset.id}`}>
                {preset.label}
              </option>
            ))}
          </select>
        );
    }
  };

  return (
    <div className="configuration-table">
      <div className="configuration-header">
        <span className="param-value">Configurations</span>
        {actions && (
          <button
            type="button"
            className="icon-button"
            title="Remove configurations (the model keeps the active one)"
            aria-label="Remove configurations"
            onClick={() => void run(() => actions.remove())}
          >
            <X size={13} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="configuration-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Configuration</th>
              {configurations.columns.map((column) => (
                <th scope="col" key={configurationColumnKey(column)}>
                  <span className="configuration-column-title">
                    {columnTitle(column)}
                    {actions && (
                      <button
                        type="button"
                        className="icon-button"
                        title={`Remove column ${columnTitle(column)}`}
                        aria-label={`Remove column ${columnTitle(column)}`}
                        onClick={() =>
                          void run(() => actions.deleteColumn(column))
                        }
                      >
                        <X size={11} aria-hidden="true" />
                      </button>
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {configurations.rows.map((row) => {
              const active = row.id === configurations.activeRowId;
              return (
                <tr key={row.id} className={active ? 'active' : undefined}>
                  <th scope="row">
                    <span className="configuration-row-name">
                      <input
                        type="radio"
                        name="active-configuration"
                        aria-label={`Use ${row.name}`}
                        checked={active}
                        disabled={readOnly}
                        onChange={() =>
                          void run(() => actions!.activate(row.id))
                        }
                      />
                      <TextCell
                        value={row.name}
                        label={`Name of ${row.name}`}
                        readOnly={readOnly}
                        onCommit={(name) =>
                          run(() => actions!.renameRow(row.id, name))
                        }
                      />
                      {actions && !active && (
                        <button
                          type="button"
                          className="icon-button"
                          title={`Delete ${row.name}`}
                          aria-label={`Delete ${row.name}`}
                          onClick={() =>
                            void run(() => actions.deleteRow(row.id))
                          }
                        >
                          <Trash2 size={12} aria-hidden="true" />
                        </button>
                      )}
                    </span>
                  </th>
                  {configurations.columns.map((column) => (
                    <td key={configurationColumnKey(column)}>
                      {cell(row, column)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {actions && (
        <div className="configuration-actions">
          <button
            type="button"
            className="secondary"
            onClick={() =>
              void run(() => actions.addRow(nextRowName(configurations)))
            }
          >
            <Plus size={13} aria-hidden="true" /> Add configuration
          </button>
          <select
            aria-label="Add column"
            value={adding}
            onChange={(event) => {
              const key = event.target.value;
              const candidate = candidates.find((entry) => entry.key === key);
              setAdding('');
              if (candidate)
                void run(() => actions.addColumn(candidate.column));
            }}
          >
            <option value="">Add column…</option>
            {candidates.map((candidate) => (
              <option key={candidate.key} value={candidate.key}>
                {candidate.label}
              </option>
            ))}
          </select>
        </div>
      )}
      {error && (
        <p className="parameter-feedback error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
