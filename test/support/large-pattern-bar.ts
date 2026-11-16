import {
  addPrimitiveFeature,
  createProjectDocument,
  patternBody,
  type PatternInput
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type { BodyId, ProjectDocument } from '@openzcad/shared';

/**
 * The public stand-in for the 2026-11-14 production QA "×50 bar"
 * (docs/qa/2026-11-14/complex-cad-kernel-limits.md, finding #16): a
 * 30 × 18 × 5 mm block repeated ×50 at the linear pattern's default 20 mm
 * spacing, whose overlapping copies fuse into one 1010 × 18 × 5 mm bar (QA's
 * readout). QA's own project is not redistributable; this one has the same
 * size, count and spacing, and is what the pattern-preview probes
 * (`test/perf/pattern-preview.bench.ts`, `test/e2e/perf-pattern-preview.spec.ts`)
 * grid. Its owner is the e2e fixtures' signed-in user.
 */
export function largePatternBar(name = 'Pattern bar'): {
  document: ProjectDocument;
  bar: BodyId;
} {
  let document = addPrimitiveFeature(
    createProjectDocument(name, toUserId('user_e2e')),
    {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 30, height: 18, depth: 5 }
    }
  );
  document = patternBody(document, {
    name: 'Bar',
    targetBodyId: document.bodyOrder[0]!,
    patternKind: 'linear',
    count: 50,
    axis: 'x',
    spacing: 20
  }).document;
  return { document, bar: document.bodyOrder.at(-1)! };
}

/**
 * The Grid pattern card's request for `count` × `count2` copies of the bar
 * with the card's defaults: 20 mm along X (copies overlap the bar by 990 mm),
 * then 20 mm along Y (2 mm gaps).
 */
export function barGrid(
  bar: BodyId,
  count: number,
  count2: number
): PatternInput {
  return {
    name: 'Grid pattern',
    targetBodyId: bar,
    patternKind: 'grid',
    count,
    count2,
    axis: 'x',
    axis2: 'y',
    spacing: 20,
    spacing2: 20
  };
}
