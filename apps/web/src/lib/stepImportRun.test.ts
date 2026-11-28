import { describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  listNodesByKind
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { createInFlightImportChecksums } from './importArchival';
import {
  importSuccessMessage,
  localStepImportSourceStore,
  runCadFileImport,
  runStepImport
} from './stepImportRun';

// The IGES translator runs in a browser worker; here it restates the file as
// the STEP below, which is all the import downstream of it ever sees.
vi.mock('./igesImport', () => ({
  igesAsStepFile: async (file: File) =>
    new File([STEP_TEXT], file.name, { type: 'model/step' })
}));

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

describe('runStepImport project guard', () => {
  // Review P1 (#1506): the commit hook binds to whichever project is open
  // when it starts, so a switch during solid discovery landed the bodies in
  // the project switched to.
  it('lands nothing when the project changes during solid discovery', async () => {
    const original = new CommandManager(
      createProjectDocument('Original', toUserId('user_step_guard'))
    );
    const other = new CommandManager(
      createProjectDocument('Other', toUserId('user_step_guard'))
    );
    let open = original;
    let ran = false;
    const statuses: string[] = [];
    const result = await runStepImport({
      file: new File([STEP_TEXT], 'Gearbox.step'),
      contentType: 'model/step',
      inspectSolids: async () => {
        open = other;
        return [0];
      },
      stillCurrent: () => open === original,
      store: {
        ...localStepImportSourceStore,
        ensureLocalProjectStorage: async () => 'unavailable'
      },
      archive: async () => 'artifact_gearbox',
      validatedFeature: {
        reserve: () => ({ release() {} }),
        run: async (_command, options) => {
          ran = true;
          open.execute(await options.finalize!());
          return 'committed';
        }
      },
      status: {
        setStatus: (message) => statuses.push(message),
        setFeatureFormError() {}
      },
      marks: {
        inFlight: createInFlightImportChecksums(),
        abandoned: new Set()
      },
      currentDocument: () => open.document,
      editDisabledReason: () => null,
      newId: () => crypto.randomUUID()
    });
    expect(result.outcome).toBe('failed');
    expect(ran).toBe(false);
    expect(listNodesByKind(original.document, 'feature')).toEqual([]);
    expect(listNodesByKind(other.document, 'feature')).toEqual([]);
    expect(statuses.at(-1)).toContain(
      'the project changed before it could land'
    );
  });
});

describe('IGES import naming (#2103, #2380)', () => {
  it('names the IGES format, and archives its STEP translation as STEP', async () => {
    const manager = new CommandManager(
      createProjectDocument('Plate', toUserId('user_iges_naming'))
    );
    const archived: { fileName: string; contentType: string }[] = [];
    const messages: string[] = [];
    await runCadFileImport({
      file: new File(['IGES bytes'], 'plate.igs', { type: 'model/iges' }),
      contentType: 'model/iges',
      commandFactory: commandFactories.importStep,
      store: {
        ...localStepImportSourceStore,
        ensureLocalProjectStorage: async () => 'unavailable'
      },
      archive: async (input) => {
        archived.push({
          fileName: input.fileName,
          contentType: input.contentType
        });
        expect(await input.body.text()).toMatch(/^ISO-10303-21;/);
        return 'artifact_plate';
      },
      validatedFeature: {
        reserve: () => ({ release() {} }),
        run: async (_command, options) => {
          manager.execute(await options.finalize!());
          messages.push(
            typeof options.successMessage === 'function'
              ? options.successMessage()
              : options.successMessage
          );
          return 'committed';
        }
      },
      status: { setStatus() {}, setFeatureFormError() {} },
      refuse: (message) => {
        throw new Error(message);
      },
      marks: {
        inFlight: createInFlightImportChecksums(),
        abandoned: new Set()
      },
      currentDocument: () => manager.document,
      editDisabledReason: () => null,
      newId: () => crypto.randomUUID()
    });
    // The feature keeps the file the user chose; the archive is named for
    // the bytes it holds.
    const [feature] = listNodesByKind(manager.document, 'feature');
    expect(
      feature?.data.featureKind === 'imported-step' && feature.data.sourceName
    ).toBe('plate.igs');
    expect(archived).toEqual([
      { fileName: 'plate.igs.step', contentType: 'model/step' }
    ]);
    expect(messages).toEqual([
      'Imported editable IGES solid from plate.igs: exact body rebuilt, STEP translation archived. The original IGES file is not stored; its STEP translation is what saves, backs up and rebuilds.'
    ]);
  });

  it('words single and multi-body imports by format, and leaves STEP as it was', () => {
    expect(
      importSuccessMessage({
        fileName: 'Frame.step',
        archived: true,
        bodies: 1
      })
    ).toBe(
      'Imported editable STEP solid from Frame.step: exact body rebuilt, source archived.'
    );
    expect(
      importSuccessMessage({
        fileName: 'Frame.step',
        archived: false,
        bodies: 2
      })
    ).toBe(
      'Imported 2 editable STEP bodies from Frame.step: exact bodies rebuilt (cloud archive unavailable; source saved locally).'
    );
    expect(
      importSuccessMessage({
        fileName: 'Mixed.IGES',
        archived: false,
        bodies: 3
      })
    ).toBe(
      'Imported 3 editable IGES bodies from Mixed.IGES: exact bodies rebuilt (cloud archive unavailable; STEP translation saved locally). The original IGES file is not stored; its STEP translation is what saves, backs up and rebuilds.'
    );
  });
});
