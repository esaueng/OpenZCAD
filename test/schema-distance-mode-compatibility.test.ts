import { describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  addSketchFeature,
  createProjectDocument,
  findSketch,
  normalizeDocument
} from '@openzcad/document-core';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  resolveSketchReferenceDimension,
  toSketchReferenceAnnotationId,
  toUserId,
  type DocumentChange,
  type DrawingSheet,
  type ProjectDocument,
  type ReferenceImage,
  type SerializedCommand,
  type SketchReferenceDimension,
  type SketchReferenceDistanceMode
} from '@openzcad/shared';

const introduced = 35;
const modes = ['absolute', 'horizontal', 'vertical'] as const;
const upgrade = /Reference distance modes require project schema v35 or newer/;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function fixture() {
  const added = addSketchFeature(
    createProjectDocument('Distance schema compatibility', toUserId('test')),
    {
      name: 'Diagonal',
      plane: 'XY',
      objects: [{ objectKind: 'line', x1: 0, y1: 0, x2: 30, y2: 40 }]
    }
  );
  const sketch = findSketch(added.document, added.sketchId)!;
  const objectId = sketch.objectIds[0]!;
  const annotation = (
    distanceMode?: SketchReferenceDistanceMode
  ): SketchReferenceDimension => ({
    annotationId: toSketchReferenceAnnotationId('sref_schema'),
    data: {
      dimensionKind: 'distance',
      ...(distanceMode === undefined ? {} : { distanceMode }),
      a: { objectId, point: 'start' },
      b: { objectId, point: 'end' }
    }
  });
  const command = (distanceMode?: SketchReferenceDistanceMode) =>
    commandFactories.addSketchReferenceDimension({
      sketchId: added.sketchId,
      data: annotation(distanceMode).data,
      ids: { annotationId: annotation().annotationId }
    });
  return { ...added, objectId, sketch, annotation, command };
}

function transaction(commands: SerializedCommand[]): SerializedCommand {
  return {
    kind: 'transaction',
    payload: commands,
    replayVersion: 1,
    label: 'Saved transaction',
    timestamp: '2026-10-22T00:00:00.000Z'
  };
}

function withHistory(
  document: ProjectDocument,
  changes: DocumentChange[],
  cursor: 0 | 1
): ProjectDocument {
  return {
    ...document,
    editHistory: {
      schemaVersion: 1,
      projectId: document.projectId,
      actorUserId: document.ownerUserId,
      entries: [{ id: 'schema_entry', label: 'Stored edit', changes }],
      cursor,
      trimmed: 0
    }
  };
}

const carriers = [
  'current node',
  'undo node',
  'redo node',
  'undo node map',
  'redo node map',
  'current nested log',
  'undo value log',
  'redo value log',
  'undo splice log',
  'redo splice log'
] as const;

function carried(
  carrier: (typeof carriers)[number],
  version: number,
  mode: SketchReferenceDistanceMode
): ProjectDocument {
  const f = fixture();
  const document = {
    ...f.document,
    schemaVersion: version as ProjectDocument['schemaVersion']
  };
  const annotated = {
    ...f.sketch,
    referenceDimensions: [f.annotation(mode)]
  };
  if (carrier === 'current node') {
    document.nodes = { ...document.nodes, [f.sketchId]: annotated };
    return document;
  }
  if (carrier.includes('node')) {
    const undo = carrier.startsWith('undo');
    const wholeMap = carrier.endsWith('map');
    const plain = wholeMap ? document.nodes : f.sketch;
    const marked = wholeMap
      ? { ...document.nodes, [f.sketchId]: annotated }
      : annotated;
    return withHistory(
      document,
      [
        {
          kind: 'value',
          field: 'nodes',
          ...(wholeMap ? {} : { key: f.sketchId }),
          before: undo ? marked : plain,
          after: undo ? plain : marked
        }
      ],
      undo ? 1 : 0
    );
  }
  const log = [transaction([transaction([f.command(mode).serialize()])])];
  if (carrier === 'current nested log') return { ...document, commandLog: log };
  const undo = carrier.startsWith('undo');
  const sides = { before: undo ? log : [], after: undo ? [] : log };
  return withHistory(
    document,
    [
      carrier.includes('splice')
        ? { kind: 'splice', field: 'commandLog', index: 0, ...sides }
        : { kind: 'value', field: 'commandLog', ...sides }
    ],
    undo ? 1 : 0
  );
}

describe('S02 reference-distance introduction at schema v35', () => {
  it.each([undefined, null, Number.NaN, '35', 35.5])(
    'requires an actual integer schema for modes when the carrier version is %s',
    (schemaVersion) => {
      for (const mode of modes) {
        for (const carrier of ['current node', 'current nested log'] as const) {
          const document = carried(carrier, 34, mode);
          if (schemaVersion === undefined)
            Reflect.deleteProperty(document, 'schemaVersion');
          else Object.assign(document, { schemaVersion });
          expect(document.editHistory).toBeUndefined();
          const before = structuredClone(document);
          expect(() => normalizeDocument(document)).toThrow(/schema/);
          expect(() => new CommandManager(document)).toThrow(upgrade);
          expect(() => replayCommands(document, [])).toThrow(upgrade);
          expect(document).toEqual(before);
        }
        const f = fixture();
        if (schemaVersion === undefined)
          Reflect.deleteProperty(f.document, 'schemaVersion');
        else Object.assign(f.document, { schemaVersion });
        const before = structuredClone(f.document);
        const manager = new CommandManager(f.document);
        expect(() => manager.execute(f.command(mode))).toThrow(upgrade);
        expect(manager.document).toBe(f.document);
        expect(manager.document).toEqual(before);
        const commands = [transaction([f.command(mode).serialize()])];
        expect(() => replayCommands(f.document, commands)).toThrow(upgrade);
        expect(f.document).toEqual(before);
      }
    }
  );

  it('retains the missing-version legacy path when all modes are absent', () => {
    const f = fixture();
    const command = f.command();
    const document = command.apply(f.document);
    document.commandLog = [transaction([command.serialize()])];
    Reflect.deleteProperty(document, 'schemaVersion');
    expect(document.editHistory).toBeUndefined();
    const before = structuredClone(document);
    const opened = normalizeDocument(document);
    expect(opened.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(opened.nodes).toEqual(before.nodes);
    expect(opened.commandLog).toEqual(before.commandLog);
    expect(
      findSketch(opened, f.sketchId)!.referenceDimensions![0]!.data
    ).not.toHaveProperty('distanceMode');
    expect(() => new CommandManager(document)).not.toThrow();
    expect(() => replayCommands(document, [])).not.toThrow();
    expect(document).toEqual(before);
  });

  it.each([31, 32, 33, 34])(
    'refuses modes in every readable v%s document carrier without rewriting it',
    (version) => {
      for (const mode of modes)
        for (const carrier of carriers) {
          const document = clone(carried(carrier, version, mode));
          const before = clone(document);
          expect(
            () => normalizeDocument(document),
            `${mode}: ${carrier}`
          ).toThrow(upgrade);
          expect(
            () => new CommandManager(document),
            `${mode}: ${carrier}`
          ).toThrow(upgrade);
          expect(
            () => replayCommands(document, []),
            `${mode}: ${carrier}`
          ).toThrow(upgrade);
          expect(document).toEqual(before);
        }
    }
  );

  it.each([31, 32, 33, 34])(
    'refuses ordinary adds and replay before processing any v%s prefix',
    (version) => {
      for (const mode of modes) {
        const f = fixture();
        f.document.schemaVersion = version as ProjectDocument['schemaVersion'];
        const before = clone(f.document);
        const manager = new CommandManager(f.document);
        expect(() => manager.execute(f.command(mode))).toThrow(upgrade);
        expect(manager.document).toBe(f.document);
        expect(manager.document).toEqual(before);
        // This invalid prefix would fail on its unknown parameter if replay
        // executed it before checking the later reference's schema.
        const prefix = commandFactories
          .setParameter({
            name: 'prefix',
            expression: 'missing_parameter'
          })
          .serialize();
        const commands = [
          prefix,
          transaction([transaction([f.command(mode).serialize()])])
        ];
        const savedCommands = clone(commands);
        expect(() => replayCommands(f.document, commands)).toThrow(upgrade);
        expect(f.document).toEqual(before);
        expect(commands).toEqual(savedCommands);
      }
    }
  );

  it.each(modes)(
    'keeps a v35 %s mode through reopen, undo, redo and replay',
    (mode) => {
      const f = fixture();
      expect(f.document.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
      Object.assign(f.document, { schemaVersion: introduced });
      const manager = new CommandManager(f.document);
      manager.execute(f.command(mode));
      const expected = clone(findSketch(manager.document, f.sketchId)!);
      const saved = clone(manager.document);
      const reopened = new CommandManager(normalizeDocument(saved));
      expect(reopened.document.schemaVersion).toBe(
        PROJECT_DOCUMENT_SCHEMA_VERSION
      );
      expect(findSketch(reopened.document, f.sketchId)).toEqual(expected);
      reopened.undo();
      expect(
        findSketch(reopened.document, f.sketchId)!.referenceDimensions
      ).toBeUndefined();
      reopened.redo();
      expect(findSketch(reopened.document, f.sketchId)).toEqual(expected);
      expect(
        findSketch(
          replayCommands(f.document, manager.document.commandLog),
          f.sketchId
        )
      ).toEqual(expected);
      const line = f.document.nodes[f.objectId]!;
      if (line.kind !== 'sketch-object') throw new Error('Missing diagonal');
      expect(
        resolveSketchReferenceDimension(
          new Map([[f.objectId, line.data]]),
          expected.referenceDimensions![0]!,
          (value) => (typeof value === 'number' ? value : undefined)
        )
      ).toMatchObject({
        status: 'current',
        value: mode === 'absolute' ? 50 : mode === 'horizontal' ? 30 : 40
      });
    }
  );

  it('migrates mode-absent v1–v34 records without adding modes or new feature sections', () => {
    const f = fixture();
    const manager = new CommandManager(f.document);
    manager.execute(f.command());
    for (let version = 1; version < introduced; version++) {
      const saved = clone(manager.document);
      saved.schemaVersion = version as ProjectDocument['schemaVersion'];
      const before = clone(saved);
      const opened = normalizeDocument(saved);
      expect(opened).toEqual({
        ...before,
        schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION
      });
      expect(
        findSketch(opened, f.sketchId)!.referenceDimensions![0]!.data
      ).not.toHaveProperty('distanceMode');
      for (const field of ['drawings', 'referenceImages', 'objectFolders'])
        expect(opened).not.toHaveProperty(field);
      expect(saved).toEqual(before);
    }
  });

  it('keeps an undefined optional mode equivalent to omission for legacy typed callers', () => {
    const f = fixture();
    f.document.schemaVersion = 34 as ProjectDocument['schemaVersion'];
    const annotation = f.annotation();
    if (annotation.data.dimensionKind !== 'distance')
      throw new Error('Missing distance');
    annotation.data.distanceMode = undefined;
    const manager = new CommandManager(f.document);
    manager.execute(
      commandFactories.addSketchReferenceDimension({
        sketchId: f.sketchId,
        data: annotation.data,
        ids: { annotationId: annotation.annotationId }
      })
    );
    const saved = clone(manager.document);
    expect(
      findSketch(saved, f.sketchId)!.referenceDimensions![0]!.data
    ).not.toHaveProperty('distanceMode');
    expect(() => normalizeDocument(manager.document)).not.toThrow();
    expect(() => normalizeDocument(saved)).not.toThrow();
    expect(() =>
      replayCommands(f.document, manager.document.commandLog)
    ).not.toThrow();
  });

  it('drops unreadable legacy history before scanning its unreachable future fields', () => {
    const saved = carried('undo node', 34, 'horizontal');
    saved.editHistory!.schemaVersion = 2 as never;
    const before = clone(saved);
    const opened = normalizeDocument(saved);
    expect(opened).not.toHaveProperty('editHistory');
    expect(opened.nodes).toEqual(before.nodes);
    expect(saved).toEqual(before);
  });

  it.each([31, 32, 33, 34])(
    'preserves earlier drawing/image content and history in v%s',
    (version) => {
      const f = fixture();
      const manager = new CommandManager(f.document);
      const sheet: DrawingSheet = {
        sheetId: 'dsht_schema' as DrawingSheet['sheetId'],
        name: 'Saved sheet',
        paper: { size: 'A3', orientation: 'landscape' },
        scale: { numerator: 1, denominator: 1 },
        projectionAngle: 'third',
        titleBlock: {},
        source: { fingerprint: 'v1:schema' },
        views: [],
        annotations: [
          {
            annotationId: 'dann_schema' as never,
            kind: 'note',
            text: 'Retain raw drawing note',
            placementMm: { x: 20, y: -10 }
          }
        ]
      };
      manager.execute(commandFactories.addDrawingSheet({ sheet }));
      if (version >= 32) {
        const image: ReferenceImage = {
          imageId: 'rimg_schema' as ReferenceImage['imageId'],
          name: 'Saved reference image',
          contentType: 'image/png',
          source: {
            marker: 'openzcad-source-ref',
            version: 1,
            hashAlgorithm: 'sha256',
            checksumSha256: 'b'.repeat(64),
            logicalBytes: 1234
          },
          artifactId: 'artifact_schema' as ReferenceImage['artifactId'],
          pixelWidth: 400,
          pixelHeight: 200,
          plane: { type: 'canonical', plane: 'XY', offset: 0 },
          center: { u: 3, v: -2 },
          rotationDeg: 10,
          width: 100,
          opacity: 0.5
        };
        manager.execute(commandFactories.addReferenceImage({ image }));
      }
      manager.execute(f.command());
      const saved = clone(manager.document);
      saved.schemaVersion = version as ProjectDocument['schemaVersion'];
      const before = clone(saved);
      const opened = normalizeDocument(saved);
      expect(opened).toEqual({
        ...before,
        schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION
      });
      const reopened = new CommandManager(opened);
      while (reopened.canUndo) reopened.undo();
      expect(clone(reopened.document)).not.toHaveProperty('drawings');
      expect(clone(reopened.document)).not.toHaveProperty('referenceImages');
      while (reopened.canRedo) reopened.redo();
      expect(reopened.document.drawings).toEqual(before.drawings);
      expect(reopened.document.referenceImages).toEqual(before.referenceImages);
      expect(reopened.document.nodes).toEqual(before.nodes);
      const replayed = replayCommands(f.document, before.commandLog);
      expect(replayed.drawings).toEqual(before.drawings);
      expect(replayed.referenceImages).toEqual(before.referenceImages);
      expect(replayed.nodes).toEqual(before.nodes);
      expect(saved).toEqual(before);
    }
  );

  it('refuses malformed reference data in a current-schema saved nested log', () => {
    const saved = carried(
      'current nested log',
      introduced,
      'diagonal' as SketchReferenceDistanceMode
    );
    const before = clone(saved);
    expect(() => normalizeDocument(saved)).toThrow(
      /replay targets are malformed/
    );
    expect(() => new CommandManager(saved)).toThrow(
      /replay targets are malformed/
    );
    expect(saved).toEqual(before);
  });
});
