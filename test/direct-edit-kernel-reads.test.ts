import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CommandManager } from '@openzcad/command-system';
import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type DerivedState,
  type ProjectDocument
} from '@openzcad/shared';
import { planFaceOffset } from '../apps/web/src/lib/interaction/faceOffsetPlan';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';

/**
 * Kernel reads per sync of an offset-face direct edit on an imported body.
 *
 * Every published face hash, witness and lineage reference is a pure function
 * of kernel handles that are never reassigned or mutated, so one sync needs
 * each face's surface class once, and the edit's source body — measured by
 * the previous sync — needs no witness reads at all. On `main` before the
 * per-sync read memo this edit read `getSurfaceType` 764 times (up to 39
 * times for one face: the planar-distance proofs re-read every face's plane
 * frame per candidate pair, and the blend scan walked every face per
 * cylinder) and `edgeLength` 892 times, re-measuring the source and result
 * witnesses up to four times each. These pins keep the counts from creeping
 * back; the bounds are today's counts, so a change that lowers them only
 * needs to tighten the numbers.
 */
const COUNTED = ['getSurfaceType', 'faceArea', 'edgeLength'] as const;
type Counted = (typeof COUNTED)[number];

function holderDocument() {
  return importStepBody(
    createProjectDocument('Kernel reads', toUserId('user_kernel_reads')),
    {
      name: 'Holder',
      artifactId: 'holder',
      sourceName: 'synthetic-holder.step',
      stepText: readFileSync(
        new URL(
          './fixtures/hammer-holder/synthetic-holder.step',
          import.meta.url
        ),
        'utf8'
      )
    }
  );
}

/**
 * Everything a sync publishes about topology, across different arenas. The
 * opening evidence alone names raw kernel handles, which differ between two
 * adapters by construction.
 */
function publishedTopology(derived: DerivedState) {
  return {
    warnings: derived.warnings,
    featureWarnings: derived.featureWarnings,
    bodies: Object.values(derived.bodyRepresentations).map((body) => {
      const opening = body.topology?.recognizedOpening;
      return {
        volume: body.volume,
        faceCount: body.faceCount,
        topology: {
          ...body.topology,
          recognizedOpening:
            opening && 'evidence' in opening
              ? { ...opening, evidence: undefined }
              : opening
        }
      };
    })
  };
}

describe('kernel reads per direct-edit sync', { timeout: 120_000 }, () => {
  let adapter: ExactKernelAdapter;
  const calls = new Map<Counted, number>();
  const surfaceTypeReads = new Map<number, number>();

  beforeAll(async () => {
    for (const name of COUNTED) {
      const underlying = RemusKernel.prototype[name] as (
        ...args: unknown[]
      ) => unknown;
      vi.spyOn(RemusKernel.prototype, name).mockImplementation(function (
        this: RemusKernel,
        ...args: unknown[]
      ) {
        calls.set(name, (calls.get(name) ?? 0) + 1);
        if (name === 'getSurfaceType') {
          const face = args[0] as number;
          surfaceTypeReads.set(face, (surfaceTypeReads.get(face) ?? 0) + 1);
        }
        return underlying.apply(this, args);
      } as never);
    }
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => {
    vi.restoreAllMocks();
    adapter.dispose();
  });

  async function countedSync(document: ProjectDocument) {
    calls.clear();
    surfaceTypeReads.clear();
    const derived = await adapter.syncDocument(document);
    return {
      derived,
      counts: Object.fromEntries(
        COUNTED.map((name) => [name, calls.get(name) ?? 0])
      ) as Record<Counted, number>,
      readsOfOneFace: Math.max(...surfaceTypeReads.values())
    };
  }

  it('reads each surface class once and reuses the source witnesses', async () => {
    const imported = holderDocument();
    const cold = await countedSync(imported.document);
    expect(cold.derived.warnings).toEqual([]);
    expect(cold.readsOfOneFace).toBe(1);
    expect(cold.counts.getSurfaceType).toBeLessThanOrEqual(47);
    expect(cold.counts.edgeLength).toBeLessThanOrEqual(270);
    expect(cold.counts.faceArea).toBeLessThanOrEqual(69);

    const base: ProjectDocument = {
      ...imported.document,
      derived: cold.derived
    };
    // The holder's large back face: moving it re-limits planar neighbours
    // only, which the pinned kernel accepts.
    const face = base.derived.bodyRepresentations[
      imported.bodyId
    ]!.topology!.faces.filter(
      (candidate) =>
        candidate.geometry?.surfaceType === 'plane' &&
        (candidate.geometry.normal?.y ?? 0) < -0.99
    ).sort((a, b) => (b.geometry?.area ?? 0) - (a.geometry?.area ?? 0))[0]!;
    expect(face).toBeDefined();
    const plan = planFaceOffset({
      document: base,
      bodyId: imported.bodyId,
      face,
      faceHash: face.hash,
      offset: -1
    });
    expect(plan?.kind).toBe('direct-edit');
    const edited = new CommandManager(base).runTransaction('Offset', [
      plan!.command
    ]);

    const edit = await countedSync(edited);
    expect(edit.derived.warnings).toEqual([]);
    expect(edit.readsOfOneFace).toBe(1);
    // On main before the memo: 764, 892 and 71.
    expect(edit.counts.getSurfaceType).toBeLessThanOrEqual(47);
    expect(edit.counts.edgeLength).toBeLessThanOrEqual(270);
    expect(edit.counts.faceArea).toBeLessThanOrEqual(71);

    // The reused source witnesses publish exactly what a cold adapter
    // measuring everything afresh publishes.
    const fresh = await createExactKernelAdapter();
    try {
      expect(publishedTopology(edit.derived)).toEqual(
        publishedTopology(await fresh.syncDocument(edited))
      );
    } finally {
      fresh.dispose();
    }
  });
});
