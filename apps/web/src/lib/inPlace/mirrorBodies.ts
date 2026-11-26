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

/** What the bar says to do about a refused body, after the kernel's reason. */
export const MIRROR_REFUSED_ADVICE =
  'Remove it from the picks, or pick another plane.';

/**
 * The body whose mirror refused, found by its feature's attributed warning
 * or its missing result (never by the warning's wording), or null when every
 * body's mirror built. A set is all or nothing: one refused body holds Done
 * for all of them.
 */
export function refusedMirrorMember(
  members: readonly MirrorSetMember[],
  derived: ProjectDocument['derived']
): MirrorSetMember | null {
  for (const member of members) {
    const failed = derived.featureWarnings?.some(
      (candidate) =>
        candidate.featureId === member.featureId &&
        (candidate.kind === 'build-failed' || candidate.kind === 'refusal')
    );
    if (failed || !ownEntry(derived.bodyRepresentations, member.resultBodyId))
      return member;
  }
  return null;
}

/**
 * What a click on the model does while a command that takes bodies runs:
 * the `plane` (a flat face, once a body is picked, for Mirror and Split),
 * a `body` to toggle (the host maps a preview's result to the first pick,
 * as Options lists it), or nothing. M11 (D4): Shift on a command that takes
 * a plane and several bodies (Mirror) adds or removes the clicked body
 * instead of taking its face as the plane, and on a preview's result adds
 * nothing, since that is no body yet. A Boolean, which takes no plane, is
 * left as it was: Shift on its preview names its first operand.
 */
export function bodyCommandClick(click: {
  wantsPlane: boolean;
  bodyMode: 'one' | 'many' | undefined;
  /** Shift, or the touch multi-select toggle (the viewport's additive). */
  additive: boolean;
  bodiesPicked: number;
  onFace: boolean;
  previewResult: boolean;
}): 'plane' | 'body' | 'none' {
  const addsBody =
    click.additive && click.wantsPlane && click.bodyMode === 'many';
  if (click.wantsPlane && click.bodiesPicked > 0 && click.onFace && !addsBody)
    return 'plane';
  if (addsBody && click.previewResult) return 'none';
  return 'body';
}
