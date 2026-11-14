import type {
  AxisId,
  BodyNode,
  BooleanKeepOriginals,
  BooleanOperation,
  ExtrudeEndCondition,
  ExtrudeOperation,
  FeatureData,
  FeatureKind,
  GearFit,
  GearHand,
  GearSizing,
  GearType,
  PatternKind,
  PrimitiveKind,
  RevolveAxis,
  TextFontStyle,
  ThreadAnchor,
  ThreadHand,
  ThreadProfile,
  ThroughAllSide,
  UnitSystem,
  VariableFilletLaw
} from './index';

/** Limits apply before normalization, cloning, or recursive history traversal. */
export const MAX_DOCUMENT_DEPTH = 64;
export const MAX_DOCUMENT_VALUES = 500_000;
/** Bounds extreme offline edit counters while preserving ordinary batched edits. */
export const MAX_DOCUMENT_VERSION_ADVANCE = 1_000_000;
/**
 * The refusal for a document over MAX_DOCUMENT_VALUES. The save edge answers
 * it as a 400, and continuous sync has to tell it apart from a transient
 * failure: no retry can ever store the same document.
 */
export const DOCUMENT_VALUES_REFUSAL = `Project document holds more than ${MAX_DOCUMENT_VALUES} values.`;

export function documentStructureError(value: unknown): string | null {
  const pending = [{ value, depth: 1 }];
  let visited = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (entry.depth > MAX_DOCUMENT_DEPTH) {
      return `Project document nests deeper than ${MAX_DOCUMENT_DEPTH} levels.`;
    }
    visited += 1;
    if (visited > MAX_DOCUMENT_VALUES) {
      return DOCUMENT_VALUES_REFUSAL;
    }
    const children = Array.isArray(entry.value)
      ? entry.value
      : isDocumentRecord(entry.value)
        ? Object.values(entry.value)
        : [];
    if (visited + pending.length + children.length > MAX_DOCUMENT_VALUES) {
      return DOCUMENT_VALUES_REFUSAL;
    }
    for (const child of children)
      pending.push({ value: child, depth: entry.depth + 1 });
  }
  return null;
}

/** Lexical guard for streamed JSON, before JSON.parse allocates its object graph. */
export class JsonComplexityGuard {
  private depth = 0;
  private separators = 0;
  private inString = false;
  private escaped = false;
  constructor(
    private readonly maxDepth = MAX_DOCUMENT_DEPTH + 4,
    private readonly maxSeparators = MAX_DOCUMENT_VALUES * 2
  ) {}
  consume(text: string): void {
    for (const char of text) {
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (char === '\\') this.escaped = true;
        else if (char === '"') this.inString = false;
        continue;
      }
      if (char === '"') this.inString = true;
      else if (char === '{' || char === '[') {
        this.depth += 1;
        this.separators += 1;
      } else if (char === '}' || char === ']') this.depth -= 1;
      else if (char === ',' || char === ':') this.separators += 1;
      if (this.depth > this.maxDepth || this.separators > this.maxSeparators) {
        throw new Error('JSON exceeds the document structural limit.');
      }
    }
  }
}

/** Reuses the streamed request guard, including the surrounding save envelope. */
export function documentRequestWithinComplexity(value: unknown): boolean {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return false;
    new JsonComplexityGuard().consume(text);
    return true;
  } catch {
    return false;
  }
}

export function isDocumentRecord(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Keys a document record never uses as an id: every member of
 * `Object.prototype`, plus `prototype`. Plain-object property access resolves
 * them through the prototype, so a lookup by one finds a member that is not
 * part of the document, and assigning `__proto__` changes the prototype.
 */
const RESERVED_RECORD_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__'
]);

export function isReservedRecordKey(key: unknown): boolean {
  return typeof key === 'string' && RESERVED_RECORD_KEYS.has(key);
}

/**
 * Ids a command supplies for what it creates (`input.ids`): each must be a
 * string, or a list of strings, that is not a reserved name. Checked before
 * anything is written, since each becomes a key of `nodes` or another map.
 * Returns `ids` unchanged.
 */
export function suppliedIds<T>(ids: T): T {
  if (ids === undefined) return ids;
  if (!isDocumentRecord(ids))
    throw new Error('Supplied ids must be an object.');
  for (const [field, value] of Object.entries(ids)) {
    if (value === undefined) continue;
    for (const id of Array.isArray(value) ? value : [value]) {
      if (typeof id !== 'string')
        throw new Error(`Supplied id "${field}" must be a string.`);
      if (RESERVED_RECORD_KEYS.has(id))
        throw new Error(
          `Supplied id "${field}" uses the reserved name "${id}".`
        );
    }
  }
  return ids;
}

/** A key the record holds itself: never an inherited member or a reserved name. */
export function isOwnRecordKey(
  record: Record<string, unknown>,
  key: unknown
): key is string {
  return (
    typeof key === 'string' &&
    !RESERVED_RECORD_KEYS.has(key) &&
    Object.hasOwn(record, key)
  );
}

/** `record[key]` limited to the record's own, non-reserved entries. */
export function ownEntry<T>(
  record: Readonly<Record<string, T>>,
  key: unknown
): T | undefined {
  return isOwnRecordKey(record, key) ? record[key] : undefined;
}

/**
 * Whether a property holds ids: `id`, a `…Id` field or a `…Ids` list.
 * Documents, history snapshots and command payloads name every node, body,
 * feature, sketch, parameter, constraint and annotation this way, and those
 * ids are used as keys of plain-object maps.
 */
export function isIdentifierField(field: string | undefined): boolean {
  return (
    field !== undefined &&
    (field === 'id' || ID_LIST_FIELDS.has(field) || /[a-z0-9]Ids?$/.test(field))
  );
}

/** The document's ordered id lists. */
const ID_LIST_FIELDS: ReadonlySet<string> = new Set([
  'featureOrder',
  'bodyOrder',
  'sketchOrder',
  'parameterOrder',
  'shaprImportOrder'
]);

/**
 * The values of a closed union as a set, checked against the type: the
 * record must name every member and nothing else.
 */
function valuesOf<T extends string>(members: Record<T, true>): Set<string> {
  return new Set(Object.keys(members));
}

/**
 * `representationSource` spellings the first document writer stored (before
 * 7cfee9ed1): `mock` for primitives and extrusions, `composite` for booleans,
 * `mesh-reference` for mesh imports, and `native`, which its type also
 * allowed. No migration rewrites them, so saved projects still carry them.
 * Every other union below has only ever gained members.
 */
const LEGACY_REPRESENTATION_SOURCES = [
  'mock',
  'native',
  'composite',
  'mesh-reference'
] as const;

/**
 * Persisted enum fields whose name means the same union everywhere a
 * document, its history or a stored command carries it. Their values index
 * lookup tables (an icon per primitive or pattern kind, the dimensions each
 * primitive is built from), so they must be one of the union's members:
 * anything else, a reserved name included, is refused.
 */
const ENUM_FIELDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    'primitiveKind',
    valuesOf<PrimitiveKind>({
      box: true,
      cylinder: true,
      sphere: true,
      cone: true,
      torus: true
    })
  ],
  [
    'patternKind',
    valuesOf<PatternKind>({ linear: true, circular: true, grid: true })
  ],
  [
    'gearType',
    valuesOf<GearType>({
      external: true,
      internal: true,
      rack: true,
      bevel: true,
      worm: true,
      'worm-wheel': true,
      'enveloping-worm': true,
      'enveloping-wheel': true
    })
  ],
  [
    'sizing',
    valuesOf<GearSizing>({
      module: true,
      'circular-pitch': true,
      'diametral-pitch': true
    })
  ],
  [
    'endCondition',
    valuesOf<ExtrudeEndCondition>({
      blind: true,
      'through-all': true,
      'to-face': true
    })
  ],
  [
    'throughAllSide',
    valuesOf<ThroughAllSide>({ forward: true, backward: true, both: true })
  ],
  ['depthMode', valuesOf<'blind' | 'through'>({ blind: true, through: true })],
  [
    'fontStyle',
    valuesOf<TextFontStyle>({
      regular: true,
      bold: true,
      italic: true,
      boldItalic: true
    })
  ],
  ['radiusLaw', valuesOf<VariableFilletLaw>({ linear: true, scurve: true })],
  [
    'assumedUnits',
    valuesOf<UnitSystem>({ mm: true, cm: true, m: true, inch: true })
  ],
  [
    'bodyType',
    valuesOf<BodyNode['bodyType']>({ solid: true, 'mesh-reference': true })
  ],
  [
    'representationSource',
    new Set([
      ...valuesOf<BodyNode['representationSource']>({
        brep: true,
        'step-import': true,
        'mesh-import': true
      }),
      ...LEGACY_REPRESENTATION_SOURCES
    ])
  ]
]);

const AXIS_IDS = valuesOf<AxisId>({ x: true, y: true, z: true });

type FeatureDataOf<K extends FeatureKind> = Extract<
  FeatureData,
  { featureKind: K }
>;

/**
 * Enum fields whose name is shared with other structures (an `axis` is a
 * vector elsewhere, an `operation` an object), checked against their union
 * on the data of a feature node, by its kind.
 */
const FEATURE_DATA_ENUMS: Readonly<
  Partial<Record<FeatureKind, ReadonlyMap<string, ReadonlySet<string>>>>
> = {
  pattern: new Map([
    ['axis', AXIS_IDS],
    ['axis2', AXIS_IDS]
  ]),
  boolean: new Map([
    [
      'operation',
      valuesOf<BooleanOperation>({
        union: true,
        subtract: true,
        intersect: true
      })
    ],
    [
      'keepOriginals',
      valuesOf<BooleanKeepOriginals>({ all: true, target: true, tools: true })
    ]
  ]),
  extrude: new Map([
    [
      'operation',
      valuesOf<ExtrudeOperation>({
        'new-body': true,
        add: true,
        cut: true,
        intersect: true
      })
    ]
  ]),
  revolve: new Map([
    ['axis', valuesOf<RevolveAxis>({ horizontal: true, vertical: true })]
  ]),
  loft: new Map([
    [
      'mode',
      valuesOf<FeatureDataOf<'loft'>['mode']>({ ruled: true, smooth: true })
    ]
  ]),
  sweep: new Map([
    [
      'mode',
      valuesOf<FeatureDataOf<'sweep'>['mode']>({ standard: true, smooth: true })
    ]
  ]),
  hole: new Map([
    [
      'style',
      valuesOf<FeatureDataOf<'hole'>['style']>({
        simple: true,
        counterbore: true,
        countersink: true
      })
    ]
  ]),
  gear: new Map([
    ['hand', valuesOf<GearHand>({ right: true, left: true })],
    ['fit', valuesOf<GearFit>({ 'keep-diameter': true, module: true })],
    ['anchor', valuesOf<ThreadAnchor>({ start: true, end: true })]
  ]),
  thread: new Map([
    [
      'profile',
      valuesOf<ThreadProfile>({
        'iso-metric': true,
        printable: true,
        custom: true
      })
    ],
    ['hand', valuesOf<ThreadHand>({ right: true, left: true })],
    ['anchor', valuesOf<ThreadAnchor>({ start: true, end: true })]
  ])
};

/**
 * Selector fields whose values are not one closed union across the schema
 * (`kind` names a node, a command or an annotation; `featureKind` also names
 * a recognized imported feature). Their values index tables and handle maps
 * too (a constraint's `point` picks a solver handle, `axis` a coordinate), so
 * a reserved name is refused there; no legitimate value of them is one. Any
 * field ending in `Kind` is one as well.
 */
const SELECTOR_FIELDS: ReadonlySet<string> = new Set([
  'point',
  'axis',
  'side',
  'end',
  'kind',
  'units',
  'unit',
  'mode',
  'direction',
  'operation',
  'role',
  'style',
  'profile',
  'hand',
  'anchor',
  'fit',
  'plane',
  'method',
  'align',
  'quantity',
  'keepOriginals',
  'category',
  'surfaceType'
]);

/**
 * Fields holding the owner's own data: node `metadata` (arbitrary keys and
 * string, number or boolean values) and a primitive's `dimensions`
 * (expression text). Their keys are still keys and are checked; their values
 * are text, so a metadata `role` of "constructor" is not a selector.
 */
const FREEFORM_FIELDS: ReadonlySet<string> = new Set([
  'metadata',
  'dimensions'
]);

/**
 * Whether `record` is where a freeform field really lives, rather than a map
 * whose entry happens to be named like one (a node or body id "metadata"):
 * node `metadata` sits on a node, a node snapshot or a metadata command
 * (they name a `kind` or a `nodeId`); primitive `dimensions` sit on primitive
 * feature data or a primitive command (they name a `primitiveKind` or a
 * `featureKind`), or on the `data` of a stored `feature.update` command,
 * which may carry `dimensions` alone.
 */
function ownsFreeformField(
  record: Readonly<Record<string, unknown>>,
  key: string,
  recordField: string | undefined,
  payloadEntry: { field: string | undefined; parentValue: unknown } | null
): boolean {
  if (key === 'metadata')
    return typeof record.kind === 'string' || typeof record.nodeId === 'string';
  if (key === 'dimensions')
    return (
      typeof record.primitiveKind === 'string' ||
      typeof record.featureKind === 'string' ||
      (recordField === 'data' &&
        payloadEntry?.field === 'payload' &&
        isDocumentRecord(payloadEntry.parentValue) &&
        payloadEntry.parentValue.kind === 'feature.update')
    );
  return false;
}

/** Whether a string under `field` is a key, id or selector: never reserved. */
function isKeyLikeField(field: string | undefined): boolean {
  return (
    isIdentifierField(field) ||
    (field !== undefined &&
      (SELECTOR_FIELDS.has(field) || /[a-z]Kind$/.test(field)))
  );
}

/** A parameter name is a key of the expression scope. */
function parameterNamesOf(value: Record<string, unknown>): unknown[] {
  if (value.kind === 'parameter') return [value.name];
  if (
    typeof value.kind === 'string' &&
    value.kind.startsWith('parameter.') &&
    isDocumentRecord(value.payload)
  )
    return [value.payload.name, value.payload.newName];
  return [];
}

/**
 * Refuses a reserved name used where a document keeps a key, and an enum
 * value outside its union:
 * - any object key, everywhere (every map in a document, its history and its
 *   command payloads, freeform metadata included);
 * - outside freeform data (`FREEFORM_FIELDS`): any id field (see
 *   {@link isIdentifierField}), any selector such as a constraint's `point`
 *   (see `SELECTOR_FIELDS`) and any parameter name, including those in stored
 *   `parameter.*` commands;
 * - outside freeform data: an enum field (`ENUM_FIELDS`, and on a feature
 *   node's data `FEATURE_DATA_ENUMS`) holding anything but a member of its
 *   union.
 * `field` names the property `value` sits under, so a bare id such as a
 * history change's `before` is judged by its change's field. Other strings,
 * such as display names, descriptions and metadata values, are not keys and
 * may be anything.
 */
export function reservedIdentifierError(
  value: unknown,
  field?: string
): string | null {
  interface Entry {
    value: unknown;
    field: string | undefined;
    parent: Entry | null;
    freeform: boolean;
    /** The union this value must belong to, when its field has one. */
    members?: ReadonlySet<string>;
  }
  const path = (entry: Entry): string => {
    const parts: string[] = [];
    for (let at: Entry | null = entry; at; at = at.parent)
      if (at.field !== undefined) parts.unshift(at.field);
    return parts.join('.') || 'document';
  };
  const pending: Entry[] = [
    {
      value,
      field,
      parent: null,
      freeform: field !== undefined && FREEFORM_FIELDS.has(field),
      members: field === undefined ? undefined : ENUM_FIELDS.get(field)
    }
  ];
  while (pending.length) {
    const entry = pending.pop()!;
    const current = entry.value;
    // An enum field holds one member of its union, never another type.
    if (entry.members && current !== undefined && typeof current !== 'string')
      return `"${path(entry)}" must be one of its known values.`;
    if (typeof current === 'string') {
      if (entry.freeform) continue;
      if (entry.members && !entry.members.has(current))
        return `"${path(entry)}" has the unknown value "${current}".`;
      if (RESERVED_RECORD_KEYS.has(current) && isKeyLikeField(entry.field))
        return `"${path(entry)}" uses the reserved id "${current}".`;
      continue;
    }
    if (Array.isArray(current)) {
      // Numbers hold no names; skipping them keeps dense persisted meshes
      // (an imported mesh's `number[]` payload) cheap to walk.
      for (const item of current)
        if (typeof item !== 'number')
          pending.push({ ...entry, value: item, parent: entry });
      continue;
    }
    if (!isDocumentRecord(current) || ArrayBuffer.isView(current)) continue;
    const owner = entry.parent?.value;
    const featureEnums =
      !entry.freeform &&
      entry.field === 'data' &&
      isDocumentRecord(owner) &&
      owner.kind === 'feature' &&
      typeof current.featureKind === 'string' &&
      Object.hasOwn(FEATURE_DATA_ENUMS, current.featureKind)
        ? FEATURE_DATA_ENUMS[current.featureKind as FeatureKind]
        : undefined;
    for (const key of Object.keys(current)) {
      if (RESERVED_RECORD_KEYS.has(key))
        return `"${path(entry)}" uses the reserved key "${key}".`;
      const freeform =
        entry.freeform ||
        (FREEFORM_FIELDS.has(key) &&
          ownsFreeformField(
            current,
            key,
            entry.field,
            entry.parent
              ? {
                  field: entry.parent.field,
                  parentValue: entry.parent.parent?.value
                }
              : null
          ));
      pending.push({
        value: current[key],
        field: key,
        parent: entry,
        freeform,
        members: freeform
          ? undefined
          : (featureEnums?.get(key) ?? ENUM_FIELDS.get(key))
      });
    }
    if (entry.freeform) continue;
    for (const name of parameterNamesOf(current))
      if (typeof name === 'string' && RESERVED_RECORD_KEYS.has(name))
        return `"${path(entry)}" uses the reserved parameter name "${name}".`;
  }
  return null;
}

/**
 * Node ids are the keys of `nodes`. A node map with a reserved key, or with a
 * node whose own id is reserved or not a string, is refused.
 */
export function nodeMapKeyError(nodes: unknown): string | null {
  if (!isDocumentRecord(nodes)) return null;
  for (const key of Object.keys(nodes)) {
    if (RESERVED_RECORD_KEYS.has(key))
      return `Project document uses the reserved node id "${key}".`;
    const node = nodes[key];
    if (
      isDocumentRecord(node) &&
      node.id !== undefined &&
      (typeof node.id !== 'string' || RESERVED_RECORD_KEYS.has(node.id))
    )
      return `Project document node "${key}" has an invalid id.`;
  }
  return null;
}

/** The points a sketch constraint can name: `SketchPointRef['point']`. */
const SKETCH_POINT_ROLES: ReadonlySet<unknown> = new Set([
  'start',
  'end',
  'center'
]);

/**
 * Per constraint kind: the fields holding a point reference, an object id,
 * an optional point reference, and a dimensional value.
 */
const SKETCH_CONSTRAINT_FIELDS: Readonly<
  Record<
    string,
    {
      points?: readonly string[];
      objects?: readonly string[];
      optionalPoints?: readonly string[];
      values?: readonly string[];
    }
  >
> = {
  coincident: { points: ['a', 'b'] },
  horizontal: { objects: ['objectId'] },
  vertical: { objects: ['objectId'] },
  parallel: { objects: ['a', 'b'] },
  perpendicular: { objects: ['a', 'b'] },
  equal: { objects: ['a', 'b'] },
  tangent: { objects: ['a', 'b'], optionalPoints: ['at'] },
  concentric: { objects: ['a', 'b'] },
  midpoint: { points: ['point'], objects: ['line'] },
  distance: { points: ['a', 'b'], values: ['value'] },
  radius: { objects: ['objectId'], values: ['value'] },
  angle: { objects: ['a', 'b'], values: ['valueDeg'] },
  symmetric: { points: ['a', 'b'], objects: ['axis'] },
  'point-on-object': { points: ['point'], objects: ['objectId'] },
  lock: { points: ['point'] }
};

function isSketchPointSelector(value: unknown): boolean {
  return (
    isDocumentRecord(value) &&
    typeof value.objectId === 'string' &&
    !RESERVED_RECORD_KEYS.has(value.objectId) &&
    SKETCH_POINT_ROLES.has(value.point)
  );
}

/**
 * Why a stored sketch constraint's data has the wrong shape, or null. Point
 * references must name an object and one of its points (`start`, `end` or
 * `center`): the solver picks the point's handle by that name, so anything
 * else would read a member that is not a point.
 */
export function sketchConstraintShapeError(data: unknown): string | null {
  if (!isDocumentRecord(data))
    return 'Sketch constraint data must be an object.';
  const kind = data.constraintKind;
  const fields =
    typeof kind === 'string' && Object.hasOwn(SKETCH_CONSTRAINT_FIELDS, kind)
      ? SKETCH_CONSTRAINT_FIELDS[kind]
      : undefined;
  if (typeof kind !== 'string' || !fields)
    return `Unknown sketch constraint kind "${String(kind)}".`;
  for (const field of fields.points ?? [])
    if (!isSketchPointSelector(data[field]))
      return `Sketch ${kind} constraint has an invalid point "${field}".`;
  for (const field of fields.optionalPoints ?? [])
    if (data[field] !== undefined && !isSketchPointSelector(data[field]))
      return `Sketch ${kind} constraint has an invalid point "${field}".`;
  for (const field of fields.objects ?? []) {
    const objectId = data[field];
    if (typeof objectId !== 'string' || RESERVED_RECORD_KEYS.has(objectId))
      return `Sketch ${kind} constraint has an invalid object "${field}".`;
  }
  for (const field of fields.values ?? []) {
    const value = data[field];
    if (typeof value !== 'number' && typeof value !== 'string')
      return `Sketch ${kind} constraint has an invalid value "${field}".`;
  }
  if (
    kind === 'lock' &&
    (typeof data.x !== 'number' || typeof data.y !== 'number')
  )
    return 'Sketch lock constraint needs a numeric position.';
  return null;
}

/** The envelope read by all persistence and collaboration entry points. */
export function documentEnvelopeError(value: unknown): string | null {
  if (
    !isDocumentRecord(value) ||
    typeof value.projectId !== 'string' ||
    !value.projectId.trim() ||
    typeof value.ownerUserId !== 'string' ||
    !value.ownerUserId.trim() ||
    typeof value.name !== 'string' ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 0 ||
    (value.version as number) >=
      Number.MAX_SAFE_INTEGER - MAX_DOCUMENT_VERSION_ADVANCE ||
    !isDocumentRecord(value.nodes) ||
    !Object.values(value.nodes).every(isDocumentRecord) ||
    !Array.isArray(value.commandLog) ||
    !Array.isArray(value.revisions)
  ) {
    return 'Project document is missing required collections or a valid identity/version.';
  }
  return nodeMapKeyError(value.nodes);
}

/**
 * The parts beyond the envelope that the account itself reads from a stored
 * document (ADR-024 Phase 1: it no longer normalizes what it stores):
 * - `derived`: its warnings and update time survive
 *   `withoutDerivedProjection`;
 * - `assets` and `referenceImages`: artifact cleanup and copies walk them
 *   for the sources they name.
 * Browsers always send well-formed values; the account refuses others with a
 * validation error rather than failing on them.
 */
export function accountReadFieldsError(value: unknown): string | null {
  if (!isDocumentRecord(value)) return 'Project document must be an object.';
  const derived = value.derived;
  if (
    !isDocumentRecord(derived) ||
    !Array.isArray(derived.warnings) ||
    !derived.warnings.every((warning) => typeof warning === 'string') ||
    typeof derived.updatedAt !== 'string'
  ) {
    return 'Project document is missing its derived state.';
  }
  if (
    !isDocumentRecord(value.assets) ||
    !Object.values(value.assets).every(
      (asset) =>
        isDocumentRecord(asset) &&
        (asset.artifactId === undefined || typeof asset.artifactId === 'string')
    )
  ) {
    return 'Project document has invalid assets.';
  }
  const images = value.referenceImages;
  if (
    images !== undefined &&
    (!isDocumentRecord(images) ||
      !Array.isArray(images.images) ||
      !images.images.every(isDocumentRecord))
  ) {
    return 'Project document has invalid reference images.';
  }
  return null;
}

export const MAX_NODE_NAME_LENGTH = 200;
export const MAX_EXPRESSION_LENGTH = 4_096;
export function boundedName(value: string): string {
  const end = value.charCodeAt(MAX_NODE_NAME_LENGTH - 1);
  return value.slice(
    0,
    end >= 0xd800 && end <= 0xdbff
      ? MAX_NODE_NAME_LENGTH - 1
      : MAX_NODE_NAME_LENGTH
  );
}

export function documentVersionCanAdvance(
  incoming: number,
  trusted: number
): boolean {
  return (
    Number.isSafeInteger(incoming) &&
    Number.isSafeInteger(trusted) &&
    incoming >= 0 &&
    trusted >= 0 &&
    incoming < Number.MAX_SAFE_INTEGER - MAX_DOCUMENT_VERSION_ADVANCE &&
    incoming <= trusted + MAX_DOCUMENT_VERSION_ADVANCE
  );
}
