/** Opt-in paired-pin diagnostic; constructs only the public unit fixture. */
import { it, expect } from 'vitest';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { RemusKernel } from '../../packages/kernel-adapter/src/remus-runtime';
import {
  longFilletedUnion,
  unionEndFace
} from '../../test/support/filleted-union';
import { planFaceOffset } from '../../apps/web/src/lib/interaction/faceOffsetPlan';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const names = [
  'filletWithEvolution',
  'filletDetailed',
  'moveFacesJournaled',
  'moveFacesPreparedJournaled',
  'moveFacesJournaledWithQuality',
  'moveFacesPreparedJournaledWithQuality',
  'validateSolid',
  'validateSolidDetailed',
  'validateSolidRelaxed',
  'meshQuality',
  'tessellateSolidGroupedBinary',
  'tessellateSolid',
  'volume',
  'faceArea',
  'checkpoint',
  'restore',
  'serializeSolids',
  'deserializeSolids',
  'journalSummary',
  'unifyFacesChecked',
  'fuseWithEvolution',
  'fuseDetailed',
  'getBlendRegion'
];
async function capture<T>(run: () => Promise<T>) {
  const proto = RemusKernel.prototype;
  const descriptors = new Map<string, PropertyDescriptor>();
  const stages: Record<string, { calls: number; ms: number }> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (!descriptor || typeof descriptor.value !== 'function') continue;
    descriptors.set(name, descriptor);
    const original = descriptor.value as (...args: unknown[]) => unknown;
    Object.defineProperty(proto, name, {
      ...descriptor,
      value: function (this: RemusKernel, ...args: unknown[]) {
        const start = performance.now();
        try {
          return original.apply(this, args);
        } finally {
          const s = (stages[name] ??= { calls: 0, ms: 0 });
          s.calls++;
          s.ms += performance.now() - start;
        }
      }
    });
  }
  const start = performance.now();
  try {
    return {
      result: await run(),
      elapsedMs: performance.now() - start,
      stages
    };
  } finally {
    for (const [name, descriptor] of descriptors)
      Object.defineProperty(proto, name, descriptor);
  }
}
it.skipIf(!process.env.AXIAL_PROFILE_OUT)(
  'profiles one cached width edit and its independent cold oracle',
  async () => {
    const warm = await createExactKernelAdapter();
    const cold = await createExactKernelAdapter({ historyCheckpointLimit: 0 });
    try {
      const model = await longFilletedUnion(warm);
      const face = unionEndFace(model.body);
      const plan = planFaceOffset({
        document: model.document,
        bodyId: model.bodyId,
        face,
        faceHash: face.hash,
        offset: 2.75
      });
      expect(plan?.kind).toBe('primitive-dimension');
      const next = plan!.command.apply(model.document);
      const a = await capture(() => warm.syncDocument(next));
      const b = await capture(() => cold.syncDocument(next));
      expect(a.stages.filletWithEvolution?.calls ?? 0).toBe(0);
      expect(b.result.bodyRepresentations[model.bodyId]!.volume).toBeCloseTo(
        a.result.bodyRepresentations[model.bodyId]!.volume,
        7
      );
      const cached = { elapsedMs: a.elapsedMs, stages: a.stages },
        fresh = { elapsedMs: b.elapsedMs, stages: b.stages };
      mkdirSync(dirname(process.env.AXIAL_PROFILE_OUT!), { recursive: true });
      writeFileSync(
        process.env.AXIAL_PROFILE_OUT!,
        JSON.stringify(
          {
            pin: process.env.AXIAL_PIN,
            preparedGroupAPI:
              typeof RemusKernel.prototype.prepareResizeBlend === 'function',
            cached,
            cold: fresh,
            faceCount: b.result.bodyRepresentations[model.bodyId]!.faceCount,
            volume: b.result.bodyRepresentations[model.bodyId]!.volume
          },
          null,
          2
        )
      );
    } finally {
      warm.dispose();
      cold.dispose();
    }
  },
  600_000
);
