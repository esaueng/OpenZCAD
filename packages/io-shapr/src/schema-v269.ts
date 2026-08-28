import { decodeSqlText, parseBoundedJson } from './json';
import type { ShaprImportLimits } from './limits';
import { truncateCodeUnits } from './truncate';
import { decodeShaprMessagePack } from './msgpack';
import type {
  ShaprDatabase,
  ShaprDatabaseRow,
  ShaprImportDiagnostic,
  ShaprImportIR,
  ShaprMigrationStatus,
  ShaprOperationIR,
  ShaprOperationKind,
  ShaprSchemaTuple,
  ShaprSketchConstraintCandidate,
  ShaprSketchCurve,
  ShaprSketchIR
} from './types';
import type { ShaprArchiveInspection } from './zip';

const SUPPORTED_SCHEMA: ShaprSchemaTuple = {
  workspaceSchemaVersion: 269,
  schemaVersion: 307000,
  historyVersion: 100,
  projectVersion: 249000
};

const REQUIRED_TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  Settings: ['SettingName', 'SettingValue'],
  HistoryTreeNodes: ['HistoryTreeNodeID', 'HistoryTreeNodeType', 'Properties'],
  SketchControllers: [
    'SketchID',
    'Name',
    'IsHidden',
    'PlaneCenterX',
    'PlaneCenterY',
    'PlaneCenterZ',
    'PlaneNormX',
    'PlaneNormY',
    'PlaneNormZ',
    'PlaneUDirX',
    'PlaneUDirY',
    'PlaneUDirZ'
  ],
  SketchCurves: ['CurveID', 'SketchID', 'Data', 'IsMissingReference'],
  Constraints: ['RowID', 'SketchID', 'Data', 'IsBroken'],
  HistorySketchConstraints: [
    'DescriptorID',
    'SketchID',
    'ConstraintType',
    'Data'
  ],
  HistoryImportedBodies: ['ImportedBodyID', 'ImportedPrototypeID', 'Transform'],
  HistoryImportedPrototypes: ['ImportedPrototypeID', 'BodyData'],
  BodyRevisionBlocks: [
    'PartitionID',
    'ChunkIndex',
    'Block',
    'Phase',
    'IsDeleted'
  ],
  BodyRevisionDeltas: [
    'PartitionID',
    'ChunkIndex',
    'Delta',
    'Phase',
    'IsDeleted'
  ]
};

function rowValue(row: ShaprDatabaseRow, column: string): unknown {
  if (!(column in row)) {
    throw new Error(
      `SHAPR database query omitted required column "${column}".`
    );
  }
  return row[column];
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} is not a finite number.`);
  }
  return value;
}

function safeInteger(value: unknown, label: string): number {
  const number = finiteNumber(value, label);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`${label} is not a safe integer.`);
  }
  return number;
}

function booleanValue(value: unknown, label: string): boolean {
  const number = safeInteger(value, label);
  if (number !== 0 && number !== 1) {
    throw new Error(`${label} is not a SQLite boolean.`);
  }
  return number === 1;
}

function bytesValue(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof Int8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  throw new Error(`${label} is not binary data.`);
}

function boundedName(value: unknown, fallback: string): string {
  if (value === null || value === undefined) {
    return fallback;
  }
  const decoded = [...decodeSqlText(value, 'SHAPR name')]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f ? ' ' : character;
    })
    .join('')
    .trim();
  return decoded.length > 0 ? truncateCodeUnits(decoded, 200) : fallback;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object.`);
  }
  return value as Record<string, unknown>;
}

function numberArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} is not an array.`);
  }
  return value.map((item, index) => finiteNumber(item, `${label}[${index}]`));
}

function vector2(value: unknown, label: string): { x: number; y: number } {
  const object = objectValue(value, label);
  return {
    x: finiteNumber(object.x, `${label}.x`),
    y: finiteNumber(object.y, `${label}.y`)
  };
}

function collectNumericCandidates(value: unknown, maximum = 64): number[] {
  const stack: unknown[] = [value];
  const seen = new Set<number>();
  while (stack.length > 0 && seen.size < maximum) {
    const current = stack.pop();
    if (
      typeof current === 'number' &&
      Number.isFinite(current) &&
      current !== 0 &&
      !Number.isInteger(current)
    ) {
      seen.add(current);
    } else if (Array.isArray(current)) {
      stack.push(...(current as unknown[]));
    } else if (current && typeof current === 'object') {
      stack.push(...Object.values(current as Record<string, unknown>));
    }
  }
  return [...seen];
}

function collectReferencedCurveIds(value: unknown, maximum = 64): number[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  const found = new Set<number>();
  const stack: Array<Record<string, unknown>> = [
    value as Record<string, unknown>
  ];
  while (stack.length > 0 && found.size < maximum) {
    const current = stack.pop()!;
    for (const [key, child] of Object.entries(current)) {
      if (
        /curve|line/i.test(key) &&
        typeof child === 'number' &&
        Number.isSafeInteger(child)
      ) {
        found.add(child);
      } else if (child && typeof child === 'object' && !Array.isArray(child)) {
        stack.push(child as Record<string, unknown>);
      }
    }
  }
  return [...found];
}

function tableColumns(database: ShaprDatabase, table: string): Set<string> {
  return new Set(
    database
      .all(`PRAGMA table_info("${table}")`)
      .map((row) =>
        decodeSqlText(rowValue(row, 'name'), `${table} column name`)
      )
  );
}

function validateRequiredSchema(database: ShaprDatabase): void {
  const tables = new Set(
    database
      .all("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .map((row) => decodeSqlText(rowValue(row, 'name'), 'SHAPR table name'))
  );
  for (const [table, requiredColumns] of Object.entries(
    REQUIRED_TABLE_COLUMNS
  )) {
    if (!tables.has(table)) {
      throw new Error(`Supported SHAPR schema is missing table "${table}".`);
    }
    const columns = tableColumns(database, table);
    for (const column of requiredColumns) {
      if (!columns.has(column)) {
        throw new Error(
          `Supported SHAPR schema table "${table}" is missing column "${column}".`
        );
      }
    }
  }
}

function rowCount(
  database: ShaprDatabase,
  table: string,
  maximum: number
): number {
  const [row] = database.all(`SELECT COUNT(*) AS rowCount FROM "${table}"`);
  const count = safeInteger(
    rowValue(row ?? {}, 'rowCount'),
    `${table} row count`
  );
  if (count > maximum) {
    throw new Error(`${table} exceeds the ${maximum} row import limit.`);
  }
  return count;
}

function readSettings(database: ShaprDatabase): Map<string, unknown> {
  const settings = new Map<string, unknown>();
  for (const row of database.all(
    'SELECT SettingName, SettingValue FROM Settings ORDER BY RowID'
  )) {
    const name = decodeSqlText(
      rowValue(row, 'SettingName'),
      'SHAPR setting name'
    );
    if (name.length > 200 || settings.has(name)) {
      throw new Error('SHAPR settings contain an invalid or duplicate name.');
    }
    settings.set(name, rowValue(row, 'SettingValue'));
  }
  return settings;
}

function settingInteger(settings: Map<string, unknown>, name: string): number {
  if (!settings.has(name)) {
    throw new Error(`SHAPR database is missing setting "${name}".`);
  }
  return safeInteger(settings.get(name), `SHAPR setting ${name}`);
}

function detectSchema(settings: Map<string, unknown>): ShaprSchemaTuple {
  const schema: ShaprSchemaTuple = {
    workspaceSchemaVersion: settingInteger(settings, 'WorkspaceSchemaVersion'),
    schemaVersion: settingInteger(settings, 'SchemaVersion'),
    historyVersion: settingInteger(settings, 'HistoryVersion'),
    projectVersion: settingInteger(settings, 'Persistence_ProjectVersion')
  };
  if (
    Object.keys(SUPPORTED_SCHEMA).some((key) => {
      const field = key as keyof ShaprSchemaTuple;
      return schema[field] !== SUPPORTED_SCHEMA[field];
    })
  ) {
    throw new Error(
      `Unsupported SHAPR schema ${schema.workspaceSchemaVersion}/${schema.schemaVersion}/${schema.historyVersion}/${schema.projectVersion}. Exact STEP import remains available.`
    );
  }
  return schema;
}

function parseCurve(
  row: ShaprDatabaseRow,
  limits: ShaprImportLimits
): ShaprSketchCurve {
  const sourceCurveId = safeInteger(rowValue(row, 'CurveID'), 'SHAPR curve id');
  const missing = booleanValue(
    rowValue(row, 'IsMissingReference'),
    `SHAPR curve ${sourceCurveId} missing-reference flag`
  );
  if (missing) {
    return {
      sourceCurveId,
      kind: 'unknown',
      evidence: 'observed',
      sourceType: null,
      reason: 'The source project marks this curve as a missing reference.'
    };
  }
  const parsed = objectValue(
    parseBoundedJson(
      rowValue(row, 'Data'),
      `SHAPR curve ${sourceCurveId}`,
      limits
    ),
    `SHAPR curve ${sourceCurveId}`
  );
  const sourceType = safeInteger(
    parsed.type,
    `SHAPR curve ${sourceCurveId} type`
  );
  if (sourceType === 0) {
    return {
      sourceCurveId,
      kind: 'line',
      evidence: 'inferred',
      start: vector2(parsed.start, `SHAPR curve ${sourceCurveId} start`),
      end: vector2(parsed.end, `SHAPR curve ${sourceCurveId} end`)
    };
  }
  if (sourceType === 2) {
    const radius = finiteNumber(
      parsed.radius,
      `SHAPR curve ${sourceCurveId} radius`
    );
    if (radius <= 0) {
      throw new Error(
        `SHAPR curve ${sourceCurveId} has a non-positive radius.`
      );
    }
    return {
      sourceCurveId,
      kind: 'circle',
      evidence: 'inferred',
      center: vector2(parsed.center, `SHAPR curve ${sourceCurveId} center`),
      radius
    };
  }
  if (sourceType === 3) {
    if (!Array.isArray(parsed.controlPoints)) {
      throw new Error(
        `SHAPR curve ${sourceCurveId} has no control-point array.`
      );
    }
    const controlPoints = parsed.controlPoints.map((point, index) =>
      vector2(point, `SHAPR curve ${sourceCurveId} control point ${index}`)
    );
    const degree = safeInteger(
      parsed.degree,
      `SHAPR curve ${sourceCurveId} degree`
    );
    const knots = numberArray(
      parsed.knots,
      `SHAPR curve ${sourceCurveId} knots`
    );
    const multiplicities = numberArray(
      parsed.multiplicities,
      `SHAPR curve ${sourceCurveId} multiplicities`
    );
    const weights = numberArray(
      parsed.weights,
      `SHAPR curve ${sourceCurveId} weights`
    );
    if (typeof parsed.periodic !== 'boolean') {
      throw new Error(
        `SHAPR curve ${sourceCurveId} has an invalid periodic flag.`
      );
    }
    const periodic = parsed.periodic;
    if (
      degree < 1 ||
      degree > 5 ||
      controlPoints.length < degree + 1 ||
      knots.length !== multiplicities.length ||
      knots.some((knot, index) => index > 0 && knot < knots[index - 1]!) ||
      multiplicities.some(
        (multiplicity) =>
          !Number.isInteger(multiplicity) ||
          multiplicity < 1 ||
          multiplicity > degree + 1
      ) ||
      (!periodic &&
        multiplicities.reduce((sum, value) => sum + value, 0) !==
          controlPoints.length + degree + 1) ||
      (weights.length !== 0 && weights.length !== controlPoints.length) ||
      weights.some((weight) => weight <= 0)
    ) {
      throw new Error(
        `SHAPR curve ${sourceCurveId} has an invalid B-spline definition.`
      );
    }
    return {
      sourceCurveId,
      kind: 'bspline',
      evidence: 'inferred',
      controlPoints,
      knots,
      multiplicities,
      weights,
      degree,
      periodic
    };
  }
  return {
    sourceCurveId,
    kind: 'unknown',
    evidence: 'observed',
    sourceType,
    reason: `Curve type ${sourceType} has no proven OpenZCAD translation.`
  };
}

function constraintCandidate(
  value: unknown,
  sourceConstraintId: string,
  sourceType: number | null
): ShaprSketchConstraintCandidate {
  return {
    sourceConstraintId,
    sourceType,
    status: 'candidate',
    numericCandidates: collectNumericCandidates(value),
    referencedCurveIds: collectReferencedCurveIds(value),
    diagnostic:
      'Constraint type and reference roles are decoded as candidates only; no solver constraint was applied.'
  };
}

function readSketches(
  database: ShaprDatabase,
  limits: ShaprImportLimits
): ShaprSketchIR[] {
  rowCount(database, 'SketchControllers', limits.maxSketches);
  rowCount(database, 'SketchCurves', limits.maxSketchCurves);
  rowCount(database, 'Constraints', limits.maxConstraints);
  rowCount(database, 'HistorySketchConstraints', limits.maxConstraints);

  const curvesBySketch = new Map<number, ShaprSketchCurve[]>();
  let controlPointCount = 0;
  for (const row of database.all(
    'SELECT CurveID, SketchID, Data, IsMissingReference FROM SketchCurves ORDER BY CurveID'
  )) {
    const sketchId = safeInteger(
      rowValue(row, 'SketchID'),
      'SHAPR curve sketch id'
    );
    const curve = parseCurve(row, limits);
    if (curve.kind === 'bspline') {
      controlPointCount += curve.controlPoints.length;
      if (controlPointCount > limits.maxControlPoints) {
        throw new Error(
          'SHAPR sketches exceed the control-point import limit.'
        );
      }
    }
    const curves = curvesBySketch.get(sketchId) ?? [];
    curves.push(curve);
    curvesBySketch.set(sketchId, curves);
  }

  const constraintsBySketch = new Map<
    number,
    ShaprSketchConstraintCandidate[]
  >();
  for (const row of database.all(
    'SELECT RowID, SketchID, Data, IsBroken FROM Constraints ORDER BY RowID'
  )) {
    const rowId = safeInteger(
      rowValue(row, 'RowID'),
      'SHAPR constraint row id'
    );
    const sketchId = safeInteger(
      rowValue(row, 'SketchID'),
      `SHAPR constraint ${rowId} sketch id`
    );
    const value = parseBoundedJson(
      rowValue(row, 'Data'),
      `SHAPR constraint ${rowId}`,
      limits
    );
    const sourceType =
      value && typeof value === 'object' && !Array.isArray(value)
        ? safeInteger(
            (value as Record<string, unknown>).type,
            `SHAPR constraint ${rowId} type`
          )
        : null;
    const candidate = constraintCandidate(
      value,
      `materialized:${rowId}`,
      sourceType
    );
    if (
      booleanValue(
        rowValue(row, 'IsBroken'),
        `SHAPR constraint ${rowId} broken flag`
      )
    ) {
      candidate.status = 'unsupported';
      candidate.diagnostic =
        'The source project marks this constraint as broken.';
    }
    const constraints = constraintsBySketch.get(sketchId) ?? [];
    constraints.push(candidate);
    constraintsBySketch.set(sketchId, constraints);
  }
  for (const row of database.all(
    'SELECT DescriptorID, SketchID, ConstraintType, Data FROM HistorySketchConstraints ORDER BY DescriptorID'
  )) {
    const descriptorId = safeInteger(
      rowValue(row, 'DescriptorID'),
      'SHAPR history constraint id'
    );
    const sketchId = safeInteger(
      rowValue(row, 'SketchID'),
      `SHAPR history constraint ${descriptorId} sketch id`
    );
    const sourceType = safeInteger(
      rowValue(row, 'ConstraintType'),
      `SHAPR history constraint ${descriptorId} type`
    );
    const value = parseBoundedJson(
      rowValue(row, 'Data'),
      `SHAPR history constraint ${descriptorId}`,
      limits
    );
    const constraints = constraintsBySketch.get(sketchId) ?? [];
    constraints.push(
      constraintCandidate(value, `history:${descriptorId}`, sourceType)
    );
    constraintsBySketch.set(sketchId, constraints);
  }

  return database
    .all(
      'SELECT SketchID, Name, IsHidden, PlaneCenterX, PlaneCenterY, PlaneCenterZ, PlaneNormX, PlaneNormY, PlaneNormZ, PlaneUDirX, PlaneUDirY, PlaneUDirZ FROM SketchControllers ORDER BY SketchID'
    )
    .map((row) => {
      const sourceSketchId = safeInteger(
        rowValue(row, 'SketchID'),
        'SHAPR sketch id'
      );
      return {
        sourceSketchId,
        name: boundedName(rowValue(row, 'Name'), `Sketch ${sourceSketchId}`),
        hidden: booleanValue(
          rowValue(row, 'IsHidden'),
          `SHAPR sketch ${sourceSketchId} hidden flag`
        ),
        frame: {
          origin: {
            x: finiteNumber(
              rowValue(row, 'PlaneCenterX'),
              'SHAPR plane origin x'
            ),
            y: finiteNumber(
              rowValue(row, 'PlaneCenterY'),
              'SHAPR plane origin y'
            ),
            z: finiteNumber(
              rowValue(row, 'PlaneCenterZ'),
              'SHAPR plane origin z'
            )
          },
          normal: {
            x: finiteNumber(
              rowValue(row, 'PlaneNormX'),
              'SHAPR plane normal x'
            ),
            y: finiteNumber(
              rowValue(row, 'PlaneNormY'),
              'SHAPR plane normal y'
            ),
            z: finiteNumber(rowValue(row, 'PlaneNormZ'), 'SHAPR plane normal z')
          },
          uDirection: {
            x: finiteNumber(
              rowValue(row, 'PlaneUDirX'),
              'SHAPR plane U direction x'
            ),
            y: finiteNumber(
              rowValue(row, 'PlaneUDirY'),
              'SHAPR plane U direction y'
            ),
            z: finiteNumber(
              rowValue(row, 'PlaneUDirZ'),
              'SHAPR plane U direction z'
            )
          }
        },
        curves: curvesBySketch.get(sourceSketchId) ?? [],
        constraints: constraintsBySketch.get(sourceSketchId) ?? []
      } satisfies ShaprSketchIR;
    });
}

function operationKind(token: string): ShaprOperationKind {
  switch (token) {
    case 'MaterializeImportedBodies':
      return 'import';
    case 'MaterializeSketchPlane':
      return 'sketch';
    case 'Transform':
      return 'transform';
    case 'Delete':
      return 'delete';
    case 'CreateCGPlaneWithMidPlane':
      return 'midplane';
    case 'Split':
      return 'split';
    case 'OffsetFace':
      return 'offset-face';
    case 'Union':
      return 'union';
    case 'Extrude':
      return 'extrude';
    default:
      return 'unknown';
  }
}

function operationStatus(kind: ShaprOperationKind): ShaprMigrationStatus {
  switch (kind) {
    case 'sketch':
    case 'transform':
    case 'union':
    case 'extrude':
      return 'candidate';
    default:
      return 'unsupported';
  }
}

function readOperations(
  database: ShaprDatabase,
  limits: ShaprImportLimits
): { historyNodeCount: number; operations: ShaprOperationIR[] } {
  const historyNodeCount = rowCount(
    database,
    'HistoryTreeNodes',
    limits.maxHistoryNodes
  );
  const decoded = new Map<number, { sourceType: number; value: unknown }>();
  for (const row of database.all(
    'SELECT HistoryTreeNodeID, HistoryTreeNodeType, Properties FROM HistoryTreeNodes ORDER BY HistoryTreeNodeID'
  )) {
    const sourceNodeId = safeInteger(
      rowValue(row, 'HistoryTreeNodeID'),
      'SHAPR history node id'
    );
    const sourceType = safeInteger(
      rowValue(row, 'HistoryTreeNodeType'),
      `SHAPR history node ${sourceNodeId} type`
    );
    const value = decodeShaprMessagePack(
      bytesValue(
        rowValue(row, 'Properties'),
        `SHAPR history node ${sourceNodeId} properties`
      ),
      limits
    );
    decoded.set(sourceNodeId, { sourceType, value });
  }

  const operations: ShaprOperationIR[] = [];
  for (const [sourceNodeId, node] of decoded) {
    if (
      node.sourceType !== 2 ||
      !Array.isArray(node.value) ||
      node.value.length < 5
    ) {
      continue;
    }
    const name =
      typeof node.value[2] === 'string'
        ? boundedName(node.value[2], 'Operation')
        : 'Operation';
    const token =
      typeof node.value[3] === 'string'
        ? boundedName(node.value[3], 'Unknown')
        : 'Unknown';
    const propertyNodeIds = Array.isArray(node.value[4])
      ? node.value[4].map((value, index) =>
          safeInteger(
            value,
            `SHAPR operation ${sourceNodeId} property id ${index}`
          )
        )
      : [];
    const propertyValues = propertyNodeIds.flatMap((id) => {
      const property = decoded.get(id);
      return property ? [property.value] : [];
    });
    const kind = operationKind(token);
    const status = operationStatus(kind);
    if (operations.length >= limits.maxRecoveredOperations) {
      throw new Error(
        `SHAPR project exceeds the ${limits.maxRecoveredOperations} recovered-operation limit.`
      );
    }
    operations.push({
      sourceNodeId,
      sourceType: node.sourceType,
      name,
      token,
      kind,
      status,
      propertyNodeIds,
      numericCandidates: collectNumericCandidates(propertyValues),
      diagnostic:
        status === 'candidate'
          ? 'Recognized schema shape; units, coordinate frame, operands, or topology correspondence are not yet proven.'
          : 'Preserved in the exact STEP body; no semantic operation was applied.'
    });
  }
  return { historyNodeCount, operations };
}

function aggregate(
  database: ShaprDatabase,
  sql: string,
  column: string
): number {
  const [row] = database.all(sql);
  return safeInteger(rowValue(row ?? {}, column), `SHAPR ${column}`);
}

function geometrySummary(
  database: ShaprDatabase,
  settings: Map<string, unknown>
) {
  const parasolidVersions = [
    'Create_ParasolidVersion',
    'Latest_ParasolidVersion'
  ]
    .flatMap((name) => {
      const value = settings.get(name);
      return value === undefined ? [] : [boundedName(value, 'unknown')];
    })
    .filter((value, index, all) => all.indexOf(value) === index);
  return {
    importedBodyCount: aggregate(
      database,
      'SELECT COUNT(*) AS value FROM HistoryImportedBodies',
      'value'
    ),
    importedPrototypeCount: aggregate(
      database,
      'SELECT COUNT(*) AS value FROM HistoryImportedPrototypes',
      'value'
    ),
    revisionBlockCount: aggregate(
      database,
      'SELECT COUNT(*) AS value FROM BodyRevisionBlocks WHERE Phase = 2 AND IsDeleted = 0',
      'value'
    ),
    revisionDeltaCount: aggregate(
      database,
      'SELECT COUNT(*) AS value FROM BodyRevisionDeltas WHERE Phase = 2 AND IsDeleted = 0',
      'value'
    ),
    importedPrototypeBytes: aggregate(
      database,
      'SELECT COALESCE(SUM(LENGTH(BodyData)), 0) AS value FROM HistoryImportedPrototypes',
      'value'
    ),
    revisionBlockBytes: aggregate(
      database,
      'SELECT COALESCE(SUM(LENGTH(Block)), 0) AS value FROM BodyRevisionBlocks WHERE Phase = 2 AND IsDeleted = 0',
      'value'
    ),
    revisionDeltaBytes: aggregate(
      database,
      'SELECT COALESCE(SUM(LENGTH(Delta)), 0) AS value FROM BodyRevisionDeltas WHERE Phase = 2 AND IsDeleted = 0',
      'value'
    ),
    parasolidVersions
  };
}

function diagnostics(
  operations: ShaprOperationIR[],
  sketches: ShaprSketchIR[]
): ShaprImportDiagnostic[] {
  const unknownCurves = sketches.reduce(
    (count, sketch) =>
      count + sketch.curves.filter((curve) => curve.kind === 'unknown').length,
    0
  );
  const unsupportedOperations = operations.filter(
    (operation) => operation.status === 'unsupported'
  ).length;
  return [
    {
      severity: 'info',
      code: 'schema-supported',
      message: 'Workspace schema 269 is recognized by an exact-version adapter.'
    },
    {
      severity: 'warning',
      code: 'units-unproven',
      message:
        'Workspace distances appear to use metres, but no scaling is applied until the companion STEP proves the coordinate contract.'
    },
    {
      severity: 'warning',
      code: 'parasolid-opaque',
      message:
        'Embedded Parasolid prototypes and revision bodies remain opaque; the companion STEP is the exact geometry witness.'
    },
    ...(unsupportedOperations > 0
      ? [
          {
            severity: 'warning' as const,
            code: 'unsupported-operations',
            message: `${unsupportedOperations} history operations remain non-operative and are preserved by the exact STEP body.`
          }
        ]
      : []),
    ...(unknownCurves > 0
      ? [
          {
            severity: 'warning' as const,
            code: 'unsupported-curves',
            message: `${unknownCurves} sketch curves have no proven translation.`
          }
        ]
      : []),
    {
      severity: 'info',
      code: 'private-data-omitted',
      message:
        'Remote project identifiers, thumbnails, UI state, local paths, usernames, timestamps, and commit identifiers were not imported.'
    }
  ];
}

export function parseWorkspace269(
  database: ShaprDatabase,
  archive: ShaprArchiveInspection,
  archiveBytes: number,
  checksumSha256: string,
  limits: ShaprImportLimits
): ShaprImportIR {
  validateRequiredSchema(database);
  const [integrity] = database.all('PRAGMA quick_check(1)');
  if (
    !integrity ||
    decodeSqlText(
      rowValue(integrity, 'quick_check'),
      'SQLite quick_check result'
    ) !== 'ok'
  ) {
    throw new Error('SHAPR workspace database failed its integrity check.');
  }
  const settings = readSettings(database);
  const schema = detectSchema(settings);
  const sketches = readSketches(database, limits);
  const { historyNodeCount, operations } = readOperations(database, limits);
  return {
    format: 'openzcad-shapr-ir',
    version: 1,
    schema,
    schemaAdapter: 'workspace-269',
    units: {
      source: 'metre-candidate',
      evidence: 'inferred',
      documentScaleCandidate: 1000
    },
    archive: {
      bytes: archiveBytes,
      entries: archive.entries.length,
      workspaceBytes: archive.workspace.uncompressedBytes,
      checksumSha256
    },
    historyNodeCount,
    sketches,
    operations,
    opaqueGeometry: geometrySummary(database, settings),
    diagnostics: diagnostics(operations, sketches),
    omittedPrivateData: [
      '.metadata remote project identifiers',
      'drawing thumbnails',
      'UI and camera state',
      'project nonce',
      'commit identifiers and timestamps',
      'STEP header paths and authors'
    ]
  };
}
