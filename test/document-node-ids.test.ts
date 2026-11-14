import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchConstraint,
  addSketchObjects,
  addSketchFeature,
  assertSafeDocumentIdentifiers,
  assertStorableDocument,
  createBodyFeatureIds,
  createProjectDocument,
  documentIdentifierError,
  findSketch,
  evaluateExpression,
  getNode,
  getParameterScope,
  isLiveAssemblyBody,
  normalizeDocument,
  patternBody,
  renameNode,
  reservedDocumentIdentifierError,
  setNodeMetadata,
  setParameter,
  setParameterDescription,
  UnstorableDocumentError
} from '@openzcad/document-core';
import {
  COMMAND_CREATED_FEATURE_KINDS,
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  COMMAND_FEATURE_KINDS,
  documentEnvelopeError,
  drawingPaperPerModelUnit,
  isDocumentHistory,
  millimetresPerUnit,
  ownEntry,
  reservedIdentifierError,
  toBodyId,
  toUserId,
  type EntityId,
  type ProjectDocument,
  type SerializedCommand,
  type SketchConstraintId,
  type UnitSystem
} from '@openzcad/shared';
import {
  solveSketchWithGcs,
  type GcsKernelSurface
} from '../packages/kernel-adapter/src/gcs-sketch';

const owner = toUserId('user_node_ids');
const RESERVED = ['__proto__', 'constructor', 'prototype', 'toString'] as const;

function valid(): ProjectDocument {
  return addPrimitiveFeature(createProjectDocument('Node ids', owner), {
    name: 'Box',
    primitiveKind: 'box',
    dimensions: { width: 1, height: 1, depth: 1 }
  });
}

interface NodeJson {
  id?: unknown;
  parentId?: unknown;
  activePartId?: unknown;
  childIds: unknown[];
}
interface DocumentJson {
  rootNodeId: string;
  rootAssemblyId: string;
  activePartId: string;
  nodes: Record<string, NodeJson>;
}

/** A document as `JSON.parse` returns it from storage, a backup or a peer. */
function received(edit: (json: DocumentJson) => void): unknown {
  const json = JSON.parse(JSON.stringify(valid())) as DocumentJson;
  edit(json);
  return JSON.parse(JSON.stringify(json));
}

/** Rename a node key by rewriting the JSON text, so `__proto__` stays an own key. */
function withNodeKey(id: string): unknown {
  const document = valid();
  const partId = document.activePartId;
  const text = JSON.stringify(document).replaceAll(
    JSON.stringify(partId),
    JSON.stringify(id)
  );
  return JSON.parse(text) as unknown;
}

function refusal(value: unknown): string {
  try {
    assertStorableDocument(value);
  } catch (error) {
    expect(error).toBeInstanceOf(UnstorableDocumentError);
    return (error as Error).message;
  }
  throw new Error('The document was accepted.');
}

const prototypeNames = () => Object.getOwnPropertyNames(Object.prototype);

afterEach(() => {
  // Nothing in this file may leave a member on the shared prototype.
  expect(({} as Record<string, unknown>).name).toBeUndefined();
  expect(({} as Record<string, unknown>).metadata).toBeUndefined();
});

describe('document node ids', () => {
  it('still accepts every generated node id and reference', () => {
    const document = valid();
    expect(documentEnvelopeError(document)).toBeNull();
    expect(assertStorableDocument(document).activePartId).toBe(
      document.activePartId
    );
  });

  it.each(RESERVED)('refuses a document whose node is keyed "%s"', (id) => {
    const value = withNodeKey(id);
    expect(Object.hasOwn((value as { nodes: object }).nodes, id)).toBe(true);
    expect(refusal(value)).toMatch(/reserved node id/);
    expect(documentEnvelopeError(value)).toMatch(/reserved node id/);
  });

  it('keeps accepting a child or parent that names a removed node', () => {
    const value = received((json) => {
      json.nodes[json.activePartId]!.childIds.push('ent_removed');
      json.nodes[json.activePartId]!.parentId = 'ent_removed_parent';
    });
    expect(() => assertStorableDocument(value)).not.toThrow();
  });

  it('refuses a node whose id is reserved under an ordinary key', () => {
    const value = received((json) => {
      json.nodes[json.activePartId]!.id = '__proto__';
    });
    expect(refusal(value)).toMatch(/invalid id/);
  });

  it.each([
    [
      'a child id inherited from Object.prototype',
      (json: DocumentJson) => {
        json.nodes[json.rootAssemblyId]!.childIds.push('constructor');
      },
      /invalid child id/
    ],
    [
      'a child id that is not a string',
      (json: DocumentJson) => {
        json.nodes[json.rootAssemblyId]!.childIds.push(7);
      },
      /invalid child id/
    ],
    [
      'an active part that names no node',
      (json: DocumentJson) => {
        json.activePartId = 'ent_missing';
      },
      /document\.activePartId/
    ],
    [
      'an inherited active part',
      (json: DocumentJson) => {
        json.activePartId = 'toString';
      },
      /document\.activePartId/
    ],
    [
      'an inherited root assembly',
      (json: DocumentJson) => {
        json.rootAssemblyId = 'hasOwnProperty';
      },
      /document\.rootAssemblyId/
    ],
    [
      'an inherited parent',
      (json: DocumentJson) => {
        json.nodes[json.activePartId]!.parentId = 'valueOf';
      },
      /invalid parent id/
    ],
    [
      'the project node naming an inherited active part',
      (json: DocumentJson) => {
        json.nodes[json.rootNodeId]!.activePartId = 'constructor';
      },
      /active part that is not in the project/
    ]
  ])('refuses %s', (_case, edit, message) => {
    expect(refusal(received(edit))).toMatch(message);
  });

  it('refuses undo history that restores a node under a reserved key', () => {
    const document = valid();
    const history = {
      schemaVersion: 1,
      projectId: document.projectId,
      actorUserId: owner,
      entries: [
        {
          id: 'entry_1',
          label: 'Edit',
          changes: [
            {
              kind: 'value',
              field: 'nodes',
              key: 'ent_ok',
              after: { id: 'ent_ok' }
            }
          ]
        }
      ],
      cursor: 1,
      trimmed: 0
    };
    expect(isDocumentHistory(history, document.projectId)).toBe(true);
    for (const id of RESERVED) {
      const keyed = JSON.parse(
        JSON.stringify(history).replace('"ent_ok"', JSON.stringify(id))
      ) as unknown;
      expect(isDocumentHistory(keyed, document.projectId)).toBe(false);
      const whole = JSON.parse(
        JSON.stringify({
          ...history,
          entries: [
            {
              id: 'entry_1',
              label: 'Edit',
              changes: [
                { kind: 'value', field: 'nodes', after: { ent_ok: {} } }
              ]
            }
          ]
        }).replace('"ent_ok"', JSON.stringify(id))
      ) as unknown;
      expect(isDocumentHistory(whole, document.projectId)).toBe(false);
    }
  });

  it('never resolves an inherited member as a node', () => {
    const document = valid();
    for (const id of [...RESERVED, 'hasOwnProperty']) {
      expect(getNode(document, id)).toBeUndefined();
      expect(ownEntry(document.nodes, id)).toBeUndefined();
    }
    expect(getNode(document, document.activePartId)?.kind).toBe('part');
  });

  it('leaves Object.prototype untouched when a mutator is given a reserved id', () => {
    const before = prototypeNames();
    // structuredClone (inside every mutator) drops a prototype that an
    // assignment to `nodes.__proto__` would have set, so the lookup must not
    // fall through to Object.prototype either.
    const document = structuredClone(valid());
    for (const nodeId of [...RESERVED, 'valueOf']) {
      expect(() => renameNode(document, { nodeId, name: 'Renamed' })).toThrow(
        /not found/
      );
      expect(() =>
        setNodeMetadata(document, { nodeId, metadata: { tint: 'red' } })
      ).toThrow(/not found/);
    }
    expect(prototypeNames()).toEqual(before);
    expect(({} as Record<string, unknown>).tint).toBeUndefined();
  });

  it('refuses to normalize a node map with a reserved key', () => {
    const value = withNodeKey('__proto__') as ProjectDocument;
    expect(() => normalizeDocument(value)).toThrow(/reserved node id/);
  });
});

/** A history whose one entry holds `changes`, as storage returns it. */
function historyOf(document: ProjectDocument, changes: unknown[]): unknown {
  return JSON.parse(
    JSON.stringify({
      schemaVersion: 1,
      projectId: document.projectId,
      actorUserId: owner,
      entries: [{ id: 'entry_1', label: 'Edit', changes }],
      cursor: 1,
      trimmed: 0
    })
  ) as unknown;
}

/** `value` serialized with `placeholder` replaced by `id`, kept as an own key. */
function withName(value: unknown, placeholder: string, id: string): unknown {
  return JSON.parse(
    JSON.stringify(value).replaceAll(
      JSON.stringify(placeholder),
      JSON.stringify(id)
    )
  ) as unknown;
}

describe('ids that key other document maps', () => {
  it.each(RESERVED)('refuses a body whose body id is "%s"', (id) => {
    const document = valid();
    const value = withName(document, document.bodyOrder[0]!, id);
    expect(refusal(value)).toMatch(/reserved id/);
  });

  it('never reports an inherited member as a live assembly body', () => {
    const document = valid();
    for (const id of [...RESERVED, 'hasOwnProperty'])
      expect(isLiveAssemblyBody(document, toBodyId(id))).toBe(false);
  });

  it.each(RESERVED)('refuses "%s" as a parameter name', (name) => {
    const document = valid();
    expect(() => setParameter(document, { name, expression: '5' })).toThrow(
      /not a valid parameter name/
    );
    const manager = new CommandManager(document);
    expect(() =>
      manager.execute(commandFactories.setParameter({ name, expression: '5' }))
    ).toThrow();
    expect(manager.document).toBe(document);
  });

  it('refuses a stored parameter or parameter command with a reserved name', () => {
    const named = setParameter(valid(), { name: 'width', expression: '5' });
    expect(() => assertStorableDocument(named)).not.toThrow();
    expect(refusal(withName(named, 'width', '__proto__'))).toMatch(
      /reserved (parameter name|key)/
    );
    const logged = {
      ...valid(),
      commandLog: [
        {
          kind: 'parameter.set',
          payload: { name: 'width', expression: '5' },
          replayVersion: 1,
          label: 'Set parameter',
          timestamp: new Date(0).toISOString()
        }
      ]
    };
    expect(refusal(withName(logged, 'width', 'constructor'))).toMatch(
      /reserved parameter name/
    );
  });

  it('never resolves an inherited member in an expression', () => {
    const { scope } = getParameterScope(valid());
    for (const name of ['constructor', 'toString', 'valueOf'])
      expect(() => evaluateExpression(name, scope)).toThrow(
        /Unknown identifier/
      );
  });

  it('never reads an inherited member as a unit suffix', () => {
    const { scope } = getParameterScope(valid());
    for (const suffix of ['constructor', 'toString', '__proto__'])
      expect(() =>
        evaluateExpression(`1 ${suffix}`, scope, { documentUnits: 'mm' })
      ).toThrow(/trailing tokens/);
    expect(evaluateExpression('1 cm', scope, { documentUnits: 'mm' })).toBe(10);
  });

  it('refuses a reserved key in any document map', () => {
    const document = valid();
    const nodeId = document.activePartId;
    const value = JSON.parse(
      JSON.stringify(document).replace(
        `"${nodeId}":{`,
        `"${nodeId}":{"metadata":{"__proto__":{"polluted":true}},`
      )
    ) as unknown;
    expect(refusal(value)).toMatch(/reserved key "__proto__"/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('accepts display names that match a reserved name', () => {
    // Display names are not keys: a part may be called "constructor".
    const base = valid();
    const document = renameNode(base, {
      nodeId: base.activePartId,
      name: 'constructor'
    });
    expect(reservedIdentifierError(document)).toBeNull();
    expect(() => assertStorableDocument(document)).not.toThrow();
  });
});

describe('undo history references', () => {
  it.each(['activePartId', 'rootNodeId', 'rootAssemblyId'])(
    'refuses a %s change that restores a reserved name',
    (field) => {
      const document = valid();
      const ok = historyOf(document, [
        {
          kind: 'value',
          field,
          before: document.activePartId,
          after: document.activePartId
        }
      ]);
      expect(isDocumentHistory(ok, document.projectId)).toBe(true);
      for (const id of RESERVED) {
        const bad = historyOf(document, [
          { kind: 'value', field, before: id, after: document.activePartId }
        ]);
        expect(isDocumentHistory(bad, document.projectId)).toBe(false);
      }
    }
  );

  it('refuses a node snapshot whose references use a reserved name', () => {
    const document = valid();
    const part = document.nodes[document.activePartId]!;
    for (const snapshot of [
      { ...part, parentId: '__proto__' },
      { ...part, childIds: ['constructor'] },
      { ...part, metadata: JSON.parse('{"__proto__":{"x":1}}') as unknown }
    ]) {
      const history = historyOf(document, [
        {
          kind: 'value',
          field: 'nodes',
          key: document.activePartId,
          before: snapshot,
          after: part
        }
      ]);
      expect(isDocumentHistory(history, document.projectId)).toBe(false);
    }
    const order = historyOf(document, [
      {
        kind: 'splice',
        field: 'featureOrder',
        index: 0,
        before: ['__proto__'],
        after: []
      }
    ]);
    expect(isDocumentHistory(order, document.projectId)).toBe(false);
  });

  it('refuses to publish an undo that restores a reserved reference', () => {
    const document = valid();
    const manager = new CommandManager(document);
    // A history built in memory is trusted by the manager, so the restored
    // document itself is checked before undo publishes it.
    const tampered = {
      ...document,
      editHistory: {
        schemaVersion: 1,
        projectId: document.projectId,
        actorUserId: owner,
        entries: [
          {
            id: 'entry_1',
            label: 'Edit',
            changes: [
              {
                kind: 'value',
                field: 'activePartId',
                before: '__proto__',
                after: document.activePartId
              }
            ]
          }
        ],
        cursor: 1,
        trimmed: 0
      }
    } as unknown as ProjectDocument;
    manager.document = tampered;
    expect(() => manager.undo()).toThrow(/Undo refused/);
    expect(manager.document).toBe(tampered);
    expect(manager.document.activePartId).toBe(document.activePartId);
  });
});

describe('supplied creation ids', () => {
  const box = {
    name: 'Box',
    primitiveKind: 'box' as const,
    dimensions: { width: 1, height: 1, depth: 1 }
  };
  const ids = {
    featureId: 'feat_supplied',
    featureNodeId: 'ent_supplied_feature',
    bodyId: 'body_supplied',
    bodyNodeId: 'ent_supplied_body'
  };
  const stored = (payload: unknown): SerializedCommand => ({
    kind: 'primitive.add',
    payload,
    replayVersion: 1,
    label: 'Add box',
    timestamp: new Date(0).toISOString()
  });

  it('still accepts ordinary supplied ids', () => {
    const document = addPrimitiveFeature(valid(), {
      ...box,
      ids: ids as never
    });
    expect(getNode(document, 'ent_supplied_feature')?.kind).toBe('feature');
  });

  it.each(['featureNodeId', 'bodyNodeId', 'featureId', 'bodyId'] as const)(
    'refuses a reserved %s before writing anything',
    (field) => {
      const document = valid();
      for (const id of RESERVED) {
        const input = { ...box, ids: { ...ids, [field]: id } as never };
        expect(() => addPrimitiveFeature(document, input)).toThrow(/reserved/);
        const manager = new CommandManager(document);
        expect(() =>
          manager.execute(commandFactories.addPrimitive(input))
        ).toThrow(/reserved/);
        expect(manager.document).toBe(document);
      }
    }
  );

  it('checks bulk sketch object ids once, not once per object', () => {
    const { document, sketchId } = addSketchFeature(
      createProjectDocument('Bulk', owner),
      {
        name: 'Profile',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [{ objectKind: 'line', x1: 0, y1: 0, x2: 1, y2: 0 }]
      }
    );
    const count = 400;
    const objects = Array.from({ length: count }, (_, index) => ({
      objectKind: 'line' as const,
      x1: index,
      y1: 0,
      x2: index,
      y2: 1
    }));
    let reads = 0;
    const objectNodeIds = new Proxy(
      Array.from({ length: count }, (_, index) => `ent_bulk_${index}`),
      {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
          return Reflect.get(target, key, receiver) as unknown;
        }
      }
    ) as EntityId[];
    const { objectNodeIds: added } = addSketchObjects(document, {
      sketchId,
      objects,
      ids: { objectNodeIds }
    });
    expect(added).toHaveLength(count);
    // One pass to check the ids and one to assign them; re-checking the
    // whole list for each object would read it count × count times.
    expect(reads).toBeLessThanOrEqual(2 * count);
    const forged = [...objectNodeIds];
    forged[count - 1] = '__proto__' as EntityId;
    expect(() =>
      addSketchObjects(document, {
        sketchId,
        objects,
        ids: { objectNodeIds: forged }
      })
    ).toThrow(/reserved/);
  });

  it('refuses a supplied id that is not a string', () => {
    expect(() =>
      addPrimitiveFeature(valid(), {
        ...box,
        ids: { ...ids, featureNodeId: 7 } as never
      })
    ).toThrow(/must be a string/);
  });

  it('refuses a stored creation command with a reserved id, nested or not', () => {
    const base = valid();
    const command = stored({ ...box, ids: { ...ids, featureNodeId: 'x' } });
    const transaction: SerializedCommand = {
      kind: 'transaction',
      payload: [command],
      replayVersion: 1,
      label: 'Batch',
      timestamp: new Date(0).toISOString()
    };
    for (const log of [[command], [transaction]]) {
      const document = withName(
        { ...base, commandLog: [...base.commandLog, ...log] },
        'x',
        '__proto__'
      );
      expect(refusal(document)).toMatch(/reserved id "__proto__"/);
      const replayed = withName(log, 'x', '__proto__') as SerializedCommand[];
      expect(() =>
        replayCommands(createProjectDocument('Replay', owner), replayed)
      ).toThrow(/reserved id "__proto__"/);
    }
    expect(prototypeNames()).not.toContain('kind');
  });
});

describe('derived projections', () => {
  /** A received document carrying a forged projection under `bodyKey`. */
  function withProjection(
    bodyKey: string,
    representation: Record<string, unknown>,
    exportableBodyIds: string[] = []
  ): unknown {
    const document = valid();
    const placeholder = 'projection_body_placeholder';
    return withName(
      {
        ...document,
        derived: {
          ...document.derived,
          bodyRepresentations: { [placeholder]: representation },
          exportableBodyIds
        }
      },
      placeholder,
      bodyKey
    );
  }
  const representation = (bodyId: string, extra = {}) => ({
    bodyId,
    name: 'Box',
    mesh: { kind: 'mesh', vertices: [], indices: [] },
    ...extra
  });

  it.each(RESERVED)('refuses a projection keyed by "%s"', (id) => {
    expect(refusal(withProjection(id, representation('ent_body')))).toMatch(
      /bodyRepresentations" uses the reserved key/
    );
  });

  it('refuses a reserved body id, exportable id or picking reference', () => {
    expect(
      refusal(withProjection('ent_body', representation('constructor')))
    ).toMatch(/reserved id "constructor"/);
    expect(
      refusal(
        withProjection('ent_body', representation('ent_body'), ['__proto__'])
      )
    ).toMatch(/exportableBodyIds/);
    const topology = {
      faces: [
        {
          topologyId: 'face_1',
          reference: { kind: 'face', featureId: 'toString' }
        }
      ],
      edges: []
    };
    expect(
      refusal(
        withProjection('ent_body', representation('ent_body', { topology }))
      )
    ).toMatch(/reserved id "toString"/);
    const mesh = {
      kind: 'mesh',
      vertices: [],
      indices: [],
      reference: { featureId: 'valueOf' }
    };
    expect(
      refusal(withProjection('ent_body', representation('ent_body', { mesh })))
    ).toMatch(/reserved id "valueOf"/);
  });

  it('keeps accepting a live projection with typed-array meshes', () => {
    const document = valid();
    const bodyId = document.bodyOrder[0]!;
    const live = {
      ...document,
      derived: {
        ...document.derived,
        bodyRepresentations: {
          [bodyId]: {
            ...representation(bodyId),
            mesh: {
              kind: 'mesh',
              vertices: new Float32Array(9),
              indices: new Uint32Array(3)
            }
          }
        },
        exportableBodyIds: [bodyId]
      }
    } as unknown as ProjectDocument;
    expect(() => assertStorableDocument(live)).not.toThrow();
    expect(reservedDocumentIdentifierError(live)).toBeNull();
  });
});

describe('sketch point selectors', () => {
  function sketchWithLineAndArc() {
    const { document, sketchId } = addSketchFeature(
      createProjectDocument('Selectors', owner),
      {
        name: 'Profile',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [
          { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
          {
            objectKind: 'arc',
            centerX: 20,
            centerY: 0,
            radius: 5,
            startAngleDeg: 0,
            endAngleDeg: 90
          }
        ]
      }
    );
    const [line, arc] = findSketch(document, sketchId)!.objectIds;
    return { document, sketchId, line: line!, arc: arc! };
  }

  it.each([...RESERVED, 'middle'])(
    'refuses to add a constraint naming point "%s"',
    (point) => {
      const { document, sketchId, line, arc } = sketchWithLineAndArc();
      for (const objectId of [line, arc])
        expect(() =>
          addSketchConstraint(document, {
            sketchId,
            constraint: {
              constraintKind: 'coincident',
              a: { objectId, point: point as 'start' },
              b: { objectId: objectId === line ? arc : line, point: 'start' }
            }
          })
        ).toThrow(/start, end or center/);
    }
  );

  interface StoredSketchJson {
    nodes: Record<
      string,
      { kind: string; constraints?: { data: { a: { point: string } } }[] }
    >;
  }

  /** A stored coincident constraint, then its first point renamed. */
  function storedWithPoint(point: string): unknown {
    const { document, sketchId, line, arc } = sketchWithLineAndArc();
    const added = addSketchConstraint(document, {
      sketchId,
      constraint: {
        constraintKind: 'coincident',
        a: { objectId: line, point: 'end' },
        b: { objectId: arc, point: 'start' }
      }
    }).document;
    expect(() => assertStorableDocument(added)).not.toThrow();
    const json = JSON.parse(JSON.stringify(added)) as StoredSketchJson;
    const sketch = Object.values(json.nodes).find(
      (node) => node.kind === 'sketch' && node.constraints?.length
    )!;
    sketch.constraints![0]!.data.a.point = point;
    return json;
  }

  it.each(RESERVED)(
    'refuses a stored constraint naming point "%s"',
    (point) => {
      expect(refusal(storedWithPoint(point))).toMatch(
        new RegExp(`reserved id "${point}"`)
      );
    }
  );

  it('refuses a stored constraint with a point outside start, end and center', () => {
    expect(refusal(storedWithPoint('middle'))).toMatch(/invalid point "a"/);
  });

  it('refuses a reserved name in any enum-like selector, not in display text', () => {
    expect(reservedIdentifierError({ kind: 'toString' })).toMatch(/reserved/);
    expect(reservedIdentifierError({ featureKind: '__proto__' })).toMatch(
      /reserved/
    );
    expect(reservedIdentifierError({ axis: 'constructor' })).toMatch(
      /reserved/
    );
    expect(reservedIdentifierError({ name: 'toString' })).toBeNull();
    expect(reservedIdentifierError({ text: 'constructor' })).toBeNull();
  });

  it.each([...RESERVED, 'valueOf', 'middle'])(
    'never sends the solver anything but a point handle for "%s"',
    (point) => {
      let next = 0;
      const sent: string[] = [];
      const kernel: GcsKernelSurface = {
        gcsNew: () => ++next,
        gcsAddPoint: () => ++next,
        gcsAddLine: () => ++next,
        gcsAddCircle: () => ++next,
        gcsAddArc: () => ++next,
        gcsAddEllipse: () => ++next,
        gcsEllipseParams: () => new Float64Array(5),
        gcsAddConstraint: (_sketch, json) => {
          sent.push(json);
          return ++next;
        },
        gcsSolveDetailed: () => ({}),
        gcsPointPosition: () => new Float64Array(2),
        gcsCircleRadius: () => 1,
        gcsDof: () => 0
      };
      const line = (objectId: string, y: number) => ({
        objectId: objectId as EntityId,
        kind: 'line' as const,
        x1: 0,
        y1: y,
        x2: 10,
        y2: y
      });
      expect(() =>
        solveSketchWithGcs(
          kernel,
          [line('line_a', 0), line('line_b', 5)],
          [
            {
              constraintId: 'scon_1' as SketchConstraintId,
              data: {
                constraintKind: 'coincident',
                a: { objectId: 'line_a' as EntityId, point: point as 'start' },
                b: { objectId: 'line_b' as EntityId, point: 'start' }
              }
            }
          ],
          (value) => Number(value)
        )
      ).toThrow(/has no '.*' point to constrain/);
      expect(sent).toEqual([]);
    }
  );
});

describe('persisted enum selectors and freeform values', () => {
  /** A box, patterned twice along x. */
  function patterned(): ProjectDocument {
    const document = valid();
    return patternBody(document, {
      name: 'Row',
      targetBodyId: document.bodyOrder[0]!,
      patternKind: 'linear',
      count: 2,
      axis: 'x',
      spacing: 10
    }).document;
  }

  /** `document` as received, with one feature's data edited. */
  function withFeatureData(
    document: ProjectDocument,
    featureKind: string,
    edit: (data: Record<string, unknown>) => void
  ): unknown {
    const json = JSON.parse(JSON.stringify(document)) as {
      nodes: Record<
        string,
        { kind?: string; featureKind?: string; data: Record<string, unknown> }
      >;
    };
    const node = Object.values(json.nodes).find(
      (candidate) =>
        candidate.kind === 'feature' && candidate.featureKind === featureKind
    )!;
    edit(node.data);
    return JSON.parse(JSON.stringify(json));
  }

  it.each(RESERVED)(
    'refuses a stored refusal whose category is "%s"',
    (category) => {
      const value = JSON.parse(JSON.stringify(valid())) as {
        derived?: Record<string, unknown>;
      };
      value.derived = {
        ...(value.derived ?? {}),
        featureWarnings: [
          {
            kernelRefusal: { category, message: 'The kernel refused this.' }
          }
        ]
      };
      expect(reservedDocumentIdentifierError(value as object)).not.toBeNull();
    }
  );

  it.each([...RESERVED, 'valueOf', 'hexagon'])(
    'refuses a primitive whose primitiveKind is "%s"',
    (kind) => {
      const value = withFeatureData(valid(), 'primitive', (data) => {
        data.primitiveKind = kind;
      });
      expect(reservedDocumentIdentifierError(value as object)).toMatch(
        /primitiveKind" has the unknown value/
      );
      expect(refusal(value)).toMatch(/primitiveKind" has the unknown value/);
    }
  );

  it.each([...RESERVED, 'valueOf', 'spiral'])(
    'refuses a pattern whose patternKind is "%s"',
    (kind) => {
      const value = withFeatureData(patterned(), 'pattern', (data) => {
        data.patternKind = kind;
      });
      expect(reservedDocumentIdentifierError(value as object)).toMatch(
        /patternKind" has the unknown value/
      );
      expect(refusal(value)).toMatch(/patternKind" has the unknown value/);
    }
  );

  it.each([
    ['axis', 'constructor'],
    ['axis', 'w'],
    ['axis2', '__proto__']
  ])('refuses a pattern whose %s is "%s"', (field, axis) => {
    const value = withFeatureData(patterned(), 'pattern', (data) => {
      data[field] = axis;
    });
    expect(refusal(value)).toMatch(
      new RegExp(`${field}" has the unknown value`)
    );
  });

  it('still accepts every generated primitive and pattern', () => {
    for (const primitiveKind of [
      'box',
      'cylinder',
      'sphere',
      'cone',
      'torus'
    ] as const) {
      const document = addPrimitiveFeature(
        createProjectDocument('Kinds', owner),
        { name: 'Solid', primitiveKind, dimensions: {} }
      );
      expect(() => assertStorableDocument(document)).not.toThrow();
    }
    expect(() => assertStorableDocument(patterned())).not.toThrow();
  });

  it('refuses a forged primitiveKind in undo history or a stored command', () => {
    const manager = new CommandManager(createProjectDocument('Kinds', owner));
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      })
    );
    const commandLog = JSON.parse(
      JSON.stringify(manager.document.commandLog)
    ) as unknown;
    expect(JSON.stringify(commandLog)).toContain('"primitiveKind":"box"');
    manager.undo();
    // Only the redo snapshot and the stored command still hold the box.
    const stored = JSON.parse(JSON.stringify(manager.document)) as {
      editHistory: unknown;
    };
    expect(JSON.stringify(stored.editHistory)).toContain(
      '"primitiveKind":"box"'
    );
    const forge = (part: unknown) =>
      JSON.parse(
        JSON.stringify(part).replaceAll(
          '"primitiveKind":"box"',
          '"primitiveKind":"__proto__"'
        )
      ) as unknown;
    expect(
      refusal({ ...stored, editHistory: forge(stored.editHistory) })
    ).toMatch(/primitiveKind" has the unknown value "__proto__"/);
    expect(reservedIdentifierError(forge(commandLog), 'commandLog')).toMatch(
      /primitiveKind" has the unknown value "__proto__"/
    );
    const pattern = {
      kind: 'feature.pattern',
      payload: { patternKind: 'toString', axis: 'x' }
    };
    expect(reservedIdentifierError([pattern], 'commandLog')).toMatch(
      /patternKind" has the unknown value "toString"/
    );
  });

  it('accepts a reserved name as a metadata value, with its undo history', () => {
    const document = valid();
    const nodeId = document.activePartId;
    const direct = setNodeMetadata(document, {
      nodeId,
      metadata: { role: 'constructor' }
    });
    expect(() => assertStorableDocument(direct)).not.toThrow();
    expect(reservedDocumentIdentifierError(direct)).toBeNull();

    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.setNodeMetadata({
        nodeId,
        metadata: {
          role: 'constructor',
          kind: 'toString',
          point: 'valueOf',
          primitiveKind: '__proto__',
          sourceId: 'prototype'
        }
      })
    );
    const executed = manager.document;
    expect(JSON.stringify(executed.editHistory)).toContain(
      '"role":"constructor"'
    );
    manager.undo();
    const undone = manager.document;
    manager.redo();
    for (const stored of [executed, undone, manager.document]) {
      const received = JSON.parse(JSON.stringify(stored)) as ProjectDocument;
      expect(received.editHistory?.entries.length).toBeGreaterThan(0);
      expect(reservedDocumentIdentifierError(received)).toBeNull();
      expect(() => assertStorableDocument(received)).not.toThrow();
    }
    expect(getNode(manager.document, nodeId)?.metadata?.role).toBe(
      'constructor'
    );
  });

  it.each(['metadata', 'dimensions'])(
    'checks a node named "%s" like any other node',
    (nodeId) => {
      const json = JSON.parse(JSON.stringify(valid())) as {
        nodes: Record<
          string,
          { kind?: string; data?: Record<string, unknown> }
        >;
      };
      const [key, node] = Object.entries(json.nodes).find(
        ([, candidate]) =>
          candidate.kind === 'feature' &&
          candidate.data?.featureKind === 'primitive'
      )!;
      delete json.nodes[key];
      json.nodes[nodeId] = {
        ...node,
        id: nodeId,
        data: { ...node.data, primitiveKind: 'constructor' }
      } as never;
      expect(reservedDocumentIdentifierError(json as object)).not.toBeNull();
    }
  );

  it.each([null, false, 3, {}, ['box']])(
    'refuses a primitiveKind that is not a string (%j)',
    (kind) => {
      const value = withFeatureData(valid(), 'primitive', (data) => {
        data.primitiveKind = kind;
      });
      expect(reservedDocumentIdentifierError(value as object)).toMatch(
        /primitiveKind" must be one of its known values/
      );
    }
  );

  it('keeps a dimensions-only feature.update command free text', () => {
    const command = {
      kind: 'feature.update',
      label: 'Edit feature',
      replayVersion: 1,
      payload: {
        featureId: 'feature_1',
        data: { dimensions: { primitiveKind: 'width', width: '2 * width' } }
      }
    };
    expect(reservedDocumentIdentifierError({ commands: [command] })).toBeNull();
    expect(
      reservedDocumentIdentifierError({
        commands: [
          {
            kind: 'transaction',
            label: 'Edit',
            replayVersion: 1,
            payload: [command]
          }
        ]
      })
    ).toBeNull();
    // Where a command defines one, a primitiveKind is still checked: on a
    // creation payload and on the data a feature.update changes.
    expect(
      reservedIdentifierError(
        [
          {
            ...command,
            kind: 'primitive.add',
            payload: { name: 'Box', primitiveKind: 'width', dimensions: {} }
          }
        ],
        'commandLog'
      )
    ).toMatch(/primitiveKind" has the unknown value "width"/);
    expect(
      reservedIdentifierError(
        [
          {
            ...command,
            payload: {
              featureId: 'feature_1',
              data: { primitiveKind: 'width' }
            }
          }
        ],
        'commandLog'
      )
    ).toMatch(/primitiveKind" has the unknown value "width"/);
  });

  it.each(['primitiveKind', 'patternKind', 'bodyType'])(
    'accepts a node id spelled like an enum field ("%s")',
    (nodeId) => {
      const json = JSON.parse(JSON.stringify(valid())) as {
        nodes: Record<string, { kind?: string; id?: string }>;
      };
      const [key, node] = Object.entries(json.nodes).find(
        ([, candidate]) => candidate.kind === 'feature'
      )!;
      delete json.nodes[key];
      json.nodes[nodeId] = { ...node, id: nodeId };
      expect(reservedDocumentIdentifierError(json as object)).toBeNull();
      // Its history snapshot of the same map is accepted too.
      expect(
        reservedIdentifierError({ [nodeId]: json.nodes[nodeId] }, 'nodes')
      ).toBeNull();
    }
  );

  it('still refuses a reserved metadata key', () => {
    const value = received((json) => {
      const node = json.nodes[json.activePartId] as unknown as {
        metadata?: Record<string, unknown>;
      };
      node.metadata = { constructor: 'x' };
    });
    expect(refusal(value)).toMatch(/reserved key "constructor"/);
  });

  it('accepts reserved names as names, descriptions, notes and other text', () => {
    let document = setParameter(valid(), { name: 'width', expression: '5' });
    document = setParameterDescription(document, {
      name: 'width',
      description: 'constructor'
    });
    document = renameNode(document, {
      nodeId: document.activePartId,
      name: 'toString'
    });
    const value = withFeatureData(document, 'primitive', (data) => {
      (data.dimensions as Record<string, unknown>).width = 'valueOf';
    });
    expect(reservedDocumentIdentifierError(value as object)).toBeNull();
    expect(() => assertStorableDocument(value)).not.toThrow();
    for (const text of [
      { name: 'constructor' },
      { description: 'prototype' },
      { notes: 'toString' },
      { label: '__proto__' },
      { text: 'valueOf' },
      { expression: 'constructor' },
      { kind: 'note', text: 'hasOwnProperty' },
      { title: 'isPrototypeOf', caption: 'toLocaleString' }
    ])
      expect(reservedIdentifierError(text)).toBeNull();
  });
});

describe('documents from earlier writers', () => {
  /**
   * Written by the document-core writer at 8dcb1643b (7cfee9ed1^): two
   * primitives, a sketch extrusion, a union and a mesh import. Its bodies
   * carry the first spellings of `representationSource` (`mock`, `composite`
   * and `mesh-reference`), which no migration rewrites.
   */
  const firstWriter = (): Record<string, unknown> =>
    JSON.parse(
      readFileSync(
        'test/fixtures/legacy-documents/writer-8dcb1643b.json',
        'utf8'
      )
    ) as Record<string, unknown>;

  it('opens a document the first writer saved', () => {
    const document = firstWriter();
    expect(reservedDocumentIdentifierError(document)).toBeNull();
    // The identifier guard runs before normalization on every read.
    expect(() => assertSafeDocumentIdentifiers(document)).not.toThrow();
    const normalized = normalizeDocument(
      document as unknown as ProjectDocument
    );
    // Every check this guard adds, node references included. (Its mesh
    // import has no stored payload, which an older, separate check of
    // `assertStorableDocument` refuses.)
    expect(documentIdentifierError(normalized)).toBeNull();
  });

  it.each(['mock', 'native', 'composite', 'mesh-reference'])(
    'accepts the earlier representationSource "%s" on a current document',
    (source) => {
      const value = received((json) => {
        const body = Object.values(json.nodes).find(
          (node) => (node as { kind?: string }).kind === 'body'
        ) as unknown as Record<string, unknown>;
        body.representationSource = source;
      });
      expect(reservedDocumentIdentifierError(value as object)).toBeNull();
      expect(() => assertStorableDocument(value)).not.toThrow();
    }
  );

  it.each([...RESERVED, 'valueOf', 'hologram'])(
    'still refuses the representationSource "%s"',
    (source) => {
      const value = received((json) => {
        const body = Object.values(json.nodes).find(
          (node) => (node as { kind?: string }).kind === 'body'
        ) as unknown as Record<string, unknown>;
        body.representationSource = source;
      });
      expect(refusal(value)).toMatch(
        /representationSource" has the unknown value/
      );
    }
  );
});

describe('enum rules by schema position, not by property name', () => {
  /** Ids spelled like enum fields or freeform fields. */
  const ENUM_SPELLED_IDS = [
    'primitiveKind',
    'patternKind',
    'bodyType',
    'representationSource',
    'fontStyle',
    'metadata',
    'dimensions'
  ];

  type NodesJson = Record<string, Record<string, unknown>>;

  /** `valid()` as received, with its body node stored under `id`. */
  function withBodyNodeId(
    id: string,
    edit: (body: Record<string, unknown>) => void = () => {}
  ): { nodes: NodesJson } {
    const json = JSON.parse(JSON.stringify(valid())) as { nodes: NodesJson };
    const [key, body] = Object.entries(json.nodes).find(
      ([, node]) => node.kind === 'body'
    )!;
    delete json.nodes[key];
    const node = { ...body, id };
    edit(node);
    json.nodes[id] = node;
    return JSON.parse(JSON.stringify(json)) as { nodes: NodesJson };
  }

  it.each([
    'assets',
    'nodes',
    'shaprImports',
    'placements',
    'values',
    'objects',
    'dimensionLabelPositions',
    'sketchProjections'
  ])('checks a body node stored under the id "%s" like any other', (id) => {
    expect(reservedDocumentIdentifierError(withBodyNodeId(id))).toBeNull();
    expect(
      reservedDocumentIdentifierError(
        withBodyNodeId(id, (body) => {
          body.bodyType = 'constructor';
        })
      )
    ).toMatch(/bodyType" has the unknown value "constructor"/);
    expect(
      reservedDocumentIdentifierError(
        withBodyNodeId(id, (body) => {
          body.representationSource = 'hologram';
        })
      )
    ).toMatch(/representationSource" has the unknown value "hologram"/);
  });

  it('refuses bad enums on a body node stored under the id "assets"', () => {
    expect(
      refusal(
        withBodyNodeId('assets', (body) => {
          body.bodyType = 'constructor';
        })
      )
    ).toMatch(/assets\.bodyType" has the unknown value "constructor"/);
    expect(
      refusal(
        withBodyNodeId('assets', (body) => {
          body.representationSource = 'hologram';
        })
      )
    ).toMatch(/representationSource" has the unknown value "hologram"/);
  });

  /** A sketch with one line, and a CommandManager over it. */
  function sketchManager() {
    const { document, sketchId } = addSketchFeature(
      createProjectDocument('Labels', owner),
      {
        name: 'Profile',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [{ objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }]
      }
    );
    const [line] = findSketch(document, sketchId)!.objectIds;
    return { manager: new CommandManager(document), sketchId, line: line! };
  }

  /** `document` as received is accepted by the identifier guard and on save. */
  function stores(document: unknown): void {
    const received = JSON.parse(JSON.stringify(document)) as ProjectDocument;
    expect(reservedDocumentIdentifierError(received)).toBeNull();
    expect(() => assertStorableDocument(received)).not.toThrow();
  }

  it.each(ENUM_SPELLED_IDS)(
    'saves a dimension "%s" after its label is moved, with its history',
    (constraintId) => {
      const { manager, sketchId, line } = sketchManager();
      manager.execute(
        commandFactories.addSketchConstraint({
          sketchId,
          constraint: {
            constraintKind: 'distance',
            a: { objectId: line, point: 'start' },
            b: { objectId: line, point: 'end' },
            value: 10
          },
          ids: { constraintId: constraintId as SketchConstraintId }
        })
      );
      stores(manager.document);
      manager.execute(
        commandFactories.setSketchDimensionLabelPosition({
          sketchId,
          constraintId: constraintId as SketchConstraintId,
          position: { x: 4, y: 2 }
        })
      );
      expect(JSON.stringify(manager.document)).toContain(
        `"dimensionLabelPositions":{"${constraintId}":`
      );
      stores(manager.document);
      manager.undo();
      stores(manager.document);
      manager.redo();
      stores(manager.document);
    }
  );

  it.each(ENUM_SPELLED_IDS)(
    'accepts the id "%s" in every id-keyed map of a document',
    (id) => {
      const json = JSON.parse(JSON.stringify(valid())) as Record<
        string,
        unknown
      > & { nodes: NodesJson; derived: Record<string, unknown> };
      json.derived = {
        ...json.derived,
        datumFrames: { [id]: { origin: [0, 0, 0] } },
        datumAxes: { [id]: { origin: [0, 0, 0] } },
        sketchProjections: { [id]: { status: 'linked' } },
        sketchGeometry: {
          projectId: 'project_1',
          documentVersion: 1,
          objects: {
            [id]: { objectKind: 'text', text: 'A', fontStyle: 'bold' }
          }
        }
      };
      json.objectFolders = {
        folders: [{ id: 'folder_1', name: 'Parts', parentId: null }],
        placements: { [id]: 'folder_1' }
      };
      json.assembly = {
        components: [],
        joints: [],
        positions: [{ id: 'position_1', name: 'Open', values: { [id]: [10] } }],
        studies: []
      };
      const part = Object.values(json.nodes).find(
        (node) => node.kind === 'part'
      )!;
      json.nodes.sketch_labels = {
        ...part,
        id: 'sketch_labels',
        kind: 'sketch',
        dimensionLabelPositions: { [id]: { x: 1, y: 2 } }
      };
      expect(reservedDocumentIdentifierError(json)).toBeNull();
      // The same maps restored whole by undo history.
      expect(reservedIdentifierError(json.objectFolders, 'objectFolders')).toBe(
        null
      );
      expect(reservedIdentifierError(json.assembly, 'assembly')).toBeNull();
      expect(reservedIdentifierError(json.nodes, 'nodes')).toBeNull();
      // Map entries are still checked: a placement names a folder id, and a
      // text object in the derived geometry has a font style.
      const folderForged = JSON.parse(JSON.stringify(json)) as {
        objectFolders: { placements: Record<string, unknown> };
      };
      folderForged.objectFolders.placements[id] = 'constructor';
      expect(reservedDocumentIdentifierError(folderForged)).toMatch(
        /reserved id "constructor"/
      );
      const fontForged = JSON.parse(JSON.stringify(json)) as {
        derived: {
          sketchGeometry: { objects: Record<string, Record<string, unknown>> };
        };
      };
      fontForged.derived.sketchGeometry.objects[id]!.fontStyle = 'toString';
      expect(reservedDocumentIdentifierError(fontForged)).toMatch(
        /fontStyle" has the unknown value "toString"/
      );
    }
  );

  it.each(ENUM_SPELLED_IDS)(
    'accepts the id "%s" in the maps of stored commands',
    (id) => {
      const command = (kind: string, payload: unknown): SerializedCommand => ({
        kind,
        payload,
        replayVersion: 1,
        label: kind,
        timestamp: new Date(0).toISOString()
      });
      const commands = [
        command('assembly.pose.set', {
          values: { [id]: [10] },
          placements: { [id]: { position: [0, 0, 0] } }
        }),
        command('assembly.position.save', {
          positionId: 'position_1',
          name: 'Open',
          values: { [id]: [10] }
        }),
        command('sketch.constraint.label-position', {
          sketchId: 'sketch_1',
          constraintId: id,
          position: { x: 1, y: 2 }
        })
      ];
      expect(reservedIdentifierError(commands, 'commandLog')).toBeNull();
      expect(
        reservedIdentifierError(
          [command('transaction', commands)],
          'commandLog'
        )
      ).toBeNull();
      const document = JSON.parse(
        JSON.stringify({ ...valid(), commandLog: commands })
      ) as object;
      expect(reservedDocumentIdentifierError(document)).toBeNull();
      // A creation payload is still held to the enums it defines.
      expect(
        reservedIdentifierError(
          [
            command('transaction', [
              ...commands,
              command('primitive.add', {
                name: 'Box',
                primitiveKind: id,
                dimensions: {}
              })
            ])
          ],
          'commandLog'
        )
      ).toMatch(/primitiveKind" has the unknown value/);
    }
  );

  it('accepts a whole node map restored by undo history', () => {
    const document = valid();
    const nodes = (JSON.parse(JSON.stringify(document)) as { nodes: NodesJson })
      .nodes;
    const after = JSON.parse(JSON.stringify(nodes)) as NodesJson;
    for (const kind of ['feature', 'body']) {
      const [key, node] = Object.entries(after).find(
        ([, candidate]) => candidate.kind === kind
      )!;
      const id = kind === 'feature' ? 'primitiveKind' : 'bodyType';
      delete after[key];
      after[id] = { ...node, id };
    }
    const history = (restored: NodesJson) =>
      JSON.parse(
        JSON.stringify({
          schemaVersion: 1,
          projectId: document.projectId,
          actorUserId: owner,
          entries: [
            {
              id: 'entry_1',
              label: 'Edit',
              changes: [
                {
                  kind: 'value',
                  field: 'nodes',
                  before: nodes,
                  after: restored
                }
              ]
            }
          ],
          cursor: 1,
          trimmed: 0
        })
      ) as ProjectDocument['editHistory'];
    expect(isDocumentHistory(history(after), document.projectId)).toBe(true);
    stores({ ...document, editHistory: history(after) });
    // Its nodes are still held to the enums they define.
    const forged = JSON.parse(JSON.stringify(after)) as NodesJson;
    forged.bodyType!.representationSource = 'hologram';
    expect(isDocumentHistory(history(forged), document.projectId)).toBe(false);
    expect(
      reservedDocumentIdentifierError({
        ...document,
        editHistory: history(forged)
      })
    ).toMatch(
      /after\.bodyType\.representationSource" has the unknown value "hologram"/
    );
  });
});

describe('stored command enums by the feature they create or change', () => {
  const command = (kind: string, payload: unknown): SerializedCommand => ({
    kind,
    payload,
    replayVersion: 1,
    label: kind,
    timestamp: new Date(0).toISOString()
  });

  /** The reported payload: a grid pattern whose second axis is no axis. */
  function gridPattern(document: ProjectDocument, axis2: unknown) {
    return {
      name: 'Grid',
      targetBodyId: document.bodyOrder[0]!,
      patternKind: 'grid' as const,
      count: 2,
      axis: 'x' as const,
      spacing: 10,
      axis2: axis2 as 'y'
    };
  }

  /** A box patterned along x, and the pattern's feature id. */
  function patterned() {
    const document = valid();
    const next = patternBody(document, gridPattern(document, 'y')).document;
    const feature = Object.values(next.nodes).find(
      (node) => node.kind === 'feature' && node.featureKind === 'pattern'
    ) as { featureId: string };
    return { document: next, featureId: feature.featureId };
  }

  it('refuses the reported grid pattern before it runs, stored or replayed', () => {
    const document = valid();
    const manager = new CommandManager(document);
    expect(() =>
      manager.execute(
        commandFactories.patternBody(gridPattern(document, 'constructor'))
      )
    ).toThrow(/axis2" has the unknown value "constructor"/);
    // Nothing ran: no pattern feature, no stored command.
    expect(manager.document.commandLog).toHaveLength(0);
    const stored = command('feature.pattern', {
      ...gridPattern(document, 'constructor'),
      ids: { featureId: 'feature_grid', featureNodeId: 'node_grid' }
    });
    expect(reservedIdentifierError([stored], 'commandLog')).toMatch(
      /payload\.axis2" has the unknown value "constructor"/
    );
    expect(() => replayCommands(document, [stored])).toThrow(
      /axis2" has the unknown value "constructor"/
    );
    // In a document's log, nested in a transaction, or in its undo history.
    const json = JSON.parse(JSON.stringify(document)) as ProjectDocument;
    expect(refusal({ ...json, commandLog: [stored] })).toMatch(
      /axis2" has the unknown value "constructor"/
    );
    expect(
      refusal({
        ...json,
        commandLog: [command('transaction', [command('transaction', [stored])])]
      })
    ).toMatch(/axis2" has the unknown value "constructor"/);
    const history = {
      schemaVersion: 1,
      projectId: document.projectId,
      actorUserId: owner,
      entries: [
        {
          id: 'entry_1',
          label: 'Grid',
          changes: [
            {
              kind: 'splice',
              field: 'commandLog',
              index: 0,
              before: [],
              after: [stored]
            }
          ]
        }
      ],
      cursor: 1,
      trimmed: 0
    };
    expect(isDocumentHistory(history, document.projectId)).toBe(false);
    expect(refusal({ ...json, editHistory: history })).toMatch(
      /axis2" has the unknown value "constructor"/
    );
    // The valid grid still runs and saves.
    manager.execute(commandFactories.patternBody(gridPattern(document, 'z')));
    const saved = JSON.parse(JSON.stringify(manager.document)) as unknown;
    expect(() => assertStorableDocument(saved)).not.toThrow();
  });

  it.each([
    ['feature.boolean', { operation: 'constructor', targetBodyIds: [] }],
    ['feature.boolean', { operation: 'union', keepOriginals: 'none' }],
    ['feature.extrude', { operation: 'merge' }],
    ['feature.revolve', { axis: 'x' }],
    ['feature.loft', { mode: 'toString', sections: [] }],
    ['feature.sweep', { mode: 'ruled' }],
    ['feature.hole', { style: 'tapped', depthMode: 'blind' }],
    ['feature.gear', { gearType: 'external', hand: 'both' }],
    ['feature.thread', { profile: 'acme' }],
    ['feature.pattern', { patternKind: 'linear', axis: 'horizontal' }],
    ['feature.fillet', { radiusLaw: 'cubic' }],
    ['import.mesh', { assumedUnits: 'parsec' }]
  ])('refuses %s with %j', (kind, payload) => {
    const error = reservedIdentifierError(
      [command(kind, payload)],
      'commandLog'
    );
    expect(error).toMatch(/has the unknown value/);
    expect(
      reservedIdentifierError(
        [command('transaction', [command(kind, payload)])],
        'commandLog'
      )
    ).toMatch(/has the unknown value/);
  });

  it('holds a field only to the enums of the feature its command creates', () => {
    // A revolve's axis is horizontal or vertical; a pattern's is x, y or z.
    expect(
      reservedIdentifierError(
        [
          command('feature.revolve', { axis: 'horizontal' }),
          command('feature.pattern', { patternKind: 'grid', axis: 'x' })
        ],
        'commandLog'
      )
    ).toBeNull();
    // A direct edit's operation and a gear's axis are objects, not enums.
    expect(
      reservedIdentifierError(
        [
          command('feature.direct-edit', { operation: { kind: 'move-face' } }),
          command('feature.gear', {
            gearType: 'external',
            axis: { x: 0, y: 0, z: 1 }
          })
        ],
        'commandLog'
      )
    ).toBeNull();
    // Other commands define no feature enums.
    expect(
      reservedIdentifierError(
        [command('drawing.view.add', { style: 'anything', mode: 'shaded' })],
        'commandLog'
      )
    ).toBeNull();
  });

  it('judges a feature.update by the kind of the feature it changes', () => {
    const { document, featureId } = patterned();
    const update = (data: Record<string, unknown>) =>
      command('feature.update', { featureId, data });
    // With the document, the pattern's own enums apply.
    for (const data of [
      { axis2: 'constructor' },
      { axis: 'horizontal' },
      { axis: { x: 1, y: 0, z: 0 } }
    ]) {
      expect(
        reservedIdentifierError([update(data)], 'commandLog', document)
      ).not.toBeNull();
      expect(() =>
        new CommandManager(document).execute(
          commandFactories.updateFeature({
            featureId: featureId as never,
            data: data as never
          })
        )
      ).toThrow(/The command cannot run/);
      expect(
        refusal({
          ...(JSON.parse(JSON.stringify(document)) as object),
          commandLog: [command('transaction', [update(data)])]
        })
      ).toMatch(/axis2?" (has the unknown value|must be one of)/);
    }
    expect(
      reservedIdentifierError([update({ axis2: 'z' })], 'commandLog', document)
    ).toBeNull();
    // The feature a log creates is known to its later updates.
    const created = command('feature.pattern', {
      ...gridPattern(document, 'y'),
      ids: { featureId: 'feature_later', featureNodeId: 'node_later' }
    });
    expect(
      reservedIdentifierError(
        [
          created,
          command('feature.update', {
            featureId: 'feature_later',
            data: { axis: 'vertical' }
          })
        ],
        'commandLog'
      )
    ).toMatch(/axis" has the unknown value "vertical"/);
    // Without its feature, a string must be a value the field has on some
    // feature; a non-string, an object on other kinds, is left alone.
    const unknown = (data: Record<string, unknown>) =>
      reservedIdentifierError(
        [command('feature.update', { featureId: 'feature_gone', data })],
        'commandLog'
      );
    expect(unknown({ axis2: 'constructor' })).toMatch(
      /axis2" has the unknown value "constructor"/
    );
    expect(unknown({ mode: 'sideways' })).toMatch(
      /mode" has the unknown value "sideways"/
    );
    expect(unknown({ axis: 'vertical' })).toBeNull();
    expect(unknown({ operation: { kind: 'move-face' } })).toBeNull();
    // Data naming its kind is judged by it.
    expect(unknown({ featureKind: 'pattern', axis: 'vertical' })).toMatch(
      /axis" has the unknown value "vertical"/
    );
  });

  it('judges a feature.update in undo history by its feature', () => {
    const { document, featureId } = patterned();
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.updateFeature({
        featureId: featureId as never,
        data: { axis2: 'z' }
      })
    );
    const saved = JSON.parse(JSON.stringify(manager.document)) as {
      editHistory: unknown;
      commandLog: unknown;
    };
    expect(() => assertStorableDocument(saved)).not.toThrow();
    const forge = (part: unknown) =>
      JSON.parse(
        JSON.stringify(part).replaceAll('"axis2":"z"', '"axis2":"horizontal"')
      ) as unknown;
    // "horizontal" is a revolve's axis: the pattern's feature refuses it.
    expect(
      refusal({ ...saved, editHistory: forge(saved.editHistory) })
    ).toMatch(/axis2" has the unknown value "horizontal"/);
    expect(refusal({ ...saved, commandLog: forge(saved.commandLog) })).toMatch(
      /axis2" has the unknown value "horizontal"/
    );
  });

  it('lists every feature-creating command with the kind it creates', () => {
    expect(COMMAND_CREATED_FEATURE_KINDS).toBe(COMMAND_FEATURE_KINDS);
    const document = valid();
    const manager = new CommandManager(document);
    for (const created of [
      commandFactories.patternBody(gridPattern(document, 'y')),
      commandFactories.addPrimitive({
        name: 'Ball',
        primitiveKind: 'sphere',
        dimensions: { radius: 1 }
      })
    ]) {
      const before = new Set(manager.document.featureOrder);
      manager.execute(created);
      const feature = Object.values(manager.document.nodes).find(
        (node) => node.kind === 'feature' && !before.has(node.featureId)
      ) as { featureKind: string };
      expect(
        COMMAND_FEATURE_KINDS[
          created.kind as keyof typeof COMMAND_FEATURE_KINDS
        ]
      ).toBe(feature.featureKind);
    }
  });
});

describe('document units', () => {
  type Json = Record<string, unknown> & {
    nodes: Record<string, Record<string, unknown>>;
    rootNodeId: string;
  };
  const json = () => JSON.parse(JSON.stringify(valid())) as Json;

  it('still accepts every unit system, on the document and its project', () => {
    for (const units of ['mm', 'cm', 'm', 'inch']) {
      const value = json();
      value.units = units;
      value.nodes[value.rootNodeId]!.units = units;
      expect(() => assertStorableDocument(value)).not.toThrow();
    }
  });

  it.each([
    ['parsec'],
    ['constructor'],
    ['__proto__'],
    [null],
    [3],
    [{}],
    [['mm']]
  ])('refuses document units %j', (units) => {
    const value = json();
    value.units = units;
    expect(refusal(value)).toMatch(
      /"units" (has the unknown value|must be one of its known values)/
    );
  });

  it.each([['parsec'], ['toString'], [null], [{ mm: 1 }]])(
    'refuses project node units %j',
    (units) => {
      const value = json();
      expect(value.nodes[value.rootNodeId]!.kind).toBe('project');
      value.nodes[value.rootNodeId]!.units = units;
      expect(refusal(value)).toMatch(
        /\.units" (has the unknown value|must be one of its known values)/
      );
    }
  );

  it('refuses undo history that restores unknown units', () => {
    const value = json();
    const history = (changes: unknown[]) => ({
      schemaVersion: 1,
      projectId: value.projectId,
      actorUserId: owner,
      entries: [{ id: 'entry_1', label: 'Units', changes }],
      cursor: 1,
      trimmed: 0
    });
    const project = value.nodes[value.rootNodeId]!;
    const good = history([
      { kind: 'value', field: 'units', before: 'mm', after: 'inch' },
      {
        kind: 'value',
        field: 'nodes',
        key: value.rootNodeId,
        before: project,
        after: { ...project, units: 'inch' }
      }
    ]);
    expect(isDocumentHistory(good, value.projectId as string)).toBe(true);
    expect(() =>
      assertStorableDocument({ ...value, editHistory: good })
    ).not.toThrow();
    for (const change of [
      { kind: 'value', field: 'units', before: 'mm', after: 'parsec' },
      { kind: 'value', field: 'units', before: null, after: 'mm' },
      {
        kind: 'value',
        field: 'nodes',
        key: value.rootNodeId,
        before: project,
        after: { ...project, units: 'parsec' }
      },
      {
        kind: 'value',
        field: 'nodes',
        before: value.nodes,
        after: {
          ...value.nodes,
          [value.rootNodeId]: { ...project, units: 'parsec' }
        }
      }
    ]) {
      const forged = history([change]);
      expect(isDocumentHistory(forged, value.projectId as string)).toBe(false);
      expect(refusal({ ...value, editHistory: forged })).toMatch(
        /(units|before|after)" (has the unknown value|must be one of its known values)/
      );
    }
    expect(reservedIdentifierError('parsec', 'units')).toMatch(
      /"units" has the unknown value "parsec"/
    );
  });

  it('never reads an unknown unit as a number', () => {
    const scale = { numerator: 1, denominator: 2 };
    expect(drawingPaperPerModelUnit(scale, 'inch')).toBe(12.7);
    for (const units of ['parsec', 'constructor', '__proto__']) {
      expect(() => millimetresPerUnit(units as UnitSystem)).toThrow(
        /Unknown units/
      );
      expect(() =>
        drawingPaperPerModelUnit(scale, units as UnitSystem)
      ).toThrow(/Unknown units/);
    }
  });
});

const storedCommand = (kind: string, payload: unknown): SerializedCommand => ({
  kind,
  payload,
  replayVersion: 1,
  label: kind,
  timestamp: new Date(0).toISOString()
});

const changeHistory = (projectId: string, changes: unknown[]) => ({
  schemaVersion: 1,
  projectId,
  actorUserId: owner,
  entries: [{ id: 'entry_1', label: 'Edit', changes }],
  cursor: 1,
  trimmed: 0
});

describe('a feature id reused by another kind', () => {
  /**
   * The reported sequence: revolve F, set its axis to vertical, delete F,
   * then pattern a box as F again. The update is a revolve's, wherever the
   * pattern now is.
   */
  function reusedSequence(base: ProjectDocument) {
    const sketch = commandFactories.addSketch({
      name: 'Profile',
      plane: 'XZ',
      offset: 0,
      object: {
        objectKind: 'rectangle',
        width: 4,
        height: 4,
        centerX: 10,
        centerY: 10
      }
    });
    const revolveIds = createBodyFeatureIds();
    const sketchId = (sketch.payload as { ids: { sketchId: string } }).ids
      .sketchId;
    return {
      featureId: revolveIds.featureId,
      commands: [
        sketch,
        commandFactories.revolveSketch({
          name: 'Ring',
          sketchId: sketchId as never,
          axis: 'horizontal',
          ids: revolveIds
        }),
        commandFactories.updateFeature({
          featureId: revolveIds.featureId,
          data: { axis: 'vertical' }
        }),
        commandFactories.deleteFeature({ featureId: revolveIds.featureId }),
        commandFactories.patternBody({
          name: 'Grid',
          targetBodyId: base.bodyOrder[0]!,
          patternKind: 'grid',
          count: 2,
          axis: 'x',
          spacing: 10,
          axis2: 'y',
          ids: { ...createBodyFeatureIds(), featureId: revolveIds.featureId }
        })
      ]
    };
  }

  it('judges each update by the kind its feature had where the update sits', () => {
    const base = valid();
    const { featureId, commands } = reusedSequence(base);
    const manager = new CommandManager(base);
    for (const command of commands) manager.execute(command);
    const saved = JSON.parse(JSON.stringify(manager.document)) as {
      commandLog: SerializedCommand[];
      editHistory: unknown;
    };
    // Stored, in its log and its undo history.
    expect(() => assertStorableDocument(saved)).not.toThrow();
    expect(
      isDocumentHistory(saved.editHistory, manager.document.projectId)
    ).toBe(true);
    // Replayed, and run as one transaction.
    expect(() => replayCommands(base, saved.commandLog)).not.toThrow();
    expect(() =>
      new CommandManager(base).runTransaction('Rebuild', commands)
    ).not.toThrow();
    // The pattern F is now judged as a pattern, in every place.
    const patternUpdate = (axis: string) =>
      commandFactories.updateFeature({
        featureId,
        data: { axis } as never
      });
    expect(() =>
      new CommandManager(manager.document).execute(patternUpdate('vertical'))
    ).toThrow(/axis" has the unknown value "vertical"/);
    expect(() =>
      new CommandManager(manager.document).execute(patternUpdate('z'))
    ).not.toThrow();
    expect(() =>
      new CommandManager(base).runTransaction('Rebuild', [
        ...commands,
        patternUpdate('vertical')
      ])
    ).toThrow(/axis" has the unknown value "vertical"/);
    expect(
      refusal({
        ...saved,
        commandLog: [
          ...saved.commandLog,
          JSON.parse(JSON.stringify(patternUpdate('vertical').serialize()))
        ]
      })
    ).toMatch(/axis" has the unknown value "vertical"/);
    // Before the reuse the revolve's own enums still apply.
    const early = saved.commandLog
      .slice(0, 3)
      .map((command, index) =>
        index === 2
          ? { ...command, payload: { featureId, data: { axis: 'x' } } }
          : command
      );
    expect(reservedIdentifierError(early, 'commandLog')).toMatch(
      /axis" has the unknown value "x"/
    );
  });

  it('holds an update after its feature was deleted to every kind', () => {
    const base = valid();
    const { featureId, commands } = reusedSequence(base);
    const log = commands
      .slice(0, 4)
      .map((command) => command.serialize() as SerializedCommand);
    const after = (data: Record<string, unknown>) =>
      reservedIdentifierError(
        [...log, storedCommand('feature.update', { featureId, data })],
        'commandLog'
      );
    expect(after({ axis: 'z' })).toBeNull();
    expect(after({ axis: 'sideways' })).toMatch(
      /axis" has the unknown value "sideways"/
    );
  });
});

describe('feature and node ids are strings', () => {
  /** A box whose feature id is the number 123, as JSON from storage. */
  function numericFeature(): ProjectDocument {
    const json = JSON.parse(JSON.stringify(valid())) as {
      nodes: Record<string, Record<string, unknown>>;
      featureOrder: unknown[];
    };
    const node = Object.values(json.nodes).find(
      (candidate) => candidate.kind === 'feature'
    )!;
    const featureId = node.featureId;
    node.featureId = 123;
    json.featureOrder = json.featureOrder.map((id) =>
      id === featureId ? 123 : id
    );
    return json as unknown as ProjectDocument;
  }

  it('refuses a document whose feature, body or node id is no string', () => {
    expect(refusal(numericFeature())).toMatch(/invalid "featureId"/);
    for (const [kind, field] of [
      ['body', 'bodyId'],
      ['feature', 'featureId'],
      ['project', 'id']
    ] as const) {
      const json = JSON.parse(JSON.stringify(valid())) as {
        nodes: Record<string, Record<string, unknown>>;
      };
      const node = Object.values(json.nodes).find(
        (candidate) => candidate.kind === kind
      )!;
      node[field] = 7;
      expect(refusal(json)).toMatch(/has an invalid/);
      delete node[field];
      expect(refusal(json)).toMatch(/has an invalid/);
    }
  });

  it('refuses a numeric feature id in a node snapshot in undo history', () => {
    const json = JSON.parse(JSON.stringify(valid())) as ProjectDocument & {
      nodes: Record<string, Record<string, unknown>>;
    };
    const [key, node] = Object.entries(json.nodes).find(
      ([, candidate]) => candidate.kind === 'feature'
    )!;
    const history = changeHistory(json.projectId, [
      {
        kind: 'value',
        field: 'nodes',
        key,
        before: { ...node, featureId: 123 },
        after: node
      }
    ]);
    expect(isDocumentHistory(history, json.projectId)).toBe(false);
  });

  it('refuses a command naming its feature or node by a number', () => {
    const document = numericFeature();
    const update = commandFactories.updateFeature({
      featureId: 123 as never,
      data: { primitiveKind: {} } as never
    });
    expect(() => new CommandManager(document).execute(update)).toThrow(
      /featureId" must be a string/
    );
    expect(() =>
      replayCommands(valid(), [update.serialize() as SerializedCommand])
    ).toThrow(/featureId" must be a string/);
    for (const kind of ['feature.delete', 'node.rename']) {
      expect(
        reservedIdentifierError(
          [storedCommand(kind, { featureId: 1, nodeId: 2, name: 'x' })],
          'commandLog'
        )
      ).toMatch(/must be a string/);
    }
    // A string id, or none, is fine.
    expect(
      reservedIdentifierError(
        [storedCommand('node.rename', { nodeId: 'node_1', name: 'x' })],
        'commandLog'
      )
    ).toBeNull();
  });

  it('keeps fields that are strings on every kind strict for an unknown target', () => {
    const unknown = (data: Record<string, unknown>) =>
      reservedIdentifierError(
        [storedCommand('feature.update', { featureId: 'feature_gone', data })],
        'commandLog'
      );
    for (const data of [
      { primitiveKind: {} },
      { patternKind: 1 },
      { mode: ['ruled'] },
      { style: null },
      { positionAnchor: {} }
    ])
      expect(unknown(data)).toMatch(/must be one of its known values/);
    // Fields some kind holds as an object or vector still may.
    for (const data of [
      { axis: { x: 0, y: 0, z: 1 } },
      { operation: { kind: 'move-face' } },
      { profile: { sketchId: 'sketch_1', all: true } }
    ])
      expect(unknown(data)).toBeNull();
  });
});

describe('units are never missing', () => {
  type Json = Record<string, unknown> & {
    projectId: string;
    nodes: Record<string, Record<string, unknown>>;
    rootNodeId: string;
  };
  const json = () => JSON.parse(JSON.stringify(valid())) as Json;

  it('refuses a document or project node without units', () => {
    const document = json();
    delete document.units;
    expect(refusal(document)).toMatch(/missing its "units"/);
    const project = json();
    delete project.nodes[project.rootNodeId]!.units;
    expect(refusal(project)).toMatch(/missing its "units"/);
  });

  it('refuses undo history that would delete the units', () => {
    const value = json();
    const project = value.nodes[value.rootNodeId]!;
    const { units: _units, ...withoutUnits } = project;
    for (const change of [
      { kind: 'value', field: 'units', before: 'mm' },
      { kind: 'value', field: 'units', after: 'inch' },
      { kind: 'value', field: 'units', before: undefined, after: 'mm' },
      {
        kind: 'value',
        field: 'nodes',
        key: value.rootNodeId,
        before: project,
        after: withoutUnits
      }
    ]) {
      const history = changeHistory(value.projectId, [change]);
      expect(isDocumentHistory(history, value.projectId)).toBe(false);
      expect(refusal({ ...value, editHistory: history })).toMatch(
        /missing its "(before|after|units)"|invalid or unsupported undo history/
      );
    }
  });
});

describe('optional feature enums', () => {
  it.each([
    [
      'feature.hole',
      { style: 'simple', depthMode: 'blind' },
      'positionAnchor',
      'centroid',
      'corner'
    ],
    ['feature.helical-sweep', {}, 'construction', 'in-place', 'offset'],
    ['feature.thread', { profile: 'npt' }, 'pipeSize', '1/2', '5/8']
  ])(
    'holds %s %j %s to its values, absent or not',
    (kind, base, field, good, bad) => {
      const featureKind =
        COMMAND_FEATURE_KINDS[kind as keyof typeof COMMAND_FEATURE_KINDS];
      const ids = { featureId: 'feature_f', featureNodeId: 'node_f' };
      const create = (payload: Record<string, unknown>) =>
        reservedIdentifierError(
          [storedCommand(kind, { ...base, ...payload, ids })],
          'commandLog'
        );
      // A creation command, and a later update of what it created.
      expect(create({})).toBeNull();
      expect(create({ [field]: good })).toBeNull();
      for (const value of [bad, 'constructor', 1, {}])
        expect(create({ [field]: value })).toMatch(
          /has the unknown value|must be one of its known values/
        );
      const update = (value: unknown) =>
        reservedIdentifierError(
          [
            storedCommand(kind, { ...base, ids }),
            storedCommand('feature.update', {
              featureId: 'feature_f',
              data: { [field]: value }
            })
          ],
          'commandLog'
        );
      expect(update(good)).toBeNull();
      expect(update(bad)).toMatch(/has the unknown value/);
      // A live feature node, and its snapshot in undo history.
      const document = JSON.parse(JSON.stringify(valid())) as ProjectDocument;
      const node = (value: unknown) => ({
        id: 'node_f',
        kind: 'feature',
        parentId: document.rootNodeId,
        name: 'F',
        featureId: 'feature_f',
        featureKind,
        data: {
          featureKind,
          ...base,
          ...(value === undefined ? {} : { [field]: value })
        }
      });
      const live = (value: unknown) =>
        reservedIdentifierError({
          ...document,
          nodes: { ...document.nodes, node_f: node(value) }
        });
      expect(live(undefined)).toBeNull();
      expect(live(good)).toBeNull();
      expect(live(bad)).toMatch(/has the unknown value/);
      const history = (value: unknown) =>
        changeHistory(document.projectId, [
          {
            kind: 'value',
            field: 'nodes',
            key: 'node_f',
            before: undefined,
            after: node(value)
          }
        ]);
      expect(isDocumentHistory(history(good), document.projectId)).toBe(true);
      expect(isDocumentHistory(history(bad), document.projectId)).toBe(false);
    }
  );
});
