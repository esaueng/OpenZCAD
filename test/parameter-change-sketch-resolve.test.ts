import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  composeCommands,
  type AnyCommand
} from '@openzcad/command-system';
import {
  activateConfiguration,
  addConfigurationColumn,
  addConfigurationRow,
  createConfigurations,
  createProjectDocument,
  findSketch,
  getNode,
  getParameterScope,
  listParameters,
  resolveParamValue,
  setConfigurationCell,
  setParameter
} from '@openzcad/document-core';
import { computeSketchRegions } from '@openzcad/geometry';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type ParamValue,
  type ProjectDocument,
  type SketchConstraintData,
  type SketchId
} from '@openzcad/shared';
import { preflightCadPatch } from '../apps/web/src/lib/aiPatchPreflight';
import { buildConfigurationRow } from '../apps/web/src/lib/configurationRowGeometry';
import { sharedDocumentOnRow } from '../apps/web/src/lib/sharedConfiguration';
import { planSketchEdit } from '../apps/web/src/lib/sketch/edits';
import {
  resolveSketchesForValueChange,
  resolvedForDisplay,
  type SolveSketch
} from '../apps/web/src/lib/sketch/parameterResolve';

/**
 * The document stores each sketch's solved coordinates and the rebuild
 * extrudes from them, so a parameter value that drives a sketch relation
 * must solve that sketch again wherever the value changes, not only in the
 * Parameters table: a configuration row switch, a cell of the active row,
 * an assistant `set_parameter` patch and the read-only builds of another
 * row. Two sketches show it on the pinned kernel: a circle held `gap` from
 * a locked origin by a distance dimension, and the last copy of a linear
 * pattern spaced `pitch * 2`. Each is extruded into its own body, whose
 * centre is where the rebuilt solid really is.
 */

let adapter: ExactKernelAdapter;
const solve: SolveSketch = (document, sketchId) =>
  adapter.solveSketch(document, sketchId);

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);

afterAll(() => {
  adapter.dispose();
});

const resolverFor = (document: ProjectDocument) => {
  const { scope } = getParameterScope(document);
  return (value: ParamValue) =>
    resolveParamValue(value, scope, undefined, document.units);
};

function extrudeRegionOf(
  manager: CommandManager,
  sketchId: SketchId,
  objectId: string,
  name: string
) {
  const document = manager.document;
  const objects = findSketch(document, sketchId)!.objectIds.map((id) => {
    const node = getNode(document, id);
    if (node?.kind !== 'sketch-object') throw new Error('no object');
    return { id: String(id), data: node.data };
  });
  const resolve = resolverFor(document);
  const region = computeSketchRegions(objects, (value) =>
    Number(resolve(value))
  ).find(
    (candidate) =>
      candidate.sourceEntityIds.length === 1 &&
      String(candidate.sourceEntityIds[0]) === objectId
  );
  if (!region) throw new Error(`no region for ${name}`);
  manager.execute(
    commandFactories.extrudeSketch({
      name,
      sketchId,
      distance: 5,
      profiles: [
        {
          profileId: region.profileId,
          regionFingerprint: region.regionFingerprint,
          samplePoint: region.samplePoint,
          sourceArea: region.area,
          sourceEntityIds: region.sourceEntityIds
        }
      ]
    })
  );
  return manager.document.bodyOrder.at(-1)! as BodyId;
}

/**
 * `gap` 30 mm drives the distance sketch and `pitch` 12 mm the pattern;
 * configuration "Large" holds 45 mm and 15 mm, "Small" the model as it is.
 */
async function fixture() {
  let document = createProjectDocument(
    'Driven sketches',
    toUserId('user_driven_sketches')
  );
  document = setParameter(document, {
    name: 'gap',
    expression: '30 mm',
    quantity: 'length'
  });
  document = setParameter(document, {
    name: 'pitch',
    expression: '12 mm',
    quantity: 'length'
  });
  const manager = new CommandManager(document);

  // Distance: a locked, horizontal construction line `gap` long whose end
  // holds the circle's centre.
  manager.execute(
    commandFactories.addSketch({
      name: 'Distance',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [
        {
          objectKind: 'line',
          x1: 0,
          y1: 0,
          x2: 30,
          y2: 0,
          construction: true
        },
        { objectKind: 'circle', centerX: 30, centerY: 0, radius: 2 }
      ]
    })
  );
  const distanceSketch = manager.document.sketchOrder[0]!;
  const [lineId, circleId] = findSketch(
    manager.document,
    distanceSketch
  )!.objectIds.map(String) as [string, string];
  const constrain = (sketchId: SketchId, constraint: SketchConstraintData) =>
    manager.execute(
      commandFactories.addSketchConstraint({ sketchId, constraint })
    );
  constrain(distanceSketch, {
    constraintKind: 'lock',
    point: { objectId: lineId as never, point: 'start' },
    x: 0,
    y: 0
  });
  constrain(distanceSketch, {
    constraintKind: 'horizontal',
    objectId: lineId as never
  });
  constrain(distanceSketch, {
    constraintKind: 'coincident',
    a: { objectId: lineId as never, point: 'end' },
    b: { objectId: circleId as never, point: 'center' }
  });
  constrain(distanceSketch, {
    constraintKind: 'radius',
    objectId: circleId as never,
    value: 2
  });
  constrain(distanceSketch, {
    constraintKind: 'distance',
    a: { objectId: lineId as never, point: 'start' },
    b: { objectId: lineId as never, point: 'end' },
    value: 'gap'
  });

  // Pattern: three copies of a circle at `pitch * 2` along a line, as the
  // sketch Pattern tool records them.
  manager.execute(
    commandFactories.addSketch({
      name: 'Pattern',
      planeRef: { type: 'canonical', plane: 'XY', offset: 20 },
      objects: [
        { objectKind: 'circle', centerX: 10, centerY: 0, radius: 1 },
        { objectKind: 'line', x1: 0, y1: -5, x2: 100, y2: -5 }
      ]
    })
  );
  const patternSketch = manager.document.sketchOrder[1]!;
  const [source, direction] = findSketch(
    manager.document,
    patternSketch
  )!.objectIds.map(String) as [string, string];
  const plan = planSketchEdit(
    manager.document,
    findSketch(manager.document, patternSketch)!,
    patternSketch,
    'linear-pattern',
    [source, direction],
    [24, 3],
    ['pitch * 2', '3'],
    resolverFor(manager.document),
    undefined,
    undefined,
    { spacing: 'spacing', orientation: 'rotate' }
  );
  if (plan.status !== 'commands') throw new Error(plan.status);
  manager.execute(composeCommands(plan.label, plan.commands));
  const pattern = findSketch(
    manager.document,
    patternSketch
  )!.constraints!.find(({ data }) => data.constraintKind === 'pattern')!
    .data as Extract<SketchConstraintData, { constraintKind: 'pattern' }>;
  const lastCopy = String(pattern.instances.at(-1)!.objectId);

  const circleBody = extrudeRegionOf(manager, distanceSketch, circleId, 'Boss');
  const copyBody = extrudeRegionOf(manager, patternSketch, lastCopy, 'Copy');

  let configured = createConfigurations(manager.document, {
    rowId: 'row_small',
    name: 'Small'
  });
  for (const name of ['gap', 'pitch']) {
    const parameter = listParameters(configured).find((p) => p.name === name)!;
    configured = addConfigurationColumn(configured, {
      column: { kind: 'parameter', parameterId: parameter.parameterId }
    });
  }
  configured = addConfigurationRow(configured, {
    rowId: 'row_large',
    name: 'Large'
  });
  const columnOf = (name: string) => ({
    kind: 'parameter' as const,
    parameterId: listParameters(configured).find((p) => p.name === name)!
      .parameterId
  });
  configured = setConfigurationCell(configured, {
    rowId: 'row_large',
    column: columnOf('gap'),
    value: '45 mm'
  });
  configured = setConfigurationCell(configured, {
    rowId: 'row_large',
    column: columnOf('pitch'),
    value: '15 mm'
  });
  const configuredManager = new CommandManager(configured);

  /** Each body's centre x as the document rebuilds. */
  const centres = async (candidate: ProjectDocument) => {
    const derived = await adapter.syncDocument(candidate);
    expect(derived.warnings).toEqual([]);
    const x = (bodyId: BodyId) => {
      const { bbox } = derived.bodyRepresentations[bodyId]!;
      return (bbox.min.x + bbox.max.x) / 2;
    };
    return { boss: x(circleBody), copy: x(copyBody) };
  };
  /** The stored centre of the distance circle, as a reopened sketch reads it. */
  const storedCircleX = (candidate: ProjectDocument) => {
    const node = getNode(candidate, circleId as never);
    if (node?.kind !== 'sketch-object' || node.data.objectKind !== 'circle')
      throw new Error('no circle');
    return resolverFor(candidate)(node.data.centerX);
  };
  return {
    manager: configuredManager,
    centres,
    storedCircleX,
    columnOf
  };
}

function expectCentres(
  actual: { boss: number; copy: number },
  boss: number,
  copy: number
) {
  expect(actual.boss).toBeCloseTo(boss, 6);
  expect(actual.copy).toBeCloseTo(copy, 6);
}

describe('a parameter value changed outside the Parameters table', () => {
  it(
    'switching a configuration row moves the sketches its values drive',
    { timeout: 120_000 },
    async () => {
      const f = await fixture();
      const base = f.manager.document;
      expectCentres(await f.centres(base), 30, 58);

      // The row switch alone writes the values but leaves the solved
      // geometry where the Small row put it: the bug.
      const activate = commandFactories.activateConfiguration({
        rowId: 'row_large'
      });
      activate.validate(base);
      const switched = activate.apply(base);
      expectCentres(await f.centres(switched), 30, 58);

      // With the re-solve App runs for every configuration command, the
      // distance circle and the pattern copy follow the Large row, in one
      // history entry.
      const resolved = await resolveSketchesForValueChange(
        base,
        switched,
        solve
      );
      if (!resolved?.ok) throw new Error('the row did not solve');
      expect(resolved.commands.length).toBeGreaterThan(0);
      expect(
        resolved.commands.every(
          (command) => command.kind === 'sketch.object.update'
        )
      ).toBe(true);
      f.manager.runTransaction('Switch to Large', [
        activate,
        ...resolved.commands
      ]);
      const live = f.manager.document;
      expect(f.storedCircleX(live)).toBeCloseTo(45, 6);
      expectCentres(await f.centres(live), 45, 70);
      // Tweak's undo admits the entry: a row switch and its solved sketches.
      expect(f.manager.undoIsParameterOnly).toBe(true);

      // Replay needs no solver: the recorded commands store the geometry.
      const replayed = new CommandManager(base).runTransaction(
        'Switch to Large',
        [activate, ...resolved.commands] as AnyCommand[]
      );
      expect(f.storedCircleX(replayed)).toBeCloseTo(45, 6);

      // And back: the Small row's sizes return.
      const back = activateConfiguration(live, { rowId: 'row_small' });
      const backResolved = await resolveSketchesForValueChange(
        live,
        back,
        solve
      );
      if (!backResolved?.ok) throw new Error('the row did not solve');
      expectCentres(await f.centres(backResolved.document), 30, 58);
    }
  );

  it(
    'an active-row cell edit moves the sketches as a row switch does',
    { timeout: 120_000 },
    async () => {
      const f = await fixture();
      const base = f.manager.document;
      const cell = setConfigurationCell(base, {
        rowId: 'row_small',
        column: f.columnOf('gap'),
        value: '40 mm'
      });
      const resolved = await resolveSketchesForValueChange(base, cell, solve);
      if (!resolved?.ok) throw new Error('the cell did not solve');
      expect(f.storedCircleX(resolved.document)).toBeCloseTo(40, 6);
      expectCentres(await f.centres(resolved.document), 40, 58);
    }
  );

  it(
    'an assistant set_parameter patch stores the solved sketches in its transaction',
    { timeout: 180_000 },
    async () => {
      const f = await fixture();
      const base = f.manager.document;
      const derive = (candidate: ProjectDocument) =>
        adapter.syncDocument(candidate);
      const proposal = {
        proposalId: 'proposal_driven_sketches',
        summary: 'Widen the gap and the pattern pitch.',
        assumptions: [],
        operations: [
          { kind: 'set_parameter' as const, name: 'gap', expression: '50 mm' },
          {
            kind: 'set_parameter' as const,
            name: 'pitch',
            expression: '20 mm'
          }
        ]
      };
      const preflight = await preflightCadPatch(base, proposal, derive, solve);
      expect(
        preflight.commands.some(
          (command) => command.kind === 'sketch.object.update'
        )
      ).toBe(true);
      // The previewed candidate and the applied transaction agree.
      expectCentres(await f.centres(preflight.candidate), 50, 90);
      const applied = new CommandManager(base).runTransaction(
        'Apply AI patch',
        preflight.commands
      );
      expect(f.storedCircleX(applied)).toBeCloseTo(50, 6);
      expectCentres(await f.centres(applied), 50, 90);
    }
  );

  it(
    'builds another row for display with that row’s sketch geometry',
    { timeout: 180_000 },
    async () => {
      const f = await fixture();
      const base = f.manager.document;
      const row = await buildConfigurationRow(
        base,
        'row_large',
        async (candidate) => {
          const derived = await adapter.syncDocument(candidate);
          return {
            status: 'ready',
            bodyRepresentations: derived.bodyRepresentations,
            warnings: derived.warnings
          } as never;
        },
        new AbortController().signal,
        solve
      );
      expect(f.storedCircleX(row)).toBeCloseTo(45, 6);
      expectCentres(await f.centres(row), 45, 70);

      const shared = await sharedDocumentOnRow(
        base,
        'row_large',
        async (candidate) => adapter.syncDocument(candidate),
        solve
      );
      expect(shared.note).toBe('Showing Large.');
      expect(f.storedCircleX(shared.document)).toBeCloseTo(45, 6);

      // The live document is never touched by a display build.
      expect(f.storedCircleX(base)).toBeCloseTo(30, 6);
      const unchanged = await resolvedForDisplay(base, base, solve);
      expect(unchanged).toBe(base);
    }
  );
});
