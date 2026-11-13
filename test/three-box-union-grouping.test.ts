import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type BodyId, type ProjectDocument } from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators,
  remusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import { transformMatrix } from '../packages/kernel-adapter/src/exact-math';
import { exactBooleanOutcome } from '../packages/kernel-adapter/src/exact-boolean-refusal';
import {
  fuseUniformSolidChecked,
  isFaceConnectedSolid,
  solidMeshIsClosed
} from '../packages/kernel-adapter/src/exact-boolean-helpers';
import { importStepWithOwnBudget } from '../packages/kernel-adapter/src/kernel-step-import';

/**
 * Three overlapping boxes unite to the same material however they are
 * grouped (#1246, CAD-006).
 *
 * On Remus 2026.1.121–129, `A ∪ (B ∪ C)` refused in both orders with
 * `exact_only_unattainable` straight from `fuseDetailed`, while `(A ∪ B) ∪ C`
 * built the closed 26748 mm³ solid. The B ∪ C intermediate has an L-shaped
 * planar wall whose reflex corner the next fuse's section ended at, and the
 * kernel's greedy face walk turned that section into an out-and-back spur,
 * leaving the wall unsplit (six free edges). Remus fixed the splitter in
 * esaueng/remus#1625 (`ed07787a`, first packaged in v2026.1.130); this pins the
 * consumer side on the installed pin: every grouping and operand order,
 * native and after a STEP round trip, through the kernel gate and through a
 * document Union of imported STEP bodies — the production reproduction.
 */

type Bounds = readonly [
  readonly [number, number, number],
  readonly [number, number, number]
];
const BOXES = {
  A: [
    [0, 0, 0],
    [30, 18, 24]
  ],
  B: [
    [15, 6, 0],
    [45, 24, 24]
  ],
  C: [
    [-6, 4, 3],
    [24, 22, 27]
  ]
} as const satisfies Record<string, Bounds>;
type Name = keyof typeof BOXES;

/** Volume of the common part of axis-aligned boxes; 0 when they miss. */
function overlapVolume(boxes: readonly Bounds[]): number {
  let volume = 1;
  for (let axis = 0; axis < 3; axis += 1) {
    const lo = Math.max(...boxes.map((box) => box[0][axis]!));
    const hi = Math.min(...boxes.map((box) => box[1][axis]!));
    volume *= Math.max(0, hi - lo);
  }
  return volume;
}

/**
 * The union volume by inclusion–exclusion over the box bounds, independent
 * of the kernel: 3 × 12960 − (7776 + 7776 + 5184) + 4032 = 26748 mm³.
 */
const UNION_VOLUME = (() => {
  const [a, b, c] = [BOXES.A, BOXES.B, BOXES.C];
  return (
    overlapVolume([a]) +
    overlapVolume([b]) +
    overlapVolume([c]) -
    overlapVolume([a, b]) -
    overlapVolume([b, c]) -
    overlapVolume([a, c]) +
    overlapVolume([a, b, c])
  );
})();

/**
 * Material witnesses: a point in each box alone, in all three, in the part
 * of C that rises above A and B, and points inside the combined bounding box
 * that no box covers. Each sits well clear of every face.
 */
const INSIDE = [
  [2, 1, 1], // A only
  [40, 20, 12], // B only
  [-3, 10, 25], // C only, above A and B
  [20, 10, 12], // A ∩ B ∩ C
  [20, 20, 26] // C over the A ∩ B overlap
] as const;
const OUTSIDE = [
  [40, 2, 12], // beside A, below B in y
  [-3, 2, 12], // beside C, below it in y
  [40, 20, 26], // above B, beyond C in x
  [2, 1, 26] // above A, below C in y
] as const;

function expectSameMaterial(kernel: RemusKernel, solid: number) {
  expect(kernel.volume(solid, 0.01)).toBeCloseTo(UNION_VOLUME, 6);
  const report = JSON.parse(
    kernel.validateSolidDetailed(solid) as string
  ) as { errorCount: number };
  expect(report.errorCount).toBe(0);
  expect(isFaceConnectedSolid(kernel, solid)).toBe(true);
  expect(solidMeshIsClosed(kernel, solid)).toBe(true);
  for (const [x, y, z] of INSIDE) {
    expect(kernel.classifyPoint(solid, x, y, z, 1e-6), `${x},${y},${z}`).toBe(
      'inside'
    );
  }
  for (const [x, y, z] of OUTSIDE) {
    expect(kernel.classifyPoint(solid, x, y, z, 1e-6), `${x},${y},${z}`).toBe(
      'outside'
    );
  }
}

function makeBox(kernel: RemusKernel, name: Name): number {
  const [lo, hi] = BOXES[name];
  const solid = kernel.makeBox(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  kernel.transformSolid(
    solid,
    transformMatrix({ x: lo[0], y: lo[1], z: lo[2] }, { x: 0, y: 0, z: 0 })
  );
  return solid;
}

/** Each pair first, then the third box: every grouping of three. */
const GROUPINGS = [
  { pair: ['A', 'B'], third: 'C' },
  { pair: ['B', 'C'], third: 'A' },
  { pair: ['A', 'C'], third: 'B' }
] as const;

/** All twelve grouping/order combinations: pair order × outer order. */
const COMBINATIONS = GROUPINGS.flatMap(({ pair, third }) =>
  [pair, [pair[1], pair[0]] as const].flatMap((inner) =>
    (['pair-first', 'third-first'] as const).map((outer) => ({
      inner,
      third,
      outer,
      label:
        outer === 'pair-first'
          ? `(${inner[0]} ∪ ${inner[1]}) ∪ ${third}`
          : `${third} ∪ (${inner[0]} ∪ ${inner[1]})`
    }))
  )
);

describe('three overlapping boxes at the kernel gate (#1246)', () => {
  let kernel: RemusKernel;
  beforeAll(async () => {
    await loadRemusTranslators();
    kernel = new RemusKernel();
  });
  afterAll(() => kernel.free());

  /** One solid exported to STEP and read back, as an import would. */
  function viaStep(solid: number): number {
    const bytes = remusTranslators().exportStep(
      kernel.serializeSolids(Uint32Array.from([solid]))
    );
    const imported = importStepWithOwnBudget(kernel, bytes);
    expect(imported.solids).toHaveLength(1);
    return imported.solids[0]!;
  }

  function fuse(a: number, b: number, label: string): number {
    const outcome = exactBooleanOutcome(kernel, 'fuse', a, b);
    expect(
      outcome.status,
      outcome.status === 'refused'
        ? `${label}: ${outcome.refusal.kernelCode}`
        : label
    ).toBe('ok');
    return (outcome as { solid: number }).solid;
  }

  for (const intermediate of ['raw', 'unified'] as const) {
    for (const step of [false, true]) {
      it(`every grouping and order builds the same material (${intermediate} intermediate${step ? ', STEP-reloaded operands' : ''})`, () => {
        for (const { inner, third, outer, label } of COMBINATIONS) {
          const first = makeBox(kernel, inner[0]);
          const second = makeBox(kernel, inner[1]);
          // `raw` is the plain fuse; `unified` is the production union gate,
          // which merges coplanar fragments as an imported body would carry.
          let pair =
            intermediate === 'raw'
              ? fuse(first, second, `${label} pair`)
              : fuseUniformSolidChecked(kernel, [first, second]).solid;
          let other = makeBox(kernel, third);
          if (step) {
            pair = viaStep(pair);
            other = viaStep(other);
          }
          const pairVolume = kernel.volume(pair, 0.01);
          const otherVolume = kernel.volume(other, 0.01);
          const result =
            outer === 'pair-first'
              ? fuse(pair, other, label)
              : fuse(other, pair, label);
          expectSameMaterial(kernel, result);
          // The fuse leaves both operands as they were.
          expect(kernel.volume(pair, 0.01)).toBeCloseTo(pairVolume, 9);
          expect(kernel.volume(other, 0.01)).toBeCloseTo(otherVolume, 9);
          // The production gate agrees on the same operands.
          const gated = fuseUniformSolidChecked(
            kernel,
            outer === 'pair-first' ? [pair, other] : [other, pair]
          );
          expect(gated.verdict.strictErrors, label).toBe(0);
          expect(gated.verdict.meshClosed, label).toBe(true);
          expectSameMaterial(kernel, gated.solid);
        }
      });
    }
  }
});

describe('a Union of imported STEP bodies (#1246 production path)', () => {
  let adapter: ExactKernelAdapter | undefined;
  const stepText = new Map<string, string>();

  beforeAll(async () => {
    const io = await loadRemusTranslators();
    const kernel = new RemusKernel();
    try {
      const text = (solid: number) =>
        new TextDecoder().decode(
          io.exportStep(kernel.serializeSolids(Uint32Array.from([solid])))
        );
      for (const name of ['A', 'B', 'C'] as const) {
        stepText.set(name, text(makeBox(kernel, name)));
      }
      // The precomputed intermediates go through the same union gate a
      // document Union does before they are exported.
      for (const [x, y] of [
        ['A', 'B'],
        ['B', 'C'],
        ['A', 'C']
      ] as const) {
        stepText.set(
          `${x}${y}`,
          text(
            fuseUniformSolidChecked(kernel, [
              makeBox(kernel, x),
              makeBox(kernel, y)
            ]).solid
          )
        );
      }
    } finally {
      kernel.free();
    }
  });
  afterAll(() => adapter?.dispose());

  function importBody(
    document: ProjectDocument,
    key: string
  ): { document: ProjectDocument; bodyId: BodyId } {
    return importStepBody(document, {
      name: key,
      sourceName: `${key}.step`,
      artifactId: `artifact_three_box_${key}`,
      stepText: stepText.get(key)!
    });
  }

  it.each([
    ['A', 'BC'],
    ['BC', 'A'],
    ['AB', 'C'],
    ['C', 'AB'],
    ['B', 'AC'],
    ['AC', 'B']
  ])(
    'unites %s (selected first) with %s into the closed 26748 mm³ solid',
    async (firstKey, secondKey) => {
      adapter ??= await createExactKernelAdapter();
      let document = createProjectDocument(
        'Three boxes',
        toUserId('user_three_box')
      );
      const first = importBody(document, firstKey);
      const second = importBody(first.document, secondKey);
      document = second.document;
      const united = new CommandManager(document).execute(
        commandFactories.booleanBodies({
          name: 'Union',
          operation: 'union',
          targetBodyIds: [first.bodyId, second.bodyId]
        })
      );
      const derived = await adapter.syncDocument(united);
      expect(derived.featureWarnings ?? []).toEqual([]);
      expect(derived.warnings).toEqual([]);
      const result = derived.bodyRepresentations[united.bodyOrder.at(-1)!]!;
      expect(result.volume).toBeCloseTo(UNION_VOLUME, 4);
      // Both sources are consumed by the union rather than passed through.
      expect(derived.bodyRepresentations[first.bodyId]?.consumed).toBe(true);
      expect(derived.bodyRepresentations[second.bodyId]?.consumed).toBe(true);
    },
    120_000
  );
});
