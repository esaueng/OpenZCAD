import { afterEach, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  assertStorableDocument,
  createProjectDocument,
  getNode,
  normalizeDocument,
  renameNode,
  setNodeMetadata,
  UnstorableDocumentError
} from '@openzcad/document-core';
import {
  documentEnvelopeError,
  isDocumentHistory,
  ownEntry,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';

const owner = toUserId('user_node_ids');
const RESERVED = ['__proto__', 'constructor', 'prototype', 'toString'] as const;

function valid(): ProjectDocument {
  return addPrimitiveFeature(createProjectDocument('Node ids', owner), {
    name: 'Box',
    primitiveKind: 'box',
    dimensions: { width: 1, height: 1, depth: 1 }
  });
}

interface NodeJson {
  id?: unknown;
  parentId?: unknown;
  activePartId?: unknown;
  childIds: unknown[];
}
interface DocumentJson {
  rootNodeId: string;
  rootAssemblyId: string;
  activePartId: string;
  nodes: Record<string, NodeJson>;
}

/** A document as `JSON.parse` returns it from storage, a backup or a peer. */
function received(edit: (json: DocumentJson) => void): unknown {
  const json = JSON.parse(JSON.stringify(valid())) as DocumentJson;
  edit(json);
  return JSON.parse(JSON.stringify(json));
}

/** Rename a node key by rewriting the JSON text, so `__proto__` stays an own key. */
function withNodeKey(id: string): unknown {
  const document = valid();
  const partId = document.activePartId;
  const text = JSON.stringify(document).replaceAll(
    JSON.stringify(partId),
    JSON.stringify(id)
  );
  return JSON.parse(text) as unknown;
}

function refusal(value: unknown): string {
  try {
    assertStorableDocument(value);
  } catch (error) {
    expect(error).toBeInstanceOf(UnstorableDocumentError);
    return (error as Error).message;
  }
  throw new Error('The document was accepted.');
}

const prototypeNames = () => Object.getOwnPropertyNames(Object.prototype);

afterEach(() => {
  // Nothing in this file may leave a member on the shared prototype.
  expect(({} as Record<string, unknown>).name).toBeUndefined();
  expect(({} as Record<string, unknown>).metadata).toBeUndefined();
});

describe('document node ids', () => {
  it('still accepts every generated node id and reference', () => {
    const document = valid();
    expect(documentEnvelopeError(document)).toBeNull();
    expect(assertStorableDocument(document).activePartId).toBe(
      document.activePartId
    );
  });

  it.each(RESERVED)('refuses a document whose node is keyed "%s"', (id) => {
    const value = withNodeKey(id);
    expect(Object.hasOwn((value as { nodes: object }).nodes, id)).toBe(true);
    expect(refusal(value)).toMatch(/reserved node id/);
    expect(documentEnvelopeError(value)).toMatch(/reserved node id/);
  });

  it('keeps accepting a child or parent that names a removed node', () => {
    const value = received((json) => {
      json.nodes[json.activePartId]!.childIds.push('ent_removed');
      json.nodes[json.activePartId]!.parentId = 'ent_removed_parent';
    });
    expect(() => assertStorableDocument(value)).not.toThrow();
  });

  it('refuses a node whose id is reserved under an ordinary key', () => {
    const value = received((json) => {
      json.nodes[json.activePartId]!.id = '__proto__';
    });
    expect(refusal(value)).toMatch(/invalid id/);
  });

  it.each([
    [
      'a child id inherited from Object.prototype',
      (json: DocumentJson) => {
        json.nodes[json.rootAssemblyId]!.childIds.push('constructor');
      },
      /invalid child id/
    ],
    [
      'a child id that is not a string',
      (json: DocumentJson) => {
        json.nodes[json.rootAssemblyId]!.childIds.push(7);
      },
      /invalid child id/
    ],
    [
      'an active part that names no node',
      (json: DocumentJson) => {
        json.activePartId = 'ent_missing';
      },
      /document\.activePartId/
    ],
    [
      'an inherited active part',
      (json: DocumentJson) => {
        json.activePartId = 'toString';
      },
      /document\.activePartId/
    ],
    [
      'an inherited root assembly',
      (json: DocumentJson) => {
        json.rootAssemblyId = 'hasOwnProperty';
      },
      /document\.rootAssemblyId/
    ],
    [
      'an inherited parent',
      (json: DocumentJson) => {
        json.nodes[json.activePartId]!.parentId = 'valueOf';
      },
      /invalid parent id/
    ],
    [
      'the project node naming an inherited active part',
      (json: DocumentJson) => {
        json.nodes[json.rootNodeId]!.activePartId = 'constructor';
      },
      /active part that is not in the project/
    ]
  ])('refuses %s', (_case, edit, message) => {
    expect(refusal(received(edit))).toMatch(message);
  });

  it('refuses undo history that restores a node under a reserved key', () => {
    const document = valid();
    const history = {
      schemaVersion: 1,
      projectId: document.projectId,
      actorUserId: owner,
      entries: [
        {
          id: 'entry_1',
          label: 'Edit',
          changes: [{ kind: 'value', field: 'nodes', key: 'ent_ok', after: {} }]
        }
      ],
      cursor: 1,
      trimmed: 0
    };
    expect(isDocumentHistory(history, document.projectId)).toBe(true);
    for (const id of RESERVED) {
      const keyed = JSON.parse(
        JSON.stringify(history).replace('"ent_ok"', JSON.stringify(id))
      ) as unknown;
      expect(isDocumentHistory(keyed, document.projectId)).toBe(false);
      const whole = JSON.parse(
        JSON.stringify({
          ...history,
          entries: [
            {
              id: 'entry_1',
              label: 'Edit',
              changes: [
                { kind: 'value', field: 'nodes', after: { ent_ok: {} } }
              ]
            }
          ]
        }).replace('"ent_ok"', JSON.stringify(id))
      ) as unknown;
      expect(isDocumentHistory(whole, document.projectId)).toBe(false);
    }
  });

  it('never resolves an inherited member as a node', () => {
    const document = valid();
    for (const id of [...RESERVED, 'hasOwnProperty']) {
      expect(getNode(document, id)).toBeUndefined();
      expect(ownEntry(document.nodes, id)).toBeUndefined();
    }
    expect(getNode(document, document.activePartId)?.kind).toBe('part');
  });

  it('leaves Object.prototype untouched when a mutator is given a reserved id', () => {
    const before = prototypeNames();
    // structuredClone (inside every mutator) drops a prototype that an
    // assignment to `nodes.__proto__` would have set, so the lookup must not
    // fall through to Object.prototype either.
    const document = structuredClone(valid());
    for (const nodeId of [...RESERVED, 'valueOf']) {
      expect(() => renameNode(document, { nodeId, name: 'Renamed' })).toThrow(
        /not found/
      );
      expect(() =>
        setNodeMetadata(document, { nodeId, metadata: { tint: 'red' } })
      ).toThrow(/not found/);
    }
    expect(prototypeNames()).toEqual(before);
    expect(({} as Record<string, unknown>).tint).toBeUndefined();
  });

  it('refuses to normalize a node map with a reserved key', () => {
    const value = withNodeKey('__proto__') as ProjectDocument;
    expect(() => normalizeDocument(value)).toThrow(/reserved node id/);
  });
});
