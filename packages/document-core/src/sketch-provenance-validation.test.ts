import { describe, expect, it } from 'vitest';
import {
  toEntityId,
  toSketchConstraintId,
  toUserId,
  type DocumentChange,
  type ProjectDocument,
  type SerializedCommand,
  type SketchPromotion
} from '@openzcad/shared';
import { addSketchFeature, createProjectDocument, findSketch } from './index';
import { assertSketchProvenance } from './sketch-provenance-validation';

function fixture() {
  const f = addSketchFeature(
    createProjectDocument('Provenance guard', toUserId('user_test')),
    {
      name: 'Legacy rectangle',
      plane: 'XY',
      objects: [
        {
          objectKind: 'rectangle',
          width: 'width',
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

function history(document: ProjectDocument, change: DocumentChange) {
  document.editHistory = {
    schemaVersion: 1,
    projectId: document.projectId,
    actorUserId: document.ownerUserId,
    cursor: 0,
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

describe('S04 provenance carrier validation', () => {
  it('keeps all legacy envelopes without new fields unchanged', () => {
    const f = fixture();
    const before = structuredClone(f.document);
    for (let schema = 1; schema < 33; schema++) {
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
      f.document.schemaVersion = 32 as ProjectDocument['schemaVersion'];
      expect(() => assertSketchProvenance(f.document)).toThrow(/schema v33/);
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
      f.document.schemaVersion = 32 as ProjectDocument['schemaVersion'];
      expect(() => assertSketchProvenance(f.document)).toThrow(/schema v33/);
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
    f.document.schemaVersion = 32 as ProjectDocument['schemaVersion'];
    expect(() => assertSketchProvenance(f.document)).toThrow(/schema v33/);
  });

  it('does not interpret arbitrary metadata as authored profile or ownership fields', () => {
    const f = fixture();
    f.document.schemaVersion = 32 as ProjectDocument['schemaVersion'];
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
    f.document.schemaVersion = 32 as ProjectDocument['schemaVersion'];
    expect(() => assertSketchProvenance(f.document)).toThrow(/schema v33/);
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
    f.document.schemaVersion = 32 as ProjectDocument['schemaVersion'];
    expect(() => assertSketchProvenance(f.document)).toThrow(/schema v33/);
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
    f.document.schemaVersion = 32 as ProjectDocument['schemaVersion'];
    expect(() => assertSketchProvenance(f.document)).toThrow(/schema v33/);
  });
});
