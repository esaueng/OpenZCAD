import { afterEach, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchConstraint,
  addSketchFeature,
  assertStorableDocument,
  createProjectDocument,
  findSketch,
  evaluateExpression,
  getNode,
  getParameterScope,
  isLiveAssemblyBody,
  normalizeDocument,
  renameNode,
  reservedDocumentIdentifierError,
  setNodeMetadata,
  setParameter,
  UnstorableDocumentError
} from '@openzcad/document-core';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  documentEnvelopeError,
  isDocumentHistory,
  ownEntry,
  reservedIdentifierError,
  toBodyId,
  toUserId,
  type EntityId,
  type ProjectDocument,
  type SerializedCommand,
  type SketchConstraintId
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
          changes: [{ kind: 'value', field: 'nodes', key: 'ent_ok', after: {} }]
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
