import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectTriangleMeshClosure } from '../packages/kernel-adapter/src/boolean-result-validation';
import {
  createCadDocumentDigest,
  createGrowingHolderProposal,
  parseCadPatchProposal,
  validateCadPatchProposalAgainstDigest
} from '@openzcad/ai-contracts';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument, setParameter } from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type ProjectDocument,
  type UnitSystem
} from '@openzcad/shared';
import { preflightCadPatch } from '../apps/web/src/lib/aiPatchPreflight';
import {
  RemusKernel,
  loadRemusTranslators,
  remusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import { syntheticHolderSolid } from './support/synthetic-holder';
import { buildDocumentHistory } from '../packages/kernel-adapter/src/exact-build-loop';

/**
 * H01 "equivalent units": the same STEP source, parameterized in an inch
 * document, must measure, grow and export the same metal as it does in a
 * millimetre document. The STEP file itself is in millimetres; the importer
 * scales it into document units, so every measured number below is the
 * millimetre figure divided by 25.4, and the export scales back.
 */

const MM_PER_INCH = 25.4;
const selection = { featureIds: [], bodyIds: [], topologies: [] };

/** Independent physical material witnesses, clear of every boundary. */
function expectGrownMaterial(document: ProjectDocument): number[] {
  const native = new RemusKernel();
  try {
    const bodyId = document.derived.exportableBodyIds[0]!;
    const solids = buildDocumentHistory(native, document).shapes.get(
      bodyId
    )!.solids;
    expect(solids).toHaveLength(1);
    expect(native.validateSolid(solids[0]!)).toBe(0);
    expect(native.getSolidShells(solids[0]!)).toHaveLength(1);
    const factor = document.units === 'inch' ? MM_PER_INCH : 1;
    const witnesses: Array<[number, number, number, 'inside' | 'outside']> = [
      [30, 4, 10, 'inside'],
      [30, 7.8, 19, 'inside'],
      [30, 8.2, 10, 'outside'],
      [-2, 10, 10, 'inside'],
      [61, 10, 10, 'inside'],
      [-3.6, 4, 10, 'outside'],
      [4.8, 15, 8, 'inside'],
      [5.2, 15, 8, 'outside'],
      [30, 4, -0.2, 'outside'],
      [30, 4, 20.2, 'outside']
    ];
    for (const x of [0.6, 59.4]) {
      witnesses.push(
        [x, 19, 1, 'outside'],
        [x, 19, 10, 'outside'],
        [x, 21.2, 17, 'outside'],
        [x, 21.7, 17, 'inside'],
        [x, 21.7, 18.5, 'outside'],
        [x, 22.2, 18.5, 'inside'],
        [x, 22.8, 19.5, 'outside'],
        [x, 23.2, 19.5, 'inside']
      );
    }
    for (const [x, y, z, expected] of witnesses)
      expect(
        native.classifyPoint(
          solids[0]!,
          x / factor,
          y / factor,
          z / factor,
          1e-7 / factor
        ),
        `${document.units}: material at ${x},${y},${z} mm`
      ).toBe(expected);
    // This bracket's tight outer extrema are its planar corner vertices.
    // The generic kernel AABB also includes untrimmed countersink carriers.
    const points = [...native.getSolidVertices(solids[0]!)].map((vertex) =>
      [...native.getVertexPosition(vertex)].map((value) => value * factor)
    );
    const bounds = [0, 1, 2]
      .map((axis) => Math.min(...points.map((p) => p[axis]!)))
      .concat(
        [0, 1, 2].map((axis) => Math.max(...points.map((p) => p[axis]!)))
      );
    for (const [index, expected] of [-3.4, 0, 0, 63.4, 32, 20].entries())
      expect(bounds[index]).toBeCloseTo(expected, 6);
    return bounds;
  } finally {
    native.free();
  }
}

describe(
  'growing-holder recipe in an inch document',
  { timeout: 300_000 },
  () => {
    let adapter: ExactKernelAdapter;
    let stepText: string;

    beforeAll(async () => {
      adapter = await createExactKernelAdapter();
      await loadRemusTranslators();
      const kernel = new RemusKernel();
      try {
        stepText = new TextDecoder().decode(
          remusTranslators().exportStep(
            kernel.serializeSolids(Uint32Array.of(syntheticHolderSolid(kernel)))
          )
        );
      } finally {
        kernel.free();
      }
    }, 300_000);
    afterAll(() => adapter.dispose());

    async function imported(units: UnitSystem, text = stepText) {
      const manager = new CommandManager(
        createProjectDocument('Bracket', toUserId('user_units'), units)
      );
      manager.execute(
        commandFactories.importStep({
          name: 'Bracket',
          artifactId: 'bracket',
          sourceName: 'bracket.step',
          stepText: text
        })
      );
      const derived = await adapter.syncDocument(manager.document);
      return { ...manager.document, derived } as ProjectDocument;
    }

    const holderOf = (document: ProjectDocument) =>
      document.derived.bodyRepresentations[
        document.derived.exportableBodyIds[0]!
      ]!;

    it('measures the opening in inches exactly as the millimetre document does', async () => {
      const inch = await imported('inch');
      const opening = holderOf(inch).topology?.recognizedOpening;
      expect(opening?.status).toBe('recognized');
      if (opening?.status !== 'recognized') return;
      // Every published length is the millimetre document's figure over 25.4,
      // to the recognizer's own rounding of a millionth of a millimetre.
      const mmOpening = holderOf(await imported('mm')).topology
        ?.recognizedOpening;
      expect(mmOpening?.status).toBe('recognized');
      if (mmOpening?.status !== 'recognized') return;
      const inches = (mm: number) => mm / MM_PER_INCH;
      expect(opening.opening.axis).toBe(mmOpening.opening.axis);
      expect(opening.opening.sourceOpening).toBeCloseTo(
        inches(mmOpening.opening.sourceOpening),
        5
      );
      expect(opening.opening.minimumOpening).toBeCloseTo(
        inches(mmOpening.opening.minimumOpening),
        5
      );
      expect(opening.opening.center).toBeCloseTo(
        inches(mmOpening.opening.center),
        5
      );
      expect(opening.opening.cuts[0]).toBeCloseTo(
        inches(mmOpening.opening.cuts[0]),
        5
      );
      expect(opening.opening.cuts[1]).toBeCloseTo(
        inches(mmOpening.opening.cuts[1]),
        5
      );
      expect(opening.opening.section).toHaveLength(
        mmOpening.opening.section.length
      );
    });

    it('preflights the exact inch recipe with one exportable body', async () => {
      const inch = await imported('inch');
      const proposal = createGrowingHolderProposal(inch, selection);
      expect(proposal).not.toBeNull();
      expect(proposal!.summary).toContain('1.73 inch opening of Bracket');
      const digest = createCadDocumentDigest(inch, selection);
      const parsed = validateCadPatchProposalAgainstDigest(
        parseCadPatchProposal(structuredClone(proposal!), digest),
        digest
      );
      const preflight = await preflightCadPatch(inch, parsed, (candidate) =>
        adapter.syncDocument(candidate)
      );
      expect(preflight.candidate.derived.warnings).toEqual([]);
      expect(preflight.candidate.derived.exportableBodyIds).toHaveLength(1);
      expect(holderOf(preflight.candidate).bbox.min.x).toBeCloseTo(0, 6);
      expect(holderOf(preflight.candidate).bbox.max.x).toBeCloseTo(
        60 / MM_PER_INCH,
        6
      );
      const native = new RemusKernel();
      try {
        const resultId = preflight.candidate.derived.exportableBodyIds[0]!;
        const solids = buildDocumentHistory(
          native,
          preflight.candidate
        ).shapes.get(resultId)?.solids;
        expect(solids).toHaveLength(1);
        expect(native.validateSolid(solids![0]!)).toBe(0);
        expect(native.getSolidShells(solids![0]!)).toHaveLength(1);
      } finally {
        native.free();
      }
    });

    it('grows by an inch expression and exports the same metal as the millimetre document', async () => {
      const inch = await imported('inch');
      const proposal = createGrowingHolderProposal(inch, selection);
      const digest = createCadDocumentDigest(inch, selection);
      const parsed = validateCadPatchProposalAgainstDigest(
        parseCadPatchProposal(structuredClone(proposal!), digest),
        digest
      );
      const preflight = await preflightCadPatch(inch, parsed, (candidate) =>
        adapter.syncDocument(candidate)
      );
      expect(preflight.candidate.derived.warnings).toEqual([]);
      expect(preflight.candidate.derived.exportableBodyIds).toHaveLength(1);
      const applied = holderOf(preflight.candidate);
      // Applying the recipe preserves its measured 44 mm opening.
      expect(applied.bbox.min.x).toBeCloseTo(0, 6);
      expect(applied.bbox.max.x).toBeCloseTo(60 / MM_PER_INCH, 6);

      // Two inches is 50.8 mm: the opening grows 6.8 mm, 3.4 mm per side.
      const grown = setParameter(preflight.candidate, {
        name: 'opening_width',
        expression: '2'
      });
      const derived = await adapter.syncDocument(grown);
      expect(derived.warnings).toEqual([]);
      const inchHolder =
        derived.bodyRepresentations[derived.exportableBodyIds[0]!]!;
      expect(
        inspectTriangleMeshClosure(
          inchHolder.mesh.vertices,
          inchHolder.mesh.indices
        )
      ).toMatchObject({
        boundaryEdges: 0,
        nonManifoldEdges: 0,
        inconsistentWindingEdges: 0
      });
      expect(inchHolder.bbox.min.x).toBeCloseTo(-3.4 / MM_PER_INCH, 6);
      expect(inchHolder.bbox.max.x).toBeCloseTo(63.4 / MM_PER_INCH, 6);

      // The exported STEP is in millimetres again: reimported into a millimetre
      // document it measures 50.8 across the opening and the same outer span.
      const exported = await adapter.exportStep(
        { ...grown, derived },
        derived.exportableBodyIds
      );
      const reimported = await imported('mm', exported);
      const mmHolder = holderOf(reimported);
      expect(mmHolder.bbox.min.x).toBeCloseTo(-3.4, 4);
      expect(mmHolder.bbox.max.x).toBeCloseTo(63.4, 4);
      const reopening = mmHolder.topology?.recognizedOpening;
      expect(reopening?.status).toBe('recognized');
      if (reopening?.status === 'recognized')
        expect(reopening.opening.sourceOpening).toBeCloseTo(50.8, 4);

      // And it is the same metal the millimetre document produces at 50.8.
      const mm = await imported('mm');
      const mmProposal = createGrowingHolderProposal(mm, selection)!;
      const mmDigest = createCadDocumentDigest(mm, selection);
      const mmPreflight = await preflightCadPatch(
        mm,
        validateCadPatchProposalAgainstDigest(
          parseCadPatchProposal(structuredClone(mmProposal), mmDigest),
          mmDigest
        ),
        (candidate) => adapter.syncDocument(candidate)
      );
      const mmGrown = await adapter.syncDocument(
        setParameter(mmPreflight.candidate, {
          name: 'opening_width',
          expression: '50.8'
        })
      );
      expect(mmGrown.warnings).toEqual([]);
      expect(mmGrown.exportableBodyIds).toHaveLength(1);
      const inchBounds = expectGrownMaterial({ ...grown, derived });
      const mmBounds = expectGrownMaterial({
        ...setParameter(mmPreflight.candidate, {
          name: 'opening_width',
          expression: '50.8'
        }),
        derived: mmGrown
      });
      const exportedBounds = expectGrownMaterial(reimported);
      // Compare f64 B-Rep bounds, not the display's f32 projection, at the
      // same physical precision after scaling back from document units.
      for (let axis = 0; axis < 6; axis++) {
        expect(inchBounds[axis]).toBeCloseTo(mmBounds[axis]!, 6);
        expect(exportedBounds[axis]).toBeCloseTo(mmBounds[axis]!, 6);
      }
    });

    it('offers the arm height control on the hole-free holder in inches', async () => {
      const kernel = new RemusKernel();
      let openText: string;
      try {
        openText = new TextDecoder().decode(
          remusTranslators().exportStep(
            kernel.serializeSolids(
              Uint32Array.of(syntheticHolderSolid(kernel, { holes: false }))
            )
          )
        );
      } finally {
        kernel.free();
      }
      const inch = await imported('inch', openText);
      const mm = await imported('mm', openText);
      const inchOpening = holderOf(inch).topology?.recognizedOpening;
      const mmOpening = holderOf(mm).topology?.recognizedOpening;
      expect(mmOpening?.status).toBe('recognized');
      expect(inchOpening?.status).toBe('recognized');
      if (
        inchOpening?.status !== 'recognized' ||
        mmOpening?.status !== 'recognized'
      )
        return;
      expect(mmOpening.opening.height).toBeDefined();
      expect(inchOpening.opening.height).toBeDefined();
      if (!mmOpening.opening.height || !inchOpening.opening.height) return;
      expect(inchOpening.opening.height.sourceHeight).toBeCloseTo(
        mmOpening.opening.height.sourceHeight / MM_PER_INCH,
        5
      );
      expect(inchOpening.opening.height.minimumHeight).toBeCloseTo(
        mmOpening.opening.height.minimumHeight / MM_PER_INCH,
        5
      );
    });
  }
);
