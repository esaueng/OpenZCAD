import { afterEach, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  chamferEdges,
  createProjectDocument,
  directEditBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter,
  type RebuildCacheEvent
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type EdgeTopology,
  type ProjectDocument
} from '@openzcad/shared';
import { planFaceOffset } from '../apps/web/src/lib/interaction/faceOffsetPlan';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';

/**
 * An edit's preview and commit check propose carrying hash-only edge picks
 * (`proposeCarry`); the broadcast of the committed document does not. The
 * two only ever differ where a stored hash fails to resolve, so while every
 * hash-only pick resolves they share history checkpoints: a drag on a part
 * with hash-only blends no longer replays every blend for the first frame,
 * the commit, and again for the broadcast. Once a pick misses, a carry and a
 * plain refusal of the same document must still never be served for each
 * other.
 */

const user = toUserId('user_carry_neutral_checkpoints');

/** Counts the kernel's chamfer builds across every kernel instance. */
function countChamfers(): { count: () => number; restore: () => void } {
  const proto = RemusKernel.prototype as unknown as Record<string, unknown>;
  const methods = [
    'chamferWithEvolution',
    'chamferDetailed',
    'chamferDistanceAngleWithEvolution',
    'chamferDistanceAngleDetailed'
  ].filter((method) => typeof proto[method] === 'function');
  let calls = 0;
  const originals = methods.map((method) => {
    const original = proto[method] as (...args: unknown[]) => unknown;
    proto[method] = function (this: unknown, ...args: unknown[]) {
      calls += 1;
      return original.apply(this, args);
    };
    return [method, original] as const;
  });
  return {
    count: () => calls,
    restore: () => {
      for (const [method, original] of originals) proto[method] = original;
    }
  };
}

function adjacentFaces(body: BodyRepresentation, edge: EdgeTopology) {
  return (edge.adjacentFaceHashes ?? []).flatMap((hash) => {
    const face = body.topology!.faces.find((f) => f.hash === hash);
    return face ? [face] : [];
  });
}

const restorers: (() => void)[] = [];
afterEach(() => {
  while (restorers.length) restorers.pop()!();
});

async function adapterWithEvents() {
  const events: RebuildCacheEvent[] = [];
  const adapter = await createExactKernelAdapter({
    onRebuildCacheEvent: (event) => events.push(event)
  });
  restorers.push(() => adapter.dispose());
  return { adapter, events };
}

/** A box whose bottom edges a document saved before names chamfered. */
async function hashOnlyChamferedBox(adapter: ExactKernelAdapter) {
  const box = addPrimitiveFeature(createProjectDocument('Carry', user), {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 30, height: 18, depth: 24 }
  });
  const bodyId = box.bodyOrder[0]!;
  const base = await adapter.syncDocument(box);
  const body = base.bodyRepresentations[bodyId]!;
  const bottom = body.topology!.edges.filter((edge) =>
    adjacentFaces(body, edge).some(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        (face.geometry.normal?.z ?? 0) < -0.999
    )
  );
  expect(bottom).toHaveLength(4);
  // Hashes only, as a document saved before edges had names stores them.
  const { document } = chamferEdges(box, {
    name: 'Break bottom',
    targetBodyId: bodyId,
    edgeHashes: bottom.map((edge) => edge.hash),
    size: 1
  });
  const derived = await adapter.syncDocument(document);
  expect(derived.warnings).toEqual([]);
  return { document: { ...document, derived }, bodyId };
}

function outcome(derived: ProjectDocument['derived'], bodyId: BodyId) {
  const body = derived.bodyRepresentations[bodyId]!;
  return {
    warnings: derived.warnings,
    featureWarnings: derived.featureWarnings ?? [],
    edgeHashRepairs: derived.edgeHashRepairs ?? [],
    volume: Math.round(body.volume * 1e6) / 1e6,
    bbox: body.bbox,
    faces: body.topology!.faces.map((face) => face.hash),
    edges: body.topology!.edges.map((edge) => edge.hash)
  };
}

describe('carry-neutral history checkpoints', { timeout: 240_000 }, () => {
  it('shares checkpoints between carry proposals and plain syncs while every pick resolves', async () => {
    const { adapter, events } = await adapterWithEvents();
    const chamfers = countChamfers();
    restorers.push(chamfers.restore);
    const model = await hashOnlyChamferedBox(adapter);
    const top = model.document.derived.bodyRepresentations[
      model.bodyId
    ]!.topology!.faces.find((face) => (face.geometry?.normal?.z ?? 0) > 0.999)!;
    expect(top).toBeDefined();
    const offsetBy = (offset: number) =>
      directEditBody(model.document, {
        name: 'Offset',
        targetBodyId: model.bodyId,
        operation: {
          kind: 'offset-face',
          faceHash: top.hash,
          ...(top.reference ? { faceReference: top.reference } : {}),
          sourceSurfaceType: 'plane',
          sourceArea: top.geometry!.area,
          sourceCenter: top.geometry!.center,
          sourceNormal: top.geometry!.normal!,
          offset
        }
      }).document;

    // A drag's frames and its release check propose carrying, and restore
    // the plain sync's chamfer instead of replaying it.
    const chamfersBefore = chamfers.count();
    for (const offset of [1, 2, 2.5]) {
      const frame = await adapter.previewGeometry(offsetBy(offset), {
        deferTopology: true,
        proposeCarry: true
      });
      expect(frame.warnings).toEqual([]);
    }
    const committed = offsetBy(2.5);
    const commit = await adapter.syncDocument(
      committed,
      undefined,
      undefined,
      undefined,
      { proposeCarry: true }
    );
    expect(chamfers.count()).toBe(chamfersBefore);
    expect(commit.warnings).toEqual([]);
    expect(commit.edgeHashRepairs ?? []).toEqual([]);
    expect(adapter.isCarryNeutral?.(commit)).toBe(true);

    // The broadcast of the committed document is a plain sync. It restores
    // the commit's checkpoints, the edit's result included: nothing replays.
    const broadcast = await adapter.syncDocument(
      committed,
      undefined,
      undefined,
      undefined,
      { lineageDemand: [] }
    );
    expect(events.at(-1)).toMatchObject({
      kind: 'prefix-restore',
      replayed: 0
    });
    expect(chamfers.count()).toBe(chamfersBefore);
    // A plain sync's result is never vouched for as a carry proposal's.
    expect(adapter.isCarryNeutral?.(broadcast)).toBe(false);

    // Both agree exactly with a cold plain build of the committed document.
    const cold = await createExactKernelAdapter();
    try {
      const expected = outcome(
        await cold.syncDocument(committed),
        model.bodyId
      );
      expect(outcome(commit, model.bodyId)).toEqual(expected);
      expect(outcome(broadcast, model.bodyId)).toEqual(expected);
    } finally {
      cold.dispose();
    }
  });

  it('never serves a plain refusal for a carry, or a carry for a plain sync', async () => {
    const { adapter } = await adapterWithEvents();
    const model = await hashOnlyChamferedBox(adapter);
    const side = model.document.derived.bodyRepresentations[
      model.bodyId
    ]!.topology!.faces.find((face) =>
      face.reference?.lineageName.endsWith('box.face.x-max')
    )!;
    expect(side).toBeDefined();
    // Narrowing the box moves the chamfered edges, so their stored hashes no
    // longer resolve: a plain build refuses, a carry proposal carries.
    const plan = planFaceOffset({
      document: model.document,
      bodyId: model.bodyId,
      face: side,
      faceHash: side.hash,
      offset: -7.5
    });
    expect(plan?.kind).toBe('primitive-dimension');
    const candidate = plan!.command.apply(model.document);
    const refused = (derived: ProjectDocument['derived']) =>
      (derived.featureWarnings ?? []).some(
        (warning) =>
          warning.kind === 'build-failed' &&
          warning.kernelRefusal?.code === 'reference_missing'
      );
    const carried = (derived: ProjectDocument['derived']) =>
      derived.warnings.length === 0 &&
      (derived.edgeHashRepairs?.length ?? 0) > 0;
    const plain = () => adapter.syncDocument(candidate);
    const carry = () =>
      adapter.syncDocument(candidate, undefined, undefined, undefined, {
        proposeCarry: true
      });

    // Plain first: its refusal is checkpointed, and the carry must not
    // restore it.
    expect(refused(await plain())).toBe(true);
    const first = await carry();
    expect(carried(first)).toBe(true);
    expect(adapter.isCarryNeutral?.(first)).toBe(false);
    // Then the carry's checkpoints must not answer a plain sync, in either
    // order, however often the two alternate.
    expect(refused(await plain())).toBe(true);
    expect(carried(await carry())).toBe(true);
    expect(carried(await carry())).toBe(true);
    expect(refused(await plain())).toBe(true);
    expect(
      carried(
        await adapter
          .previewGeometry(candidate, {
            deferTopology: true,
            proposeCarry: true
          })
          .then(() => carry())
      )
    ).toBe(true);
  });
});
