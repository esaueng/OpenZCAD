import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addSketchFeature,
  createProjectDocument,
  importStepBody
} from '@openzcad/document-core';
import {
  toUserId,
  toEntityId,
  MAX_DOCUMENT_TEXT_OBJECTS,
  MAX_TEXT_OBJECT_CODE_UNITS,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';
import {
  HttpError,
  parseCreateProjectRequest,
  parseSaveProjectDocumentRequest,
  parseSaveRevisionRequest
} from '../apps/web/worker/validation';

const reference = {
  marker: 'openzcad-source-ref' as const,
  version: 1 as const,
  hashAlgorithm: 'sha256' as const,
  checksumSha256: 'a'.repeat(64),
  logicalBytes: 14
};

function importedDocument(embedded = false): ProjectDocument {
  return importStepBody(
    createProjectDocument('Imported part', toUserId('owner')),
    {
      name: 'Exact import',
      artifactId: 'artifact_local_source',
      sourceName: 'part.step',
      ...(embedded
        ? { stepText: 'ISO-10303-21;' }
        : { stepSourceRef: reference })
    }
  ).document;
}

function importedFeature(document: ProjectDocument): FeatureNode {
  const feature = Object.values(document.nodes).find(
    (node) => node.kind === 'feature'
  );
  if (!feature || feature.kind !== 'feature')
    throw new Error('Missing fixture');
  return feature;
}

function textDocument(count: number, length: number): ProjectDocument {
  const document = addSketchFeature(importedDocument(), {
    name: 'Label',
    plane: 'XY',
    objects: [
      {
        objectKind: 'text',
        text: 'x',
        fontFamily: 'open-sans',
        fontStyle: 'regular',
        size: 10,
        x: 0,
        y: 0,
        construction: true
      }
    ]
  }).document;
  const text = Object.values(document.nodes).find(
    (node) => node.kind === 'sketch-object'
  );
  const sketch = Object.values(document.nodes).find(
    (node) => node.kind === 'sketch'
  );
  if (
    !text ||
    text.kind !== 'sketch-object' ||
    !sketch ||
    sketch.kind !== 'sketch'
  )
    throw new Error('Missing fixture');
  delete document.nodes[text.id];
  sketch.objectIds = [];
  for (let index = 0; index < count; index++) {
    const id = toEntityId(`synthetic_text_${index}`);
    document.nodes[id] = {
      ...text,
      id,
      data: { ...text.data, text: 'x'.repeat(length) }
    } as typeof text;
    sketch.objectIds.push(id);
  }
  return document;
}

const parsers = [
  {
    name: 'adoption',
    parse: (document: ProjectDocument) =>
      parseCreateProjectRequest({ name: document.name, document })
  },
  {
    name: 'autosave',
    parse: (document: ProjectDocument) =>
      parseSaveProjectDocumentRequest(
        {
          projectId: document.projectId,
          expectedVersion: document.version,
          document
        },
        document.projectId
      )
  },
  {
    name: 'revision',
    parse: (document: ProjectDocument) =>
      parseSaveRevisionRequest(
        {
          projectId: document.projectId,
          expectedVersion: document.version,
          reason: 'Save',
          document
        },
        document.projectId
      )
  }
];

describe.each(parsers)(
  'import source validation at $name ingress',
  ({ parse }) => {
    it('preserves short construction text without modifying the document', () => {
      const document = textDocument(1, MAX_TEXT_OBJECT_CODE_UNITS);
      expect(parse(document).document).toBe(document);
    });

    it('rejects text over per-object and collective limits with HTTP 400', () => {
      const documents = [
        textDocument(1, MAX_TEXT_OBJECT_CODE_UNITS + 1),
        textDocument(5, MAX_TEXT_OBJECT_CODE_UNITS),
        textDocument(MAX_DOCUMENT_TEXT_OBJECTS + 1, 1)
      ];
      // Detached text nodes still impose a document budget.
      const detached = documents[2]!;
      for (const node of Object.values(detached.nodes))
        if (node.kind === 'sketch') node.objectIds = [];
      for (const document of documents) {
        expect(() => parse(document)).toThrow(/outline limit/);
        try {
          parse(document);
        } catch (error) {
          expect((error as HttpError).status).toBe(400);
        }
      }
    });

    it.each(['before', 'after'] as const)(
      'rejects oversized text in a %s history snapshot',
      (side) => {
        const manager = new CommandManager(textDocument(1, 1));
        manager.execute(
          commandFactories.renameNode({
            nodeId: manager.document.rootNodeId,
            name: 'Renamed'
          })
        );
        const document = structuredClone(manager.document);
        const text = Object.values(document.nodes).find(
          (node) => node.kind === 'sketch-object'
        );
        if (!text || text.kind !== 'sketch-object')
          throw new Error('Missing fixture');
        document.editHistory!.entries[0]!.changes.push({
          kind: 'value',
          field: 'nodes',
          key: text.id,
          [side]: {
            ...text,
            data: {
              ...text.data,
              text: 'x'.repeat(MAX_TEXT_OBJECT_CODE_UNITS + 1)
            }
          }
        });
        expect(() => parse(document)).toThrow(/outline limit/);
      }
    );

    it.each([
      { artifactId: null },
      { artifactId: {} },
      { artifactId: false },
      { artifactId: undefined },
      { sourceName: null },
      { sourceName: [] },
      { stepText: null },
      { stepText: 'ISO-10303-21;' },
      { stepSourceRef: null },
      { stepSourceRef: [] },
      { stepSourceRef: { ...reference, checksumSha256: 42 } },
      { stepSourceRef: { ...reference, checksumSha256: 'not-a-checksum' } },
      { stepSourceRef: { ...reference, version: 2 } },
      { stepSourceRef: { ...reference, logicalBytes: -1 } },
      { stepSourceRef: undefined }
    ])('rejects malformed source fields with 400: %j', (fields) => {
      const document = importedDocument();
      Object.assign(importedFeature(document).data, fields);
      expect(() => parse(document)).toThrow(
        'invalid imported STEP source data'
      );
      try {
        parse(document);
      } catch (error) {
        expect(error).toBeInstanceOf(HttpError);
        expect((error as HttpError).status).toBe(400);
      }
    });

    it.each([false, true])(
      'preserves valid source data, embedded=%s',
      (embedded) => {
        const document = importedDocument(embedded);
        const before = structuredClone(document);
        expect(parse(document).document).toBe(document);
        expect(document).toEqual(before);
      }
    );

    it.each(['before', 'after'] as const)(
      'rejects an import in a keyed %s undo snapshot',
      (side) => {
        const manager = new CommandManager(importedDocument());
        manager.execute(
          commandFactories.renameNode({
            nodeId: manager.document.rootNodeId,
            name: 'Renamed'
          })
        );
        const document = structuredClone(manager.document);
        const feature = importedFeature(document);
        const poisoned = {
          ...feature,
          data: { ...feature.data, artifactId: null }
        };
        document.editHistory!.entries[0]!.changes.push({
          kind: 'value',
          field: 'nodes',
          key: feature.id,
          [side]: poisoned
        });
        expect(() => parse(document)).toThrow(
          'invalid imported STEP source data'
        );
      }
    );

    it('rejects an import in a whole-nodes redo snapshot', () => {
      const manager = new CommandManager(importedDocument());
      manager.execute(
        commandFactories.renameNode({
          nodeId: manager.document.rootNodeId,
          name: 'Renamed'
        })
      );
      const document = structuredClone(manager.document);
      const feature = importedFeature(document);
      document.editHistory!.entries[0]!.changes.push({
        kind: 'value',
        field: 'nodes',
        after: {
          [feature.id]: {
            ...feature,
            data: { ...feature.data, artifactId: {} }
          }
        }
      });
      document.editHistory!.cursor = 0;
      expect(() => parse(document)).toThrow(
        'invalid imported STEP source data'
      );
    });
  }
);
