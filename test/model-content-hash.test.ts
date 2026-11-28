import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  modelContentHash
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';

/**
 * AS04: what names the model a geometry result is of. A result is out of
 * date when this changes, whatever the document version does.
 */
function box(width: number): ProjectDocument {
  return addPrimitiveFeature(
    createProjectDocument('Hash', toUserId('user_hash')),
    {
      name: 'Box',
      bodyName: 'Box',
      primitiveKind: 'box',
      dimensions: { width, height: 10, depth: 10 }
    }
  );
}

/** The same model as `document`, with one of the box's dimensions changed. */
function resized(document: ProjectDocument): ProjectDocument {
  const [key, node] = Object.entries(document.nodes).find(
    ([, entry]) =>
      entry.kind === 'feature' && entry.data.featureKind === 'primitive'
  )!;
  if (node.kind !== 'feature' || node.data.featureKind !== 'primitive')
    throw new Error('no primitive');
  return {
    ...document,
    nodes: {
      ...document.nodes,
      [key]: {
        ...node,
        data: {
          ...node.data,
          dimensions: { ...node.data.dimensions, width: 45 }
        }
      }
    }
  };
}

describe('model content hash', () => {
  it('changes with the model, at the same document version', () => {
    const document = box(20);
    const edited = resized(document);
    expect(edited.version).toBe(document.version);
    expect(modelContentHash(edited)).not.toBe(modelContentHash(document));
    // The same content hashes the same, copied or not.
    expect(modelContentHash(structuredClone(document))).toBe(
      modelContentHash(document)
    );
  });

  it('leaves out the version, the history records and derived state', () => {
    const document = box(20);
    expect(
      modelContentHash({
        ...document,
        version: document.version + 7,
        commandLog: [],
        revisions: [],
        checkpoints: [],
        derived: { ...document.derived, meshes: {} }
      } as ProjectDocument)
    ).toBe(modelContentHash(document));
  });

  it('reads a nested field named like one it leaves out', () => {
    const document = box(20);
    const withNested = (version: number): ProjectDocument =>
      ({
        ...document,
        version,
        assets: { nested: { version } }
      }) as unknown as ProjectDocument;
    expect(modelContentHash(withNested(1))).not.toBe(
      modelContentHash(withNested(2))
    );
  });
});
