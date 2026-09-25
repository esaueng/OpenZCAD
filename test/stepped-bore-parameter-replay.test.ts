import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  attachDerivedState,
  listFeaturesInOrder,
  setParameter
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import type { BodyRepresentation, ProjectDocument } from '@openzcad/shared';
import { topologyReferenceRepairCommand } from '../apps/web/src/lib/topologyReferenceRepairs';
import { parameterBuildError } from '../apps/web/src/lib/parameterEdit';
import { steppedBore } from './helpers/stepped-bore';

function geometry(body: BodyRepresentation): unknown {
  return JSON.parse(
    JSON.stringify(
      {
        volume: body.volume,
        faceCount: body.faceCount,
        bbox: body.bbox,
        faces: body.topology!.faces.map((f) => ({
          hash: f.hash,
          geometry: f.geometry
        })),
        edges: body.topology!.edges.map((e) => ({
          hash: e.hash,
          curve: e.curve
        }))
      },
      (key, value: unknown) => (key === 'blendRegionKey' ? undefined : value)
    )
  );
}

describe('parameter replay through a drilled, offset, resized and rounded part', () => {
  let adapter: ExactKernelAdapter;
  let baseline: Awaited<ReturnType<typeof steppedBore>>;
  let repaired: ProjectDocument;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
    baseline = await steppedBore(adapter);
    expect(baseline.derived.warnings).toEqual([]);
    expect(baseline.derived.faceReferenceRepairs).toHaveLength(2);
    expect(baseline.derived.referenceRepairs).toHaveLength(4);
    const command = topologyReferenceRepairCommand(
      baseline.document,
      baseline.derived
    );
    expect(command).not.toBeNull();
    repaired = new CommandManager(baseline.document).normalize(command!);
  }, 120000);
  afterAll(() => adapter?.dispose());

  it('upgrades the complete legacy stack once without changing its geometry', async () => {
    const result = await adapter.syncDocument(repaired);
    expect(result.warnings).toEqual([]);
    expect(geometry(result.bodyRepresentations[baseline.bodyId]!)).toEqual(
      geometry(baseline.derived.bodyRepresentations[baseline.bodyId]!)
    );
    expect(result.referenceRepairs).toBeUndefined();
    expect(result.faceReferenceRepairs).toBeUndefined();
    expect(topologyReferenceRepairCommand(repaired, result)).toBeNull();
    const attached = attachDerivedState(baseline.document, baseline.derived);
    expect(attached.derived.faceReferenceRepairs).toBeUndefined();
  }, 60000);

  it.each([
    ['radius', 19],
    ['height', 26],
    ['recess_offset', -4],
    ['recess_diameter', 14],
    ['entry_round', 0.7],
    ['shoulder_round', 0.7],
    ['bore_round', 0.7],
    ['outside_round', 0.9]
  ] as const)(
    'replays %s and matches a freshly authored shape',
    async (name, value) => {
      const candidate = setParameter(repaired, {
        name,
        expression: String(value)
      });
      const derived = await adapter.syncDocument(candidate);
      expect(derived.warnings).toEqual([]);
      expect(derived.exportableBodyIds).toEqual([baseline.bodyId]);
      expect(
        parameterBuildError({ ...repaired, derived: baseline.derived }, derived)
      ).toBeNull();
      const oracle = await steppedBore(adapter, { [name]: value });
      expect(oracle.derived.warnings).toEqual([]);
      const result = derived.bodyRepresentations[baseline.bodyId]!;
      const expected = oracle.derived.bodyRepresentations[oracle.bodyId]!;
      expect(result.faceCount).toBe(expected.faceCount);
      expect(result.volume).toBeCloseTo(expected.volume, 6);
      expect(result.bbox).toEqual(expected.bbox);
      expect(result.topology!.faces.map((f) => f.hash).sort()).toEqual(
        expected.topology!.faces.map((f) => f.hash).sort()
      );
    },
    120000
  );

  it('survives a cold serialized reopen and preserves repairs through undo and redo', async () => {
    const manager = new CommandManager(repaired);
    manager.execute(
      commandFactories.setParameter({ name: 'height', expression: '26' })
    );
    manager.execute(
      commandFactories.setParameter({ name: 'radius', expression: '19' })
    );
    const cold = await createExactKernelAdapter({ historyCheckpointLimit: 0 });
    try {
      for (const doc of [manager.document, manager.undo(), manager.redo()]) {
        const restored = JSON.parse(JSON.stringify(doc)) as ProjectDocument;
        const d = await cold.syncDocument(restored);
        expect(d.warnings).toEqual([]);
        expect(d.exportableBodyIds).toEqual([baseline.bodyId]);
        expect(d.referenceRepairs).toBeUndefined();
        expect(d.faceReferenceRepairs).toBeUndefined();
      }
      const step = await cold.exportStep(manager.document, [baseline.bodyId]);
      expect(step).toContain('MANIFOLD_SOLID_BREP');
    } finally {
      cold.dispose();
    }
  }, 120000);

  it('keeps invalid edits and stale saved selections closed', async () => {
    const candidate = setParameter(repaired, {
      name: 'radius',
      expression: '-1'
    });
    const derived = await adapter.syncDocument(candidate);
    expect(
      parameterBuildError({ ...repaired, derived: baseline.derived }, derived)
    ).toBeTruthy();
    const broken = structuredClone(baseline.document);
    const offset = listFeaturesInOrder(broken).find(
      (f) => f.data.featureKind === 'direct-edit'
    )!;
    if (offset.data.featureKind !== 'direct-edit')
      throw new Error('Missing offset');
    offset.data.operation.faceHash = 987654321;
    const refused = await adapter.syncDocument(broken);
    expect(refused.warnings.length).toBeGreaterThan(0);
    expect(
      refused.faceReferenceRepairs?.some(
        (r) => r.featureId === offset.featureId
      )
    ).not.toBe(true);
    expect(topologyReferenceRepairCommand(broken, refused)).toBeNull();
  }, 60000);
});
