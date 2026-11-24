import { describe, expect, it } from 'vitest';
import {
  createProjectDocument,
  listFeaturesInOrder,
  normalizeDocument
} from '@openzcad/document-core';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type OffsetRimPolicy,
  type ProjectDocument
} from '@openzcad/shared';
import { CommandManager, commandFactories, replayCommands } from './index';

function setup() {
  const source = createProjectDocument('Rim replay', toUserId('user_test'));
  const manager = new CommandManager(source);
  manager.execute(
    commandFactories.importStep({
      name: 'Plate',
      artifactId: 'plate',
      sourceName: 'plate.step',
      stepText: 'ISO-10303-21;'
    })
  );
  return manager.document;
}

function offset(document: ProjectDocument, choice?: OffsetRimPolicy) {
  return commandFactories.directEditBody({
    name: 'Offset Face',
    targetBodyId: document.bodyOrder[0]!,
    operation: {
      kind: 'offset-face',
      faceHash: 7,
      sourceArea: 100,
      sourceSurfaceType: 'plane',
      sourceCenter: { x: 0, y: 0, z: 5 },
      sourceNormal: { x: 0, y: 0, z: 1 },
      offset: 2,
      ...(choice === undefined ? {} : { ambiguousRim: choice })
    }
  });
}

function operationOf(doc: ProjectDocument) {
  const feature = listFeaturesInOrder(doc).at(-1)!;
  if (feature.data.featureKind !== 'direct-edit')
    throw new Error('Missing offset feature.');
  return feature.data.operation;
}

describe('saved Offset Face rim policy', () => {
  it.each([undefined, 'draft', 'chamfer'] as const)(
    'preserves authored choice %s during reload, replay and redo',
    (choice) => {
      const source = setup();
      const manager = new CommandManager(source);
      const command = offset(source, choice);
      const expected = choice ?? 'refuse';
      expect(command.serialize().payload.operation).toHaveProperty(
        'ambiguousRim',
        expected
      );
      manager.execute(command);
      expect(
        operationOf(normalizeDocument(structuredClone(manager.document)))
      ).toHaveProperty('ambiguousRim', expected);
      const replayed = replayCommands(source, [command.serialize()]);
      expect(operationOf(replayed)).toHaveProperty('ambiguousRim', expected);
      manager.undo();
      expect(manager.document.featureOrder).toEqual(source.featureOrder);
      manager.redo();
      expect(operationOf(manager.document)).toHaveProperty(
        'ambiguousRim',
        expected
      );
    }
  );

  it('keeps an archived operation unmarked after replay, upgrade and resave', () => {
    const source = setup();
    const archived = offset(source).serialize();
    const op = archived.payload.operation;
    if (op.kind !== 'offset-face') throw new Error('Expected face offset');
    delete op.ambiguousRim;
    const doc = replayCommands(source, [archived]);
    const older = {
      ...doc,
      schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION - 1
    } as ProjectDocument;
    const loaded = normalizeDocument(older);
    expect(operationOf(loaded)).not.toHaveProperty('ambiguousRim');
    expect(
      operationOf(normalizeDocument(structuredClone(loaded)))
    ).not.toHaveProperty('ambiguousRim');
  });

  it('refuses unknown options and current fields in an older schema', () => {
    const source = setup();
    expect(() => offset(source, 'legacyReplay' as OffsetRimPolicy)).toThrow(
      /rim policy/i
    );
    const doc = offset(source, 'draft').apply(source);
    expect(() =>
      normalizeDocument({
        ...doc,
        schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION - 1
      } as ProjectDocument)
    ).toThrow(/rim policy/i);
    const command = offset(source).serialize();
    Object.assign(command.payload.operation, { ambiguousRim: 'legacyReplay' });
    expect(() =>
      normalizeDocument({ ...source, commandLog: [command] })
    ).toThrow(/rim policy/i);
  });
});
