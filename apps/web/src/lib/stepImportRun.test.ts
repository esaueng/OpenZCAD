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

describe('runStepImport layout', () => {
  it('groups solids into the bodies a layout names, with its extras, in one step', async () => {
    const manager = new CommandManager(
      createProjectDocument('Target', toUserId('user_step_layout'))
    );
    const finished: string[] = [];
    const seen: (readonly number[])[] = [];
    const result = await runStepImport({
      file: new File([STEP_TEXT], 'Gearbox.step'),
      contentType: 'model/step',
      inspectSolids: async () => [0, 1, 2],
      layout: ({ solidIndices }) => {
        seen.push(solidIndices);
        return {
          label: 'Insert Gearbox',
          bodies: [
            { name: 'Housing', solidIndices: [0, 1] },
            { name: 'Shaft', solidIndices: [2] }
          ],
          extras: (ids) => [
            commandFactories.setNodeMetadata({
              nodeId: ids[1]!.bodyNodeId,
              metadata: { color: '#5f8fe8', colorChosen: true }
            })
          ]
        };
      },
      store: {
        ...localStepImportSourceStore,
        ensureLocalProjectStorage: async () => 'unavailable'
      },
      archive: async () => 'artifact_gearbox',
      validatedFeature: {
        reserve: () => ({ release() {} }),
        run: async (_command, options) => {
          manager.execute(await options.finalize!());
          return 'committed';
        }
      },
      status: { setStatus() {}, setFeatureFormError() {} },
      progress: {
        start() {},
        update() {},
        finish: (outcome) => finished.push(outcome.message)
      },
      marks: {
        inFlight: createInFlightImportChecksums(),
        abandoned: new Set()
      },
      currentDocument: () => manager.document,
      editDisabledReason: () => null,
      newId: () => crypto.randomUUID()
    });
    expect(result.outcome).toBe('committed');
    expect(seen).toEqual([[0, 1, 2]]);
    const features = listNodesByKind(manager.document, 'feature');
    expect(features.map((feature) => feature.name)).toEqual([
      'Housing',
      'Shaft'
    ]);
    expect(
      features.map((feature) =>
        feature.data.featureKind === 'imported-step'
          ? feature.data.solidIndices
          : null
      )
    ).toEqual([[0, 1], [2]]);
    const shaft = listNodesByKind(manager.document, 'body')[1]!;
    expect(shaft.metadata).toMatchObject({
      color: '#5f8fe8',
      colorChosen: true
    });
    // One undo removes the whole insert.
    manager.undo();
    expect(listNodesByKind(manager.document, 'feature')).toEqual([]);
    expect(finished).toEqual(['2 bodies']);
  });
});
