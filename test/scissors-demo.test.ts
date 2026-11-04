import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { normalizeDocument } from '@openzcad/document-core';
import {
  solveAssembly,
  toUserId,
  transformPoint,
  type Vector3
} from '@openzcad/shared';
import {
  buildDemoSeed,
  DEMO_DEFINITIONS,
  type DemoSeed
} from '../apps/web/src/lib/demos';

describe('shared scissors sample', () => {
  const definition = DEMO_DEFINITIONS.find((demo) => demo.key === 'scissors')!;
  let adapter: ExactKernelAdapter;
  let seed: DemoSeed;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
    seed = await buildDemoSeed(
      definition,
      toUserId('user_sample'),
      (document) => adapter.syncDocument(document)
    );
  }, 120_000);

  afterAll(() => adapter?.dispose());

  it('rebuilds the supplied editable geometry as three exact solids', () => {
    const { document } = seed;
    expect(document.name).toBe('Demo · Scissors');
    expect(document.units).toBe('mm');
    expect(document.featureOrder).toHaveLength(30);
    expect(document.sketchOrder).toHaveLength(11);
    expect(document.assets).toEqual({});
    expect(document.derived.warnings).toEqual([]);
    expect(document.derived.exportableBodyIds).toHaveLength(3);
    for (const id of document.derived.exportableBodyIds) {
      const body = document.derived.bodyRepresentations[id]!;
      expect(body.exportableStep).toBe(true);
      expect(body.meshReference).toBeUndefined();
      expect(body.volume).toBeGreaterThan(0);
    }
    expect(normalizeDocument(document).assembly).toEqual(document.assembly);
  });

  it('preserves the working pivot and stores the complete assembly checkpoint', () => {
    const { document, saveStates } = seed;
    expect(
      document.assembly?.components.map(({ name, grounded }) => ({
        name,
        grounded
      }))
    ).toEqual([
      { name: 'Lower blade & finger loop', grounded: true },
      { name: 'Upper blade & thumb loop', grounded: false },
      { name: 'Captive pivot pin', grounded: true }
    ]);
    expect(document.assembly?.joints).toHaveLength(1);
    expect(document.assembly?.joints[0]).toMatchObject({
      kind: 'revolute',
      values: [30],
      limits: [{ min: 0, max: 55 }]
    });
    expect(definition.revisions).toEqual([]);
    expect(saveStates).toHaveLength(1);
    expect(document.checkpoints).toHaveLength(1);
    expect(saveStates[0]?.assembly).toEqual(document.assembly);
    expect(saveStates[0]?.checkpoints).toEqual(document.checkpoints);
  });

  it('seeds independent copies with the current owner and deterministic identity', async () => {
    const next = await buildDemoSeed(
      definition,
      undefined,
      async () => seed.document.derived
    );
    for (const document of [seed.document, ...seed.saveStates, next.document]) {
      expect(document.projectId).toBe(definition.projectId);
      expect(document.nodes[document.rootNodeId]).toMatchObject({
        projectId: definition.projectId,
        name: definition.name
      });
      expect(document.editHistory).toBeUndefined();
    }
    expect(seed.document.ownerUserId).toBe('user_sample');
    expect(seed.saveStates[0]?.ownerUserId).toBe('user_sample');
    expect(next.document.ownerUserId).toBe('user_local_browser');
    next.document.assembly!.joints[0]!.values[0] = 10;
    expect(seed.document.assembly!.joints[0]!.values).toEqual([30]);
    const reset = await buildDemoSeed(
      definition,
      toUserId('user_sample'),
      async () => seed.document.derived
    );
    expect(reset.document.assembly!.joints[0]!.values).toEqual([30]);
  });

  it('opens the blades by spreading the finger loops, never crossing them', () => {
    const set = seed.document.assembly!;
    const joint = set.joints[0]!;
    const { min, max } = joint.limits[0]!;
    // The blades lie along +x from the pivot; the loops are on the -x side.
    // Mean of each loop part's vertices behind the pivot, in modelled space.
    function loopCentre(componentId: string): Vector3 {
      const component = set.components.find((c) => c.id === componentId)!;
      const { vertices } =
        seed.document.derived.bodyRepresentations[component.bodyId]!.mesh;
      const sum = { x: 0, y: 0, z: 0 };
      let count = 0;
      for (let i = 0; i < vertices.length; i += 3) {
        if (vertices[i]! >= -10) continue;
        sum.x += vertices[i]!;
        sum.y += vertices[i + 1]!;
        sum.z += vertices[i + 2]!;
        count += 1;
      }
      expect(count).toBeGreaterThan(0);
      return { x: sum.x / count, y: sum.y / count, z: sum.z / count };
    }
    const finger = joint.parent.componentId;
    const thumb = joint.child.componentId;
    const fingerLoop = loopCentre(finger);
    const thumbLoop = loopCentre(thumb);
    function gap(value: number): number {
      const poses = solveAssembly(set, new Map([[joint.id, [value]]])).poses;
      const a = transformPoint(poses.get(finger)!, fingerLoop);
      const b = transformPoint(poses.get(thumb)!, thumbLoop);
      return Math.hypot(a.x - b.x, a.y - b.y);
    }
    // Closed at 0: the loops sit apart, and opening only spreads them.
    expect(min).toBe(0);
    const steps = 11;
    let previous = gap(min);
    for (let step = 1; step <= steps; step += 1) {
      const next = gap(min + ((max - min) * step) / steps);
      expect(next).toBeGreaterThan(previous);
      previous = next;
    }
    expect(gap(max)).toBeGreaterThan(gap(min) * 1.5);
  });
});
