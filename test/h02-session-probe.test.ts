import { expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  setParameter
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  createExactKernelAdapter,
  sameStructure
} from './perf/h02-session-exact';
import type { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';

it('compares all retained buffer bytes and fails closed for unsupported structures', () => {
  expect(sameStructure(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(
    false
  );
  expect(sameStructure(Uint8Array.of(1).buffer, Uint8Array.of(2).buffer)).toBe(
    false
  );
  expect(sameStructure({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  expect(sameStructure({ a: undefined }, {})).toBe(false);
  expect(() => sameStructure(new Map(), new Map())).toThrow('fails closed');
});

it('captures the live arena, rejects corrupted raw bytes and observes retired checkpoints', async () => {
  const adapter = await createExactKernelAdapter();
  type Probe = {
    compareFresh(): Promise<{
      rawEquivalent: boolean;
      publicationEquivalent: boolean;
    }>;
    exerciseEviction(): Promise<{
      budget: number;
      passes: {
        rawEquivalent: boolean;
        publicationEquivalent: boolean;
        retainedBytes: number;
        event: { remeasured: number; reusedMeasurements: number };
      }[];
    }>;
    probeRetiredCheckpoint(): { available: boolean; rejected: boolean };
    snapshot(): { retiredCheckpoints: number; ownersAgree: boolean };
  };
  const probe = (globalThis as unknown as { __h02Session: Probe }).__h02Session;
  const base = addPrimitiveFeature(
    setParameter(createProjectDocument('Probe', toUserId('test')), {
      name: 'width',
      expression: '10'
    }),
    {
      name: 'Fixed',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 8, depth: 6 }
    }
  );
  const document = addPrimitiveFeature(base, {
    name: 'Box',
    primitiveKind: 'box',
    dimensions: { width: 'width', height: 8, depth: 6 }
  });
  try {
    await adapter.syncDocument(document);
    expect(await probe.compareFresh()).toMatchObject({
      rawEquivalent: true,
      publicationEquivalent: true
    });
    await adapter.syncDocument(document);
    const kernel = (adapter as unknown as { historyKernel: RemusKernel })
      .historyKernel;
    const serialize = kernel.serializeSolids.bind(kernel);
    const corrupt = vi
      .spyOn(kernel, 'serializeSolids')
      .mockImplementation((solids) => {
        const bytes = serialize(solids).slice();
        expect(bytes.length).toBeGreaterThan(0);
        bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
        return bytes;
      });
    expect(await probe.compareFresh()).toMatchObject({
      rawEquivalent: false,
      publicationEquivalent: true
    });
    corrupt.mockRestore();
    await adapter.syncDocument(
      setParameter(document, { name: 'width', expression: '11' })
    );
    expect(probe.snapshot()).toMatchObject({ ownersAgree: true });
    expect(probe.snapshot().retiredCheckpoints).toBeGreaterThan(0);
    expect(probe.probeRetiredCheckpoint()).toEqual({
      available: true,
      rejected: true
    });
    expect(await probe.compareFresh()).toMatchObject({
      rawEquivalent: true,
      publicationEquivalent: true
    });
    await adapter.syncDocument(document);
    const pressure = await probe.exerciseEviction();
    expect(pressure.passes).toHaveLength(4);
    for (const pass of pressure.passes) {
      expect(pass.rawEquivalent).toBe(true);
      expect(pass.publicationEquivalent).toBe(true);
      expect(pass.retainedBytes).toBeLessThanOrEqual(pressure.budget);
      expect(pass.event.remeasured).toBeGreaterThan(0);
      expect(pass.event.reusedMeasurements).toBeGreaterThan(0);
    }
  } finally {
    adapter.dispose();
    vi.restoreAllMocks();
  }
}, 30_000);

it('observes worker memo eviction without changing owned results or limits', async () => {
  const { ExactRebuildCache } =
    await import('./perf/h02-session-rebuild-cache');
  const cache = new ExactRebuildCache<{ value: number }>({
    maxEntries: 1,
    maxBytes: 64,
    maxInFlight: 1
  });
  const first = await cache.get('first', async () => ({ value: 1 }));
  first.value = 9;
  expect(await cache.get('first', async () => ({ value: 7 }))).toEqual({
    value: 1
  });
  await cache.get('second', async () => ({ value: 2 }));
  const stats = (
    globalThis as unknown as {
      __h02Memo: () => { entries: number; evictions: number; maxBytes: number };
    }
  ).__h02Memo();
  expect(stats).toMatchObject({ entries: 1, evictions: 1, maxBytes: 64 });
  cache.terminate();
  await expect(cache.get('first', async () => ({ value: 1 }))).rejects.toThrow(
    'terminated'
  );
});
