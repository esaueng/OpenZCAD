import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activateConfiguration,
  addAssemblyComponents,
  addAssemblyJoint,
  addConfigurationColumn,
  addConfigurationRow,
  addPrimitiveFeature,
  assemblyCheckComponents,
  assemblyInterferenceOperands,
  attachDerivedState,
  createConfigurations,
  createProjectDocument,
  listParameters,
  planAssemblySweep,
  runAssemblySweep,
  setConfigurationCell,
  setParameter,
  summarizeInterference,
  updateAssemblyComponent,
  type AssemblySweepCheck
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  IDENTITY_PLACEMENT,
  toUserId,
  type AssemblyFrame,
  type AssemblyInterferencePair,
  type BodyClashVerdict,
  type BodyId,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * AS04 / F06 (#2388): a part whose own Configuration names another row than
 * the model's active one is checked as that row builds it, which is what
 * Assemble draws (`assemblyRowDrawnParts`), never as the active row does.
 * Checking the active row's geometry reported a false clearance for a wider
 * part, and a false overlap for a narrower one.
 */
let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 120_000);
afterAll(() => adapter.dispose());

/**
 * The issue's fixture. A 20 × 10 × 4 plate whose width the configuration
 * drives (Narrow 20, Wide 45), a fixed 6 × 6 × 2 stop at (30, 2, 1) and an
 * Indicator lug that Wide suppresses, set well away from both. Narrow leaves
 * 10 mm between plate and stop; Wide contains the stop, a 72 mm³ overlap.
 */
function fixture() {
  let document = createProjectDocument('Stop', toUserId('user_as04_rows'));
  document = setParameter(document, { name: 'width', expression: '20' });
  for (const [name, dimensions] of [
    ['Plate', { width: 'width', height: 10, depth: 4 }],
    ['Stop', { width: 6, height: 6, depth: 2 }],
    ['Indicator lug', { width: 4, height: 4, depth: 4 }]
  ] as const)
    document = addPrimitiveFeature(document, {
      name,
      bodyName: name,
      primitiveKind: 'box',
      dimensions
    });
  const width = listParameters(document)[0]!.parameterId;
  const lug = Object.values(document.nodes).find(
    (node): node is FeatureNode =>
      node.kind === 'feature' && node.name === 'Indicator lug'
  )!;
  const [plate, stop, lugBody] = document.bodyOrder as [BodyId, BodyId, BodyId];
  document = createConfigurations(document, {
    rowId: 'narrow',
    name: 'Narrow'
  });
  document = addConfigurationColumn(document, {
    column: { kind: 'parameter', parameterId: width }
  });
  document = addConfigurationColumn(document, {
    column: { kind: 'suppression', featureId: lug.featureId }
  });
  document = addConfigurationRow(document, { rowId: 'wide', name: 'Wide' });
  document = setConfigurationCell(document, {
    rowId: 'wide',
    column: { kind: 'parameter', parameterId: width },
    value: '45'
  });
  document = setConfigurationCell(document, {
    rowId: 'wide',
    column: { kind: 'suppression', featureId: lug.featureId },
    value: true
  });
  document = addAssemblyComponents(document, {
    components: [
      { componentId: 'c_plate', name: 'Plate', bodyId: plate, grounded: true },
      {
        componentId: 'c_stop',
        name: 'Stop',
        bodyId: stop,
        grounded: true,
        placement: {
          ...IDENTITY_PLACEMENT,
          translation: { x: 30, y: 2, z: 1 }
        }
      },
      {
        componentId: 'c_lug',
        name: 'Indicator lug',
        bodyId: lugBody,
        grounded: true,
        placement: {
          ...IDENTITY_PLACEMENT,
          translation: { x: 0, y: 60, z: 0 }
        }
      }
    ]
  });
  return document;
}

async function synced(document: ProjectDocument) {
  return attachDerivedState(document, await adapter.syncDocument(document));
}

/** The check as the Interference section runs it, on the synced model. */
async function interference(document: ProjectDocument) {
  const live = await synced(document);
  const { operands, missing } = assemblyInterferenceOperands(live);
  const report = await adapter.assemblyInterference(live, operands);
  return { ...report, missing: [...new Set([...missing, ...report.missing])] };
}

function verdictOf(
  pairs: AssemblyInterferencePair[],
  a: string,
  b: string
): BodyClashVerdict {
  const pair = pairs.find((p) => p.a === a && p.b === b);
  if (!pair) throw new Error(`no pair ${a}·${b}`);
  return pair.verdict;
}

describe('AS04 interference of parts in another configuration (#2388)', () => {
  it('follows the model while no part names another row', async () => {
    const report = await interference(fixture());
    expect(report.missing).toEqual([]);
    expect(report.configurations).toBeUndefined();
    expect(verdictOf(report.pairs, 'c_plate', 'c_stop')).toMatchObject({
      kind: 'clear',
      touching: false,
      distance: 10
    });
    expect(summarizeInterference(report)).toMatchObject({
      interfering: 0,
      unknown: 0,
      clear: 3
    });
  }, 120_000);

  it('checks a Wide part in a Narrow model as Wide: the stop is inside it', async () => {
    const document = updateAssemblyComponent(fixture(), {
      componentId: 'c_plate',
      configurationId: 'wide'
    });
    const before = JSON.stringify(document);
    const report = await interference(document);
    const verdict = verdictOf(report.pairs, 'c_plate', 'c_stop');
    expect(verdict.kind).toBe('interference');
    if (verdict.kind !== 'interference') return;
    expect(verdict.volume).toBeCloseTo(72, 6);
    expect(verdict.complete).toBe(true);
    // The stop itself, in the assembly's frame.
    expect(verdict.bounds).toMatchObject({
      min: { x: 30, y: 2, z: 1 },
      max: { x: 36, y: 8, z: 3 }
    });
    expect(report.configurations).toEqual({
      c_plate: { rowId: 'wide', rowName: 'Wide' }
    });
    expect(report.missing).toEqual([]);
    expect(summarizeInterference(report)).toMatchObject({
      interfering: 1,
      unknown: 0,
      clear: 2
    });
    // The model's own active row is untouched by the check.
    expect(JSON.stringify(document)).toBe(before);
    expect(document.configurations?.activeRowId).toBe('narrow');
  }, 120_000);

  it('checks Narrow parts in a Wide model as Narrow: the gap is back, and the lug is there', async () => {
    let document = updateAssemblyComponent(fixture(), {
      componentId: 'c_plate',
      configurationId: 'narrow'
    });
    document = updateAssemblyComponent(document, {
      componentId: 'c_lug',
      configurationId: 'narrow'
    });
    // Wide active: the model's plate spans the stop and its lug is suppressed.
    document = activateConfiguration(document, { rowId: 'wide' });
    const live = await synced(document);
    // The active row builds no lug, yet its part is still put to the check.
    expect(
      assemblyCheckComponents(live).components.map((c) => c.componentId)
    ).toEqual(['c_plate', 'c_stop', 'c_lug']);
    const report = await interference(document);
    expect(report.missing).toEqual([]);
    expect(verdictOf(report.pairs, 'c_plate', 'c_stop')).toMatchObject({
      kind: 'clear',
      touching: false,
      distance: 10
    });
    expect(verdictOf(report.pairs, 'c_plate', 'c_lug').kind).toBe('clear');
    expect(report.configurations).toEqual({
      c_plate: { rowId: 'narrow', rowName: 'Narrow' },
      c_lug: { rowId: 'narrow', rowName: 'Narrow' }
    });
    expect(summarizeInterference(report)).toMatchObject({
      interfering: 0,
      unknown: 0,
      clear: 3,
      missing: 0
    });
    // Control: the same model with every part following it does overlap.
    const following = updateAssemblyComponent(
      updateAssemblyComponent(document, {
        componentId: 'c_plate',
        configurationId: null
      }),
      { componentId: 'c_lug', configurationId: null }
    );
    const followed = await interference(following);
    const overlap = verdictOf(followed.pairs, 'c_plate', 'c_stop');
    expect(overlap.kind).toBe('interference');
    if (overlap.kind === 'interference')
      expect(overlap.volume).toBeCloseTo(72, 6);
    // Suppressed in the active row and following it: nothing to check.
    expect(followed.missing).toEqual(['c_lug']);
  }, 120_000);

  it('lists a part whose own row shows no body as having nothing to check', async () => {
    const document = updateAssemblyComponent(fixture(), {
      componentId: 'c_lug',
      configurationId: 'wide'
    });
    const report = await interference(document);
    // Wide suppresses the lug: Assemble draws nothing for it.
    expect(report.missing).toEqual(['c_lug']);
    expect(report.pairs.map((p) => `${p.a}·${p.b}`)).toEqual([
      'c_plate·c_stop'
    ]);
    expect(report.configurations).toEqual({
      c_lug: { rowId: 'wide', rowName: 'Wide' }
    });
  }, 120_000);

  it('leaves every pair of a part whose row cannot be built unknown, never clear', async () => {
    let document = fixture();
    const width = listParameters(document)[0]!.parameterId;
    // Wide no longer evaluates: nothing can say what the part looks like.
    document = setConfigurationCell(document, {
      rowId: 'wide',
      column: { kind: 'parameter', parameterId: width },
      value: '1/0'
    });
    document = updateAssemblyComponent(document, {
      componentId: 'c_plate',
      configurationId: 'wide'
    });
    const report = await interference(document);
    const unknown = {
      kind: 'unknown',
      reason: 'configuration_unavailable',
      message: 'the Wide configuration of Plate could not be built'
    };
    expect(verdictOf(report.pairs, 'c_plate', 'c_stop')).toEqual(unknown);
    expect(verdictOf(report.pairs, 'c_plate', 'c_lug')).toEqual(unknown);
    // The pair that does not involve it is still decided.
    expect(verdictOf(report.pairs, 'c_stop', 'c_lug').kind).toBe('clear');
    expect(summarizeInterference(report)).toMatchObject({
      interfering: 0,
      unknown: 2,
      clear: 1,
      missing: 0
    });
  }, 120_000);

  it('sweeps a part in another row as that row builds it', async () => {
    // The stop slides along +X by 0 to 20 mm: it starts 10 mm clear of the
    // Narrow plate and never reaches it, but is inside the Wide one throughout.
    const along = (x: number): AssemblyFrame => ({
      origin: { x, y: 0, z: 0 },
      zAxis: { x: 1, y: 0, z: 0 },
      xAxis: { x: 0, y: 1, z: 0 }
    });
    const base = fixture();
    const moving: ProjectDocument = addAssemblyJoint(
      {
        ...base,
        assembly: {
          ...base.assembly!,
          components: base.assembly!.components.map((c) =>
            c.id === 'c_stop'
              ? { ...c, grounded: false, placement: { ...IDENTITY_PLACEMENT } }
              : c
          )
        }
      },
      {
        joint: {
          id: 'j_slide',
          name: 'Slide',
          kind: 'slider',
          parent: { componentId: 'c_plate', frame: along(30) },
          child: { componentId: 'c_stop', frame: along(0) },
          values: [0],
          limits: [{ min: 0, max: 5 }]
        }
      }
    );
    const check: AssemblySweepCheck = (document, components, positions) =>
      adapter.assemblyInterferenceSweep(document, components, positions);
    const sweep = async (document: ProjectDocument) => {
      const live = await synced(document);
      const planned = planAssemblySweep(live, {
        kind: 'joint',
        jointId: 'j_slide',
        dof: 0
      });
      if (!planned.ok) throw new Error(planned.reason);
      const report = await runAssemblySweep(live, planned.plan, check);
      return {
        report,
        pair: report.pairs.find((p) => p.a === 'c_plate' && p.b === 'c_stop')!
      };
    };

    const narrow = await sweep(moving);
    expect(narrow.pair.overlaps).toEqual([]);
    expect(narrow.pair.unknownAt).toEqual([]);
    expect(narrow.report.configurations).toEqual({});

    const wide = await sweep(
      updateAssemblyComponent(moving, {
        componentId: 'c_plate',
        configurationId: 'wide'
      })
    );
    expect(wide.pair.unknownAt).toEqual([]);
    expect(wide.pair.overlaps).toHaveLength(1);
    expect(wide.pair.overlaps[0]).toMatchObject({ from: 0, to: 5 });
    expect(wide.report.configurations).toEqual({
      c_plate: { rowId: 'wide', rowName: 'Wide' }
    });
  }, 240_000);
});
