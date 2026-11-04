import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  listNodesByKind
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { createInFlightImportChecksums } from './importArchival';
import { localStepImportSourceStore, runStepImport } from './stepImportRun';

// A CAD exporter's generic top-level product name, as in the reported part.
const STEP_TEXT = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION(('sleeve'),'2;1');",
  "FILE_NAME('sleeve.step','2026-11-04T00:00:00',(''),(''),'','','');",
  "FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));",
  'ENDSEC;',
  'DATA;',
  "#24=PRODUCT('root','root','',(#1));",
  'ENDSEC;',
  'END-ISO-10303-21;'
].join('\n');

async function importOnce(manager: CommandManager): Promise<void> {
  const result = await runStepImport({
    file: new File([STEP_TEXT], 'sleeve.step'),
    contentType: 'model/step',
    // An explicit factory skips kernel solid discovery; the command itself is
    // the ordinary STEP import.
    commandFactory: commandFactories.importStep,
    store: {
      ...localStepImportSourceStore,
      ensureLocalProjectStorage: async () => 'unavailable'
    },
    archive: async () => 'artifact_sleeve',
    validatedFeature: {
      reserve: () => ({ release() {} }),
      run: async (_command, options) => {
        manager.execute(await options.finalize!());
        return 'committed';
      }
    },
    status: { setStatus() {}, setFeatureFormError() {} },
    marks: { inFlight: createInFlightImportChecksums(), abandoned: new Set() },
    currentDocument: () => manager.document,
    editDisabledReason: () => null,
    newId: () => crypto.randomUUID()
  });
  expect(result.outcome).toBe('committed');
}

function names(document: ProjectDocument, kind: 'body' | 'feature') {
  return listNodesByKind(document, kind).map((node) => node.name);
}

describe('runStepImport naming', () => {
  // Regression: importing the same file twice listed two bodies and two
  // History rows both named "root" that could not be told apart.
  it('numbers a repeated import like any other new feature', async () => {
    const manager = new CommandManager(
      createProjectDocument('Sleeve', toUserId('user_step_naming'))
    );
    await importOnce(manager);
    await importOnce(manager);
    expect(names(manager.document, 'feature')).toEqual(['root', 'root 2']);
    expect(names(manager.document, 'body')).toEqual(['root', 'root 2']);
  });
});
