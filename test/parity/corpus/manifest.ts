/**
 * The STEP parity corpus manifest.
 *
 * Every entry is one STEP file measured through BOTH kernel adapters. The
 * categories map 1:1 onto the Z1.3 design in `docs/kernel-execution-plan.md`:
 *
 *   a  exports produced from `samples/` and from the adapters themselves
 *   b  unit variants — mm, inch `CONVERSION_BASED_UNIT`, degree plane angles,
 *      and a file with no `GLOBAL_UNIT_ASSIGNED_CONTEXT` at all
 *   c  cavity/void solids (`BREP_WITH_VOIDS`)
 *   d  multi-solid files
 *   e  NURBS-heavy files
 *   f  known-hostile files, mined from `test/step-import-compat.test.ts` and
 *      from what the adapters actually refuse today
 *
 * `referenceVolumeMm3` is the kernel-INDEPENDENT truth where one exists: for
 * hand-authored boxes it is arithmetic, not a kernel reading. It is the only
 * oracle in this suite that neither kernel can talk us out of, which is what
 * makes the inch case (category b) decidable rather than merely divergent.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type CorpusCategory =
  | 'a-exports'
  | 'b-units'
  | 'c-voids'
  | 'd-multi-solid'
  | 'e-nurbs'
  | 'f-hostile';

export interface CorpusEntry {
  /** Stable id: the baseline key, the pin key, and the file's basename. */
  id: string;
  category: CorpusCategory;
  /** One line: what this file is testing. Mirrored into the file's header. */
  purpose: string;
  /**
   * Path relative to the repository root. Corpus-owned files live in
   * `test/parity/corpus/`; the `samples/` entries point at the shipped sample
   * files so the corpus measures the real artifacts rather than copies that
   * can drift.
   */
  path: string;
  /**
   * Exact volume in mm³ derived from the file's own construction, independent
   * of any kernel. Absent when the shape has no closed-form volume (adapter
   * exports of blended or tessellated bodies).
   */
  referenceVolumeMm3?: number;
  /** Solids the file declares, counted by construction. */
  referenceSolidCount?: number;
  /** True when the file is expected to yield no importable solid at all. */
  expectNoSolids?: boolean;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const CORPUS_DIR = HERE;
export const REPO_ROOT = join(HERE, '..', '..', '..');

/** mm³ in one cubic inch — the constant the inch case turns on. */
export const CUBIC_INCH_MM3 = 25.4 ** 3;

/** The plate the import-modeling scenarios are layered on top of. */
export const MODELING_BASE = {
  path: 'test/parity/corpus/modeling-base-plate.step',
  width: 40,
  depth: 24,
  height: 10
} as const;

export const CORPUS: CorpusEntry[] = [
  // ---------------------------------------------------------------------
  // (a) exports — what OpenZCAD itself produces, re-read by both kernels
  // ---------------------------------------------------------------------
  {
    id: 'a-sample-parametric-bracket',
    category: 'a-exports',
    purpose:
      'The shipped walkthrough sample: an exact 14-face boolean result with ' +
      'three analytic cylindrical faces. Stresses mixed-surface import.',
    path: 'samples/parametric-bracket.step',
    referenceSolidCount: 1
  },
  {
    id: 'a-sample-simple-assembly',
    category: 'a-exports',
    purpose:
      'The shipped metadata-only sample: PRODUCT and COLOUR_RGB entities, no ' +
      'shape representation. A valid STEP file that contains no geometry.',
    path: 'samples/simple-assembly.step',
    referenceSolidCount: 0,
    expectNoSolids: true
  },
  {
    id: 'a-export-box',
    category: 'a-exports',
    purpose:
      'BrepKit export of a 10x20x30 primitive box. The all-planar baseline: ' +
      'anything that diverges here is a parser problem, not a surface problem.',
    path: 'test/parity/corpus/a-export-box.step',
    referenceVolumeMm3: 10 * 20 * 30,
    referenceSolidCount: 1
  },
  {
    id: 'a-export-cylinder',
    category: 'a-exports',
    purpose:
      'BrepKit export of an r8 h20 cylinder. First periodic surface in the ' +
      'corpus: the seam edge is where the two kernels first disagree on how ' +
      'many edges a body has.',
    path: 'test/parity/corpus/a-export-cylinder.step',
    referenceVolumeMm3: Math.PI * 8 * 8 * 20,
    referenceSolidCount: 1
  },
  {
    id: 'a-export-cone',
    category: 'a-exports',
    purpose:
      'BrepKit export of an r10 h10 cone. Carries the CONICAL_SURFACE ' +
      'half-angle in radians — the control for the degree variants in (b).',
    path: 'test/parity/corpus/a-export-cone.step',
    referenceVolumeMm3: (Math.PI * 10 * 10 * 10) / 3,
    referenceSolidCount: 1
  },
  {
    id: 'a-export-sphere',
    category: 'a-exports',
    purpose:
      'BrepKit export of an r6 sphere: two SPHERICAL_SURFACE patches with ' +
      'degenerate polar edges.',
    path: 'test/parity/corpus/a-export-sphere.step',
    referenceVolumeMm3: (4 / 3) * Math.PI * 6 ** 3,
    referenceSolidCount: 1
  },
  {
    id: 'a-export-bored-plate',
    category: 'a-exports',
    purpose:
      'BrepKit export of a boolean result: a 40x24x10 plate with an r5 bore ' +
      'through it. Analytic cylinder produced by a cut, not by a primitive.',
    path: 'test/parity/corpus/a-export-bored-plate.step',
    referenceVolumeMm3: 40 * 24 * 10 - Math.PI * 25 * 10,
    referenceSolidCount: 1
  },

  // ---------------------------------------------------------------------
  // (b) units — the K0.1 lane's acceptance set
  // ---------------------------------------------------------------------
  {
    id: 'b-unit-mm-cube',
    category: 'b-units',
    purpose:
      'A 25.4 mm cube in an SI millimetre context. The control half of the ' +
      'unit pair: physically identical to b-unit-inch-cube.',
    path: 'test/parity/corpus/b-unit-mm-cube.step',
    referenceVolumeMm3: CUBIC_INCH_MM3,
    referenceSolidCount: 1
  },
  {
    id: 'b-unit-inch-cube',
    category: 'b-units',
    purpose:
      'The SAME physical cube authored as a 1x1x1 inch cube through ' +
      "CONVERSION_BASED_UNIT('INCH'). Must read 16387.064 mm3, identical to " +
      'b-unit-mm-cube. A kernel that ignores the conversion reads 1.',
    path: 'test/parity/corpus/b-unit-inch-cube.step',
    referenceVolumeMm3: CUBIC_INCH_MM3,
    referenceSolidCount: 1
  },
  {
    id: 'b-unit-degree-cone',
    category: 'b-units',
    purpose:
      'The r10 h10 cone with its plane-angle unit redeclared as DEGREE and ' +
      'the CONICAL_SURFACE half-angle written as 45. Byte-derived from ' +
      'a-export-cone, so it is provably the same cone in a different unit ' +
      'and must read the same volume. A kernel that ignores ' +
      'PLANE_ANGLE_UNIT reads 45 radians and produces a wildly wrong cone.',
    path: 'test/parity/corpus/b-unit-degree-cone.step',
    referenceVolumeMm3: (Math.PI * 10 * 10 * 10) / 3,
    referenceSolidCount: 1
  },
  {
    id: 'b-unit-degree-cone-unassigned',
    category: 'b-units',
    purpose:
      'The degree cone with its GLOBAL_UNIT_ASSIGNED_CONTEXT removed, so ' +
      'nothing in the file binds a unit to the model at all. Both kernels ' +
      'refuse it rather than guess a scale, which is the answer this file ' +
      'exists to hold them to.',
    path: 'test/parity/corpus/b-unit-degree-cone-unassigned.step',
    referenceSolidCount: 1,
    expectNoSolids: true
  },
  {
    id: 'b-unit-no-global-context',
    category: 'b-units',
    purpose:
      'A 20 mm cube whose units are declared but never bound: no ' +
      'GLOBAL_UNIT_ASSIGNED_CONTEXT anywhere in the file. Both kernels ' +
      'currently assume millimetres. A kernel change in flight may turn this ' +
      'into a hard refusal; the corpus exists to make that audible instead of ' +
      'silent.',
    path: 'test/parity/corpus/b-unit-no-global-context.step',
    referenceVolumeMm3: 20 * 20 * 20,
    referenceSolidCount: 1
  },

  // ---------------------------------------------------------------------
  // (c) voids — BREP_WITH_VOIDS, K0.1 step 2
  // ---------------------------------------------------------------------
  {
    id: 'c-void-single-cavity',
    category: 'c-voids',
    purpose:
      'A 20 mm cube with one enclosed 10 mm cubic cavity, via BREP_WITH_VOIDS ' +
      'over ORIENTED_CLOSED_SHELL. Volume is outer minus inner: 7000 mm3. ' +
      'A reader that drops inner shells reads 8000.',
    path: 'test/parity/corpus/c-void-single-cavity.step',
    referenceVolumeMm3: 20 ** 3 - 10 ** 3,
    referenceSolidCount: 1
  },
  {
    id: 'c-void-two-cavities',
    category: 'c-voids',
    purpose:
      'A 30x20x20 block with two disjoint enclosed cavities. Proves the void ' +
      'set is a set, not a single optional inner shell.',
    path: 'test/parity/corpus/c-void-two-cavities.step',
    referenceVolumeMm3: 30 * 20 * 20 - 6 ** 3 - 8 ** 3,
    referenceSolidCount: 1
  },

  // ---------------------------------------------------------------------
  // (d) multi-solid
  // ---------------------------------------------------------------------
  {
    id: 'd-multi-two-boxes',
    category: 'd-multi-solid',
    purpose:
      'Two disjoint MANIFOLD_SOLID_BREPs in one ' +
      'ADVANCED_BREP_SHAPE_REPRESENTATION. The K0.2/Z2 shape: one imported ' +
      'body carrying several solids.',
    path: 'test/parity/corpus/d-multi-two-boxes.step',
    referenceVolumeMm3: 10 ** 3 + 6 ** 3,
    referenceSolidCount: 2
  },
  {
    id: 'd-multi-solid-and-void',
    category: 'd-multi-solid',
    purpose:
      'A multi-solid file where ONE of the two solids is a BREP_WITH_VOIDS. ' +
      'Separates "cannot read voids" from "cannot read multiple solids": a ' +
      'reader with only the first defect still loses the whole file.',
    path: 'test/parity/corpus/d-multi-solid-and-void.step',
    referenceVolumeMm3: 20 ** 3 - 10 ** 3 + 6 ** 3,
    referenceSolidCount: 2
  },

  // ---------------------------------------------------------------------
  // (e) NURBS-heavy
  // ---------------------------------------------------------------------
  {
    id: 'e-nurbs-fillet-plate',
    category: 'e-nurbs',
    purpose:
      'BrepKit export of a 40x24x10 plate with four r3 vertical corner ' +
      'fillets, written as four B_SPLINE_SURFACE_WITH_KNOTS bands. The ' +
      'analytic truth of the shape is 9522.74 mm3; this file is the NURBS ' +
      'encoding of it.',
    path: 'test/parity/corpus/e-nurbs-fillet-plate.step',
    referenceVolumeMm3: 40 * 24 * 10 - 4 * (1 - Math.PI / 4) * 9 * 10,
    referenceSolidCount: 1
  },
  {
    id: 'e-analytic-fillet-plate',
    category: 'e-nurbs',
    purpose:
      'The SAME nominal plate exported by OCCT, which writes the four fillet ' +
      'bands as CYLINDRICAL_SURFACE plus SURFACE_CURVE/PCURVE pairs. Paired ' +
      'with e-nurbs-fillet-plate this isolates encoding from geometry: same ' +
      'shape, same reference volume, two representations.',
    path: 'test/parity/corpus/e-analytic-fillet-plate.step',
    referenceVolumeMm3: 40 * 24 * 10 - 4 * (1 - Math.PI / 4) * 9 * 10,
    referenceSolidCount: 1
  },

  // ---------------------------------------------------------------------
  // (f) known-hostile
  // ---------------------------------------------------------------------
  {
    id: 'f-hostile-occt-authored-box',
    category: 'f-hostile',
    purpose:
      'A plain 10x20x30 box exported by OCCT rather than by BrepKit. Every ' +
      'OCCT-written file carries SURFACE_CURVE with PCURVE pairs, and that is ' +
      'the single most common shape a real-world STEP file arrives in. This ' +
      'is the smallest file in the corpus that BrepKit cannot read at all.',
    path: 'test/parity/corpus/f-hostile-occt-authored-box.step',
    referenceVolumeMm3: 10 * 20 * 30,
    referenceSolidCount: 1
  },
  {
    id: 'f-hostile-open-shell',
    category: 'f-hostile',
    purpose:
      'A box shell with its z-max face removed: five faces, twelve edges, ' +
      'four of them used once. Structurally well-formed STEP that is not a ' +
      'solid. Tests that a reader refuses rather than reporting a volume.',
    path: 'test/parity/corpus/f-hostile-open-shell.step',
    referenceSolidCount: 0,
    expectNoSolids: true
  },
  {
    id: 'f-hostile-dangling-reference',
    category: 'f-hostile',
    purpose:
      'A well-formed box whose z-max ADVANCED_FACE points at an entity id ' +
      'that does not exist. Tests the parser error path, not the geometry ' +
      'path.',
    path: 'test/parity/corpus/f-hostile-dangling-reference.step',
    referenceSolidCount: 0,
    expectNoSolids: true
  },
  {
    id: 'f-hostile-no-shape-representation',
    category: 'f-hostile',
    purpose:
      'Header plus PRODUCT entities and nothing else — the same class as ' +
      'samples/simple-assembly.step but minimal and self-describing. The ' +
      'refusal message is the whole test.',
    path: 'test/parity/corpus/f-hostile-no-shape-representation.step',
    referenceSolidCount: 0,
    expectNoSolids: true
  }
];

export function corpusEntry(id: string): CorpusEntry {
  const entry = CORPUS.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`unknown corpus entry '${id}'`);
  }
  return entry;
}
