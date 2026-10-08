// Opt-in sketch dimension -> GCS -> solved document -> exact solid probe.
import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  addSketchConstraint,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  findSketch,
  setParameter
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type RebuildCacheEvent
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type DerivedState } from '@openzcad/shared';
import { solvedSketchCommands } from '../../apps/web/src/lib/sketch/applySolve';

function normalized({ updatedAt: _updatedAt, ...state }: DerivedState) {
  return state;
}

it('measures a solved sketch dimension and its dependent extrusion', async () => {
  if (!process.env.CAD_PERF_RUN) return;
  for (const history of [2, 100]) {
    let document = setParameter(
      createProjectDocument('Sketch perf', toUserId('cad_perf')),
      {
        name: 'radius',
        expression: '10'
      }
    );
    const sketch = addSketchFeature(document, {
      name: 'Profile',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [{ objectKind: 'circle', centerX: 0, centerY: 0, radius: 10 }]
    });
    document = addSketchConstraint(sketch.document, {
      sketchId: sketch.sketchId,
      constraint: {
        constraintKind: 'radius',
        objectId: findSketch(sketch.document, sketch.sketchId)!.objectIds[0]!,
        value: 'radius'
      }
    }).document;
    for (let index = 0; index < history - 2; index++) {
      document = addPrimitiveFeature(document, {
        name: `Independent ${index}`,
        primitiveKind: 'box',
        dimensions: { width: 10, height: 8, depth: 6 }
      });
    }
    document = extrudeSketch(document, {
      name: 'Cylinder',
      sketchId: sketch.sketchId,
      distance: 4
    }).document;
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      onRebuildCacheEvent: (event) => events.push(event)
    });
    const fresh = await createExactKernelAdapter({ historyCheckpointLimit: 0 });
    try {
      const samples = Number(process.env.CAD_PERF_SAMPLES ?? 30);
      for (let index = 0; index <= samples; index++) {
        const radius = index === 0 ? 10 : 11 + (index % 2);
        const start = performance.now();
        const command = commandFactories.setParameter({
          name: 'radius',
          expression: String(radius)
        });
        const prospective = command.apply(document);
        const solveStart = performance.now();
        const outcome = await adapter.solveSketch(prospective, sketch.sketchId);
        const solveMs = performance.now() - solveStart;
        expect(outcome.converged).toBe(true);
        expect(outcome.rolledBack).toBe(false);
        expect(outcome.maxResidual).toBeLessThan(1e-8);
        const current = new CommandManager(document).runTransaction('Radius', [
          command,
          ...solvedSketchCommands(prospective, sketch.sketchId, outcome)
        ]);
        const regenStart = performance.now();
        const actual = await adapter.syncDocument(current);
        const regenMs = performance.now() - regenStart;
        const elapsedMs = performance.now() - start;
        expect(actual.warnings).toEqual([]);
        expect(
          actual.bodyRepresentations[document.bodyOrder.at(-1)!]!.volume
        ).toBeCloseTo(Math.PI * radius * radius * 4, 5);
        if (process.env.CAD_PERF_SKETCH_OUT)
          appendFileSync(
            process.env.CAD_PERF_SKETCH_OUT,
            `${JSON.stringify({
              history,
              phase: index === 0 ? 'cold' : 'warm',
              sample: index,
              radius,
              elapsedMs,
              solveMs,
              regenMs,
              cache: events.at(-1),
              maxResidual: outcome.maxResidual
            })}\n`
          );
        // Same solved document, full geometry and mesh oracle, outside timing.
        expect(normalized(actual)).toEqual(
          normalized(await fresh.syncDocument(current))
        );
      }
    } finally {
      adapter.dispose();
      fresh.dispose();
    }
  }
}, 900_000);
