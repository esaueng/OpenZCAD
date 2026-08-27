import type { ProjectDocument } from '@openzcad/shared';

/**
 * How an imported mesh crosses `postMessage`.
 *
 * The document holds a mesh as `vertices: number[]` and `indices: number[]`,
 * and structured-cloning a JS array of a million boxed numbers is slow in a way
 * that has nothing to do with the byte count: measured at 100,000 triangles
 * (1.2M components) the clone costs 46 ms, against 1.1 ms for the identical
 * data in a `Float64Array`. That 46 ms is spent on the main thread, on every
 * sync — including every frame of a drag preview, which is exactly where it is
 * felt.
 *
 * So the arrays travel as typed arrays and are unpacked on arrival. The
 * canonical document is untouched: only the copy handed to `postMessage`
 * differs, so nothing about what is persisted, replayed, or hashed changes.
 * Unpacking costs about 16 ms, but it is paid inside the worker where it
 * competes with the rebuild rather than with rendering.
 *
 * Both halves live here together because they are one wire format. Split
 * across the two files that use them, a change to either side would be a
 * silent corruption of every imported mesh rather than a type error.
 */

/** Wire form of one mesh payload. Indices are integral, so they pack smaller. */
interface PackedMesh {
  readonly vertices: Float64Array;
  readonly indices: Uint32Array;
}

const PACKED = '__openzcadPackedMesh';

type MaybePacked = { [PACKED]?: true } & Record<string, unknown>;

function packedMeshOf(data: Record<string, unknown>): PackedMesh | null {
  if (
    data.featureKind !== 'imported-mesh' ||
    !Array.isArray(data.vertices) ||
    !Array.isArray(data.indices)
  ) {
    return null;
  }
  return {
    vertices: Float64Array.from(data.vertices as number[]),
    indices: Uint32Array.from(data.indices as number[])
  };
}

/**
 * Shallow-copies `document` with every imported mesh payload packed.
 *
 * Shallow on purpose — this runs on the main thread on the hot path, and
 * `postMessage` clones the result anyway, so copying anything the swap does not
 * touch would be paying twice for the same bytes.
 */
export function documentForWorker(document: ProjectDocument): ProjectDocument {
  let nodes: Record<string, unknown> | null = null;
  for (const [id, node] of Object.entries(
    document.nodes as unknown as Record<string, unknown>
  )) {
    if (node === null || typeof node !== 'object') {
      continue;
    }
    const data = (node as { data?: unknown }).data;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      continue;
    }
    const packed = packedMeshOf(data as Record<string, unknown>);
    if (!packed) {
      continue;
    }
    nodes ??= { ...(document.nodes as unknown as Record<string, unknown>) };
    nodes[id] = {
      ...(node as Record<string, unknown>),
      data: { ...data, ...packed, [PACKED]: true }
    };
  }
  return nodes
    ? ({ ...document, nodes } as unknown as ProjectDocument)
    : document;
}

/**
 * Restores packed payloads in place on a document the worker just received.
 *
 * In place because the value came out of `postMessage` and nothing else holds
 * a reference to it yet. A document that was never packed — anything posted by
 * an older client, or a document with no imported mesh — passes through
 * untouched, so the two sides do not have to be upgraded together.
 */
export function unpackWorkerDocument(document: unknown): void {
  const nodes = (document as { nodes?: unknown } | null)?.nodes;
  if (nodes === null || typeof nodes !== 'object') {
    return;
  }
  for (const node of Object.values(nodes as Record<string, unknown>)) {
    if (node === null || typeof node !== 'object') {
      continue;
    }
    const data = (node as { data?: unknown }).data as MaybePacked | undefined;
    if (!data || typeof data !== 'object' || data[PACKED] !== true) {
      continue;
    }
    if (ArrayBuffer.isView(data.vertices)) {
      data.vertices = Array.from(data.vertices as Float64Array);
    }
    if (ArrayBuffer.isView(data.indices)) {
      data.indices = Array.from(data.indices as Uint32Array);
    }
    delete data[PACKED];
  }
}

/**
 * Unpacks whatever document a worker request carries, if it carries one.
 * `cancel` carries none, and an unpacked request passes through untouched.
 */
export function unpackWorkerRequest<T>(request: T): T {
  const document = (request as { document?: unknown } | null)?.document;
  if (document !== null && typeof document === 'object') {
    unpackWorkerDocument(document);
  }
  return request;
}
