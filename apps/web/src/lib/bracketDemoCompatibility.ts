import { CommandManager, commandFactories } from '@openzcad/command-system';
import { listFeaturesInOrder } from '@openzcad/document-core';
import type { ProjectDocument, SerializedCommand } from '@openzcad/shared';
import { BRACKET_BOSS_HEIGHT } from './bracketDemoPlacement';

const LEGACY_HEIGHT = 'plate_t + wall_h / 2';
const REPAIR_LABEL = 'Repair bracket fillet clearance';
const NAMES = [
  'Base plate',
  'Wall plate',
  'Seat wall on base',
  'Union L bracket',
  'Boss',
  'Place boss on wall',
  'Union boss',
  'Boss bore tool',
  'Aim bore through boss',
  'Boss bore',
  'Mount hole L',
  'Place mount hole L',
  'Mount hole R',
  'Place mount hole R',
  'Mount hole L cut',
  'Mounting holes',
  'Wall top edge break'
];
const SEED_COMMANDS = new Set([
  'parameter.set',
  'primitive.add',
  'feature.transform',
  'feature.boolean',
  'feature.fillet',
  'node.rename',
  'node.metadata.set'
]);

function seedCommand(command: SerializedCommand): boolean {
  return command.kind === 'transaction'
    ? Array.isArray(command.payload) &&
        (command.payload as SerializedCommand[]).every(seedCommand)
    : SEED_COMMANDS.has(command.kind);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
        )
      : item
  );
}

/**
 * Repair only the original deterministic local demo with its original feature
 * recipe. Parameter edits and presentation changes survive. A modeling edit,
 * different project identity, changed expression or changed target abstains.
 * The two updates form one ordinary, durable, undoable transaction; no stored
 * snapshot, checkpoint or earlier command is rewritten.
 * Caller must establish ownership before applying this document edit.
 */
export function repairLegacyBracketDemo(
  document: ProjectDocument
): ProjectDocument {
  if (
    document.projectId !== 'proj_demo_mounting_bracket' ||
    document.units !== 'mm'
  )
    return document;
  // An owner who explicitly undid the repair keeps that choice and its redo.
  if (
    document.editHistory?.entries.some((entry) => entry.label === REPAIR_LABEL)
  )
    return document;
  const features = listFeaturesInOrder(document);
  if (
    features.length !== NAMES.length ||
    features.some(
      (feature, index) =>
        feature.name !== NAMES[index] || feature.metadata?.suppressed
    ) ||
    document.commandLog.some((command) => !seedCommand(command))
  )
    return document;

  const primitive = (
    primitiveKind: string,
    dimensions: Record<string, string>
  ) => ({ featureKind: 'primitive', primitiveKind, dimensions });
  const transform = (
    target: number,
    translation: Record<string, string | number>,
    rotationDeg = { x: 0, y: 0, z: 0 }
  ) => ({
    featureKind: 'transform',
    targetBodyId: features[target]!.bodyId,
    transform: { translation, rotationDeg }
  });
  const boolean = (operation: string, ...targets: number[]) => ({
    featureKind: 'boolean',
    operation,
    targetBodyIds: targets.map((index) => features[index]!.bodyId)
  });
  const expected = [
    primitive('box', { width: 'width', height: 'depth', depth: 'plate_t' }),
    primitive('box', { width: 'width', height: 'plate_t', depth: 'wall_h' }),
    transform(1, { x: 0, y: 'depth - plate_t', z: 'plate_t - 0.5' }),
    boolean('union', 0, 1),
    primitive('cylinder', { radius: 'boss_r', height: 'plate_t + 4' }),
    transform(
      4,
      { x: 'width / 2', y: 'depth - plate_t + 2', z: LEGACY_HEIGHT },
      { x: 90, y: 0, z: 0 }
    ),
    boolean('union', 3, 4),
    primitive('cylinder', { radius: 'hole_r', height: 'wall_h + 16' }),
    transform(
      7,
      { x: 'width / 2', y: 'depth + 8', z: LEGACY_HEIGHT },
      { x: 90, y: 0, z: 0 }
    ),
    boolean('subtract', 6, 7),
    primitive('cylinder', { radius: 'mount_r', height: 'plate_t + 4' }),
    transform(10, { x: 'mount_inset', y: 'depth / 2', z: -2 }),
    primitive('cylinder', { radius: 'mount_r', height: 'plate_t + 4' }),
    transform(12, { x: 'width - mount_inset', y: 'depth / 2', z: -2 }),
    boolean('subtract', 9, 10),
    boolean('subtract', 14, 12)
  ];
  if (
    expected.some(
      (data, index) => canonical(features[index]!.data) !== canonical(data)
    )
  )
    return document;
  const fillet = features[16]!.data;
  if (
    fillet.featureKind !== 'fillet' ||
    fillet.targetBodyId !== features[15]!.bodyId ||
    fillet.radius !== 'fillet_r' ||
    fillet.endRadius !== undefined ||
    fillet.edgeHashes.length !== 2 ||
    fillet.edgeReferences?.length !== 2
  )
    return document;
  const updates = [features[5]!, features[8]!].map((feature) => {
    if (feature.data.featureKind !== 'transform')
      throw new Error('Expected demo placement');
    return commandFactories.updateFeature({
      featureId: feature.featureId,
      data: {
        transform: {
          ...feature.data.transform,
          translation: {
            ...feature.data.transform.translation,
            z: BRACKET_BOSS_HEIGHT
          }
        }
      }
    });
  });
  return new CommandManager(document).runTransaction(REPAIR_LABEL, updates);
}
