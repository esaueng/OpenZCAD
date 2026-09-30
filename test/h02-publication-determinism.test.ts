/**
 * H02 publication determinism.
 *
 * A warm adapter that restores history checkpoints and replays a suffix must
 * publish the same derived state as a cold adapter that rebuilds from an
 * empty kernel, down to `blendRegionKey` and `lineageDiagnostics` messages.
 * This is the public mirror of the opt-in private fresh-build publication
 * oracle (docs/qa/2026-09-29/h02-cache-safety.md, PR #488), which failed on
 * both main and the hardened cache because those two field families quoted
 * kernel arena handles: allocation order differs between a restored arena
 * and a fresh one, so identical geometry published different values.
 *
 * The only tolerated arena-bound fields stay the two recognized-opening
 * diagnostic face indices, normalized exactly as the public growing-holder
 * equivalence test does; every witness, hash, key and message is compared.
 */
import { expect, it } from 'vitest';
import { CommandManager } from '@openzcad/command-system';
import { setParameter } from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type RebuildCacheEvent
} from '@openzcad/kernel-adapter/exact';
import type { BodyRepresentation, BodyTopology } from '@openzcad/shared';
import { topologyReferenceRepairCommand } from '../apps/web/src/lib/topologyReferenceRepairs';
import { steppedBore } from './helpers/stepped-bore';

function topologyWithoutArenaHandles(topology: BodyTopology | undefined) {
  const copy = structuredClone(topology);
  const recognition = copy?.recognizedOpening;
  if (recognition?.status === 'recognized') {
    for (const key of ['faceA', 'faceB'] as const) {
      expect(Number.isSafeInteger(recognition.evidence.candidate[key])).toBe(
        true
      );
      expect(recognition.evidence.candidate[key]).toBeGreaterThanOrEqual(0);
      recognition.evidence.candidate[key] = 0;
    }
  }
  return copy;
}

function publicationOf(body: BodyRepresentation) {
  return {
    volume: body.volume,
    faceCount: body.faceCount,
    bbox: body.bbox,
    triangles: body.mesh.indices.length / 3,
    topology: topologyWithoutArenaHandles(body.topology)
  };
}

function blendRegionKeys(derived: {
  bodyRepresentations: Record<string, BodyRepresentation>;
}): string[] {
  return Object.values(derived.bodyRepresentations).flatMap((body) =>
    (body.topology?.faces ?? [])
      .map((face) => face.geometry?.blendRegionKey)
      .filter((key): key is string => key !== undefined)
  );
}

it('publishes a checkpoint-restored warm edit identically to a cold exact rebuild', async () => {
  const events: RebuildCacheEvent[] = [];
  const warm = await createExactKernelAdapter({
    onRebuildCacheEvent: (event) => events.push(event)
  });
  const cold = await createExactKernelAdapter({
    historyCheckpointLimit: 0,
    measuredShapeCacheBytes: 0
  });
  try {
    const base = await steppedBore(warm);
    expect(base.derived.warnings).toEqual([]);
    // Upgrade the legacy hash pins to lineage references so tail edits
    // replay cleanly, exactly like the parameter-replay suite does.
    const repair = topologyReferenceRepairCommand(base.document, base.derived);
    expect(repair).not.toBeNull();
    const repaired = new CommandManager(base.document).normalize(repair!);
    // A tail parameter: the last fillet feature. The prefix digest is
    // unchanged, so the warm adapter must restore a checkpoint and replay
    // only the suffix — the arena path the private oracle caught.
    const edited = setParameter(repaired, {
      name: 'outside_round',
      expression: '0.9'
    });
    events.length = 0;
    const actual = await warm.syncDocument(edited);
    const restore = events.at(-1)!;
    expect(restore.kind).toBe('prefix-restore');
    expect(restore.restored).toBeGreaterThan(0);
    expect(restore.replayed).toBeGreaterThan(0);
    const expected = await cold.syncDocument(edited);
    expect(actual.warnings).toEqual([]);
    expect(expected.warnings).toEqual([]);
    expect(actual.exportableBodyIds).toEqual(expected.exportableBodyIds);
    // The comparison below must actually see the blend-region-key family the
    // private oracle caught, or it proves nothing. Lineage diagnostic
    // messages ride along in the topology equality; their arena-handle
    // determinism is pinned per producer site in
    // packages/kernel-adapter/src/lineage-message-determinism.test.ts.
    expect(blendRegionKeys(actual).length).toBeGreaterThan(0);
    expect(blendRegionKeys(actual)).toEqual(blendRegionKeys(expected));
    for (const bodyId of edited.bodyOrder) {
      expect(publicationOf(actual.bodyRepresentations[bodyId]!)).toEqual(
        publicationOf(expected.bodyRepresentations[bodyId]!)
      );
    }
    // The repair-only resync (identical geometry, upgraded pins) is the
    // same-adapter comparison the replay suite had to strip
    // `blendRegionKey` from; cross-adapter it must be exact too.
    events.length = 0;
    const repairedActual = await warm.syncDocument(repaired);
    expect(events.at(-1)!.kind).toBe('prefix-restore');
    const repairedExpected = await cold.syncDocument(repaired);
    expect(repairedActual.warnings).toEqual([]);
    expect(repairedExpected.warnings).toEqual([]);
    expect(blendRegionKeys(repairedActual).length).toBeGreaterThan(0);
    for (const bodyId of repaired.bodyOrder) {
      expect(
        publicationOf(repairedActual.bodyRepresentations[bodyId]!)
      ).toEqual(publicationOf(repairedExpected.bodyRepresentations[bodyId]!));
    }
  } finally {
    warm.dispose();
    cold.dispose();
  }
}, 240_000);
