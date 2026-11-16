import type { BodyId, FeatureId, ParameterId } from './index';
import { MAX_EXPRESSION_LENGTH } from './document-validation';
import {
  normalizeMassDensitySelection,
  type MassDensitySelection
} from './mass-density';

/**
 * F06 configurations (schema v70): a variant table on the document. Each row
 * is a named configuration; each column is one thing a row decides: a
 * parameter's expression, whether a feature is suppressed, whether a body is
 * shown, or the material. The table is dense: every row holds a value for
 * every column, so a row means the same thing whatever was active before it.
 *
 * Exactly one row is active. Its parameter and suppression values are the
 * ones the document's own parameters and features hold, so every rebuild,
 * panel and export reads the active row without knowing the table exists;
 * activating another row first copies those live values back into the row
 * being left (see document-core's `activateConfiguration`). Body and material
 * values have no other home, so they are read from the active row directly.
 */

export type ConfigurationColumn =
  | { kind: 'parameter'; parameterId: ParameterId }
  | { kind: 'suppression'; featureId: FeatureId }
  | { kind: 'body'; bodyId: BodyId }
  | { kind: 'material' };

export type ConfigurationColumnKind = ConfigurationColumn['kind'];

export interface ConfigurationRow {
  id: string;
  name: string;
  /** Expression per parameter column. */
  parameters: Record<ParameterId, string>;
  /** True when the row suppresses the feature. */
  suppressed: Record<FeatureId, boolean>;
  /** True when the row shows the body. */
  bodies: Record<BodyId, boolean>;
  /** Present exactly when the table has a material column. */
  material?: MassDensitySelection;
}

export interface ConfigurationSet {
  columns: ConfigurationColumn[];
  rows: ConfigurationRow[];
  activeRowId: string;
}

export const MAX_CONFIGURATION_ROWS = 100;
export const MAX_CONFIGURATION_COLUMNS = 200;
export const MAX_CONFIGURATION_NAME_LENGTH = 80;
export const MAX_CONFIGURATION_ID_LENGTH = 128;

/** A stable key for a column: one per parameter, feature or body. */
export function configurationColumnKey(column: ConfigurationColumn): string {
  switch (column.kind) {
    case 'parameter':
      return `parameter:${column.parameterId}`;
    case 'suppression':
      return `suppression:${column.featureId}`;
    case 'body':
      return `body:${column.bodyId}`;
    case 'material':
      return 'material';
  }
}

export function activeConfigurationRow(
  set: ConfigurationSet | undefined
): ConfigurationRow | null {
  if (!set) return null;
  return set.rows.find((row) => row.id === set.activeRowId) ?? null;
}

/** Bodies the active row hides, for display and every export. */
export function configurationHiddenBodyIds(
  set: ConfigurationSet | undefined
): BodyId[] {
  const row = activeConfigurationRow(set);
  if (!row || !set) return [];
  const hidden: BodyId[] = [];
  for (const column of set.columns)
    if (column.kind === 'body' && row.bodies[column.bodyId] !== true)
      hidden.push(column.bodyId);
  return hidden;
}

/** The active row's material, or null when the table has no material column. */
export function configurationMaterial(
  set: ConfigurationSet | undefined
): MassDensitySelection | null {
  if (!set?.columns.some((column) => column.kind === 'material')) return null;
  return activeConfigurationRow(set)?.material ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_CONFIGURATION_ID_LENGTH &&
    value !== '__proto__' &&
    value !== 'constructor' &&
    value !== 'prototype'
  );
}

export function isConfigurationName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    value === value.trim() &&
    value.length <= MAX_CONFIGURATION_NAME_LENGTH &&
    ![...value].some((char) => char.charCodeAt(0) < 0x20 || char === '\u007f')
  );
}

function columnError(value: unknown): string | null {
  if (!isRecord(value)) return 'A configuration column is malformed.';
  const keys = Object.keys(value);
  switch (value.kind) {
    case 'parameter':
      return isId(value.parameterId) && keys.length === 2
        ? null
        : 'A parameter column names no parameter.';
    case 'suppression':
      return isId(value.featureId) && keys.length === 2
        ? null
        : 'A suppression column names no feature.';
    case 'body':
      return isId(value.bodyId) && keys.length === 2
        ? null
        : 'A body column names no body.';
    case 'material':
      return keys.length === 1 ? null : 'The material column is malformed.';
    default:
      return 'A configuration column has an unknown kind.';
  }
}

function materialError(value: unknown): string | null {
  if (!isRecord(value)) return 'has no material.';
  const normalized = normalizeMassDensitySelection(value);
  // A preset this client does not know, or a bad density, would read back as
  // unit density: refuse it rather than quietly change the row's mass.
  return JSON.stringify(normalized) === JSON.stringify(value)
    ? null
    : 'has a material this version does not know.';
}

/** Why a stored configuration section cannot be kept, or null. */
export function configurationSetError(value: unknown): string | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.columns) ||
    !Array.isArray(value.rows) ||
    !isId(value.activeRowId)
  )
    return 'The configuration table is malformed.';
  const extra = Object.keys(value).filter(
    (key) => !['columns', 'rows', 'activeRowId'].includes(key)
  );
  if (extra.length)
    return `The configuration table has an unknown field "${extra[0]}".`;
  if (value.rows.length === 0) return 'A configuration table needs a row.';
  if (value.rows.length > MAX_CONFIGURATION_ROWS)
    return `A configuration table holds at most ${MAX_CONFIGURATION_ROWS} rows.`;
  if (value.columns.length > MAX_CONFIGURATION_COLUMNS)
    return `A configuration table holds at most ${MAX_CONFIGURATION_COLUMNS} columns.`;
  const columnKeys = new Set<string>();
  const parameterIds = new Set<string>();
  const featureIds = new Set<string>();
  const bodyIds = new Set<string>();
  let material = false;
  for (const column of value.columns) {
    const error = columnError(column);
    if (error) return error;
    const typed = column as ConfigurationColumn;
    const key = configurationColumnKey(typed);
    if (columnKeys.has(key)) return `Column ${key} is listed twice.`;
    columnKeys.add(key);
    if (typed.kind === 'parameter') parameterIds.add(typed.parameterId);
    if (typed.kind === 'suppression') featureIds.add(typed.featureId);
    if (typed.kind === 'body') bodyIds.add(typed.bodyId);
    if (typed.kind === 'material') material = true;
  }
  const rowIds = new Set<string>();
  const names = new Set<string>();
  for (const row of value.rows) {
    if (!isRecord(row) || !isId(row.id))
      return 'A configuration row has no id.';
    const id = row.id;
    if (rowIds.has(id)) return `Configuration ${id} is listed twice.`;
    rowIds.add(id);
    if (!isConfigurationName(row.name))
      return `Configuration ${id} has no usable name.`;
    const folded = row.name.toLocaleLowerCase();
    if (names.has(folded)) return `Two configurations are named "${row.name}".`;
    names.add(folded);
    const rowExtra = Object.keys(row).filter(
      (key) =>
        ![
          'id',
          'name',
          'parameters',
          'suppressed',
          'bodies',
          'material'
        ].includes(key)
    );
    if (rowExtra.length)
      return `Configuration "${row.name}" has an unknown field "${rowExtra[0]}".`;
    if (
      !isRecord(row.parameters) ||
      !isRecord(row.suppressed) ||
      !isRecord(row.bodies)
    )
      return `Configuration "${row.name}" is malformed.`;
    const cells = (
      cells: Record<string, unknown>,
      expected: Set<string>,
      ok: (cell: unknown) => boolean,
      what: string
    ): string | null => {
      const keys = Object.keys(cells);
      if (
        keys.length !== expected.size ||
        keys.some((key) => !expected.has(key))
      )
        return `Configuration "${String(row.name)}" does not hold one ${what} per ${what} column.`;
      return keys.every((key) => ok(cells[key]))
        ? null
        : `Configuration "${String(row.name)}" holds an unusable ${what}.`;
    };
    const parameterError = cells(
      row.parameters,
      parameterIds,
      (cell) =>
        typeof cell === 'string' &&
        cell.trim() !== '' &&
        cell.length <= MAX_EXPRESSION_LENGTH,
      'parameter value'
    );
    if (parameterError) return parameterError;
    const suppressionError = cells(
      row.suppressed,
      featureIds,
      (cell) => typeof cell === 'boolean',
      'suppression'
    );
    if (suppressionError) return suppressionError;
    const bodyError = cells(
      row.bodies,
      bodyIds,
      (cell) => typeof cell === 'boolean',
      'body visibility'
    );
    if (bodyError) return bodyError;
    if (material !== (row.material !== undefined))
      return material
        ? `Configuration "${row.name}" has no material.`
        : `Configuration "${row.name}" has a material but the table has no material column.`;
    if (row.material !== undefined) {
      const error = materialError(row.material);
      if (error) return `Configuration "${row.name}" ${error}`;
    }
  }
  if (!rowIds.has(value.activeRowId))
    return 'The active configuration is not in the table.';
  return null;
}
