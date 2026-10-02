import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type DerivedState,
  type ProjectDocument
} from '@openzcad/shared';
import { createExactKernelAdapter } from './exact';
import { OperationCancellationToken, RemusKernel } from './remus-runtime';
import { kernelRefusalCategoryOf } from './kernel-refusal';
import { exactBooleanOutcome } from './exact-boolean-refusal';
import {
  exactBooleanOutcomeWithCancellation,
  exactFuseWithCancellation,
  generationCancellation,
  isBuildCancelled,
  type BuildCancellation,
  type BuildCancellationSignal
} from './exact-cancellation';
import { buildDocumentHistory } from './exact-build-loop';
import type { RebuildProgress } from './rebuild-progress';

const user = toUserId('user_cancel');

/** Row-major rigid translation, matching `copyAndTransformSolid`. */
function translation(x: number, y: number, z: number): Float64Array {
  return Float64Array.of(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1);
}

/** Two overlapping boxes: the pair the cancellable path must agree on. */
function overlappingBoxes(kernel: RemusKernel): [number, number] {
  return [
    kernel.makeBox(10, 10, 10),
    kernel.copyAndTransformSolid(
      kernel.makeBox(10, 10, 10),
      translation(5, 0, 0)
    )
  ];
}

/**
 * Two unit spheres offset by half a radius: the curved-curved contact the
 * exact pipeline declines. Both entry points must refuse it identically.
 */
function offsetSpheres(kernel: RemusKernel): [number, number] {
  return [
    kernel.makeSphere(1.0, 24),
    kernel.copyAndTransformSolid(
      kernel.makeSphere(1.0, 24),
      translation(0.5, 0, 0)
    )
  ];
}

function liveCancellation(
  signal: BuildCancellationSignal
): BuildCancellation {
  return { signal, token: new OperationCancellationToken() };
}

const neverCancelled: BuildCancellationSignal = {
  isCancelled: () => false
};

function twoBoxes(): ProjectDocument {
  let document = createProjectDocument('Cancel two boxes', user);
  for (const name of ['Box A', 'Box B']) {
    document = addPrimitiveFeature(document, {
      name,
      primitiveKind: 'box',
      dimensions: { width: 10, height: 8, depth: 6 }
    });
  }
  return document;
}

/**
 * A clean through-cut: the 60x18x24 plate with an r6 tool moved to (30, 9),
 * clearing both faces. The boolean feature below exercises the cancellable
 * twin end to end; the geometry matches the classic-path oracle.
 */
function throughCut(): ProjectDocument {
  let document = createProjectDocument('Cancel through cut', user);
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 60, height: 18, depth: 24 }
  });
  const plateId = document.bodyOrder[0] as BodyId;
  document = addPrimitiveFeature(document, {
    name: 'Tool',
    primitiveKind: 'cylinder',
    dimensions: { radius: 6, height: 28 }
  });
  const toolId = document.bodyOrder[1] as BodyId;
  document = transformBody(document, {
    name: 'Move tool',
    targetBodyId: toolId,
    translation: { x: 30, y: 9, z: 0 }
  }).document;
  document = booleanBodies(document, {
    name: 'Bore',
    operation: 'subtract',
    targetBodyIds: [plateId, toolId]
  }).document;
  return document;
}

// Same triangulation-layout normalization as bounded-history-cache.test: all
// topology, references, face ranges, edges, bounds, mass and warnings stay.
function normalized({ updatedAt: _updatedAt, ...derived }: DerivedState) {
  return {
    ...derived,
    bodyRepresentations: Object.fromEntries(
      Object.entries(derived.bodyRepresentations).map(([id, body]) => [
        id,
        {
          ...body,
          mesh: {
            kind: body.mesh.kind,
            triangles: body.mesh.indices.length / 3
          }
        }
      ])
    )
  };
}

describe('cancellable exact booleans', () => {
  it('refuses a pre-cancelled token without touching topology', () => {
    const kernel = new RemusKernel();
    const [a, b] = overlappingBoxes(kernel);
    const token = new OperationCancellationToken();
    token.cancel();
    const outcome = exactBooleanOutcomeWithCancellation(kernel, 'fuse', a, b, {
      signal: { isCancelled: () => true },
      token
    });
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    expect(outcome.refusal.category).toBe('cancelled');
    expect(outcome.refusal.kernelCode).toBe('operation_cancelled');
    expect(kernelRefusalCategoryOf(outcome.refusal)).toBe('cancelled');
    // Cancel-before-call retains nothing partial: both inputs still measure.
    expect(kernel.volume(a, 0.01)).toBeCloseTo(1000, 3);
    expect(kernel.volume(b, 0.01)).toBeCloseTo(1000, 3);
  });

  it('throws the typed refusal through the throwing twin', () => {
    const kernel = new RemusKernel();
    const [a, b] = overlappingBoxes(kernel);
    const token = new OperationCancellationToken();
    token.cancel();
    let thrown: unknown;
    try {
      exactFuseWithCancellation(
        kernel,
        a,
        b,
        { signal: { isCancelled: () => true }, token },
        ['Block', 'Block 2']
      );
    } catch (error) {
      thrown = error;
    }
    expect(kernelRefusalCategoryOf(thrown)).toBe('cancelled');
    // The cancelled clause names the operation, not the operands — there was
    // no pair to blame, only a rebuild that stopped. The operands still ride
    // along for attribution.
    expect((thrown as Error).message.split('\n')[0]).toBe(
      'Union refused: the union was cancelled.'
    );
    expect(
      (thrown as { operands: readonly string[] }).operands
    ).toEqual(['Block', 'Block 2']);
  });

  it('matches the classic path on a clean pair', () => {
    const kernel = new RemusKernel();
    const [a, b] = overlappingBoxes(kernel);
    const classic = exactBooleanOutcome(kernel, 'fuse', a, b);
    const cancellable = exactBooleanOutcomeWithCancellation(
      kernel,
      'fuse',
      a,
      b,
      liveCancellation(neverCancelled)
    );
    expect(classic.status).toBe('ok');
    expect(cancellable.status).toBe('ok');
    if (classic.status !== 'ok' || cancellable.status !== 'ok') return;
    expect(kernel.validateSolid(classic.solid)).toBe(0);
    expect(kernel.validateSolid(cancellable.solid)).toBe(0);
    expect(kernel.volume(classic.solid, 0.01)).toBeCloseTo(1500, 3);
    expect(kernel.volume(cancellable.solid, 0.01)).toBeCloseTo(1500, 3);
  });

  it('matches the classic refusal on a declined pair', () => {
    const kernel = new RemusKernel();
    const [a, b] = offsetSpheres(kernel);
    const classic = exactBooleanOutcome(kernel, 'fuse', a, b);
    const cancellable = exactBooleanOutcomeWithCancellation(
      kernel,
      'fuse',
      a,
      b,
      liveCancellation(neverCancelled)
    );
    expect(classic.status).toBe('refused');
    expect(cancellable.status).toBe('refused');
    if (classic.status !== 'refused' || cancellable.status !== 'refused') {
      return;
    }
    expect(cancellable.refusal.category).toBe(classic.refusal.category);
    expect(cancellable.refusal.kernelCode).toBe(classic.refusal.kernelCode);
  });

  it('classifies an invalid handle without prose', () => {
    const kernel = new RemusKernel();
    const outcome = exactBooleanOutcomeWithCancellation(
      kernel,
      'cut',
      999_999,
      999_998,
      liveCancellation(neverCancelled)
    );
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    expect(outcome.refusal.category).toBe('invalid_input');
  });
});

describe('build loop cancellation', () => {
  it('stops a two-feature rebuild after the first feature', () => {
    const kernel = new RemusKernel();
    const started: number[] = [];
    let cancelled = false;
    let thrown: unknown;
    try {
      buildDocumentHistory(
        kernel,
        twoBoxes(),
        undefined,
        undefined,
        undefined,
        undefined,
        (index) => {
          if (index === 0) cancelled = true;
        },
        (index) => {
          started.push(index);
        },
        undefined,
        undefined,
        { isCancelled: () => cancelled }
      );
    } catch (error) {
      thrown = error;
    }
    // The second feature never started, and the throw is the typed category
    // rather than a recorded feature warning that would continue the build.
    expect(started).toEqual([0]);
    expect(isBuildCancelled(thrown)).toBe(true);
    expect(kernelRefusalCategoryOf(thrown)).toBe('cancelled');
  });

  it('a stale generation starts nothing', () => {
    const kernel = new RemusKernel();
    const started: number[] = [];
    let thrown: unknown;
    try {
      buildDocumentHistory(
        kernel,
        twoBoxes(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        (index) => {
          started.push(index);
        },
        undefined,
        undefined,
        generationCancellation(7, (generation) => generation === 8)
      );
    } catch (error) {
      thrown = error;
    }
    expect(started).toEqual([]);
    expect(kernelRefusalCategoryOf(thrown)).toBe('cancelled');
  });

  it('an uncancelled signal rebuilds both features', () => {
    const kernel = new RemusKernel();
    const started: number[] = [];
    const result = buildDocumentHistory(
      kernel,
      twoBoxes(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (index) => {
        started.push(index);
      },
      undefined,
      undefined,
      neverCancelled
    );
    expect(started).toEqual([0, 1]);
    expect(result.shapes.size).toBe(2);
    expect(result.warnings).toEqual([]);
  });

  it('recognizes cancellation through a wrapping cause chain', () => {
    const kernel = new RemusKernel();
    const [a, b] = overlappingBoxes(kernel);
    const token = new OperationCancellationToken();
    token.cancel();
    const outcome = exactBooleanOutcomeWithCancellation(kernel, 'fuse', a, b, {
      signal: { isCancelled: () => true },
      token
    });
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    const wrapped = new Error('boolean feature failed', {
      cause: outcome.refusal
    });
    expect(isBuildCancelled(wrapped)).toBe(true);
    expect(isBuildCancelled(new Error('plain failure'))).toBe(false);
  });
});

describe('syncDocument cancellation', { timeout: 120_000 }, () => {
  it('a cancelled sync commits nothing and the next sync matches a fresh adapter', async () => {
    const document = twoBoxes();
    const adapter = await createExactKernelAdapter({
      historyCheckpointLimit: 0
    });
    const events: unknown[] = [];
    const eventAdapter = await createExactKernelAdapter({
      historyCheckpointLimit: 0,
      onRebuildCacheEvent: (event) => events.push(event)
    });
    try {
      const baseline = normalized(await adapter.syncDocument(document));

      let cancelled = false;
      const onProgress = (progress: RebuildProgress) => {
        if (progress.stage === 'feature' && progress.status === 'completed') {
          cancelled = true;
        }
      };
      let thrown: unknown;
      try {
        await eventAdapter.syncDocument(document, onProgress, undefined, undefined, {
          cancellation: { isCancelled: () => cancelled }
        });
      } catch (error) {
        thrown = error;
      }
      expect(kernelRefusalCategoryOf(thrown)).toBe('cancelled');
      // Nothing committed: no cache event, and the retry is the baseline.
      expect(events).toEqual([]);
      expect(normalized(await eventAdapter.syncDocument(document))).toEqual(
        baseline
      );
    } finally {
      adapter.dispose();
      eventAdapter.dispose();
    }
  });

  it('a stale generation is dropped and the next sync matches', async () => {
    const document = twoBoxes();
    const adapter = await createExactKernelAdapter({
      historyCheckpointLimit: 0
    });
    try {
      const baseline = normalized(await adapter.syncDocument(document));
      let thrown: unknown;
      try {
        await adapter.syncDocument(document, undefined, undefined, undefined, {
          cancellation: generationCancellation(7, (generation) => generation === 8)
        });
      } catch (error) {
        thrown = error;
      }
      expect(kernelRefusalCategoryOf(thrown)).toBe('cancelled');
      expect(normalized(await adapter.syncDocument(document))).toEqual(
        baseline
      );
    } finally {
      adapter.dispose();
    }
  });

  it('a signalled boolean rebuild matches the classic result', async () => {
    const document = throughCut();
    const signalled = await createExactKernelAdapter({
      historyCheckpointLimit: 0
    });
    const fresh = await createExactKernelAdapter({
      historyCheckpointLimit: 0
    });
    try {
      // The boolean feature below runs through the cancellable twin; an
      // uncancelled signal must build exactly what the classic path builds.
      const actual = await signalled.syncDocument(
        document,
        undefined,
        undefined,
        undefined,
        { cancellation: neverCancelled }
      );
      expect(actual.warnings).toEqual([]);
      expect(normalized(actual)).toEqual(
        normalized(await fresh.syncDocument(document))
      );
    } finally {
      signalled.dispose();
      fresh.dispose();
    }
  });
});
