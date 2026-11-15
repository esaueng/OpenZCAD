import { MAX_PROJECT_NAME_LENGTH } from '@openzcad/shared';
import { countLabel } from './toasts';
import { unsupportedImportMessage } from './plainFailure';

/** The formats Import CAD files takes, by extension. */
const CAD_FILE = /\.(?:step|stp|stl|3mf|obj|glb|ply|dxf|shapr)$/i;
const BACKUP_FILE = /\.openzcad$/i;

/**
 * What the start screen does with files dropped on it or picked through its
 * Import: a backup restores as its own project, and CAD files start a new
 * project named after them and are imported into it, exactly as Import CAD
 * files would. Anything else is refused before a project is made, so a
 * wrong file never leaves an empty "Untitled" behind.
 */
export type StartScreenImportPlan =
  | { kind: 'backup'; file: File }
  | { kind: 'cad'; name: string; files: File[] }
  | { kind: 'refuse'; message: string };

export function planStartScreenImport(files: File[]): StartScreenImportPlan {
  if (files.length === 0) {
    return { kind: 'refuse', message: 'No files to import.' };
  }
  const backups = files.filter((file) => BACKUP_FILE.test(file.name));
  if (backups.length > 0) {
    return files.length === 1
      ? { kind: 'backup', file: backups[0]! }
      : {
          kind: 'refuse',
          message: `${countLabel(files.length, 'file', 'files')} dropped. Drop one .openzcad backup on its own.`
        };
  }
  const unsupported = files.find((file) => !CAD_FILE.test(file.name));
  if (unsupported) {
    return {
      kind: 'refuse',
      message: unsupportedImportMessage(unsupported.name)
    };
  }
  // A .shapr pair is named for the Shapr3D project, not its STEP companion.
  const named = files.find((file) => /\.shapr$/i.test(file.name)) ?? files[0]!;
  return { kind: 'cad', name: projectNameForFile(named.name), files };
}

/** "bracket_v2.step" → "bracket_v2": the file's name without its extension. */
export function projectNameForFile(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, '').trim();
  return (stem || 'Imported part').slice(0, MAX_PROJECT_NAME_LENGTH).trim();
}
