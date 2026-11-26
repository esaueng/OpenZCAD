import { composeCommands, type AnyCommand } from '@openzcad/command-system';
import { numberedFeatureName } from '@openzcad/document-core';
import {
  ownEntry,
  type BodyId,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * M11 (D4): a Mirror of several bodies is one Mirror feature per body,
 * committed as one transaction, so one Undo takes every copy back and one
 * Redo restores them under the same ids. There is no grouped feature: each
 * row in History stays a Mirror of its own, edited and deleted alone.
 */

/** One body's feature in the set, as its command made it. */
export interface MirrorSetMember {
  sourceBodyId: BodyId;
  featureId: FeatureId;
  featureName: string;
  resultBodyId: BodyId;
}

/**
 * The bodies' commands as one transaction. Each is named as its own Done
 * would have named it, counting on from the one before it ("Mirror",
 * "Mirror 2", …), so no two rows in History share a name. `build` makes the
 * command for the body at `index` under the name given.
 */
export function composeMirrorSet(
  document: ProjectDocument | null | undefined,
  name: string,
  bodyIds: readonly BodyId[],
  build: (index: number, name: string) => AnyCommand
): { command: AnyCommand; members: MirrorSetMember[] } {
  const commands: AnyCommand[] = [];
  const members: MirrorSetMember[] = [];
  let current = document ?? null;
  for (const [index, bodyId] of bodyIds.entries()) {
    const featureName =
      index === 0 || !current ? name : numberedFeatureName(current, name);
    const command = build(index, featureName);
    commands.push(command);
    const ids = (
      command.payload as
        { ids?: { featureId?: FeatureId; bodyId?: BodyId } } | undefined
    )?.ids;
    if (ids?.featureId && ids.bodyId) {
      members.push({
        sourceBodyId: bodyId,
        featureId: ids.featureId,
        featureName,
        resultBodyId: ids.bodyId
      });
    }
    if (current) {
      try {
        current = command.apply(current);
      } catch {
        // The transaction refuses this command itself; naming goes on.
      }
    }
  }
  return {
    command: composeCommands(`Mirror ${bodyIds.length} bodies`, commands),
    members
  };
}

const FEATURE_LEAD = /^Feature "[^"]*":\s*/;

/**
 * Why the set cannot be committed, naming the body whose mirror refused, or
 * null when every body's mirror built. A set is all or nothing: one refused
 * body holds Done for all of them.
 */
export function mirrorSetRefusal(
  members: readonly MirrorSetMember[],
  derived: ProjectDocument['derived'],
  bodyName: (bodyId: BodyId) => string | undefined
): string | null {
  for (const member of members) {
    const warning = derived.featureWarnings?.find(
      (candidate) =>
        candidate.featureId === member.featureId &&
        (candidate.kind === 'build-failed' || candidate.kind === 'refusal')
    );
    const built = ownEntry(derived.bodyRepresentations, member.resultBodyId);
    if (!warning && built) continue;
    const name = bodyName(member.sourceBodyId) ?? 'A body';
    const reason = warning
      ? warning.message.replace(FEATURE_LEAD, '')
      : 'it produced no body.';
    return `${name} cannot be mirrored: ${reason} Remove it from the picks, or pick another plane.`;
  }
  return null;
}
