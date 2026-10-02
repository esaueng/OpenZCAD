import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addSketchFeature,
  createProjectDocument,
  importStepBody
} from '@openzcad/document-core';
import {
  toUserId,
  MAX_TEXT_OBJECT_CODE_UNITS,
  type ProjectDocument
} from '@openzcad/shared';
import {
  createRoomContext,
  createTestRoom,
  installWorkerSocketGlobals
} from './collaboration-room-harness';

let globals: ReturnType<typeof installWorkerSocketGlobals>;
beforeAll(() => {
  globals = installWorkerSocketGlobals();
});
afterAll(() => {
  globals.restore();
});

function sourceDocument(embedded = false) {
  return importStepBody(
    createProjectDocument('Shared part', toUserId('user_room')),
    {
      name: 'Exact import',
      artifactId: 'artifact_cloud_source',
      sourceName: 'part.step',
      ...(embedded
        ? { stepText: 'ISO-10303-21;' }
        : {
            stepSourceRef: {
              marker: 'openzcad-source-ref' as const,
              version: 1 as const,
              hashAlgorithm: 'sha256' as const,
              checksumSha256: 'a'.repeat(64),
              logicalBytes: 14
            }
          })
    }
  ).document;
}

function textDocument() {
  return addSketchFeature(sourceDocument(), {
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
}

async function submission(transport: string, document: ProjectDocument) {
  const { context, values } = createRoomContext();
  const room = createTestRoom(context, {});
  const url = `https://room.test/?projectId=${document.projectId}`;
  const headers = {
    'x-openzcad-user-id': 'user_room',
    'x-openzcad-display-name': 'Owner',
    'x-openzcad-project-role': 'owner'
  };
  if (transport === 'http') {
    const response = await room.fetch(
      new Request(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          clientId: 'client_source',
          baseVersion: null,
          document
        })
      })
    );
    return { result: (await response.json()) as unknown, values };
  }
  const response = await room.fetch(
    new Request(url, {
      headers: { ...headers, upgrade: 'websocket' }
    })
  );
  expect(response.status).toBe(101);
  const socket = globals.serverSockets.at(-1)!;
  await socket.receive(
    JSON.stringify({
      type: 'hello',
      clientId: 'client_source',
      displayName: 'Owner',
      baseVersion: null,
      document: null
    })
  );
  await socket.receive(
    JSON.stringify({
      type: 'document',
      clientId: 'client_source',
      baseVersion: null,
      document
    })
  );
  return { result: socket.lastFrame(), values };
}

describe.each(['http', 'websocket'])(
  'import sources in %s collaboration snapshots',
  (transport) => {
    it('rejects excessive text in current, historical and repeated-reference forms before storage', async () => {
      for (const location of [
        'current',
        'before',
        'after',
        'whole-map',
        'references'
      ]) {
        const manager = new CommandManager(textDocument());
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
        const sketch = Object.values(document.nodes).find(
          (node) => node.kind === 'sketch'
        );
        if (
          !text ||
          text.kind !== 'sketch-object' ||
          text.data.objectKind !== 'text' ||
          !sketch ||
          sketch.kind !== 'sketch'
        )
          throw new Error('Missing fixture');
        const oversized = {
          ...text,
          data: {
            ...text.data,
            text: 'x'.repeat(MAX_TEXT_OBJECT_CODE_UNITS + 1)
          }
        };
        if (location === 'current') text.data.text = oversized.data.text;
        else if (location === 'references') {
          text.data.text = 'x'.repeat(MAX_TEXT_OBJECT_CODE_UNITS);
          sketch.objectIds = Array.from({ length: 5 }, () => text.id);
        } else
          document.editHistory!.entries[0]!.changes.push(
            location === 'whole-map'
              ? {
                  kind: 'value',
                  field: 'nodes',
                  after: { [text.id]: oversized }
                }
              : {
                  kind: 'value',
                  field: 'nodes',
                  key: text.id,
                  [location]: oversized
                }
          );
        const { result, values } = await submission(transport, document);
        expect(result).toMatchObject({
          code: 'document-invalid'
        });
        expect((result as { message?: unknown }).message).toMatch(
          /outline limit/
        );
        expect(values.has('room:latest')).toBe(false);
      }
    });

    it('keeps ordinary construction text accepted', async () => {
      const document = textDocument();
      const { result, values } = await submission(transport, document);
      expect(result).toMatchObject({ type: 'ack' });
      expect((values.get('room:latest') as ProjectDocument).nodes).toEqual(
        document.nodes
      );
    });

    it.each([false, true])(
      'retains valid exact source data, embedded=%s',
      async (embedded) => {
        const document = sourceDocument(embedded);
        const { result, values } = await submission(transport, document);
        expect(result).toMatchObject({ type: 'ack' });
        const stored = values.get('room:latest') as ProjectDocument;
        expect(stored.nodes).toEqual(document.nodes);
      }
    );

    it.each(['current', 'before', 'after', 'whole-map'])(
      'rejects invalid source fields in %s nodes before storage',
      async (location) => {
        for (const fields of [
          { artifactId: null },
          { artifactId: {} },
          { sourceName: [] },
          { stepSourceRef: {} },
          { stepText: {} }
        ]) {
          const manager = new CommandManager(sourceDocument());
          manager.execute(
            commandFactories.renameNode({
              nodeId: manager.document.rootNodeId,
              name: 'Renamed'
            })
          );
          const document = structuredClone(manager.document);
          const feature = Object.values(document.nodes).find(
            (node) => node.kind === 'feature'
          );
          if (!feature || feature.kind !== 'feature')
            throw new Error('Missing fixture');
          const malformed = {
            ...feature,
            data: { ...feature.data, ...fields }
          };
          if (location === 'current') Object.assign(feature.data, fields);
          else
            document.editHistory!.entries[0]!.changes.push(
              location === 'whole-map'
                ? {
                    kind: 'value',
                    field: 'nodes',
                    after: { [feature.id]: malformed }
                  }
                : {
                    kind: 'value',
                    field: 'nodes',
                    key: feature.id,
                    [location]: malformed
                  }
            );
          const { result, values } = await submission(transport, document);
          expect(result).toMatchObject({ code: 'document-invalid' });
          expect(values.has('room:latest')).toBe(false);
        }
      }
    );
  }
);
