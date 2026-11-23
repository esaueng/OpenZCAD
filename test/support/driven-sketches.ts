import {
  CommandManager,
  commandFactories,
  composeCommands
} from '@openzcad/command-system';
import {
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
  toUserId,
  type ParamValue,
  type ProjectDocument,
  type SketchConstraintData,
  type SketchId
} from '@openzcad/shared';
import { planSketchEdit } from '../../apps/web/src/lib/sketch/edits';

/**
 * Two parameter-driven sketches, each extruded into its own body, under a
 * two-row configuration table: a circle held `gap` from a locked origin by
 * a distance dimension (body "Boss", centre x = gap), and the last copy of a
 * linear pattern spaced `pitch * 2` from a circle at x = 10 (body "Copy",
 * centre x = 10 + 4 × pitch). Small (active) is gap 30 mm, pitch 12 mm;
 * Large is 45 mm and 15 mm. Built without a kernel: the stored geometry is
 * the Small row's, already solved.
 */
export const resolverFor = (document: ProjectDocument) => {
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
  return manager.document.bodyOrder.at(-1)!;
}

/**
 * `gap` 30 mm drives the distance sketch and `pitch` 12 mm the pattern;
 * configuration "Large" holds 45 mm and 15 mm, "Small" the model as it is.
 */
export function drivenSketchesDocument() {
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
  /** The stored centre of the distance circle, as a reopened sketch reads it. */
  const storedCircleX = (candidate: ProjectDocument) => {
    const node = getNode(candidate, circleId as never);
    if (node?.kind !== 'sketch-object' || node.data.objectKind !== 'circle')
      throw new Error('no circle');
    return resolverFor(candidate)(node.data.centerX);
  };
  return {
    document: configured,
    distanceSketch,
    circleId,
    circleBody,
    copyBody,
    storedCircleX,
    columnOf
  };
}
