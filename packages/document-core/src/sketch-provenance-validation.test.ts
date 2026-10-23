import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import { computeSketchProfileAnalysis } from '@openzcad/geometry';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toEntityId,
  toSketchConstraintId,
  toUserId,
  type DocumentChange,
  type ProjectDocument,
  type SerializedCommand,
  type SketchPromotion
} from '@openzcad/shared';
import {
  addSketchFeature,
  createProjectDocument,
  findSketch,
  normalizeDocument
} from './index';
import { assertSketchProvenance } from './sketch-provenance-validation';

import {
  createRoomContext,
  createTestRoom,
  installWorkerSocketGlobals
} from '../../../test/collaboration-room-harness';

function fixture(width: number | string = 'width') {
  const f = addSketchFeature(
    createProjectDocument('Provenance guard', toUserId('user_test')),
    {
      name: 'Legacy rectangle',
      plane: 'XY',
      objects: [
        {
          objectKind: 'rectangle',
          width,
          height: 3,
          centerX: 0,
          centerY: 0
        }
      ]
    }
  );
  const sourceObjectId = findSketch(f.document, f.sketchId)!.objectIds[0]!;
  return { ...f, sourceObjectId };
}

const reference = () => ({
  regionFingerprint: 42,
  sourceArea: 12,
  samplePoint: { x: 0, y: 0 },
  sourceEntityIds: ['ent_legacy'],
  sourceBoundaryLoops: {
    outer: Array.from(
      { length: 4 },
      (_, i) => `b1/ent_legacy/rectangle/1/4/e/${i}`
    ),
    holes: []
  }
});

function command(kind: string, payload: unknown): SerializedCommand {
  return {
    kind,
    payload,
    label: 'Saved command',
    replayVersion: 1,
    timestamp: new Date(0).toISOString()
  };
}

function history(
  document: ProjectDocument,
  change: DocumentChange,
  cursor: 0 | 1 = 0
) {
  document.editHistory = {
    schemaVersion: 1,
    projectId: document.projectId,
    actorUserId: document.ownerUserId,
    cursor,
    trimmed: 0,
    entries: [{ id: 'history_guard', label: 'Saved edit', changes: [change] }]
  };
}

function promotion(f: ReturnType<typeof fixture>): SketchPromotion {
  const edgeIds = Array.from({ length: 4 }, (_, i) =>
    toEntityId(`ent_edge_${i}`)
  );
  const centerSpokeId = toEntityId('ent_spoke');
  return {
    promotionId: 'sprm_fixture',
    version: 1,
    sourceObjectId: f.sourceObjectId,
    sourceData: {
      objectKind: 'rectangle',
      width: 'width',
      height: 3,
      centerX: 0,
      centerY: 0
    },
    sourceName: 'Legacy rectangle',
    topology: { kind: 'rectangle', version: 1, count: 4 },
    edgeIds,
    centerSpokeId,
    helperIds: [toEntityId('ent_diagonal')],
    structureConstraintIds: [toSketchConstraintId('scon_structure')],
    aliases: {
      version: 1,
      edges: [...edgeIds],
      vertices: edgeIds.map((objectId) => ({ objectId, point: 'start' })),
      center: { objectId: centerSpokeId, point: 'start' }
    }
  };
}

function promoted() {
  const f = fixture();
  const sketch = findSketch(f.document, f.sketchId)!;
  const owner = promotion(f);
  sketch.promotions = [owner];
  sketch.constraints = [
    {
      constraintId: owner.structureConstraintIds[0]!,
      origin: 'promotion-structure',
      promotionId: owner.promotionId,
      data: { constraintKind: 'horizontal', objectId: owner.edgeIds[0]! }
    }
  ];
  return { ...f, sketch, owner };
}

function authored(family: 'boundary profile' | 'promotion ownership') {
  const f = fixture(20);
  const manager = new CommandManager(f.document);
  const source = f.document.nodes[f.sourceObjectId]!;
  if (source.kind !== 'sketch-object') throw new Error('Missing legacy source');
  if (family === 'promotion ownership') {
    manager.execute(
      commandFactories.convertLegacySketchObject({
        sketchId: f.sketchId,
        sourceObjectId: f.sourceObjectId,
        expectedSource: source.data
      })
    );
  } else {
    const profile = computeSketchProfileAnalysis(
      [{ id: f.sourceObjectId, data: source.data }],
      Number
    ).profiles[0]!;
    expect(profile.sourceBoundaryLoops).toBeDefined();
    manager.execute(
      commandFactories.extrudeSketch({
        name: 'Authored plate',
        sketchId: f.sketchId,
        distance: 2,
        profile: {
          profileId: profile.profileId,
          regionFingerprint: profile.regionFingerprint,
          sourceArea: profile.area,
          samplePoint: profile.samplePoint,
          sourceEntityIds: profile.sourceEntityIds,
          sourceBoundaryLoops: profile.sourceBoundaryLoops
        }
      })
    );
  }
  const node =
    family === 'promotion ownership'
      ? findSketch(manager.document, f.sketchId)!
      : Object.values(manager.document.nodes).find(
          (candidate) =>
            candidate.kind === 'feature' &&
            candidate.data.featureKind === 'extrude'
        )!;
  const plain = structuredClone(node);
  if (plain.kind === 'sketch') {
    delete plain.promotions;
    plain.constraints = plain.constraints?.filter(
      (constraint) => constraint.origin !== 'promotion-structure'
    );
  } else if (plain.kind === 'feature' && plain.data.featureKind === 'extrude') {
    delete plain.data.profile;
  }
  return {
    ...f,
    document: manager.document,
    base: f.document,
    node,
    plain,
    recorded: manager.document.commandLog[0]!
  };
}

describe.each(['boundary profile', 'promotion ownership'] as const)(
  'S04 schema-v37 carriers: %s',
  (family) => {
    it.each([32, 33, 34, 35, 36, undefined])(
      'refuses readable older schema %s in every carrier without mutation',
      (version) => {
        for (const carrier of [
          'current node',
          'undo node',
          'redo node',
          'undo node map',
          'redo node map',
          'current nested log',
          'undo value log',
          'redo value log',
          'undo splice log',
          'redo splice log'
        ] as const) {
          const f = authored(family);
          const isNode = carrier.includes('node');
          const saved = structuredClone(isNode ? f.document : f.base);
          saved.commandLog = [];
          delete saved.editHistory;
          if (isNode) saved.nodes[f.node.id] = structuredClone(f.plain);
          const marked = structuredClone(f.node);
          const undo = carrier.startsWith('undo');
          const nested = [
            command('transaction', [
              command('transaction', [structuredClone(f.recorded)])
            ])
          ];
          if (carrier === 'current node') saved.nodes[marked.id] = marked;
          else if (carrier === 'current nested log') saved.commandLog = nested;
          else if (isNode) {
            const wholeMap = carrier.endsWith('map');
            const before = wholeMap ? saved.nodes : f.plain;
            const after = wholeMap
              ? { ...saved.nodes, [marked.id]: marked }
              : marked;
            history(
              saved,
              {
                kind: 'value',
                field: 'nodes',
                ...(wholeMap ? {} : { key: marked.id }),
                before: undo ? after : before,
                after: undo ? before : after
              },
              undo ? 1 : 0
            );
          } else {
            history(
              saved,
              carrier.includes('splice')
                ? {
                    kind: 'splice',
                    field: 'commandLog',
                    index: 0,
                    before: undo ? nested : [],
                    after: undo ? [] : nested
                  }
                : {
                    kind: 'value',
                    field: 'commandLog',
                    before: undo ? nested : [],
                    after: undo ? [] : nested
                  },
              undo ? 1 : 0
            );
          }
          expect(saved.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
          expect(normalizeDocument(saved).editHistory, carrier).toEqual(
            saved.editHistory
          );
          expect(() => assertSketchProvenance(saved), carrier).not.toThrow();
          if (version === undefined)
            Reflect.deleteProperty(saved, 'schemaVersion');
          else
            saved.schemaVersion = version as ProjectDocument['schemaVersion'];
          const before = structuredClone(saved);
          const upgrade = /require project schema v37 or newer/;
          expect(() => assertSketchProvenance(saved), carrier).toThrow(upgrade);
          expect(() => normalizeDocument(saved), carrier).toThrow(upgrade);
          expect(() => new CommandManager(saved), carrier).toThrow(upgrade);
          expect(() => replayCommands(saved, []), carrier).toThrow(upgrade);
          expect(saved, carrier).toEqual(before);
        }
      }
    );
  }
);

describe('S04 provenance carrier validation', () => {
  it('keeps all legacy envelopes without new fields unchanged', () => {
    const f = fixture();
    const before = structuredClone(f.document);
    for (let schema = 1; schema < 37; schema++) {
      const old = {
        ...f.document,
        schemaVersion: schema as ProjectDocument['schemaVersion']
      };
      expect(() => assertSketchProvenance(old)).not.toThrow();
    }
    expect(f.document).toEqual(before);
  });

  it.each([
    ['feature.extrude', { profile: reference() }],
    ['feature.extrude', { profiles: [reference()] }],
    [
      'feature.loft',
      { sections: [{ sketchId: 'sketch_1', profile: reference() }] }
    ],
    [
      'feature.sweep',
      { profile: { sketchId: 'sketch_1', profile: reference() } }
    ],
    [
      'feature.helical-sweep',
      { profile: { sketchId: 'sketch_1', profile: reference() } }
    ],
    ['feature.update', { data: { profiles: [reference()] } }]
  ] as const)(
    'checks new profile fields in replay carrier %s',
    (kind, payload) => {
      const f = fixture();
      f.document.commandLog = [
        command('transaction', [command(kind, payload)])
      ];
      expect(() => assertSketchProvenance(f.document)).not.toThrow();
      f.document.schemaVersion = 36 as ProjectDocument['schemaVersion'];
      expect(() => assertSketchProvenance(f.document)).toThrow(/schema v37/);
    }
  );

  it.each(['before', 'after'] as const)(
    'checks provenance hidden only in %s log snapshots',
    (side) => {
      const f = fixture();
      history(f.document, {
        kind: 'splice',
        field: 'commandLog',
        index: 0,
        before: [],
        after: [],
        [side]: [command('feature.extrude', { profile: reference() })]
      });
      f.document.schemaVersion = 36 as ProjectDocument['schemaVersion'];
      expect(() => assertSketchProvenance(f.document)).toThrow(/schema v37/);
    }
  );

  it('rejects malformed profile tokens and witnesses without using legacy fallback', () => {
    const f = fixture();
    const candidate = reference();
    candidate.sourceBoundaryLoops.outer[0] = 'b1/ent_legacy/rectangle/2/4/e/0';
    f.document.commandLog = [
      command('feature.extrude', { profile: candidate })
    ];
    expect(() => assertSketchProvenance(f.document)).toThrow(/malformed/);
    const badWitness = { ...reference(), samplePoint: { x: Infinity, y: 0 } };
    f.document.commandLog = [
      command('feature.extrude', { profile: badWitness })
    ];
    expect(() => assertSketchProvenance(f.document)).toThrow(/malformed/);
    f.document.commandLog = [
      command('feature.extrude', { profile: { ...reference(), all: true } })
    ];
    expect(() => assertSketchProvenance(f.document)).toThrow(/malformed/);
    f.document.commandLog = [
      command('feature.extrude', {
        profile: { ...reference(), sketchId: f.sketchId }
      })
    ];
    expect(() => assertSketchProvenance(f.document)).toThrow(/malformed/);
    f.document.schemaVersion = 36 as ProjectDocument['schemaVersion'];
    expect(() => assertSketchProvenance(f.document)).toThrow(/schema v37/);
  });

  it('does not interpret arbitrary metadata as authored profile or ownership fields', () => {
    const f = fixture();
    f.document.schemaVersion = 36 as ProjectDocument['schemaVersion'];
    f.document.commandLog = [
      command('node.metadata.set', {
        metadata: {
          sourceBoundaryLoops: { custom: true },
          promotions: [],
          origin: 'custom'
        }
      })
    ];
    expect(() => assertSketchProvenance(f.document)).not.toThrow();
  });
});

describe('S04 promotion ownership validation', () => {
  it('validates owned structure but lets missing physical members remain repairable on load', () => {
    const f = promoted();
    expect(() => assertSketchProvenance(f.document)).not.toThrow();
    f.document.schemaVersion = 36 as ProjectDocument['schemaVersion'];
    expect(() => assertSketchProvenance(f.document)).toThrow(/schema v37/);
  });

  it.each([
    'orphan',
    'wrong-owner',
    'missing-marker',
    'missing-constraint',
    'duplicate'
  ] as const)('refuses %s structural ownership', (change) => {
    const f = promoted();
    const constraint = f.sketch.constraints![0]!;
    if (change === 'orphan') delete f.sketch.promotions;
    if (change === 'wrong-owner') constraint.promotionId = 'sprm_missing';
    if (change === 'missing-marker') delete constraint.origin;
    if (change === 'missing-constraint') f.sketch.constraints = [];
    if (change === 'duplicate')
      f.sketch.constraints!.push(structuredClone(constraint));
    expect(() => assertSketchProvenance(f.document)).toThrow(
      /promotion owner|owned structural/
    );
  });

  it('checks malformed promotion aliases in undo-only sketch snapshots', () => {
    const f = promoted();
    const snapshot = structuredClone(f.sketch);
    snapshot.promotions![0]!.aliases.vertices[0]!.point = 'end';
    delete f.sketch.promotions;
    f.sketch.constraints = [];
    history(f.document, {
      kind: 'value',
      field: 'nodes',
      key: snapshot.id,
      before: snapshot
    });
    expect(() => assertSketchProvenance(f.document)).toThrow(
      /promotion records are malformed/
    );
  });

  it('rejects malformed or foreign owned payloads and misplaced ownership markers', () => {
    const malformed = promoted();
    malformed.sketch.constraints![0]!.data = {
      constraintKind: 'unknown'
    } as never;
    expect(() => assertSketchProvenance(malformed.document)).toThrow(
      /legal payloads/
    );
    const foreign = promoted();
    foreign.sketch.constraints![0]!.data = {
      constraintKind: 'horizontal',
      objectId: toEntityId('ent_foreign')
    };
    expect(() => assertSketchProvenance(foreign.document)).toThrow(
      /owned members/
    );
    const misplaced = fixture();
    findSketch(misplaced.document, misplaced.sketchId)!.constraints = [
      {
        constraintId: toSketchConstraintId('scon_misplaced'),
        data: {
          constraintKind: 'horizontal',
          objectId: misplaced.sourceObjectId,
          origin: 'promotion-structure'
        } as never
      }
    ];
    expect(() => assertSketchProvenance(misplaced.document)).toThrow(
      /not its data payload/
    );
  });

  it('requires deterministic complete conversion replay identities', () => {
    const f = fixture();
    const payload = {
      sketchId: f.sketchId,
      sourceObjectId: f.sourceObjectId,
      expectedSource: {
        objectKind: 'rectangle',
        width: 'width',
        height: 3,
        centerX: 0,
        centerY: 0
      },
      ids: {
        promotionId: 'sprm_replay',
        edgeIds: Array.from({ length: 64 }, (_, i) => `ent_new_${i}`),
        centerSpokeId: 'ent_new_spoke',
        helperIds: ['ent_new_diagonal']
      }
    };
    f.document.commandLog = [command('sketch.legacy.convert', payload)];
    expect(() => assertSketchProvenance(f.document)).not.toThrow();
    payload.ids.edgeIds[1] = payload.ids.edgeIds[0]!;
    expect(() => assertSketchProvenance(f.document)).toThrow(
      /preassigned identities/
    );
    f.document.commandLog = [command('sketch.legacy.convert', {})];
    f.document.schemaVersion = 36 as ProjectDocument['schemaVersion'];
    expect(() => assertSketchProvenance(f.document)).toThrow(/schema v37/);
  });

  it('refuses an arbitrary replay constraint carrying conversion ownership', () => {
    const f = fixture();
    f.document.commandLog = [
      command('sketch.constraint.add', {
        sketchId: f.sketchId,
        constraint: {
          constraintKind: 'horizontal',
          objectId: f.sourceObjectId,
          origin: 'promotion-structure'
        }
      })
    ];
    expect(() => assertSketchProvenance(f.document)).toThrow(
      /explicit conversion command/
    );
  });

  it('validates explicit structure release without dissolving the alias record', () => {
    const f = promoted();
    f.sketch.constraints = [];
    f.owner.structureConstraintIds = [];
    f.document.commandLog = [
      command('sketch.promotion.release', {
        sketchId: f.sketchId,
        promotionId: f.owner.promotionId
      })
    ];
    expect(() => assertSketchProvenance(f.document)).not.toThrow();
    f.document.schemaVersion = 36 as ProjectDocument['schemaVersion'];
    expect(() => assertSketchProvenance(f.document)).toThrow(/schema v37/);
  });
});

it.each(['boundary profile', 'promotion ownership'] as const)(
  'requires an integer declared schema for authored %s',
  (family) => {
    const f = authored(family);
    for (const version of [null, Number.NaN, '37', 37.5]) {
      const document = structuredClone(f.document);
      Object.assign(document, { schemaVersion: version });
      const before = structuredClone(document);
      expect(() => assertSketchProvenance(document)).toThrow(
        /require project schema v37 or newer/
      );
      expect(() => normalizeDocument(document)).toThrow(/schema/);
      expect(() => new CommandManager(document)).toThrow(
        /require project schema v37 or newer/
      );
      expect(() => replayCommands(document, [])).toThrow(
        /require project schema v37 or newer/
      );
      expect(document).toEqual(before);
    }
  }
);

let socketGlobals: ReturnType<typeof installWorkerSocketGlobals>;
beforeAll(() => {
  socketGlobals = installWorkerSocketGlobals();
});
afterAll(() => {
  socketGlobals.restore();
});

describe.each(['http', 'websocket'])(
  'S04 provenance %s collaboration boundary',
  (transport) => {
    it.each(['boundary profile', 'promotion ownership'] as const)(
      'refuses backdated and accepts current %s without rewriting',
      async (family) => {
        for (const carrier of ['current', 'nested log'] as const)
          for (const version of [36, PROJECT_DOCUMENT_SCHEMA_VERSION]) {
            const f = authored(family);
            const document = structuredClone(
              carrier === 'current' ? f.document : f.base
            );
            delete document.editHistory;
            document.commandLog =
              carrier === 'current'
                ? []
                : [
                    command('transaction', [
                      command('transaction', [structuredClone(f.recorded)])
                    ])
                  ];
            document.schemaVersion =
              version as ProjectDocument['schemaVersion'];
            const before = structuredClone(document);
            const { context, values } = createRoomContext();
            const room = createTestRoom(context, {});
            const url = `https://room.test/?projectId=${document.projectId}`;
            const headers = {
              'x-openzcad-user-id': document.ownerUserId,
              'x-openzcad-display-name': 'Owner',
              'x-openzcad-project-role': 'owner'
            };
            let result: unknown;
            if (transport === 'http') {
              const response = await room.fetch(
                new Request(url, {
                  method: 'POST',
                  headers,
                  body: JSON.stringify({
                    clientId: 'client_provenance_schema',
                    baseVersion: null,
                    document
                  })
                })
              );
              result = await response.json();
            } else {
              const response = await room.fetch(
                new Request(url, {
                  headers: { ...headers, upgrade: 'websocket' }
                })
              );
              expect(response.status).toBe(101);
              const socket = socketGlobals.serverSockets.at(-1)!;
              await socket.receive(
                JSON.stringify({
                  type: 'hello',
                  clientId: 'client_provenance_schema',
                  displayName: 'Owner',
                  baseVersion: null,
                  document: null
                })
              );
              await socket.receive(
                JSON.stringify({
                  type: 'document',
                  clientId: 'client_provenance_schema',
                  baseVersion: null,
                  document
                })
              );
              result = socket.lastFrame();
            }
            if (version === 36) {
              expect(result).toMatchObject({
                type: 'error',
                code: 'document-invalid',
                message:
                  'Sketch boundary provenance and promotion ownership require project schema v37 or newer.'
              });
              expect(values.has('room:latest')).toBe(false);
            } else {
              expect(result).toMatchObject({ type: 'ack' });
              const stored = values.get('room:latest') as ProjectDocument;
              expect(stored.nodes).toEqual(before.nodes);
              expect(stored.commandLog).toEqual(before.commandLog);
            }
            expect(document).toEqual(before);
          }
      }
    );
  }
);
