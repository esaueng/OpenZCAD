/**
 * Two small histories whose reorders are refused for different reasons, and
 * a reading of where a STEP export's cylindrical cuts stand. Shared by the
 * adapter suite (`test/consumed-cutter-reorder.test.ts`) and the browser
 * specs (`test/e2e/history-reorder-consumed-cutter.spec.ts`,
 * `test/e2e/history-reorder-preflight.spec.ts`).
 *
 * - {@link ventedBlock} (#2334): a vent cutter placed by a Move before the
 *   Subtract that consumes it. Moving the placement below the Subtract used
 *   to commit: the Subtract then consumed the cylinder where it was created,
 *   at the origin, and the export carried a vent open to the stock's corner
 *   instead of the one at (52, 21). The order gate now refuses that move.
 * - {@link keyedCore}: a placement that a later copy only READS. Moving it
 *   below the copy is a legal order that forks nothing, but the copy then
 *   misses the block and the Intersect after it cannot rebuild, which only
 *   the exact preflight can find.
 */
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createBodyFeatureIds,
  createFeatureOnlyIds,
  createProjectDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  entityRefs,
  parseStepEntities,
  splitArgs
} from '../parity/step-inner-loop-winding';

/** The stock: a block from (0, 0, 0) to (64, 42, 16) mm. */
const STOCK = { x: 64, y: 42, z: 16 } as const;
/** The blind pocket: X 18–41, Y 10–29, from Z 6 up through the top. */
const POCKET = { min: [18, 10, 6], max: [41, 29, 26] } as const;
/** The through vent: a vertical radius-3 mm cylinder on the axis (52, 21). */
export const VENT = { x: 52, y: 21, radius: 3 } as const;

export const PLACEMENT = 'Locate Offset vent';
export const SUBTRACT = 'Subtract pocket and vent';
export const VENT_BODY = 'Offset vent';

/** The history as built. */
export const HISTORY = [
  'Stock',
  'Pocket tool',
  'Place pocket tool',
  VENT_BODY,
  PLACEMENT,
  SUBTRACT
] as const;

/**
 * The refusal for the placement moved below the Subtract, or the Subtract
 * moved above the placement: the same arrangement either way.
 */
export const REFUSAL = `Cannot reorder: “${PLACEMENT}” would run after “${SUBTRACT}” already replaced “${VENT_BODY}”, which branches the history. Keep “${PLACEMENT}” before “${SUBTRACT}”.`;

export interface VentedBlock {
  manager: CommandManager;
  /** The Subtract's result: the one body on screen. */
  result: BodyId;
  features: Record<(typeof HISTORY)[number], FeatureId>;
}

/**
 * The issue's model, built through the command layer so the document carries
 * the log a session would have written. A box primitive has a corner on the
 * origin (width along X, height along Y, depth along Z); a cylinder stands on
 * Z = 0 about the Z axis.
 */
export function ventedBlock(): VentedBlock {
  const manager = new CommandManager(
    createProjectDocument('Vented block', toUserId('user_2334'), 'mm')
  );
  const stock = createBodyFeatureIds();
  const pocket = createBodyFeatureIds();
  const vent = createBodyFeatureIds();
  const placePocket = createFeatureOnlyIds();
  const locate = createFeatureOnlyIds();
  const subtract = createBodyFeatureIds();
  const size = {
    x: POCKET.max[0] - POCKET.min[0],
    y: POCKET.max[1] - POCKET.min[1],
    z: POCKET.max[2] - POCKET.min[2]
  };
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Stock',
      bodyName: 'Stock',
      primitiveKind: 'box',
      dimensions: { width: STOCK.x, height: STOCK.y, depth: STOCK.z },
      ids: stock
    })
  );
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Pocket tool',
      bodyName: 'Pocket tool',
      primitiveKind: 'box',
      dimensions: { width: size.x, height: size.y, depth: size.z },
      ids: pocket
    })
  );
  manager.execute(
    commandFactories.transformBody({
      name: 'Place pocket tool',
      targetBodyId: pocket.bodyId,
      translation: { x: POCKET.min[0], y: POCKET.min[1], z: POCKET.min[2] },
      ids: placePocket
    })
  );
  manager.execute(
    commandFactories.addPrimitive({
      name: VENT_BODY,
      bodyName: VENT_BODY,
      primitiveKind: 'cylinder',
      dimensions: { radius: VENT.radius, height: STOCK.z + 2 },
      ids: vent
    })
  );
  manager.execute(
    commandFactories.transformBody({
      name: PLACEMENT,
      targetBodyId: vent.bodyId,
      translation: { x: VENT.x, y: VENT.y, z: -1 },
      ids: locate
    })
  );
  manager.execute(
    commandFactories.booleanBodies({
      name: SUBTRACT,
      operation: 'subtract',
      targetBodyIds: [stock.bodyId, pocket.bodyId, vent.bodyId],
      ids: subtract
    })
  );
  return {
    manager,
    result: subtract.bodyId,
    features: {
      Stock: stock.featureId,
      'Pocket tool': pocket.featureId,
      'Place pocket tool': placePocket.featureId,
      [VENT_BODY]: vent.featureId,
      [PLACEMENT]: locate.featureId,
      [SUBTRACT]: subtract.featureId
    }
  };
}

/** The history of {@link keyedCore} as built. */
export const KEYED_HISTORY = [
  'Block',
  'Key',
  'Park key',
  'Key copy',
  'Keyed core'
] as const;

/**
 * A 20 mm block, a 10 mm key parked clear of it, a copy of the parked key
 * brought back 35 mm into the block, and the Intersect of block and copy.
 * The copy leaves the key live, so "Park key" below "Key copy" consumes
 * nothing twice; but the copy is then taken from the unparked key, lands
 * 35 mm clear of the block, and "Keyed core" has nothing left to keep.
 */
export function keyedCore(): ProjectDocument {
  const manager = new CommandManager(
    createProjectDocument('Keyed core', toUserId('user_2334'), 'mm')
  );
  const block = createBodyFeatureIds();
  const key = createBodyFeatureIds();
  const copy = createBodyFeatureIds();
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Block',
      bodyName: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 20 },
      ids: block
    })
  );
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Key',
      bodyName: 'Key',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 },
      ids: key
    })
  );
  manager.execute(
    commandFactories.transformBody({
      name: 'Park key',
      targetBodyId: key.bodyId,
      translation: { x: -30, y: 5, z: 5 },
      ids: createFeatureOnlyIds()
    })
  );
  manager.execute(
    commandFactories.transformBody({
      name: 'Key copy',
      bodyName: 'Key copy',
      targetBodyId: key.bodyId,
      translation: { x: 35, y: 0, z: 0 },
      copy: true,
      ids: copy
    })
  );
  manager.execute(
    commandFactories.booleanBodies({
      name: 'Keyed core',
      operation: 'intersect',
      targetBodyIds: [block.bodyId, copy.bodyId]
    })
  );
  return manager.document;
}

/**
 * The project backup File → Import project reads, for a document built
 * here. Its undo history is left out, so the opened project starts with
 * nothing to undo and a refused edit visibly adds nothing.
 */
export function projectBackup(document: ProjectDocument): Buffer {
  const { editHistory: _editHistory, ...stored } =
    withoutDerivedProjection(document);
  void _editHistory;
  return Buffer.from(
    JSON.stringify({
      format: 'openzcad-project',
      version: 1,
      document: stored,
      files: []
    })
  );
}

export const historyNames = (document: ProjectDocument): string[] =>
  document.featureOrder.map((featureId) => {
    const node = Object.values(document.nodes).find(
      (entry) => entry.kind === 'feature' && entry.featureId === featureId
    );
    return node?.name ?? String(featureId);
  });

/** One CYLINDRICAL_SURFACE of a STEP file: a point on its axis, and radius. */
export interface StepCylinder {
  x: number;
  y: number;
  z: number;
  /** The axis direction, as written. */
  axis: [number, number, number];
  radius: number;
}

function numbers(text: string | undefined): number[] {
  return [...(text ?? '').matchAll(/-?\d+\.?\d*(?:[eE][-+]?\d+)?/g)].map(
    (match) => Number(match[0])
  );
}

/**
 * Every cylindrical surface in a STEP export, read from the exchange text:
 * where the FILE says the cut is, not what a reader rebuilds from it.
 */
export function stepCylinders(step: string): StepCylinder[] {
  const entities = parseStepEntities(step);
  const cylinders: StepCylinder[] = [];
  for (const entity of entities.values()) {
    if (entity.type !== 'CYLINDRICAL_SURFACE') continue;
    const args = splitArgs(entity.args);
    const placement = entities.get(entityRefs(args[1] ?? '')[0] ?? -1);
    if (placement?.type !== 'AXIS2_PLACEMENT_3D') {
      throw new Error('CYLINDRICAL_SURFACE without an AXIS2_PLACEMENT_3D.');
    }
    const [originRef, axisRef] = entityRefs(placement.args);
    const origin = numbers(
      splitArgs(entities.get(originRef ?? -1)?.args ?? '')[1]
    );
    const axis = numbers(splitArgs(entities.get(axisRef ?? -1)?.args ?? '')[1]);
    if (origin.length < 3 || axis.length < 3) {
      throw new Error('CYLINDRICAL_SURFACE placement could not be read.');
    }
    cylinders.push({
      x: origin[0]!,
      y: origin[1]!,
      z: origin[2]!,
      axis: [axis[0]!, axis[1]!, axis[2]!],
      radius: numbers(args[2])[0]!
    });
  }
  return cylinders;
}

/** The DATA section alone: the header carries a timestamp. */
export const stepData = (step: string): string =>
  step.slice(step.indexOf('DATA;'));
