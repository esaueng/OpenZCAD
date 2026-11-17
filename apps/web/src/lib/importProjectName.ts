import type { ProjectDocument } from '@openzcad/shared';
import { isCutePartName } from './cutePartName';
import { projectNameForFile } from './startScreenImport';

/**
 * A project made with New project keeps its suggested name ("Lucky Quokka")
 * until someone renames it, and a part imported into it straight away kept
 * that name too: the library filled with Tiny Ferrets nobody could search
 * for. Files dropped on the start screen already make a project named for
 * them; this names the other route, New project and then Import, the same
 * way.
 *
 * Taken when an import starts, only for a project that is still empty and
 * still wears its suggestion; it renames nothing on its own.
 */
export interface ImportNaming {
  projectId: string;
  /** The project name the files give it: a .shapr pair's Shapr3D project. */
  name: string;
  dxf: boolean;
}

export function importNamingFor(
  doc: Pick<
    ProjectDocument,
    'projectId' | 'name' | 'featureOrder' | 'sketchOrder'
  >,
  files: readonly File[] | readonly { name: string }[]
): ImportNaming | null {
  if (files.length === 0) return null;
  if (doc.featureOrder.length > 0 || doc.sketchOrder.length > 0) return null;
  if (!isCutePartName(doc.name)) return null;
  const named = files.find((file) => /\.shapr$/i.test(file.name)) ?? files[0]!;
  return {
    projectId: doc.projectId,
    name: projectNameForFile(named.name),
    dxf: /\.dxf$/i.test(named.name)
  };
}

/**
 * What the pending naming does now that the document has changed:
 * - `wait`: nothing has landed yet (the import may still be running);
 * - `rename`: the import is the project's first content, so it takes the
 *   file's name;
 * - `drop`: something else came first, the project changed, or it was
 *   renamed meanwhile, so the suggestion is left alone.
 */
export type ImportNamingStep =
  { kind: 'wait' } | { kind: 'rename'; name: string } | { kind: 'drop' };

export function importNamingStep(
  naming: ImportNaming,
  doc: Pick<
    ProjectDocument,
    'projectId' | 'name' | 'featureOrder' | 'sketchOrder' | 'nodes'
  >
): ImportNamingStep {
  if (doc.projectId !== naming.projectId) return { kind: 'drop' };
  if (!isCutePartName(doc.name)) return { kind: 'drop' };
  const firstFeatureId = doc.featureOrder[0];
  if (firstFeatureId !== undefined) {
    const feature = Object.values(doc.nodes).find(
      (node) => node.kind === 'feature' && node.featureId === firstFeatureId
    );
    const imported =
      feature?.kind === 'feature' &&
      (feature.data.featureKind === 'imported-step' ||
        feature.data.featureKind === 'imported-mesh');
    return imported && !naming.dxf
      ? { kind: 'rename', name: naming.name }
      : { kind: 'drop' };
  }
  // A DXF lands as a sketch named for the file, rather than a feature.
  const firstSketchId = doc.sketchOrder[0];
  if (firstSketchId !== undefined) {
    const sketch = Object.values(doc.nodes).find(
      (node) => node.kind === 'sketch' && node.sketchId === firstSketchId
    );
    return naming.dxf && sketch?.name.startsWith(naming.name)
      ? { kind: 'rename', name: naming.name }
      : { kind: 'drop' };
  }
  return { kind: 'wait' };
}

/**
 * The pending naming as one check the app runs on each document change:
 * `undefined` while waiting, the name to rename to, or `null` to drop it.
 * Kept here so the app's main chunk carries only the ref that holds it.
 */
export function watchImportNaming(
  doc: Parameters<typeof importNamingFor>[0],
  files: readonly File[]
):
  | ((
      next: Parameters<typeof importNamingStep>[1]
    ) => string | null | undefined)
  | null {
  const naming = importNamingFor(doc, files);
  if (!naming) return null;
  return (next) => {
    const step = importNamingStep(naming, next);
    return step.kind === 'wait'
      ? undefined
      : step.kind === 'rename'
        ? step.name
        : null;
  };
}
