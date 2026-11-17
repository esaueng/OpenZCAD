/**
 * Inserting another project's bodies into the open one (AS01's first slice).
 *
 * The other project is rebuilt in a disposable worker and written as one
 * millimetre STEP, every shown body its own run of solids. That STEP then
 * imports exactly like any other — one stored source, archived the same way,
 * checked by the same exact rebuild — and this module only decides how its
 * solids become bodies: one body per source body, under the source body's
 * name, in the colour and opacity someone chose for it, and filed together
 * in an Objects folder named after the project. It is a copy: nothing links
 * back to the other project, and its history does not come along.
 */
import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import {
  listNodesByKind,
  listObjectFolders,
  type BodyFeatureIds
} from '@openzcad/document-core';
import {
  BODY_COLOR_CHOSEN_METADATA_KEY,
  BODY_COLOR_METADATA_KEY,
  BODY_OPACITY_METADATA_KEY,
  createId,
  MAX_OBJECT_FOLDER_NAME_LENGTH,
  MAX_OBJECT_FOLDERS,
  type ProjectDocument
} from '@openzcad/shared';

import type { StepImportLayout } from './stepImportRun';
import type { PreparedProjectInsert } from './projectInsertPrepare';

export interface ProjectInsertLayout extends StepImportLayout {
  /** Source bodies none of whose solids read back, by name. */
  dropped: string[];
}

/**
 * Names not yet taken in `document`, numbering a repeat the way new
 * features are numbered: "Bracket", then "Bracket 2".
 */
function freeNames(
  document: ProjectDocument | null,
  wanted: readonly string[]
): string[] {
  const taken = new Set(
    document
      ? [
          ...listNodesByKind(document, 'feature'),
          ...listNodesByKind(document, 'body')
        ].map((node) => node.name.trim())
      : []
  );
  return wanted.map((raw) => {
    const name = raw.trim() || 'Body';
    let candidate = name;
    if (taken.has(candidate)) {
      const stem = /^(.*\S)\s+[1-9]\d*$/.exec(name)?.[1] ?? name;
      let number = 2;
      while (taken.has(`${stem} ${number}`)) number += 1;
      candidate = `${stem} ${number}`;
    }
    taken.add(candidate);
    return candidate;
  });
}

/**
 * How the inserted STEP's readable solids become bodies. `solidIndices` are
 * the declared indices the exact reader accepted; each source body owns the
 * consecutive run of declared solids it wrote, so a body whose solids were
 * all refused is dropped (and named) rather than misattributed.
 */
export function projectInsertLayout(
  prepared: PreparedProjectInsert,
  input: { solidIndices: readonly number[]; document: ProjectDocument | null },
  newFolderId: () => string = () => createId<'ObjectFolderId'>('folder')
): ProjectInsertLayout {
  const accepted = new Set(input.solidIndices);
  const kept: {
    body: PreparedProjectInsert['bodies'][number];
    solidIndices: number[];
  }[] = [];
  const dropped: string[] = [];
  let offset = 0;
  for (const body of prepared.bodies) {
    const solidIndices = Array.from(
      { length: body.solidCount },
      (_, index) => offset + index
    ).filter((index) => accepted.has(index));
    offset += body.solidCount;
    if (solidIndices.length > 0) kept.push({ body, solidIndices });
    else dropped.push(body.name);
  }
  const names = freeNames(
    input.document,
    kept.map(({ body }) => body.name)
  );
  const folderName = prepared.projectName
    .trim()
    .slice(0, MAX_OBJECT_FOLDER_NAME_LENGTH);
  const fileInFolder =
    kept.length > 1 &&
    folderName.length > 0 &&
    (!input.document ||
      listObjectFolders(input.document).length < MAX_OBJECT_FOLDERS);
  return {
    label: `Insert ${prepared.projectName}`,
    bodies: kept.map(({ solidIndices }, index) => ({
      name: names[index]!,
      solidIndices
    })),
    dropped,
    extras(ids: readonly BodyFeatureIds[]): AnyCommand[] {
      const commands: AnyCommand[] = [];
      kept.forEach(({ body }, index) => {
        const metadata: Record<string, string | number | boolean> = {};
        if (body.color !== null) {
          // Marked chosen, as the appearance picker marks it, so it is drawn
          // even where it matches the STEP import's own stamp.
          metadata[BODY_COLOR_METADATA_KEY] = body.color;
          metadata[BODY_COLOR_CHOSEN_METADATA_KEY] = true;
        }
        if (body.opacity !== null) {
          metadata[BODY_OPACITY_METADATA_KEY] = body.opacity;
        }
        if (Object.keys(metadata).length > 0) {
          commands.push(
            commandFactories.setNodeMetadata(
              { nodeId: ids[index]!.bodyNodeId, metadata },
              `Set ${names[index]!} appearance`
            )
          );
        }
      });
      if (fileInFolder) {
        commands.push(
          commandFactories.createObjectFolder({
            folderId: newFolderId(),
            name: folderName,
            parentId: null,
            bodyIds: ids.map((entry) => entry.bodyId)
          })
        );
      }
      return commands;
    }
  };
}

const SKIP_REASONS = {
  failed: 'its history step failed',
  'mesh-reference': 'it is a mesh reference with no solid',
  empty: 'it has no solid'
} as const;

/** What was left behind, as one sentence, or '' when nothing was. */
export function projectInsertLeftOut(
  prepared: Pick<PreparedProjectInsert, 'skipped'>,
  dropped: readonly string[]
): string {
  const parts = [
    ...prepared.skipped.map(
      ({ name, reason }) => `${name} (${SKIP_REASONS[reason]})`
    ),
    ...dropped.map((name) => `${name} (its solid did not read back)`)
  ];
  return parts.length === 0 ? '' : ` Left out: ${parts.join('; ')}.`;
}
