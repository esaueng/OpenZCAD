import { listFeaturesInOrder } from './feature-order';
import { withoutDerivedProjection } from './document-projection';
import type {
  DocumentHistoryEntry,
  ProjectDocument,
  SerializedCommand
} from '@openzcad/shared';

export const BRACKET_BOSS_HEIGHT =
  'plate_t + min(wall_h / 2, wall_h - 0.5 - boss_r - fillet_r - 0.25)';

const LEGACY_HEIGHT = 'plate_t + wall_h / 2';
const FEATURE_COUNT = 17;
const SEED_COMMANDS = new Set([
  'parameter.set',
  'primitive.add',
  'feature.transform',
  'feature.boolean',
  'feature.fillet',
  'node.rename',
  'node.metadata.set'
]);

/** Copy/share/restore consumes the current model, never the source undo stack. */
export function repairLegacyBracketModel(
  document: ProjectDocument
): ProjectDocument {
  const { editHistory: _sourceHistory, ...model } = document;
  const repaired = repairLegacyBracketRecipe(model);
  return repaired === model ? document : repaired;
}

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

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Prove unclassified edits and pending Redo are parameters or feature renames. */
function nonModelingPatches(entry: DocumentHistoryEntry): boolean {
  return entry.changes.every((change) => {
    if (change.field === 'nodes' && change.kind === 'value') {
      if (!record(change.before) || !record(change.after)) return false;
      const before = change.before;
      const after = change.after;
      if (before.kind === 'parameter' && after.kind === 'parameter')
        return before.id === after.id && before.name === after.name;
      // Old node.rename entries lack commandKinds. Compare the complete node
      // after substituting only the display name: feature data, identity and
      // links must be identical in both history endpoints.
      return (
        before.kind === 'feature' &&
        after.kind === 'feature' &&
        typeof before.name === 'string' &&
        typeof after.name === 'string' &&
        canonical({ ...before, name: after.name }) === canonical(after)
      );
    }
    if (change.field === 'commandLog' && change.kind === 'splice') {
      return [...change.before, ...change.after].every(
        (command) =>
          record(command) &&
          (command.kind === 'parameter.set' || command.kind === 'node.rename')
      );
    }
    return false;
  });
}

/**
 * Recognize the original bracket template by its complete feature
 * recipe. Parameter edits and presentation changes survive. A modeling edit,
 * changed expression or changed target abstains. Copies retain the recipe.
 * Only their placement fields are migrated in nodes, creation commands and
 * history endpoints together. Parameters, entry IDs, labels, actor, cursor
 * and pending Redo survive. Owned snapshots are upgraded separately before
 * named-save restore.
 * This pure function preserves version/revisions; callers control ownership,
 * persistence and any audit revision.
 */
export function repairLegacyBracketRecipe(
  document: ProjectDocument
): ProjectDocument {
  if (
    document.units !== 'mm' ||
    document.featureOrder?.length !== FEATURE_COUNT
  )
    return document;
  const root = document.nodes[document.rootNodeId];
  if (
    root?.kind !== 'project' ||
    root.projectId !== document.projectId ||
    (document.editHistory &&
      document.editHistory.projectId !== document.projectId)
  )
    return document;
  const features = listFeaturesInOrder(document);
  if (
    features.length !== FEATURE_COUNT ||
    features.some((feature) => feature.metadata?.suppressed) ||
    document.commandLog.some((command) => !seedCommand(command)) ||
    document.editHistory?.entries.some((entry) =>
      entry.commandKinds?.length
        ? entry.commandKinds.some((kind) => !SEED_COMMANDS.has(kind))
        : !nonModelingPatches(entry)
    ) ||
    document.editHistory?.entries
      .slice(document.editHistory.cursor)
      .some((entry) => !nonModelingPatches(entry))
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
  const featureIds = new Set([features[5]!.featureId, features[8]!.featureId]);
  const bodyIds = new Set([features[4]!.bodyId, features[7]!.bodyId]);
  const next = structuredClone(document);
  const pending: unknown[] = [next.nodes, next.commandLog, next.editHistory];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    const object = value as Record<string, unknown>;
    // History node changes contain complete feature nodes. Rewrite only the
    // two identified placements, including their before/after endpoints.
    if (
      object.kind === 'feature' &&
      featureIds.has(object.featureId as (typeof features)[5]['featureId'])
    ) {
      const data = object.data as {
        featureKind: string;
        transform?: { translation: { z: unknown } };
      };
      if (
        data.featureKind === 'transform' &&
        data.transform?.translation.z === LEGACY_HEIGHT
      )
        data.transform.translation.z = BRACKET_BOSS_HEIGHT;
    }
    // Serialized creation commands (also retained inside history splices)
    // must replay the same repaired placements as the current nodes.
    if (object.kind === 'feature.transform') {
      const payload = object.payload as {
        targetBodyId?: (typeof features)[4]['bodyId'];
        translation?: { z: unknown };
      };
      if (
        bodyIds.has(payload.targetBodyId) &&
        payload.translation?.z === LEGACY_HEIGHT
      )
        payload.translation.z = BRACKET_BOSS_HEIGHT;
    }
    for (const child of Object.values(object)) {
      if (child && typeof child === 'object') pending.push(child);
    }
  }
  return withoutDerivedProjection(next);
}
