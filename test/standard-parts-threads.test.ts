import { beforeAll, describe, expect, it } from 'vitest';
import { commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  assertDocumentContentSchema,
  createProjectDocument,
  listFeaturesInOrder,
  setParameter,
  standardPartBody,
  type StandardPartInput
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter,
  type RebuildCacheEvent
} from '@openzcad/kernel-adapter/exact';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * M17 slice 4 (schema v83): simplified threads. A screw, nut or threaded
 * insert stored `thread: 'simplified'` is built without its thread (and an
 * insert without its knurl): exactly the plain blank, to its closed-form
 * volume, with the uncut face named as the thread. It draws in a small
 * fraction of the modeled part's triangles.
 */

const ORIGIN = { x: 0, y: 0, z: 0 };
const UP = { x: 0, y: 0, z: 1 };

function part(
  input: Partial<StandardPartInput>,
  units: 'mm' | 'inch' = 'mm'
): ProjectDocument {
  return standardPartBody(
    createProjectDocument('Parts', toUserId('user_m17'), units),
    {
      name: 'Part',
      partKind: 'screw',
      system: 'iso',
      size: 'M6',
      length: 20,
      origin: ORIGIN,
      axis: UP,
      xDirection: { x: 1, y: 0, z: 0 },
      ...input
    }
  ).document;
}

describe('M17 simplified threads: document contract', () => {
  it('stores a simplified thread at schema v83', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(83);
    const document = part({ thread: 'simplified' });
    expect(() => assertDocumentContentSchema(document)).not.toThrow();
    const old = {
      ...createProjectDocument('Parts', toUserId('user_m17'), 'mm'),
      schemaVersion: 82
    } as unknown as ProjectDocument;
    expect(() =>
      standardPartBody(old, {
        name: 'Part',
        partKind: 'screw',
        system: 'iso',
        size: 'M6',
        length: 20,
        origin: ORIGIN,
        axis: UP,
        thread: 'simplified'
      })
    ).toThrow(/Simplified threads require project schema v83/);
  });

  it('clears a simplified thread when the part is modeled again', () => {
    const document = part({ thread: 'simplified' });
    const screw = listFeaturesInOrder(document).at(-1)!;
    const modeled = commandFactories
      .updateFeature({
        featureId: screw.featureId,
        data: { featureKind: 'standard-part' },
        clearData: ['thread']
      })
      .apply(document);
    expect(listFeaturesInOrder(modeled).at(-1)!.data).not.toHaveProperty(
      'thread'
    );
  });

  it.each([
    [
      'a washer',
      { partKind: 'washer', length: undefined },
      /plain washer has no thread/
    ],
    [
      'a dowel pin',
      { partKind: 'dowel', size: '6' },
      /dowel pin has no thread/
    ],
    ['an unknown form', { thread: 'cosmetic' }, /modeled or simplified/]
  ] as const)('refuses a thread on %s', (_label, patch, message) => {
    expect(() =>
      commandFactories
        .standardPartBody({
          name: 'Part',
          partKind: 'screw',
          system: 'iso',
          size: 'M6',
          length: 20,
          origin: ORIGIN,
          axis: UP,
          thread: 'simplified',
          ...(patch as Partial<StandardPartInput>)
        })
        .validate(createProjectDocument('Parts', toUserId('user_m17'), 'mm'))
    ).toThrow(message);
  });
});

describe('M17 simplified threads: exact build', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  async function built(document: ProjectDocument) {
    const derived = await adapter.syncDocument(document);
    expect(
      [
        ...derived.warnings,
        ...(derived.featureWarnings ?? []).map((w) => w.message)
      ].join('\n')
    ).toBe('');
    const body = derived.bodyRepresentations[document.bodyOrder.at(-1)!]!;
    return {
      body,
      names: new Set(
        body.topology!.faces.map((face) => face.reference?.lineageName)
      ),
      triangles: (body.mesh?.indices?.length ?? 0) / 3
    };
  }

  it('builds an M6 × 20 socket screw as its exact plain envelope', async () => {
    const { body, names } = await built(part({ thread: 'simplified' }));
    // The ISO 4762 M6 head (Ø10 × 6) on the plain Ø6 × 20 shank: no
    // thread, socket or chamfer.
    expect(body.volume).toBeCloseTo(Math.PI * 25 * 6 + Math.PI * 9 * 20, 6);
    expect(body.bbox.max.z - body.bbox.min.z).toBeCloseTo(26, 6);
    expect(names.has('standard-part.face.thread')).toBe(true);
    expect(names.has('standard-part.face.head.top')).toBe(true);
    expect(names.has('standard-part.face.seat')).toBe(true);
    // Top, head side, seat, shank and tip: few edges to sample and draw.
    expect(body.topology!.faces).toHaveLength(5);
    expect(body.topology!.edges.length).toBeLessThanOrEqual(8);
  }, 900_000);

  it.each([
    // ISO 4017 M6 hex head (s 10, k 4) on its shank.
    ['hex', (Math.sqrt(3) / 2) * 100 * 4 + Math.PI * 9 * 20],
    // ISO 10642 M6 countersunk head (dk 13.44, 90°): a cone 3.72 deep to
    // the shank, within the 20 length.
    [
      'countersunk',
      (Math.PI * 3.72 * (6.72 ** 2 + 6.72 * 3 + 9)) / 3 +
        Math.PI * 9 * (20 - 3.72)
    ]
  ] as const)(
    'keeps a %s head’s form',
    async (head, volume) => {
      const { body, names } = await built(part({ head, thread: 'simplified' }));
      expect(body.volume).toBeCloseTo(volume, 6);
      expect(names.has('standard-part.face.thread')).toBe(true);
      expect(names.has('standard-part.face.head.top')).toBe(true);
    },
    900_000
  );

  it('refuses the lengths a modeled screw refuses', async () => {
    const refusal = async (thread?: 'simplified') =>
      (
        await adapter.syncDocument(
          part({ length: 4, ...(thread ? { thread } : {}) })
        )
      ).warnings.join('\n');
    const modeled = await refusal();
    expect(modeled).not.toBe('');
    expect(await refusal('simplified')).toBe(modeled);
  }, 900_000);

  it('leaves a nut’s bore and an insert’s outside plain', async () => {
    const nut = await built(
      part({ partKind: 'nut', length: undefined, thread: 'simplified' })
    );
    expect(nut.names.has('standard-part.face.thread')).toBe(true);
    // The ISO 4032 M6 hex (s 10, m 5.2) less the M6 tap drill, 5 across.
    expect(nut.body.volume).toBeCloseTo(
      ((Math.sqrt(3) / 2) * 100 - Math.PI * 6.25) * 5.2,
      6
    );
    // A typical M3 heat-set insert: 4.6 × 5.7 over a 2.5 tap drill.
    const insert = await built(
      part({
        partKind: 'insert',
        size: 'M3',
        length: undefined,
        thread: 'simplified'
      })
    );
    expect(insert.body.volume).toBeCloseTo(
      Math.PI * (2.3 ** 2 - 1.25 ** 2) * 5.7,
      6
    );
    expect(insert.names.has('standard-part.face.outside')).toBe(true);
  }, 900_000);

  it('draws in a small fraction of the modeled screw’s triangles', async () => {
    const modeled = await built(part({}));
    const simplified = await built(part({ thread: 'simplified' }));
    expect(simplified.triangles).toBeGreaterThan(0);
    // Measured here: about 465,000 against a few thousand.
    expect(modeled.triangles).toBeGreaterThan(20 * simplified.triangles);
  }, 900_000);
});

describe('M17 simplified threads: many parts stay cheap to edit', () => {
  it('reuses parts on a plane through an unrelated edit, lengths and all', async () => {
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      onRebuildCacheEvent: (event) => events.push(event)
    });
    try {
      let document = setParameter(
        addPrimitiveFeature(
          createProjectDocument('Rig', toUserId('user_m17'), 'mm'),
          {
            name: 'Box',
            primitiveKind: 'box',
            dimensions: { width: 30, height: 18, depth: 24 }
          }
        ),
        { name: 'bolt', expression: '20' }
      );
      for (const index of [0, 1, 2])
        document = standardPartBody(document, {
          name: `Screw ${index + 1}`,
          partKind: 'screw',
          system: 'iso',
          size: 'M6',
          length: 'bolt',
          origin: { x: 15 * index, y: 40, z: 0 },
          axis: UP,
          thread: 'simplified'
        }).document;
      const cold = await adapter.syncDocument(document);
      const ids = listFeaturesInOrder(document)
        .slice(1)
        .map((feature) => feature.featureId);
      const lengths = (derived: typeof cold) =>
        ids.map((id) => derived.standardParts?.[id]?.lengthsMm);
      expect(lengths(cold)).toEqual([[20], [20], [20]]);

      // The box is edited: the three parts after it are not rebuilt.
      const box = listFeaturesInOrder(document)[0]!;
      const edited = commandFactories
        .updateFeature({
          featureId: box.featureId,
          data: {
            featureKind: 'primitive',
            dimensions: { width: 31, height: 18, depth: 24 }
          }
        })
        .apply(document);
      events.length = 0;
      const warm = await adapter.syncDocument(edited);
      expect(events.at(-1)).toMatchObject({
        kind: 'independent-reuse',
        replayed: 1
      });
      expect(lengths(warm)).toEqual([[20], [20], [20]]);
      for (const bodyId of edited.bodyOrder.slice(1))
        expect(warm.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
          cold.bodyRepresentations[bodyId]!.volume,
          9
        );

      // A parameter the parts read rebuilds them at the new length.
      const longer = setParameter(edited, { name: 'bolt', expression: '25' });
      const rebuilt = await adapter.syncDocument(longer);
      expect(lengths(rebuilt)).toEqual([[25], [25], [25]]);
      const screw = rebuilt.bodyRepresentations[longer.bodyOrder[1]!]!;
      expect(screw.bbox.max.z - screw.bbox.min.z).toBeCloseTo(31, 6);
    } finally {
      adapter.dispose();
    }
  }, 900_000);
});
