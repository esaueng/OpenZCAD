import {
  createProjectDocument,
  importStepBody,
  setParameter
} from '../packages/document-core/src/index';
import {
  CommandManager,
  growingHolderCommand
} from '../packages/command-system/src/index';
import { toUserId, type SketchObjectData } from '../packages/shared/src/index';
import { buildDocumentHistory } from '../packages/kernel-adapter/src/exact-build-loop';
import {
  recognizeOpening,
  type OpeningAxis
} from '../packages/kernel-adapter/src/opening-recognition';
import {
  RemusKernel,
  loadRemusTranslators,
  remusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { syntheticHolderSolid, translated } from './support/synthetic-holder';

beforeAll(async () => {
  await loadRemusTranslators();
});

/** Order-insensitive view of a numeric line/arc profile. */
const profileKeys = (section: SketchObjectData[]): string[] =>
  section
    .map((object) =>
      object.objectKind === 'line'
        ? [
            [object.x1, object.y1],
            [object.x2, object.y2]
          ]
            .sort((a, b) => Number(a[0]) - Number(b[0]) || Number(a[1]) - Number(b[1]))
            .map((p) => p.join(','))
            .join(' ')
        : JSON.stringify(object)
    )
    .sort();

const rect = (u0: number, v0: number, u1: number, v1: number): string[] =>
  profileKeys([
    { objectKind: 'line', x1: u0, y1: v0, x2: u1, y2: v0 },
    { objectKind: 'line', x1: u1, y1: v0, x2: u1, y2: v1 },
    { objectKind: 'line', x1: u1, y1: v1, x2: u0, y2: v1 },
    { objectKind: 'line', x1: u0, y1: v1, x2: u0, y2: v0 }
  ]);

const placements: {
  axis: OpeningAxis;
  matrix: Float64Array;
  section: string[];
  envelope: { min: number[]; max: number[] };
}[] = [
  {
    axis: 'x',
    matrix: Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1),
    section: rect(0, 0, 8, 20),
    envelope: { min: [-0.5, 0, 0], max: [60.5, 32, 20] }
  },
  {
    axis: 'y',
    matrix: Float64Array.of(0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1),
    section: rect(-8, -20, 0, 0),
    envelope: { min: [-32, -0.5, 0], max: [0, 60.5, 20] }
  },
  {
    axis: 'z',
    matrix: Float64Array.of(0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1),
    section: rect(-20, 0, 0, 8),
    envelope: { min: [-20, 0, -0.5], max: [0, 32, 60.5] }
  }
];

/** Export and re-import, the way every imported body reaches the kernel. */
function roundTripped(kernel: RemusKernel, solid: number): number {
  return kernel.deserializeSolids(
    remusTranslators().importStep(
      remusTranslators().exportStep(kernel.serializeSolids(Uint32Array.of(solid)))
    )
  )[0]!;
}

function importedDocument(kernel: RemusKernel, solid: number) {
  const stepText = new TextDecoder().decode(
    remusTranslators().exportStep(kernel.serializeSolids(Uint32Array.of(solid)))
  );
  return importStepBody(createProjectDocument('Part', toUserId('local_part')), {
    name: 'Part',
    artifactId: 'part',
    sourceName: 'part.step',
    stepText
  });
}

describe('opening recognition', () => {
  let kernel: RemusKernel;
  beforeEach(() => {
    kernel = new RemusKernel();
  });
  afterEach(() => {
    kernel.free();
  });

  for (const placement of placements) {
    it(`measures the bracket's opening along ${placement.axis} and the recipe builds`, () => {
      const solid = roundTripped(
        kernel,
        kernel.copyAndTransformSolid(syntheticHolderSolid(kernel), placement.matrix)
      );
      const result = recognizeOpening(kernel, solid);
      expect(result.status).toBe('recognized');
      if (result.status !== 'recognized') return;
      const [x, y, z] = ['x', 'y', 'z'] as const;
      expect(result.opening).toMatchObject({
        axis: placement.axis,
        envelope: {
          min: { [x]: placement.envelope.min[0], [y]: placement.envelope.min[1], [z]: placement.envelope.min[2] },
          max: { [x]: placement.envelope.max[0], [y]: placement.envelope.max[1], [z]: placement.envelope.max[2] }
        },
        // The boss on the left arm's inner face ends at 8.4; the straight
        // floor runs from there to the right arm, and each cut keeps 0.5 mm
        // clear of a change of section.
        cuts: [8.9, 51.5],
        center: 30,
        sourceOpening: 44,
        minimumOpening: 1.5
      });
      expect(profileKeys(result.opening.section)).toEqual(placement.section);
      expect(result.evidence).toMatchObject({
        candidate: { axis: placement.axis, opening: 44, innerFaces: [8, 52] },
        straightRun: [8.4, 52],
        sectionEdges: 4
      });
      expect(Math.abs(result.evidence.symmetry.planeOffset)).toBeCloseTo(30, 9);

      // The measured recipe compiles and builds exactly, at the source opening
      // and grown, without any hand-written value.
      const imported = importedDocument(kernel, solid);
      const manager = new CommandManager(imported.document);
      const compiled = growingHolderCommand(manager.document, {
        version: 1,
        name: 'Bracket opening',
        targetBodyId: imported.bodyId,
        parameter: 'opening_width',
        ...result.opening
      });
      manager.execute(compiled.command);
      const axisIndex = { x: 0, y: 1, z: 2 }[placement.axis];
      for (const width of [44, 60]) {
        const built = buildDocumentHistory(
          kernel,
          setParameter(manager.document, {
            name: 'opening_width',
            expression: String(width)
          })
        );
        expect(built.warnings.map((w) => JSON.stringify(w))).toEqual([]);
        const holder = built.shapes.get(compiled.bodyId)!.solids[0]!;
        expect(kernel.validateSolid(holder)).toBe(0);
        const bounds = Array.from(kernel.boundingBox(holder));
        expect(bounds[axisIndex]).toBeCloseTo(30 - (width + 16) / 2 - 0.5, 6);
        expect(bounds[axisIndex + 3]).toBeCloseTo(30 + (width + 16) / 2 + 0.5, 6);
      }
    }, 120_000);
  }

  it('refuses a solid with no facing pair across an empty gap', () => {
    const result = recognizeOpening(kernel, kernel.makeBox(10, 20, 30));
    expect(result.status).toBe('unsupported');
    if (result.status !== 'unsupported') return;
    expect(result.reason).toMatch(/No pair of inward-facing/);
  });

  it('keeps the cuts out of a pocket that interrupts the straight section', () => {
    const pocket = translated(kernel, kernel.makeBox(4, 10, 10), 18, -1, 5);
    const solid = roundTripped(kernel, kernel.cut(syntheticHolderSolid(kernel), pocket));
    const result = recognizeOpening(kernel, solid);
    expect(result).toMatchObject({ status: 'recognized' });
    if (result.status !== 'recognized') return;
    expect(result.evidence.straightRun).toEqual([22, 52]);
    expect(result.opening.cuts).toEqual([22.5, 51.5]);
    expect(result.opening.minimumOpening).toBeCloseTo(44 - 29 + 0.1, 9);
    expect(profileKeys(result.opening.section)).toEqual(rect(0, 0, 8, 20));
  });

  it('reports two equal openings as ambiguous until one is selected', () => {
    const profile = kernel.makePolygon(
      new Float64Array([
        0, 0, 0, 60, 0, 0, 60, 32, 0, 52, 32, 0, 52, 8, 0, 34, 8, 0, 34, 32, 0,
        26, 32, 0, 26, 8, 0, 8, 8, 0, 8, 32, 0, 0, 32, 0
      ])
    );
    const solid = roundTripped(kernel, kernel.extrude(profile, 0, 0, 1, 20));
    const result = recognizeOpening(kernel, solid);
    expect(result.status).toBe('ambiguous');
    if (result.status !== 'ambiguous') return;
    expect(result.candidates.length).toBeGreaterThanOrEqual(2);
    expect(result.candidates.slice(0, 2).map((c) => c.opening)).toEqual([18, 18]);
    const chosen = result.candidates.find((c) => c.innerFaces[0] === 8)!;
    const guided = recognizeOpening(kernel, solid, {
      faces: [chosen.faceB, chosen.faceA]
    });
    expect(guided.status).toBe('recognized');
    if (guided.status !== 'recognized') return;
    expect(guided.opening).toMatchObject({
      axis: 'x',
      sourceOpening: 18,
      center: 17,
      cuts: [8.5, 25.5]
    });
    expect(recognizeOpening(kernel, solid, { axis: 'y' }).status).toBe('unsupported');
  });
});
