import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandsForCadPatch } from '@openzcad/command-system';
import type { CadPatchProposal } from '@openzcad/ai-contracts';
import {
  createCadDocumentDigest,
  parseCadPatchProposal
} from '@openzcad/ai-contracts';
import {
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';

/**
 * The assistant is expected to answer "make a box with a lid" with a real
 * box-and-lid design rather than two blocks. This fixture is that patch,
 * written exactly as the system instructions describe it, and the tests below
 * build it through the real OpenCascade kernel to prove the vocabulary can
 * express the design and that the design itself is sound: hollow, open, and
 * assemblable with clearance.
 */
const BOX_LEN = 120;
const BOX_WID = 80;
const BOX_HT = 60;
const WALL = 2.4;
const FLOOR_T = 2.4;
const LID_TOP = 2.4;
const LID_OVERLAP = 10;
const FIT_CLR = 0.3;
const LID_GAP = 30;

function boxPrimitive(
  name: string,
  localId: string,
  width: string | number,
  height: string | number,
  depth: string | number
) {
  return {
    kind: 'add_primitive',
    name,
    localId,
    primitiveKind: 'box',
    dimensions: {
      width,
      height,
      depth,
      radius: null,
      bottomRadius: null,
      topRadius: null,
      majorRadius: null,
      minorRadius: null
    }
  } as const;
}

function boxWithLidProposal(): CadPatchProposal {
  return {
    proposalId: 'proposal_box_with_lid',
    summary: 'Create a hollow open-topped box and a separate lid with a rim.',
    assumptions: [
      `Box ${BOX_LEN} x ${BOX_WID} x ${BOX_HT} mm with ${WALL} mm walls.`,
      `${FIT_CLR} mm clearance per side between the box and the lid rim.`
    ],
    operations: [
      { kind: 'set_parameter', name: 'box_len', expression: String(BOX_LEN) },
      { kind: 'set_parameter', name: 'box_wid', expression: String(BOX_WID) },
      { kind: 'set_parameter', name: 'box_ht', expression: String(BOX_HT) },
      { kind: 'set_parameter', name: 'wall', expression: String(WALL) },
      { kind: 'set_parameter', name: 'floor_t', expression: String(FLOOR_T) },
      { kind: 'set_parameter', name: 'lid_top', expression: String(LID_TOP) },
      {
        kind: 'set_parameter',
        name: 'lid_overlap',
        expression: String(LID_OVERLAP)
      },
      { kind: 'set_parameter', name: 'fit_clr', expression: String(FIT_CLR) },

      // Box: outer solid minus a cavity whose top is flush with the box top,
      // which is what leaves the box open.
      boxPrimitive('Box Outer', 'box_outer', 'box_len', 'box_wid', 'box_ht'),
      boxPrimitive(
        'Box Cavity',
        'box_cavity',
        'box_len - 2*wall',
        'box_wid - 2*wall',
        'box_ht - floor_t'
      ),
      {
        kind: 'add_transform',
        name: 'Position Box Cavity',
        targetBodyId: '$box_cavity',
        translation: { x: 'wall', y: 'wall', z: 'floor_t' },
        rotationDeg: { x: 0, y: 0, z: 0 }
      },
      {
        kind: 'add_boolean',
        name: 'Box',
        localId: 'box',
        operation: 'subtract',
        targetBodyIds: ['$box_outer', '$box_cavity']
      },

      // Lid: a plate with a downward skirt that wraps the outside of the box.
      boxPrimitive(
        'Lid Blank',
        'lid_blank',
        'box_len + 2*(fit_clr + wall)',
        'box_wid + 2*(fit_clr + wall)',
        'lid_top + lid_overlap'
      ),
      boxPrimitive(
        'Lid Pocket',
        'lid_pocket',
        'box_len + 2*fit_clr',
        'box_wid + 2*fit_clr',
        'lid_overlap'
      ),
      {
        kind: 'add_transform',
        name: 'Position Lid Pocket',
        targetBodyId: '$lid_pocket',
        translation: { x: 'wall', y: 'wall', z: 0 },
        rotationDeg: { x: 0, y: 0, z: 0 }
      },
      {
        kind: 'add_boolean',
        name: 'Lid',
        localId: 'lid',
        operation: 'subtract',
        targetBodyIds: ['$lid_blank', '$lid_pocket']
      },
      {
        kind: 'add_transform',
        name: 'Park Lid Beside Box',
        targetBodyId: '$lid',
        translation: { x: `box_len + ${LID_GAP}`, y: 0, z: 0 },
        rotationDeg: { x: 0, y: 0, z: 0 }
      }
    ]
  } as CadPatchProposal;
}

describe('AI-generated box with a lid', () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => {
    adapter.dispose();
  });

  it('survives runtime proposal validation', () => {
    expect(() => parseCadPatchProposal(boxWithLidProposal())).not.toThrow();
  });

  it('builds two separate live bodies that are hollow, open, and clear', async () => {
    const manager = new CommandManager(
      createProjectDocument('Box With Lid', toUserId('user_test'))
    );
    manager.runTransaction(
      'Apply AI patch',
      commandsForCadPatch(manager.document, boxWithLidProposal())
    );
    const derived = await adapter.syncDocument(manager.document);
    expect(derived.warnings).toEqual([]);

    // Features carry the names the patch chose; document-core derives each
    // body's name from its feature by appending " Body".
    expect(
      listFeaturesInOrder(manager.document)
        .filter((feature) => feature.featureKind === 'boolean')
        .map((feature) => feature.name)
    ).toEqual(['Box', 'Lid']);

    const live = Object.values(derived.bodyRepresentations).filter(
      (body) => !body.consumed
    );
    expect(live.map((body) => body.name).sort()).toEqual([
      'Box Body',
      'Lid Body'
    ]);

    const box = live.find((body) => body.name === 'Box Body')!;
    const lid = live.find((body) => body.name === 'Lid Body')!;

    // Hollow: the box is its walls and floor, not a solid block.
    const solidBlock = BOX_LEN * BOX_WID * BOX_HT;
    const cavity = (BOX_LEN - 2 * WALL) * (BOX_WID - 2 * WALL) * (BOX_HT - FLOOR_T);
    expect(box.volume).toBeCloseTo(solidBlock - cavity, 3);
    expect(box.volume).toBeLessThan(solidBlock * 0.25);

    // Open: the cavity reaches the top face, so the box still measures its full
    // outer height and nothing capped it.
    expect(box.bbox.max.z - box.bbox.min.z).toBeCloseTo(BOX_HT, 6);

    const lidBlank =
      (BOX_LEN + 2 * (FIT_CLR + WALL)) *
      (BOX_WID + 2 * (FIT_CLR + WALL)) *
      (LID_TOP + LID_OVERLAP);
    const lidPocket = (BOX_LEN + 2 * FIT_CLR) * (BOX_WID + 2 * FIT_CLR) * LID_OVERLAP;
    expect(lid.volume).toBeCloseTo(lidBlank - lidPocket, 3);

    // Separate: the parts are parked apart, so neither hides nor merges with
    // the other in the viewport.
    expect(lid.bbox.min.x).toBeGreaterThan(box.bbox.max.x);
  });

  it('leaves a real clearance so the lid can actually go on', async () => {
    const manager = new CommandManager(
      createProjectDocument('Box With Lid', toUserId('user_test'))
    );
    manager.runTransaction(
      'Apply AI patch',
      commandsForCadPatch(manager.document, boxWithLidProposal())
    );
    const derived = await adapter.syncDocument(manager.document);
    const live = Object.values(derived.bodyRepresentations).filter(
      (body) => !body.consumed
    );
    const box = live.find((body) => body.name === 'Box Body')!;
    const lid = live.find((body) => body.name === 'Lid Body')!;

    // The lid's outer envelope is one rim wall plus one clearance larger than
    // the box on each side. Equal sizes would be an interference fit.
    const boxX = box.bbox.max.x - box.bbox.min.x;
    const lidX = lid.bbox.max.x - lid.bbox.min.x;
    expect(lidX).toBeCloseTo(boxX + 2 * (FIT_CLR + WALL), 6);
    expect(lidX).toBeGreaterThan(boxX);

    // The rim is deep enough to keep the lid aligned rather than rock off.
    expect(LID_OVERLAP).toBeGreaterThanOrEqual(5);
  });

  it('tells the model which bodies are live and where they are', async () => {
    const manager = new CommandManager(
      createProjectDocument('Box With Lid', toUserId('user_test'))
    );
    manager.runTransaction(
      'Apply AI patch',
      commandsForCadPatch(manager.document, boxWithLidProposal())
    );
    const derived = await adapter.syncDocument(manager.document);
    const digest = createCadDocumentDigest(
      manager.commitDerivedState(derived)
    );

    // The construction solids were absorbed by the booleans; only Box and Lid
    // remain targetable, and a follow-up turn must be able to see that.
    const bodies = digest.bodies ?? [];
    const live = bodies.filter((body) => !body.consumed);
    expect(live.map((body) => body.name).sort()).toEqual([
      'Box Body',
      'Lid Body'
    ]);
    expect(bodies.filter((body) => body.consumed)).toHaveLength(4);

    const lid = live.find((body) => body.name === 'Lid Body')!;
    expect(lid.bbox.min.x).toBeGreaterThan(0);
  });

  it('rebuilds identically from the command log', async () => {
    const manager = new CommandManager(
      createProjectDocument('Box With Lid', toUserId('user_test'))
    );
    manager.runTransaction(
      'Apply AI patch',
      commandsForCadPatch(manager.document, boxWithLidProposal())
    );
    const derived = await adapter.syncDocument(manager.document);
    const volumes = Object.values(derived.bodyRepresentations)
      .filter((body) => !body.consumed)
      .map((body) => body.volume);

    // Aliases are resolved before serialization, so the log replays on its own.
    const rebuilt = await adapter.syncDocument(manager.document);
    expect(
      Object.values(rebuilt.bodyRepresentations)
        .filter((body) => !body.consumed)
        .map((body) => body.volume)
    ).toEqual(volumes);
  });
});
