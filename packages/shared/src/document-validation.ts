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
  ProjectDocument,
  ProjectNode,
  RevolveAxis,
  SketchObjectData,
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
 * The enum fields an owner record defines, each with its union. Field names
 * are checked against the owner's type, so a list can only name properties
 * the schema object really has.
 */
function enumsOf<T>(fields: {
  [F in keyof T & string]?: ReadonlySet<string>;
}): ReadonlyMap<string, ReadonlySet<string>> {
  return new Map(
    Object.entries(fields).filter(
      (entry): entry is [string, ReadonlySet<string>] => entry[1] !== undefined
    )
  );
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

const PRIMITIVE_KINDS = valuesOf<PrimitiveKind>({
  box: true,
  cylinder: true,
  sphere: true,
  cone: true,
  torus: true
});
const PATTERN_KINDS = valuesOf<PatternKind>({
  linear: true,
  circular: true,
  grid: true
});
const GEAR_TYPES = valuesOf<GearType>({
  external: true,
  internal: true,
  rack: true,
  bevel: true,
  worm: true,
  'worm-wheel': true,
  'enveloping-worm': true,
  'enveloping-wheel': true
});
const GEAR_SIZINGS = valuesOf<GearSizing>({
  module: true,
  'circular-pitch': true,
  'diametral-pitch': true
});
const END_CONDITIONS = valuesOf<ExtrudeEndCondition>({
  blind: true,
  'through-all': true,
  'to-face': true
});
const THROUGH_ALL_SIDES = valuesOf<ThroughAllSide>({
  forward: true,
  backward: true,
  both: true
});
const HOLE_DEPTH_MODES = valuesOf<FeatureDataOf<'hole'>['depthMode']>({
  blind: true,
  through: true
});
const RADIUS_LAWS = valuesOf<VariableFilletLaw>({ linear: true, scurve: true });
const UNIT_SYSTEMS = valuesOf<UnitSystem>({
  mm: true,
  cm: true,
  m: true,
  inch: true
});
const AXIS_IDS = valuesOf<AxisId>({ x: true, y: true, z: true });
const THREAD_ANCHORS = valuesOf<ThreadAnchor>({ start: true, end: true });

type FeatureDataOf<K extends FeatureKind> = Extract<
  FeatureData,
  { featureKind: K }
>;

/**
 * The enums feature data defines, by its `featureKind`. Their values index
 * lookup tables (an icon per primitive or pattern kind, the dimensions each
 * primitive is built from), so on the data of a feature node each must be
 * one of its union's members: anything else, a reserved name included, is
 * refused. The same names elsewhere (an `axis` vector, an `operation`
 * object, a map entry or id spelled `primitiveKind`) are not these enums.
 */
const FEATURE_DATA_ENUMS: Readonly<
  Partial<Record<FeatureKind, ReadonlyMap<string, ReadonlySet<string>>>>
> = {
  primitive: enumsOf<FeatureDataOf<'primitive'>>({
    primitiveKind: PRIMITIVE_KINDS
  }),
  pattern: enumsOf<FeatureDataOf<'pattern'>>({
    patternKind: PATTERN_KINDS,
    axis: AXIS_IDS,
    axis2: AXIS_IDS
  }),
  boolean: enumsOf<FeatureDataOf<'boolean'>>({
    operation: valuesOf<BooleanOperation>({
      union: true,
      subtract: true,
      intersect: true
    }),
    keepOriginals: valuesOf<BooleanKeepOriginals>({
      all: true,
      target: true,
      tools: true
    })
  }),
  extrude: enumsOf<FeatureDataOf<'extrude'>>({
    operation: valuesOf<ExtrudeOperation>({
      'new-body': true,
      add: true,
      cut: true,
      intersect: true
    }),
    endCondition: END_CONDITIONS,
    throughAllSide: THROUGH_ALL_SIDES
  }),
  revolve: enumsOf<FeatureDataOf<'revolve'>>({
    axis: valuesOf<RevolveAxis>({ horizontal: true, vertical: true })
  }),
  loft: enumsOf<FeatureDataOf<'loft'>>({
    mode: valuesOf<FeatureDataOf<'loft'>['mode']>({ ruled: true, smooth: true })
  }),
  sweep: enumsOf<FeatureDataOf<'sweep'>>({
    mode: valuesOf<FeatureDataOf<'sweep'>['mode']>({
      standard: true,
      smooth: true
    })
  }),
  hole: enumsOf<FeatureDataOf<'hole'>>({
    depthMode: HOLE_DEPTH_MODES,
    style: valuesOf<FeatureDataOf<'hole'>['style']>({
      simple: true,
      counterbore: true,
      countersink: true
    })
  }),
  gear: enumsOf<FeatureDataOf<'gear'>>({
    gearType: GEAR_TYPES,
    sizing: GEAR_SIZINGS,
    hand: valuesOf<GearHand>({ right: true, left: true }),
    fit: valuesOf<GearFit>({ 'keep-diameter': true, module: true }),
    anchor: THREAD_ANCHORS
  }),
  thread: enumsOf<FeatureDataOf<'thread'>>({
    profile: valuesOf<ThreadProfile>({
      'iso-metric': true,
      printable: true,
      custom: true,
      npt: true,
      bspt: true
    }),
    hand: valuesOf<ThreadHand>({ right: true, left: true }),
    anchor: THREAD_ANCHORS
  }),
  fillet: enumsOf<FeatureDataOf<'fillet'>>({ radiusLaw: RADIUS_LAWS }),
  'imported-mesh': enumsOf<FeatureDataOf<'imported-mesh'>>({
    assumedUnits: UNIT_SYSTEMS
  })
};

const FEATURE_KINDS = valuesOf<FeatureKind>({
  primitive: true,
  sketch: true,
  extrude: true,
  revolve: true,
  loft: true,
  sweep: true,
  'helical-sweep': true,
  boolean: true,
  transform: true,
  mirror: true,
  shell: true,
  'solid-offset': true,
  draft: true,
  thicken: true,
  fillet: true,
  chamfer: true,
  pattern: true,
  split: true,
  hole: true,
  gear: true,
  thread: true,
  'direct-edit': true,
  'imported-step': true,
  'imported-mesh': true,
  'datum-plane': true,
  'datum-axis': true
});

/**
 * The feature kind each feature-creating command creates. Its payload is that
 * feature's creation input (`PatternInput`, `BooleanInput`, ...), which
 * carries the feature data's enums under the same names and unions, so a
 * stored command is held to the enums of the feature it creates. Every
 * `feature.<kind>` command creates a `<kind>` feature; command-system checks
 * this table against its `CommandKind` union (`COMMAND_CREATED_FEATURE_KINDS`),
 * so a new creation command cannot be left out.
 */
export const COMMAND_FEATURE_KINDS = {
  'primitive.add': 'primitive',
  'sketch.add': 'sketch',
  'feature.extrude': 'extrude',
  'feature.revolve': 'revolve',
  'feature.loft': 'loft',
  'feature.sweep': 'sweep',
  'feature.helical-sweep': 'helical-sweep',
  'feature.boolean': 'boolean',
  'feature.transform': 'transform',
  'feature.mirror': 'mirror',
  'feature.split': 'split',
  'feature.datum-plane': 'datum-plane',
  'feature.datum-axis': 'datum-axis',
  'feature.hole': 'hole',
  'feature.gear': 'gear',
  'feature.thread': 'thread',
  'feature.shell': 'shell',
  'feature.solid-offset': 'solid-offset',
  'feature.draft': 'draft',
  'feature.thicken': 'thicken',
  'feature.direct-edit': 'direct-edit',
  'feature.fillet': 'fillet',
  'feature.chamfer': 'chamfer',
  'feature.pattern': 'pattern',
  'import.mesh': 'imported-mesh',
  'import.step': 'imported-step'
} as const satisfies Readonly<Record<string, FeatureKind>>;

/** The enums a feature of `kind` defines, if `kind` is a feature kind. */
function featureDataEnums(
  kind: unknown
): ReadonlyMap<string, ReadonlySet<string>> | undefined {
  return typeof kind === 'string' && Object.hasOwn(FEATURE_DATA_ENUMS, kind)
    ? FEATURE_DATA_ENUMS[kind as FeatureKind]
    : undefined;
}

/**
 * Each feature enum's values across every feature kind that defines it. A
 * stored `feature.update` whose target feature is no longer known (removed
 * since, or judged without its document) is held to these: a string there
 * must be a value the field has on some feature. A non-string is left alone,
 * since the same name is an object on other kinds (a gear's `axis` vector, a
 * direct edit's `operation`, an extrude's `profile` reference).
 */
const FEATURE_UPDATE_FALLBACK_ENUMS: ReadonlyMap<
  string,
  ReadonlySet<string>
> = (() => {
  const union = new Map<string, Set<string>>();
  for (const fields of Object.values(FEATURE_DATA_ENUMS))
    for (const [field, members] of fields)
      for (const member of members)
        (union.get(field) ?? union.set(field, new Set()).get(field)!).add(
          member
        );
  return union;
})();

/** The enums the document itself defines. */
const DOCUMENT_ENUMS = enumsOf<ProjectDocument>({ units: UNIT_SYSTEMS });

/** The enums a project node (`kind: 'project'`) defines. */
const PROJECT_NODE_ENUMS = enumsOf<ProjectNode>({ units: UNIT_SYSTEMS });

/** A history change restoring the document's `units` holds a unit on each side. */
const UNITS_CHANGE_ENUMS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['before', UNIT_SYSTEMS],
  ['after', UNIT_SYSTEMS]
]);

/** The enums a body node (`kind: 'body'`) defines. */
const BODY_NODE_ENUMS = enumsOf<BodyNode>({
  bodyType: valuesOf<BodyNode['bodyType']>({
    solid: true,
    'mesh-reference': true
  }),
  representationSource: new Set([
    ...valuesOf<BodyNode['representationSource']>({
      brep: true,
      'step-import': true,
      'mesh-import': true
    }),
    ...LEGACY_REPRESENTATION_SOURCES
  ])
});

/** The enums a text sketch object's data (`objectKind: 'text'`) defines. */
const TEXT_OBJECT_ENUMS = enumsOf<
  Extract<SketchObjectData, { objectKind: 'text' }>
>({
  fontStyle: valuesOf<TextFontStyle>({
    regular: true,
    bold: true,
    italic: true,
    boldItalic: true
  })
});

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
 * The schema objects whose fields the walk knows by position: the document,
 * the containers below it that hold id-keyed maps, its edit history, and
 * stored commands with their payloads.
 */
type Shape =
  | 'document'
  | 'derived'
  | 'sketchGeometry'
  | 'objectFolders'
  | 'assembly'
  | 'assemblyPosition'
  | 'assemblyPose'
  | 'history'
  | 'historyEntry'
  | 'change'
  | 'command'
  | 'featureUpdate'
  | 'featureUpdateData';

/**
 * Where a value sits in the schema: a known schema object (`shape`), or a map
 * keyed by ids (`idMap`). A map's keys are ids, not properties, so an id
 * spelled like a field (a node "primitiveKind", a constraint "metadata") is
 * never read as that field; `entryField` names what the map's string values
 * are, if they are ids.
 */
interface Position {
  shape?: Shape;
  idMap?: { entryField?: string };
  /** The schema property the value is judged as, when not its own key. */
  field?: string;
}

const ID_MAP: Position = { idMap: {} };

/** The fields of each known schema object that hold a known position. */
const FIELD_POSITIONS: Readonly<
  Partial<Record<Shape, Readonly<Record<string, Position>>>>
> = {
  // ProjectDocument
  document: {
    nodes: ID_MAP,
    assets: ID_MAP,
    shaprImports: ID_MAP,
    commandLog: { shape: 'command' },
    editHistory: { shape: 'history' },
    derived: { shape: 'derived' },
    objectFolders: { shape: 'objectFolders' },
    assembly: { shape: 'assembly' }
  },
  // DerivedState
  derived: {
    bodyRepresentations: ID_MAP,
    datumFrames: ID_MAP,
    datumAxes: ID_MAP,
    sketchProjections: ID_MAP,
    sketchGeometry: { shape: 'sketchGeometry' }
  },
  sketchGeometry: { objects: ID_MAP },
  // ObjectFolderSet: body id -> folder id
  objectFolders: { placements: { idMap: { entryField: 'folderId' } } },
  // AssemblySet, AssemblyPosition and the assembly.position.save payload
  assembly: { positions: { shape: 'assemblyPosition' } },
  assemblyPosition: { values: ID_MAP },
  // The assembly.pose.set payload
  assemblyPose: { values: ID_MAP, placements: ID_MAP },
  // DocumentHistory and its entries
  history: { entries: { shape: 'historyEntry' } },
  historyEntry: { changes: { shape: 'change' } },
  // The feature.update payload
  featureUpdate: { data: { shape: 'featureUpdateData' } }
};

/** Stored command payloads that hold id-keyed maps or further commands. */
const PAYLOAD_POSITIONS: Readonly<Record<string, Position>> = {
  transaction: { shape: 'command' },
  'feature.update': { shape: 'featureUpdate' },
  'assembly.pose.set': { shape: 'assemblyPose' },
  'assembly.position.save': { shape: 'assemblyPosition' }
};

/**
 * The position of a document field's value, or of one entry of it when
 * `key` names that entry: a keyed history change on `nodes` holds one node
 * snapshot, an unkeyed one the whole node map.
 */
function documentFieldPosition(field: unknown, key?: unknown): Position {
  if (typeof field !== 'string' || typeof key === 'string') return {};
  const document = FIELD_POSITIONS.document!;
  return Object.hasOwn(document, field) ? document[field]! : {};
}

/** The position of `record[key]`, from the schema object `record` is. */
function childPosition(
  shape: Shape | undefined,
  record: Readonly<Record<string, unknown>>,
  key: string
): Position {
  if (shape === 'command' && key === 'payload')
    return typeof record.kind === 'string' &&
      Object.hasOwn(PAYLOAD_POSITIONS, record.kind)
      ? PAYLOAD_POSITIONS[record.kind]!
      : {};
  // A history change restores a document field: judged as that field.
  if (shape === 'change' && (key === 'before' || key === 'after'))
    return typeof record.field === 'string'
      ? {
          ...documentFieldPosition(record.field, record.key),
          field: record.field
        }
      : {};
  // A sketch node, live or a history snapshot: constraint id -> position.
  if (record.kind === 'sketch' && key === 'dimensionLabelPositions')
    return ID_MAP;
  const fields = shape === undefined ? undefined : FIELD_POSITIONS[shape];
  return fields && Object.hasOwn(fields, key) ? fields[key]! : {};
}

/**
 * Whether `record` is where a freeform field really lives: node `metadata`
 * sits on a node, a node snapshot or a metadata command (they name a `kind`
 * or a `nodeId`); primitive `dimensions` sit on primitive feature data or a
 * primitive command (they name a `primitiveKind` or a `featureKind`), or on
 * the `data` of a stored `feature.update` command, which may carry
 * `dimensions` alone. `record` is never an id-keyed map here.
 */
function ownsFreeformField(
  record: Readonly<Record<string, unknown>>,
  key: string,
  shape: Shape | undefined
): boolean {
  if (key === 'metadata')
    return typeof record.kind === 'string' || typeof record.nodeId === 'string';
  if (key === 'dimensions')
    return (
      typeof record.primitiveKind === 'string' ||
      typeof record.featureKind === 'string' ||
      shape === 'featureUpdateData'
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

interface WalkEntry {
  value: unknown;
  /** The property or map key `value` sits under, for the refusal's path. */
  label: string | undefined;
  /**
   * The schema property `value` sits under. A map entry has none: its key is
   * an id, so only the map's `entryField` says what its value is.
   */
  field: string | undefined;
  parent: WalkEntry | null;
  freeform: boolean;
  shape?: Shape;
  idMap?: { entryField?: string };
  /** The union this value must belong to, when its owner defines one. */
  members?: ReadonlySet<string>;
  /** `members` binds only a string value: other types are left alone. */
  membersIfString?: boolean;
}

/** The enums a record defines; `loose` holds only its strings to them. */
interface OwnedEnums {
  fields: ReadonlyMap<string, ReadonlySet<string>>;
  loose?: boolean;
}

/** Feature id -> feature kind, for the features a document knows of. */
export type FeatureKinds = ReadonlyMap<string, FeatureKind>;
type FeatureKindOf = (featureId: string) => FeatureKind | undefined;

function indexFeatureNode(into: Map<string, FeatureKind>, node: unknown): void {
  if (
    !isDocumentRecord(node) ||
    node.kind !== 'feature' ||
    typeof node.featureId !== 'string'
  )
    return;
  const kind = isDocumentRecord(node.data)
    ? node.data.featureKind
    : node.featureKind;
  if (typeof kind === 'string' && FEATURE_KINDS.has(kind))
    into.set(node.featureId, kind as FeatureKind);
}

function indexNodeMap(into: Map<string, FeatureKind>, nodes: unknown): void {
  if (isDocumentRecord(nodes))
    for (const node of Object.values(nodes)) indexFeatureNode(into, node);
}

/** The features stored creation commands create, transactions included. */
function indexCommands(
  into: Map<string, FeatureKind>,
  commands: unknown,
  depth = 0
): void {
  if (!Array.isArray(commands) || depth > MAX_DOCUMENT_DEPTH) return;
  for (const command of commands) {
    if (!isDocumentRecord(command) || typeof command.kind !== 'string')
      continue;
    if (command.kind === 'transaction') {
      indexCommands(into, command.payload, depth + 1);
      continue;
    }
    const payload = command.payload;
    if (
      Object.hasOwn(COMMAND_FEATURE_KINDS, command.kind) &&
      isDocumentRecord(payload) &&
      isDocumentRecord(payload.ids) &&
      typeof payload.ids.featureId === 'string'
    )
      into.set(
        payload.ids.featureId,
        COMMAND_FEATURE_KINDS[
          command.kind as keyof typeof COMMAND_FEATURE_KINDS
        ]
      );
  }
}

/** The node snapshots and command lists one history change restores. */
function indexHistoryChange(
  into: Map<string, FeatureKind>,
  change: unknown
): void {
  if (!isDocumentRecord(change)) return;
  for (const side of [change.before, change.after]) {
    if (change.field === 'commandLog') indexCommands(into, side);
    else if (change.field === 'nodes') {
      if (change.key === undefined) indexNodeMap(into, side);
      else indexFeatureNode(into, side);
    }
  }
}

/**
 * The kind of every feature `document` knows of: its live feature nodes,
 * the features its stored commands create, and those its edit history
 * restores. Live nodes win.
 */
function indexDocument(
  into: Map<string, FeatureKind>,
  document: unknown
): void {
  if (!isDocumentRecord(document)) return;
  const history = document.editHistory;
  if (isDocumentRecord(history) && Array.isArray(history.entries))
    for (const entry of history.entries)
      if (isDocumentRecord(entry) && Array.isArray(entry.changes))
        for (const change of entry.changes) indexHistoryChange(into, change);
  indexCommands(into, document.commandLog);
  indexNodeMap(into, document.nodes);
}

/**
 * The enums `record` defines, identified by what it is: the document (its
 * `units`), the `data` of a feature node (by its `featureKind`), a stored
 * creation command's payload (by the feature its kind creates), a
 * `feature.update` command's data (by the kind of the feature it changes), a
 * history change restoring `units`, a project node, a body node, or a text
 * sketch object's data. Any other record, a map or freeform data defines
 * none.
 */
function enumsOwnedBy(
  entry: WalkEntry,
  record: Readonly<Record<string, unknown>>,
  featureKindOf: FeatureKindOf
): OwnedEnums | undefined {
  const owned = (
    fields: ReadonlyMap<string, ReadonlySet<string>> | undefined
  ): OwnedEnums | undefined => fields && { fields };
  const parent = entry.parent;
  if (entry.shape === 'document') return owned(DOCUMENT_ENUMS);
  if (
    entry.field === 'data' &&
    parent &&
    !parent.idMap &&
    !parent.freeform &&
    isDocumentRecord(parent.value) &&
    parent.value.kind === 'feature'
  )
    return owned(featureDataEnums(record.featureKind));
  if (
    entry.field === 'payload' &&
    parent?.shape === 'command' &&
    isDocumentRecord(parent.value)
  ) {
    const kind = parent.value.kind;
    return typeof kind === 'string' &&
      Object.hasOwn(COMMAND_FEATURE_KINDS, kind)
      ? owned(
          featureDataEnums(
            COMMAND_FEATURE_KINDS[kind as keyof typeof COMMAND_FEATURE_KINDS]
          )
        )
      : undefined;
  }
  if (entry.shape === 'featureUpdateData') {
    // The kind of the feature it changes, else the kind the data names.
    const featureId = isDocumentRecord(parent?.value)
      ? parent.value.featureId
      : undefined;
    const kind =
      (typeof featureId === 'string' ? featureKindOf(featureId) : undefined) ??
      (typeof record.featureKind === 'string' &&
      FEATURE_KINDS.has(record.featureKind)
        ? record.featureKind
        : undefined);
    return kind !== undefined
      ? owned(featureDataEnums(kind))
      : { fields: FEATURE_UPDATE_FALLBACK_ENUMS, loose: true };
  }
  if (entry.shape === 'change' && record.field === 'units')
    return owned(UNITS_CHANGE_ENUMS);
  if (record.kind === 'project') return owned(PROJECT_NODE_ENUMS);
  if (record.kind === 'body') return owned(BODY_NODE_ENUMS);
  if (record.objectKind === 'text') return owned(TEXT_OBJECT_ENUMS);
  return undefined;
}

function walkIdentifiers(
  root: WalkEntry,
  featureKindOf: FeatureKindOf
): string | null {
  const path = (entry: WalkEntry): string => {
    const parts: string[] = [];
    for (let at: WalkEntry | null = entry; at; at = at.parent)
      if (at.label !== undefined) parts.unshift(at.label);
    return parts.join('.') || 'document';
  };
  const pending: WalkEntry[] = [root];
  while (pending.length) {
    const entry = pending.pop()!;
    const current = entry.value;
    // An enum field holds one member of its union, never another type.
    if (
      entry.members &&
      !entry.membersIfString &&
      current !== undefined &&
      typeof current !== 'string'
    )
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
      // A list keeps its position (a command log holds commands), except
      // where the schema expects a map: its items are no map entries.
      const item: Omit<WalkEntry, 'value'> = entry.idMap
        ? { ...entry, parent: entry, shape: undefined, idMap: undefined }
        : { ...entry, parent: entry };
      // Numbers hold no names; skipping them keeps dense persisted meshes
      // (an imported mesh's `number[]` payload) cheap to walk.
      for (const value of current)
        if (typeof value !== 'number') pending.push({ ...item, value });
      continue;
    }
    if (!isDocumentRecord(current) || ArrayBuffer.isView(current)) continue;
    if (entry.idMap && !entry.freeform) {
      // Map entries: the key is an id, checked as a key; the value is an
      // entry of the map, owned by no field of it.
      for (const key of Object.keys(current)) {
        if (RESERVED_RECORD_KEYS.has(key))
          return `"${path(entry)}" uses the reserved key "${key}".`;
        pending.push({
          value: current[key],
          label: key,
          field: entry.idMap.entryField,
          parent: entry,
          freeform: false
        });
      }
      continue;
    }
    const owned = entry.freeform
      ? undefined
      : enumsOwnedBy(entry, current, featureKindOf);
    for (const key of Object.keys(current)) {
      if (RESERVED_RECORD_KEYS.has(key))
        return `"${path(entry)}" uses the reserved key "${key}".`;
      if (entry.freeform) {
        pending.push({
          value: current[key],
          label: key,
          field: key,
          parent: entry,
          freeform: true
        });
        continue;
      }
      const freeform =
        FREEFORM_FIELDS.has(key) &&
        ownsFreeformField(current, key, entry.shape);
      const position = freeform ? {} : childPosition(entry.shape, current, key);
      pending.push({
        value: current[key],
        label: key,
        field: position.field ?? key,
        parent: entry,
        freeform,
        shape: position.shape,
        idMap: position.idMap,
        members: freeform ? undefined : owned?.fields.get(key),
        membersIfString: owned?.loose
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
 * Refuses a reserved name used where a document keeps a key, and an enum
 * value outside its union:
 * - any object key, everywhere (every map in a document, its history and its
 *   command payloads, freeform metadata included);
 * - outside freeform data (`FREEFORM_FIELDS`): any id field (see
 *   {@link isIdentifierField}), any selector such as a constraint's `point`
 *   (see `SELECTOR_FIELDS`) and any parameter name, including those in stored
 *   `parameter.*` commands;
 * - an enum field holding anything but a member of its union, where the
 *   record is the schema object that defines that enum (see
 *   {@link enumsOwnedBy}): never by a property name alone, so an id, a map
 *   entry or free text spelled like an enum field is not held to it.
 * The walk knows the schema position of what it visits (`FIELD_POSITIONS`):
 * the entries of id-keyed maps (`nodes`, the derived maps, folder
 * placements, joint values, a sketch's label positions), whole maps restored
 * by a history change, and stored command payloads.
 *
 * `value` is a whole document, or with `field` the value of that document
 * field (`commandLog`, a history change's bare `nodes` map or id), judged as
 * that field. Other strings, such as display names, descriptions and
 * metadata values, are not keys and may be anything. A stored
 * `feature.update` is judged by the kind of the feature it changes, looked
 * up in the document (`value` itself when whole, else `document`, the one
 * the field belongs to) and in what `value` creates.
 */
export function reservedIdentifierError(
  value: unknown,
  field?: string,
  document?: unknown
): string | null {
  const position: Position =
    field === undefined ? { shape: 'document' } : documentFieldPosition(field);
  const features = new Map<string, FeatureKind>();
  if (field === undefined) indexDocument(features, value);
  else {
    indexDocument(features, document);
    if (field === 'commandLog') indexCommands(features, value);
    else if (field === 'nodes') indexNodeMap(features, value);
  }
  return walkIdentifiers(
    {
      value,
      label: field,
      field,
      parent: null,
      freeform: field !== undefined && FREEFORM_FIELDS.has(field),
      shape: position.shape,
      idMap: position.idMap,
      members: field === 'units' ? UNIT_SYSTEMS : undefined
    },
    (featureId) => features.get(featureId)
  );
}

/**
 * The kind of every feature `document` knows of (its feature nodes, the
 * features its stored commands create and those its edit history restores),
 * by feature id, for {@link historyChangeIdentifierError}. `document` may be
 * a partial one, such as `{ editHistory }`.
 */
export function documentFeatureKinds(document: unknown): FeatureKinds {
  const features = new Map<string, FeatureKind>();
  indexDocument(features, document);
  return features;
}

/**
 * {@link reservedIdentifierError} for one edit-history change: its `before`
 * and `after` are judged by the change's `field` and `key` (one node
 * snapshot, a whole node map, a command list or a bare id). A stored
 * `feature.update` it restores is judged by the kind of its feature in
 * `features` (see {@link documentFeatureKinds}) or in the change itself.
 */
export function historyChangeIdentifierError(
  change: unknown,
  features: FeatureKinds = new Map()
): string | null {
  const own = new Map<string, FeatureKind>();
  indexHistoryChange(own, change);
  return walkIdentifiers(
    {
      value: change,
      label: undefined,
      field: undefined,
      parent: null,
      freeform: false,
      shape: 'change'
    },
    (featureId) => features.get(featureId) ?? own.get(featureId)
  );
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
