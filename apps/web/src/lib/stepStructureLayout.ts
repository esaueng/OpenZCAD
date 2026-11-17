/**
 * I02: a STEP file's product structure as bodies and Objects folders.
 *
 * The structure reader returns one solid per placed occurrence, each with
 * the product node it belongs to, its own B-rep name and its colour. This
 * lays them out the way the file describes them: an assembly becomes a
 * folder named after it (nested for sub-assemblies), each part's solid a
 * body named after the part (or after the solid, when the file names it),
 * coloured as the file colours it. A single part stays at the top level, as
 * every STEP import placed it before.
 */
import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import {
  listObjectFolders,
  type BodyFeatureIds
} from '@openzcad/document-core';
import {
  BODY_COLOR_CHOSEN_METADATA_KEY,
  BODY_COLOR_METADATA_KEY,
  createId,
  MAX_OBJECT_FOLDER_DEPTH,
  MAX_OBJECT_FOLDER_NAME_LENGTH,
  MAX_OBJECT_FOLDERS,
  type ProjectDocument
} from '@openzcad/shared';
import type { StepStructure } from '@openzcad/kernel-adapter/exact';

import { freeNames } from './projectInsert';
import type { StepImportLayout } from './stepImportRun';

interface PlannedBody {
  name: string;
  solidIndex: number;
  color: string | null;
  /** The folder node it is filed under, or null for the top level. */
  folder: number | null;
}

/**
 * The layout for the accepted solids (`solidIndices`, the reader's
 * numbering) of a structured STEP read, or null when the structure adds
 * nothing to the plain one-body-per-solid import: no product tree, no names
 * and no colours.
 */
export function stepStructureLayout(input: {
  structure: StepStructure;
  solidIndices: readonly number[];
  /** The file name without its extension, for solids no product names. */
  fileStem: string;
  document: ProjectDocument | null;
  newFolderId?: () => string;
}): StepImportLayout | null {
  const { structure, fileStem, document } = input;
  const newFolderId =
    input.newFolderId ?? (() => createId<'ObjectFolderId'>('folder'));
  const nodes = structure.nodes;
  const childCount = nodes.map(() => 0);
  for (const node of nodes)
    if (node.parent !== null) childCount[node.parent]! += 1;
  const accepted = input.solidIndices.filter(
    (index) => structure.solids[index] !== undefined
  );
  const solidsAt = new Map<number | null, number[]>();
  for (const index of accepted) {
    const node = structure.solids[index]!.node;
    solidsAt.set(node, [...(solidsAt.get(node) ?? []), index]);
  }
  const hasAssembly = childCount.some((count) => count > 0);
  const hasColour = accepted.some((index) => {
    const solid = structure.solids[index]!;
    return solid.color !== null || solid.faceColor !== null;
  });
  const hasNames = accepted.some(
    (index) =>
      structure.solids[index]!.name !== null ||
      (structure.solids[index]!.node !== null &&
        nodes[structure.solids[index]!.node]!.name.trim() !== '')
  );
  if (accepted.length === 0 || (!hasAssembly && !hasColour && !hasNames)) {
    return null;
  }

  // Folders: every assembly node, and a part whose several solids would
  // otherwise scatter into its parent. Depth and count stay within the
  // Objects folder limits; past them, bodies stay where their nearest
  // filed ancestor is.
  const room =
    MAX_OBJECT_FOLDERS - (document ? listObjectFolders(document).length : 0);
  const depth = nodes.map(() => 0);
  const isFolder = nodes.map(() => false);
  let folders = 0;
  nodes.forEach((node, index) => {
    depth[index] = node.parent === null ? 1 : depth[node.parent]! + 1;
    const wanted =
      childCount[index]! > 0 ||
      (node.parent !== null && (solidsAt.get(index)?.length ?? 0) > 1);
    if (
      wanted &&
      folders < room &&
      depth[index] <= MAX_OBJECT_FOLDER_DEPTH &&
      (node.parent === null || isFolder[node.parent])
    ) {
      isFolder[index] = true;
      folders += 1;
    }
  });
  const folderOf = (node: number | null): number | null => {
    for (let at = node; at !== null; at = nodes[at]!.parent) {
      if (isFolder[at]) return at;
    }
    return null;
  };

  const planned: PlannedBody[] = [];
  for (const [node, indices] of solidsAt) {
    indices.forEach((solidIndex, position) => {
      const solid = structure.solids[solidIndex]!;
      const owner = node === null ? '' : nodes[node]!.name.trim();
      const base = owner || fileStem;
      const name =
        solid.name ??
        (indices.length === 1 ? base : `${base} — Body ${position + 1}`);
      planned.push({
        name,
        solidIndex,
        color: solid.color ?? solid.faceColor,
        // A part's own node is a folder only when it holds several solids.
        folder: folderOf(node)
      });
    });
  }
  planned.sort((a, b) => a.solidIndex - b.solidIndex);
  const names = freeNames(
    document,
    planned.map((body) => body.name)
  );
  const rootName = nodes.find((node) => node.parent === null)?.name.trim();

  return {
    label: `Import ${rootName || fileStem}`,
    bodies: planned.map((body, index) => ({
      name: names[index]!,
      solidIndices: [body.solidIndex]
    })),
    extras(ids: readonly BodyFeatureIds[]): AnyCommand[] {
      const commands: AnyCommand[] = [];
      planned.forEach((body, index) => {
        if (body.color === null) return;
        commands.push(
          commandFactories.setNodeMetadata(
            {
              nodeId: ids[index]!.bodyNodeId,
              metadata: {
                [BODY_COLOR_METADATA_KEY]: body.color,
                [BODY_COLOR_CHOSEN_METADATA_KEY]: true
              }
            },
            `Set ${names[index]!} appearance`
          )
        );
      });
      const folderIds = new Map<number, string>();
      nodes.forEach((node, index) => {
        if (!isFolder[index]) return;
        const folderId = newFolderId();
        folderIds.set(index, folderId);
        commands.push(
          commandFactories.createObjectFolder({
            folderId,
            name:
              (node.name.trim() || fileStem).slice(
                0,
                MAX_OBJECT_FOLDER_NAME_LENGTH
              ) || 'Assembly',
            parentId:
              node.parent === null
                ? null
                : (folderIds.get(node.parent) ?? null),
            bodyIds: planned.flatMap((body, bodyIndex) =>
              body.folder === index ? [ids[bodyIndex]!.bodyId] : []
            )
          })
        );
      });
      return commands;
    }
  };
}
