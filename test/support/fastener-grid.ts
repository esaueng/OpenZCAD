import { standardPartBody } from '@openzcad/document-core';
import type { ProjectDocument, StandardPartThread } from '@openzcad/shared';

/**
 * The M17 render-budget fixture: `count` ISO M6 × 20 socket head cap screws
 * standing in a square grid 15 mm apart on the XY plane, heads up, each its
 * own feature and body: about 100 fasteners, the case the ROADMAP's M17 row
 * asks to stay within the H02/W01 budgets. M6 socket screws are the
 * heaviest common fastener to draw: a modeled thread is about 465,000
 * display triangles. `thread` says how each is drawn: `modeled` (no field,
 * as before schema v83) or `simplified`. The Node probe
 * (`test/perf/standard-parts-display.bench.ts`) and the browser W01 probe
 * (`test/e2e/perf-cad-edit.spec.ts`, `CAD_PERF_BROWSER_FASTENERS`) use it.
 */
export function addFastenerGrid(
  document: ProjectDocument,
  count: number,
  thread: StandardPartThread
): ProjectDocument {
  const side = Math.ceil(Math.sqrt(count));
  let next = document;
  for (let index = 0; index < count; index += 1) {
    next = standardPartBody(next, {
      name: `Screw ${index + 1}`,
      partKind: 'screw',
      system: 'iso',
      size: 'M6',
      head: 'socket',
      length: 20,
      origin: {
        x: 15 * (index % side),
        y: 15 * Math.floor(index / side),
        z: 0
      },
      axis: { x: 0, y: 0, z: -1 },
      ...(thread === 'simplified' ? { thread } : {})
    }).document;
  }
  return next;
}
