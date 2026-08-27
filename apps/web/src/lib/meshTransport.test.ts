import { describe, expect, it } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  documentForWorker,
  unpackWorkerRequest
} from './meshTransport';

const BASE = createProjectDocument('Imported', toUserId('user_wire'));

function meshDocument(
  vertices: number[],
  indices: number[]
): ProjectDocument {
  return {
    ...BASE,
    nodes: {
      ...BASE.nodes,
      feat_mesh: {
        id: 'feat_mesh',
        kind: 'feature',
        featureKind: 'imported-mesh',
        name: 'Imported',
        data: {
          featureKind: 'imported-mesh',
          artifactId: 'artifact_1',
          sourceName: 'part.stl',
          triangleCount: indices.length / 3,
          vertices,
          indices
        }
      }
    }
  } as unknown as ProjectDocument;
}

const payloadOf = (document: unknown) =>
  (
    (document as { nodes: Record<string, { data: Record<string, unknown> }> })
      .nodes.feat_mesh as { data: Record<string, unknown> }
  ).data;

/** What `postMessage` does to the packed copy, without needing a real worker. */
function overTheWire<T>(value: T): T {
  return structuredClone(value);
}

/**
 * This is a wire format, and both halves live in one module precisely because
 * a mismatch would corrupt every imported mesh rather than fail to compile.
 * These tests are the other half of that guarantee: what the worker reads has
 * to equal what the main thread held, exactly.
 */
describe('imported mesh transport', () => {
  const VERTICES = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0.125, -2.5, 3.75];
  const INDICES = [0, 1, 2, 1, 2, 3];

  it('round-trips a payload to plain arrays with identical values', () => {
    const request = { type: 'sync', document: documentForWorker(meshDocument(VERTICES, INDICES)) };
    const received = unpackWorkerRequest(overTheWire(request));
    const data = payloadOf(received.document);

    expect(Array.isArray(data.vertices)).toBe(true);
    expect(Array.isArray(data.indices)).toBe(true);
    expect(data.vertices).toEqual(VERTICES);
    expect(data.indices).toEqual(INDICES);
  });

  it('leaves no transport marker on the document the worker reads', () => {
    // Anything left behind would reach the cache key and the history digest,
    // where a stray field changes what those keys mean.
    const request = { type: 'sync', document: documentForWorker(meshDocument(VERTICES, INDICES)) };
    const received = unpackWorkerRequest(overTheWire(request));
    expect(
      Object.keys(payloadOf(received.document)).filter((key) =>
        key.startsWith('__')
      )
    ).toEqual([]);
  });

  it('does not disturb the document the main thread keeps', () => {
    const original = meshDocument(VERTICES, INDICES);
    documentForWorker(original);
    expect(payloadOf(original).vertices).toBe(VERTICES);
    expect(Array.isArray(payloadOf(original).vertices)).toBe(true);
  });

  it('preserves negative zero and fractional components exactly', () => {
    const exact = [-0, 0.1, 1 / 3, -2.5, 1e-7, 12345.6789, 0, 0, 0];
    const request = { type: 'sync', document: documentForWorker(meshDocument(exact, [0, 1, 2])) };
    const data = payloadOf(unpackWorkerRequest(overTheWire(request)).document);
    expect(data.vertices).toEqual(exact);
    expect(Object.is((data.vertices as number[])[0], -0)).toBe(true);
  });

  it('passes an unpacked request through, so the two sides need not ship together', () => {
    const plain = { type: 'sync', document: meshDocument(VERTICES, INDICES) };
    const received = unpackWorkerRequest(overTheWire(plain));
    expect(payloadOf(received.document).vertices).toEqual(VERTICES);
  });

  it('ignores a request that carries no document', () => {
    expect(() =>
      unpackWorkerRequest({ type: 'cancel', requestId: 'r1' })
    ).not.toThrow();
  });

  it('leaves a document with no imported mesh untouched', () => {
    expect(documentForWorker(BASE)).toBe(BASE);
  });
});
