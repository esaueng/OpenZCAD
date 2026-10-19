import { beforeAll, describe, expect, it } from 'vitest';
import {
  parseCadPatchProposal,
  validateCadPatchProposalAgainstDigest,
  type CadDocumentDigest
} from '@openzcad/ai-contracts';
import {
  CommandManager,
  commandFactories,
  commandsForCadPatch,
  composeCommands
} from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type BodyId, type ProjectDocument } from '@openzcad/shared';

/**
 * R01-D: the assistant can create datum planes and build on them. The JSON
 * below is what strict structured output sends — every field present, unused
 * ones null — so the parser's normalization is exercised as the model uses it.
 */
const canonical = (plane: string, offset: number | string = 0) => ({
  type: 'canonical',
  plane,
  offset,
  datum: null
});
const datumSource = (datum: string) => ({
  type: 'datum',
  plane: null,
  offset: null,
  datum
});
const offsetPlane = (
  name: string,
  localId: string | null,
  source: unknown,
  offset: number | string,
  reverseNormal: boolean | null = null
) => ({
  kind: 'add_datum_plane',
  name,
  localId,
  definition: { kind: 'offset', source, sources: null, offset, reverseNormal }
});
const proposal = (operations: unknown[]) => ({
  proposalId: 'p1',
  summary: 'Datum planes',
  assumptions: [],
  operations
});

describe('R01-D datum operations: contract', () => {
  it('parses strict-output datum operations into their typed form', () => {
    const parsed = parseCadPatchProposal(
      proposal([
        offsetPlane('Lid plane', 'lid', canonical('XY'), 'lid_z'),
        {
          kind: 'add_datum_plane',
          name: 'Middle',
          localId: null,
          definition: {
            kind: 'midplane',
            source: null,
            sources: [canonical('XY', 0), datumSource('$lid')],
            offset: null,
            reverseNormal: true
          }
        },
        {
          kind: 'add_datum_sketch',
          name: 'Lid sketch',
          localId: 'lid_sketch',
          datum: '$lid',
          objects: [
            {
              objectKind: 'circle',
              centerX: 0,
              centerY: 0,
              radius: 3
            }
          ]
        }
      ])
    );
    expect(parsed.operations[0]).toEqual({
      kind: 'add_datum_plane',
      name: 'Lid plane',
      localId: 'lid',
      definition: {
        kind: 'offset',
        source: { type: 'canonical', plane: 'XY', offset: 0 },
        offset: 'lid_z'
      }
    });
    expect(parsed.operations[1]).toMatchObject({
      definition: {
        kind: 'midplane',
        sources: [
          { type: 'canonical', plane: 'XY', offset: 0 },
          { type: 'datum', datum: '$lid' }
        ],
        reverseNormal: true
      }
    });
  });

  it.each([
    [
      'a datum alias used before it is declared',
      [
        {
          kind: 'add_datum_sketch',
          name: 'Early',
          localId: null,
          datum: '$lid',
          objects: [{ objectKind: 'circle', centerX: 0, centerY: 0, radius: 1 }]
        }
      ],
      /before an earlier add_datum_plane declares/
    ],
    [
      'a midplane with one source',
      [
        {
          kind: 'add_datum_plane',
          name: 'Half',
          localId: null,
          definition: {
            kind: 'midplane',
            source: canonical('XY'),
            sources: null,
            offset: null,
            reverseNormal: null
          }
        }
      ],
      /exactly two sources/
    ],
    [
      'a canonical source that also names a datum',
      [
        offsetPlane(
          'Mixed',
          null,
          { type: 'canonical', plane: 'XY', offset: 0, datum: 'feat_x' },
          2
        )
      ],
      /no datum/
    ],
    [
      'an offset plane without an offset',
      [offsetPlane('Lost', null, canonical('XY'), null as never)],
      /one source and an offset/
    ]
  ])('refuses %s', (_label, operations, message) => {
    expect(() => parseCadPatchProposal(proposal(operations))).toThrow(message);
  });

  it('refuses a plain datum id that is not a datum plane in the digest', () => {
    const parsed = parseCadPatchProposal(
      proposal([offsetPlane('Up', null, datumSource('feat_box'), 2)])
    );
    const digest = {
      parameters: [],
      features: [
        {
          featureId: 'feat_box',
          name: 'Box',
          featureKind: 'primitive',
          suppressed: false
        }
      ]
    } as unknown as CadDocumentDigest;
    expect(() => validateCadPatchProposalAgainstDigest(parsed, digest)).toThrow(
      'add_datum_plane datum feat_box is not a datum plane'
    );
  });
});

describe('R01-D datum operations: compiled and built', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  function applyProposal(document: ProjectDocument, operations: unknown[]) {
    const manager = new CommandManager(document);
    const commands = commandsForCadPatch(
      document,
      parseCadPatchProposal(proposal(operations))
    );
    manager.execute(composeCommands('Apply proposal', commands));
    return manager;
  }

  it('builds a padded sketch on a parameter-driven datum and mirrors across another', async () => {
    const base = new CommandManager(
      createProjectDocument('AI datums', toUserId('user_ai_datum'))
    );
    base.execute(
      commandFactories.setParameter({ name: 'lid_z', expression: '10' })
    );
    const manager = applyProposal(base.document, [
      offsetPlane('Lid plane', 'lid', canonical('XY'), 'lid_z'),
      {
        kind: 'add_datum_sketch',
        name: 'Lid sketch',
        localId: 'lid_sketch',
        datum: '$lid',
        objects: [
          {
            objectKind: 'rectangle',
            centerX: 0,
            centerY: 0,
            width: 4,
            height: 6
          }
        ]
      },
      {
        kind: 'add_extrude',
        name: 'Lid pad',
        localId: 'pad',
        sketchId: '$lid_sketch',
        distance: 5,
        samplePoint: null
      },
      offsetPlane('Side plane', 'side', canonical('YZ'), 30),
      {
        kind: 'add_datum_mirror',
        name: 'Far pad',
        localId: null,
        targetBodyId: '$pad',
        datum: '$side'
      }
    ]);
    const document = manager.document;
    const datums = listFeaturesInOrder(document).filter(
      (feature) => feature.data.featureKind === 'datum-plane'
    );
    expect(datums.map((feature) => feature.name)).toEqual([
      'Lid plane',
      'Side plane'
    ]);
    const [padId, mirrorId] = document.bodyOrder as [BodyId, BodyId];
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const pad = derived.bodyRepresentations[padId]!.bbox;
    expect(pad.min.z).toBeCloseTo(10, 6);
    expect(pad.max.z).toBeCloseTo(15, 6);
    const mirrored = derived.bodyRepresentations[mirrorId]!.bbox;
    expect(mirrored.min.x).toBeCloseTo(58, 6);
    expect(mirrored.max.x).toBeCloseTo(62, 6);

    // The datum follows its parameter, and everything built on it follows.
    manager.execute(
      commandFactories.setParameter({ name: 'lid_z', expression: '20' })
    );
    const moved = await adapter.syncDocument(manager.document);
    expect(moved.bodyRepresentations[padId]!.bbox.min.z).toBeCloseTo(20, 6);

    // One undo takes the whole proposal back.
    manager.undo();
    manager.undo();
    expect(
      listFeaturesInOrder(manager.document).some(
        (feature) => feature.data.featureKind === 'datum-plane'
      )
    ).toBe(false);
  });

  it('splits a body at a datum and names both halves for later operations', async () => {
    const block = addPrimitiveFeature(
      createProjectDocument('AI split', toUserId('user_ai_datum')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 20 }
      }
    );
    const [blockId] = block.bodyOrder as [BodyId];
    const manager = applyProposal(block, [
      offsetPlane('Cut plane', 'cut', canonical('XY'), 8),
      {
        kind: 'add_datum_split',
        name: 'Cut',
        localId: 'top',
        secondLocalId: 'bottom',
        targetBodyId: blockId,
        datum: '$cut'
      },
      offsetPlane('Side plane', 'side', canonical('YZ'), 30),
      {
        kind: 'add_datum_mirror',
        name: 'Far bottom',
        localId: null,
        targetBodyId: '$bottom',
        datum: '$side'
      }
    ]);
    const split = listFeaturesInOrder(manager.document).find(
      (feature) => feature.data.featureKind === 'split'
    )!;
    expect(split.data).toMatchObject({
      targetBodyId: blockId,
      plane: { type: 'datum' }
    });
    const topId = split.bodyId!;
    const bottomId =
      split.data.featureKind === 'split' ? split.data.secondBodyId : null;
    const mirror = listFeaturesInOrder(manager.document).find(
      (feature) => feature.data.featureKind === 'mirror'
    )!;
    expect(mirror.data).toMatchObject({ targetBodyId: bottomId });
    const derived = await adapter.syncDocument(manager.document);
    expect(derived.warnings).toEqual([]);
    const z = (id: BodyId) => {
      const { min, max } = derived.bodyRepresentations[id]!.bbox;
      return [min.z, max.z].map((value) => Math.round(value * 1e6) / 1e6);
    };
    expect(z(topId)).toEqual([8, 20]);
    expect(z(bottomId!)).toEqual([0, 8]);
    expect(z(mirror.bodyId!)).toEqual([0, 8]);
    expect(derived.bodyRepresentations[blockId]?.consumed).toBe(true);
  });

  it('refuses a datum split of a body the proposal already consumed', () => {
    const block = addPrimitiveFeature(
      createProjectDocument('AI split twice', toUserId('user_ai_datum')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 20 }
      }
    );
    const [blockId] = block.bodyOrder as [BodyId];
    const split = (name: string) => ({
      kind: 'add_datum_split',
      name,
      localId: null,
      secondLocalId: null,
      targetBodyId: blockId,
      datum: '$cut'
    });
    expect(() =>
      applyProposal(block, [
        offsetPlane('Cut plane', 'cut', canonical('XY'), 8),
        split('Cut'),
        split('Cut again')
      ])
    ).toThrow();
  });
});
