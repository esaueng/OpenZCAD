import {
  FEATURE_SUPPRESSED_METADATA_KEY,
  MAX_CONFIGURATION_COLUMNS,
  MAX_CONFIGURATION_ROWS,
  MAX_EXPRESSION_LENGTH,
  activeConfigurationRow,
  configurationColumnKey,
  configurationSetError,
  isConfigurationName,
  isFeatureManuallySuppressed,
  normalizeMassDensitySelection,
  type ConfigurationColumn,
  type ConfigurationRow,
  type ConfigurationSet,
  type MassDensitySelection,
  type ParameterId,
  type ProjectDocument
} from '@openzcad/shared';
import { assertConfigurationSchema } from './document-content-schema';
import {
  cloneDocument,
  findBodyNode,
  findFeature,
  getParameterScope,
  listParameters,
  refreshParameterValues
} from './index';
import { assertSketchBoundaryTopologyPreserved } from './sketch-boundary-dependencies';

/**
 * F06 configuration commands (schema v70). Every input carries explicit ids,
 * so undo, redo and replay reproduce the same table. See the shared
 * `configurations.ts` for the table's contract: the active row's parameter
 * and suppression values live in the document itself, and activating a row
 * writes its values there in one step.
 */

export interface ConfigurationCreateInput {
  /** The first row, which becomes active and holds the model as it is. */
  rowId: string;
  name: string;
}

export interface ConfigurationRowAddInput {
  rowId: string;
  name: string;
  /** The row to copy; absent copies the active row as the model holds it. */
  copyOfRowId?: string;
}

export interface ConfigurationRowRenameInput {
  rowId: string;
  name: string;
}

export interface ConfigurationRowDeleteInput {
  rowId: string;
}

export interface ConfigurationColumnAddInput {
  column: ConfigurationColumn;
  /** The material column's starting value in every row; default unit density. */
  material?: MassDensitySelection;
}

export interface ConfigurationColumnDeleteInput {
  column: ConfigurationColumn;
}

export type ConfigurationCellValue = string | boolean | MassDensitySelection;

export interface ConfigurationCellSetInput {
  rowId: string;
  column: ConfigurationColumn;
  value: ConfigurationCellValue;
}

export interface ConfigurationActivateInput {
  rowId: string;
}

function table(document: ProjectDocument): ConfigurationSet {
  const set = document.configurations;
  if (!set) throw new Error('This model has no configurations.');
  return set;
}

function rowById(set: ConfigurationSet, rowId: string): ConfigurationRow {
  const row = set.rows.find((entry) => entry.id === rowId);
  if (!row) throw new Error('That configuration no longer exists.');
  return row;
}

function assertName(
  set: ConfigurationSet | undefined,
  name: string,
  rowId?: string
) {
  if (!isConfigurationName(name))
    throw new Error(
      'A configuration needs a name of one line, 80 characters or fewer.'
    );
  const folded = name.toLocaleLowerCase();
  if (
    set?.rows.some(
      (row) => row.id !== rowId && row.name.toLocaleLowerCase() === folded
    )
  )
    throw new Error(`A configuration is already named "${name}".`);
}

function parameterById(document: ProjectDocument, parameterId: ParameterId) {
  return listParameters(document).find(
    (parameter) => parameter.parameterId === parameterId
  );
}

/** What a column reads from the model now, or null when its target is gone. */
function liveCell(
  document: ProjectDocument,
  column: ConfigurationColumn
): string | boolean | null {
  switch (column.kind) {
    case 'parameter':
      return parameterById(document, column.parameterId)?.expression ?? null;
    case 'suppression': {
      const feature = findFeature(document, column.featureId);
      return feature ? isFeatureManuallySuppressed(feature) : null;
    }
    default:
      return null;
  }
}

/** Whether a column's parameter, feature or body is still in the model. */
export function configurationColumnTargetExists(
  document: ProjectDocument,
  column: ConfigurationColumn
): boolean {
  switch (column.kind) {
    case 'parameter':
      return parameterById(document, column.parameterId) !== undefined;
    case 'suppression':
      return findFeature(document, column.featureId) !== undefined;
    case 'body':
      return findBodyNode(document, column.bodyId) !== undefined;
    case 'material':
      return true;
  }
}

/**
 * A row as it reads: the active row's parameter and suppression values come
 * from the model, every other value from the table. Use this, not the stored
 * row, to show or export a configuration.
 */
export function effectiveConfigurationRow(
  document: ProjectDocument,
  rowId: string
): ConfigurationRow | null {
  const set = document.configurations;
  const row = set?.rows.find((entry) => entry.id === rowId);
  if (!set || !row) return null;
  if (row.id !== set.activeRowId) return row;
  return captureLive(document, set, row);
}

function captureLive(
  document: ProjectDocument,
  set: ConfigurationSet,
  row: ConfigurationRow
): ConfigurationRow {
  const next: ConfigurationRow = {
    ...row,
    parameters: { ...row.parameters },
    suppressed: { ...row.suppressed },
    bodies: { ...row.bodies }
  };
  for (const column of set.columns) {
    const live = liveCell(document, column);
    if (live === null) continue;
    if (column.kind === 'parameter')
      next.parameters[column.parameterId] = live as string;
    if (column.kind === 'suppression')
      next.suppressed[column.featureId] = live as boolean;
  }
  return next;
}

/**
 * Writes a row's parameter and suppression values into `next` (a clone). A
 * column whose target was deleted is skipped. Refuses, naming the row and
 * the parameter, a value the model cannot evaluate.
 */
function applyRowToModel(
  before: ProjectDocument,
  next: ProjectDocument,
  set: ConfigurationSet,
  row: ConfigurationRow
): void {
  const errorsBefore = new Set(getParameterScope(before).errors);
  let parametersChanged = false;
  for (const column of set.columns) {
    if (column.kind === 'parameter') {
      const parameter = parameterById(next, column.parameterId);
      const expression = row.parameters[column.parameterId];
      if (!parameter || expression === undefined) continue;
      if (parameter.expression === expression) continue;
      if (parameter.toggle && !['0', '1'].includes(expression.trim()))
        throw new Error(
          `Configuration "${row.name}": ${parameter.name} is an on/off parameter and must be 0 or 1.`
        );
      parameter.expression = expression;
      parametersChanged = true;
    }
    if (column.kind === 'suppression') {
      const feature = findFeature(next, column.featureId);
      const suppressed = row.suppressed[column.featureId];
      if (!feature || suppressed === undefined) continue;
      if (isFeatureManuallySuppressed(feature) === suppressed) continue;
      const metadata = { ...feature.metadata };
      if (suppressed) metadata[FEATURE_SUPPRESSED_METADATA_KEY] = true;
      else delete metadata[FEATURE_SUPPRESSED_METADATA_KEY];
      feature.metadata = metadata;
    }
  }
  if (!parametersChanged) return;
  const introduced = getParameterScope(next).errors.find(
    (error) => !errorsBefore.has(error)
  );
  if (introduced) throw new Error(`Configuration "${row.name}": ${introduced}`);
  refreshParameterValues(next);
  assertSketchBoundaryTopologyPreserved(before, next);
}

function commit(
  document: ProjectDocument,
  set: ConfigurationSet | undefined,
  next: ProjectDocument = cloneDocument(document)
): ProjectDocument {
  assertConfigurationSchema(next.schemaVersion);
  if (set) {
    const error = configurationSetError(set);
    if (error) throw new Error(error);
    next.configurations = set;
  } else delete next.configurations;
  next.version += 1;
  return next;
}

function cloneSet(set: ConfigurationSet): ConfigurationSet {
  return structuredClone(set);
}

/** Starts the table with one row holding the model as it is. */
export function createConfigurations(
  document: ProjectDocument,
  input: ConfigurationCreateInput
): ProjectDocument {
  if (document.configurations)
    throw new Error('This model already has configurations.');
  assertName(undefined, input.name);
  return commit(document, {
    columns: [],
    rows: [
      {
        id: input.rowId,
        name: input.name,
        parameters: {},
        suppressed: {},
        bodies: {}
      }
    ],
    activeRowId: input.rowId
  });
}

/** Removes the table. The model keeps the active row's values. */
export function deleteConfigurations(
  document: ProjectDocument
): ProjectDocument {
  table(document);
  return commit(document, undefined);
}

export function addConfigurationRow(
  document: ProjectDocument,
  input: ConfigurationRowAddInput
): ProjectDocument {
  const set = cloneSet(table(document));
  if (set.rows.length >= MAX_CONFIGURATION_ROWS)
    throw new Error(
      `A model holds at most ${MAX_CONFIGURATION_ROWS} configurations.`
    );
  if (set.rows.some((row) => row.id === input.rowId))
    throw new Error('That configuration already exists.');
  assertName(set, input.name);
  const source =
    effectiveConfigurationRow(document, input.copyOfRowId ?? set.activeRowId) ??
    null;
  if (!source) throw new Error('That configuration no longer exists.');
  const copy = structuredClone(source);
  set.rows.push({ ...copy, id: input.rowId, name: input.name });
  return commit(document, set);
}

export function renameConfigurationRow(
  document: ProjectDocument,
  input: ConfigurationRowRenameInput
): ProjectDocument {
  const set = cloneSet(table(document));
  const row = rowById(set, input.rowId);
  assertName(set, input.name, row.id);
  row.name = input.name;
  return commit(document, set);
}

export function deleteConfigurationRow(
  document: ProjectDocument,
  input: ConfigurationRowDeleteInput
): ProjectDocument {
  const set = cloneSet(table(document));
  const row = rowById(set, input.rowId);
  if (row.id === set.activeRowId)
    throw new Error(
      `"${row.name}" is active. Activate another configuration before deleting it.`
    );
  set.rows = set.rows.filter((entry) => entry.id !== row.id);
  return commit(document, set);
}

function columnLabel(column: ConfigurationColumn): string {
  switch (column.kind) {
    case 'parameter':
      return 'That parameter';
    case 'suppression':
      return 'That feature';
    case 'body':
      return 'That body';
    case 'material':
      return 'The material';
  }
}

/** Adds a column; every row starts with the value the model holds now. */
export function addConfigurationColumn(
  document: ProjectDocument,
  input: ConfigurationColumnAddInput
): ProjectDocument {
  const set = cloneSet(table(document));
  const { column } = input;
  const key = configurationColumnKey(column);
  if (set.columns.some((entry) => configurationColumnKey(entry) === key))
    throw new Error(`${columnLabel(column)} is already a column.`);
  if (set.columns.length >= MAX_CONFIGURATION_COLUMNS)
    throw new Error(
      `A configuration table holds at most ${MAX_CONFIGURATION_COLUMNS} columns.`
    );
  if (!configurationColumnTargetExists(document, column))
    throw new Error(`${columnLabel(column)} is not in the model.`);
  const live = liveCell(document, column);
  const material =
    input.material === undefined
      ? ({ kind: 'unit' } as const)
      : normalizeMassDensitySelection(input.material);
  for (const row of set.rows) {
    switch (column.kind) {
      case 'parameter':
        row.parameters[column.parameterId] = live as string;
        break;
      case 'suppression':
        row.suppressed[column.featureId] = live as boolean;
        break;
      case 'body':
        row.bodies[column.bodyId] = true;
        break;
      case 'material':
        row.material = structuredClone(material);
        break;
    }
  }
  set.columns.push(structuredClone(column));
  return commit(document, set);
}

/** Removes a column. The model keeps the active row's value. */
export function deleteConfigurationColumn(
  document: ProjectDocument,
  input: ConfigurationColumnDeleteInput
): ProjectDocument {
  const set = cloneSet(table(document));
  const key = configurationColumnKey(input.column);
  if (!set.columns.some((entry) => configurationColumnKey(entry) === key))
    throw new Error('That column is not in the table.');
  set.columns = set.columns.filter(
    (entry) => configurationColumnKey(entry) !== key
  );
  for (const row of set.rows) {
    const column = input.column;
    if (column.kind === 'parameter') delete row.parameters[column.parameterId];
    if (column.kind === 'suppression') delete row.suppressed[column.featureId];
    if (column.kind === 'body') delete row.bodies[column.bodyId];
    if (column.kind === 'material') delete row.material;
  }
  return commit(document, set);
}

/**
 * Sets one cell. A parameter or suppression cell of the active row is the
 * model's own value, so it changes the model in the same step.
 */
export function setConfigurationCell(
  document: ProjectDocument,
  input: ConfigurationCellSetInput
): ProjectDocument {
  const set = cloneSet(table(document));
  let row = rowById(set, input.rowId);
  // The active row's stored parameter and suppression values may be stale:
  // an ordinary edit changes the model, not the row. Start from what the
  // model holds, or applying the row below would undo that edit.
  if (row.id === set.activeRowId) {
    const live = captureLive(document, set, row);
    set.rows = set.rows.map((entry) => (entry.id === live.id ? live : entry));
    row = live;
  }
  const { column, value } = input;
  const key = configurationColumnKey(column);
  if (!set.columns.some((entry) => configurationColumnKey(entry) === key))
    throw new Error('That column is not in the table.');
  switch (column.kind) {
    case 'parameter':
      if (
        typeof value !== 'string' ||
        value.trim() === '' ||
        value.length > MAX_EXPRESSION_LENGTH
      )
        throw new Error('A parameter value must be an expression.');
      row.parameters[column.parameterId] = value.trim();
      break;
    case 'suppression':
      if (typeof value !== 'boolean')
        throw new Error('A suppression value must be on or off.');
      row.suppressed[column.featureId] = value;
      break;
    case 'body':
      if (typeof value !== 'boolean')
        throw new Error('A body value must be shown or hidden.');
      row.bodies[column.bodyId] = value;
      break;
    case 'material': {
      if (typeof value !== 'object')
        throw new Error('A material value must be a material.');
      row.material = normalizeMassDensitySelection(value);
      break;
    }
  }
  const next = cloneDocument(document);
  if (row.id === set.activeRowId) applyRowToModel(document, next, set, row);
  return commit(document, set, next);
}

/**
 * Makes a row active: the row being left keeps the values the model holds
 * now (edits made while it was active stay in it), and the model takes the
 * new row's parameter and suppression values. One undoable step.
 */
export function activateConfiguration(
  document: ProjectDocument,
  input: ConfigurationActivateInput
): ProjectDocument {
  const current = table(document);
  const target = rowById(current, input.rowId);
  if (target.id === current.activeRowId) return document;
  const set = cloneSet(current);
  const leaving = activeConfigurationRow(set);
  if (leaving) {
    const captured = captureLive(document, set, leaving);
    set.rows = set.rows.map((row) => (row.id === leaving.id ? captured : row));
  }
  set.activeRowId = target.id;
  const next = cloneDocument(document);
  applyRowToModel(document, next, set, rowById(set, target.id));
  return commit(document, set, next);
}

/**
 * The document as it would be with `rowId` active, for exporting a row that
 * is not the active one. Not a command: nothing is stored.
 */
export function documentForConfiguration(
  document: ProjectDocument,
  rowId: string
): ProjectDocument {
  const set = table(document);
  rowById(set, rowId);
  return rowId === set.activeRowId
    ? document
    : activateConfiguration(document, { rowId });
}
