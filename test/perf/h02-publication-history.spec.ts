/**
 * Public H02 diagnostic, outside ordinary Vitest/Playwright discovery.
 * Run with test/perf/h02-publication-history.config.ts. The current runtime
 * fails strict publication equality after an eager-to-idle transition; keep
 * that assertion intact while retaining the independent passing controls.
 */
import { expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId, type BodyId, type ProjectDocument } from '@openzcad/shared';
import type { RebuildCacheEvent } from '@openzcad/kernel-adapter/exact';
import { createExactKernelAdapter } from './h02-session-exact';

const IDLE = { lineageDemand: [] as BodyId[] };

interface Equivalence {
  rawEquivalent: boolean;
  publicationEquivalent: boolean;
  publicationDifferences: {
    root: string[];
    bodies: { bodyIndex: number; count: number; paths: string[] }[];
  };
  bodies: number;
  serializedBytes: number;
  faces: number;
  warnings: number;
}

interface Probe {
  compareFresh(): Promise<Equivalence>;
}

/** The same two-box union used by boolean-evolution-demand.test.ts. */
function fusedPlateDocument(): ProjectDocument {
  let document = addPrimitiveFeature(
    createProjectDocument('Public H02 lineage diagnostic', toUserId('test')),
    {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 24, depth: 10 }
    }
  );
  const plateId = document.bodyOrder[0]!;
  document = addPrimitiveFeature(document, {
    name: 'Post',
    primitiveKind: 'box',
    dimensions: { width: 12, height: 24, depth: 30 }
  });
  return booleanBodies(document, {
    name: 'Fuse',
    operation: 'union',
    targetBodyIds: [plateId, document.bodyOrder[1]!]
  }).document;
}

it('matches fresh raw geometry and publication across eager/idle cache history', async () => {
  const document = fusedPlateDocument();
  let cacheEvent: RebuildCacheEvent | undefined;
  const adapter = await createExactKernelAdapter({
    onRebuildCacheEvent: (event) => {
      cacheEvent = event;
    }
  });
  const probe = (globalThis as unknown as { __h02Session: Probe }).__h02Session;
  const observations: {
    phase: string;
    requestedMode: string;
    cacheEvent: RebuildCacheEvent | undefined;
    exact: Equivalence;
  }[] = [];
  const compare = async (phase: string, idle: boolean) => {
    await adapter.syncDocument(
      document,
      undefined,
      undefined,
      undefined,
      idle ? IDLE : undefined
    );
    // Use the unchanged sustained-session helper: capture every actual owning
    // arena before measurement, then compare all serialized bytes and every
    // publication field under its existing cross-arena normalization. Both
    // final calls receive the same recorded analysis and lineage-demand options.
    const requestedEvent = cacheEvent;
    const exact = await probe.compareFresh();
    observations.push({
      phase,
      requestedMode: idle ? 'idle-empty-demand' : 'eager-default',
      cacheEvent: requestedEvent,
      exact
    });
  };
  try {
    await compare('cold-idle', true);
    // Preflights use eager lineage. An idle request then admits the eager
    // checkpoint, while a fresh idle build skips the boolean evolution probe.
    await adapter.syncDocument(document);
    await compare('idle-after-eager', true);
    // Aligning both final calls to eager mode checks the same live geometry
    // without resetting the adapter. Then a reset checks cold idle mode again.
    await compare('aligned-eager', false);
    adapter.dispose();
    await compare('restart-idle', true);

    console.log(
      '[H02 public publication history]',
      JSON.stringify(observations)
    );
    // Complete every control before reporting the known failure. No field,
    // tolerance, expected-failure marker or equality condition is relaxed.
    for (const { phase, exact } of observations) {
      expect.soft(exact.bodies, `${phase}: exact bodies`).toBe(3);
      expect.soft(exact.faces, `${phase}: exact faces`).toBe(20);
      expect.soft(exact.warnings, `${phase}: warnings`).toBe(0);
      expect
        .soft(exact.serializedBytes, `${phase}: serialized bytes`)
        .toBeGreaterThan(0);
      expect.soft(exact.rawEquivalent, `${phase}: every B-rep byte`).toBe(true);
      expect
        .soft(
          exact.publicationEquivalent,
          `${phase}: strict normalized publication equality`
        )
        .toBe(true);
    }
  } finally {
    adapter.dispose();
  }
}, 120_000);
