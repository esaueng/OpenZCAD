import type { BodyId, BodyTopology, ProjectDocument } from '@openzcad/shared';

type Derived = ProjectDocument['derived'];
export type TopologyJson = Record<string, string>;
export type TopologyPayload = Record<string, string | Uint8Array>;
export type TopologyEncoding = 'json-v1' | 'json-v2' | 'utf8-v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
interface EncodedTopology {
  json: string | Uint8Array;
  undefinedJson?: string;
  bytes: number;
  nodes: object[];
}
interface WalkEntry {
  value: unknown;
  depth: number;
  parent?: WalkEntry;
  key?: string;
}

const BYTE_BUDGET = 8 * 1024 * 1024;

/** Inspect descriptors before reading or spreading an unsupported record. */
function plainDataRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.keys(value).every(
      (key) => 'value' in Object.getOwnPropertyDescriptor(value, key)!
    )
  );
}

/**
 * Explicit rebuild replies repeatedly clone unchanged exact topology. Cache
 * its encoded JSON while the worker owns the immutable completed measurement.
 * Each receiver parses a fresh graph, with the same ownership as postMessage.
 * This is an optional wire encoding, never a persisted format or cache key.
 *
 * V2 records own undefined leaves separately, replacing their null placeholders
 * before adoption. V1 clients continue to fall back for those optional fields.
 * The encoding is lossless only for unaliased trees of supported values. Anything
 * else takes the existing structured-clone path for the entire publication,
 * including aliases between bodies or between topology and other metadata.
 */
export class TopologyTransport {
  private cache = new WeakMap<object, EncodedTopology | null>();
  // A successfully packed reply proves its immutable encoding entries share no nodes.
  // The weak set retains neither the geometry nor the encoded payloads.
  private disjoint = new WeakSet<EncodedTopology>();
  private binary = false;
  private bytes = 0;
  private entries = 0;

  constructor(private readonly byteBudget = BYTE_BUDGET) {}

  private encode(root: BodyTopology): EncodedTopology | null {
    if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
    if (this.cache.has(root)) return this.cache.get(root)!;
    for (const key of ['faces', 'edges']) {
      const field = Object.getOwnPropertyDescriptor(root, key);
      if (
        !field?.enumerable ||
        !('value' in field) ||
        !Array.isArray(field.value)
      )
        return null;
    }
    const nodes: object[] = [];
    const seen = new Set<object>();
    const queue: WalkEntry[] = [{ value: root, depth: 0 }];
    const undefinedPaths: string[][] = [];
    let supported = true;
    let properties = 0;
    let textBytes = 0;
    while (queue.length && supported) {
      const current = queue.pop()!;
      const { value, depth } = current;
      if (value === undefined) {
        const path: string[] = [];
        for (let entry = current; entry.parent; entry = entry.parent) {
          path.push(entry.key!);
          textBytes += entry.key!.length * 12 + 8;
        }
        undefinedPaths.push(path.reverse());
        textBytes += 12;
      } else if (value === null) {
        textBytes += 8;
      } else if (typeof value === 'number') {
        supported = Number.isFinite(value) && !Object.is(value, -0);
        textBytes += 64;
      } else if (typeof value === 'string') {
        // Bound validation/serialization before allocating text. A UTF-16
        // code unit can need six JSON characters when escaped.
        textBytes += value.length * 12 + 4;
      } else if (typeof value === 'object') {
        const array = Array.isArray(value);
        const prototype: unknown = Object.getPrototypeOf(value);
        if (
          seen.has(value) ||
          depth > 512 ||
          nodes.length >= 100_000 ||
          (array
            ? prototype !== Array.prototype
            : prototype !== Object.prototype && prototype !== null) ||
          'toJSON' in value ||
          Object.getOwnPropertySymbols(value).length
        ) {
          supported = false;
          break;
        }
        seen.add(value);
        nodes.push(value);
        const keys = Object.keys(value);
        textBytes += 4;
        properties += keys.length;
        if (properties > 100_000 || (array && keys.length !== value.length)) {
          supported = false;
          break;
        }
        for (let index = 0; index < keys.length; index++) {
          const key = keys[index]!;
          textBytes += array ? 2 : key.length * 12 + 8;
          // JSON reads every array index, while structuredClone copies only
          // enumerable own properties. Reject holes and extra array keys.
          const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
          if ((array && key !== String(index)) || !('value' in descriptor)) {
            supported = false;
            break;
          }
          queue.push({
            value: descriptor.value as unknown,
            depth: depth + 1,
            parent: current,
            key
          });
        }
      } else if (typeof value === 'boolean') {
        textBytes += 10;
      } else {
        supported = false;
      }
      if (textBytes + nodes.length * 8 + 64 > this.byteBudget)
        supported = false;
    }
    let encoded: EncodedTopology | null = null;
    if (supported) {
      try {
        const json = undefinedPaths.length
          ? JSON.stringify(root, (_key, value: unknown) =>
              value === undefined ? null : value
            )
          : JSON.stringify(root);
        const undefinedJson = undefinedPaths.length
          ? JSON.stringify(undefinedPaths)
          : undefined;
        const payload = this.binary ? encoder.encode(json) : json;
        encoded = {
          json: payload,
          ...(undefinedJson ? { undefinedJson } : {}),
          bytes:
            (typeof payload === 'string'
              ? payload.length * 2
              : payload.byteLength) +
            (undefinedJson?.length ?? 0) * 2 +
            nodes.length * 8 +
            64,
          nodes
        };
      } catch {
        // Deep or unexpectedly nonserializable inputs still use postMessage.
      }
    }
    const bytes = encoded?.bytes ?? 64;
    if (bytes > this.byteBudget) return null;
    if (this.bytes + bytes > this.byteBudget || this.entries >= 1024) {
      this.cache = new WeakMap();
      this.bytes = 0;
      this.entries = 0;
    }
    this.cache.set(root, encoded);
    this.bytes += bytes;
    this.entries++;
    return encoded;
  }

  /** Input metadata stays immutable through postMessage. Binary cache entries
   * are structured-cloned there. Only caller-owned mesh buffers transfer. */
  pack(
    derived: Derived,
    encoding: TopologyEncoding = 'json-v1'
  ): {
    derived: Derived;
    topologyJson?: TopologyPayload;
    topologyUndefined?: TopologyJson;
  } {
    // structuredClone reads enumerable getters once. An unsupported input
    // must reach that original path without this optimization reading them
    // first (including accessors on the root, body map or body itself).
    if (!plainDataRecord(derived)) return { derived };
    const descriptor = Object.getOwnPropertyDescriptor(
      derived,
      'bodyRepresentations'
    );
    if (
      !descriptor?.enumerable ||
      !('value' in descriptor) ||
      !plainDataRecord(descriptor.value)
    )
      return { derived };
    const bodies = descriptor.value as Derived['bodyRepresentations'];
    const entries = Object.entries(bodies);
    const binary = encoding === 'utf8-v1';
    if (binary !== this.binary) {
      this.cache = new WeakMap();
      this.entries = 0;
      this.bytes = 0;
      this.binary = binary;
    }
    if (entries.some(([, body]) => !plainDataRecord(body))) return { derived };
    const encoded: Array<[string, EncodedTopology]> = [];
    const encodedIds = new Set<string>();
    const topologyNodes = new Set<object>();
    const reused = new Set<EncodedTopology>();
    const large = binary && entries.length >= 256;
    let publicationBytes = 0;
    for (const [id, body] of entries) {
      const topology = Object.getOwnPropertyDescriptor(body, 'topology');
      // Non-enumerable and inherited fields are absent from structuredClone.
      if (!topology?.enumerable || !('value' in topology) || !topology.value)
        continue;
      const entry = this.encode(topology.value as BodyTopology);
      if (!entry || (entry.undefinedJson && encoding === 'json-v1'))
        return { derived };
      publicationBytes += entry.bytes + id.length * 6;
      if (publicationBytes > this.byteBudget) return { derived };
      if (large && this.disjoint.has(entry)) {
        if (reused.has(entry)) return { derived };
        reused.add(entry);
      } else {
        for (const node of entry.nodes) {
          if (topologyNodes.has(node)) return { derived };
          topologyNodes.add(node);
        }
      }
      encoded.push([id, entry]);
      encodedIds.add(id);
    }
    if (!encoded.length) return { derived };
    // Replacing a subtree must not sever an alias into the remaining graph.
    // This scan also rejects accessors rather than evaluating them twice.
    const remainder = {
      ...derived,
      bodyRepresentations: Object.fromEntries(
        entries.map(([id, body]) => [
          id,
          encodedIds.has(id) ? { ...body, topology: undefined } : body
        ])
      )
    };
    const queue: unknown[] = [remainder];
    const seen = new Set<object>();
    let properties = 0;
    while (queue.length) {
      const value = queue.pop();
      if (value === null || typeof value !== 'object') continue;
      if (topologyNodes.has(value)) return { derived };
      if (seen.has(value)) continue;
      seen.add(value);
      // Topology trees cannot contain either type, so neither can alias one.
      if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) continue;
      const prototype: unknown = Object.getPrototypeOf(value);
      if (
        prototype !== Object.prototype &&
        prototype !== Array.prototype &&
        prototype !== null
      )
        return { derived };
      const keys = Object.keys(value);
      properties += keys.length;
      if (properties > 100_000) return { derived };
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!('value' in descriptor)) return { derived };
        queue.push(descriptor.value as unknown);
      }
    }
    if (reused.size) {
      // The retained trees were mutually disjoint in one complete earlier reply.
      // They can only collide with the changed trees or the current metadata.
      for (const node of topologyNodes) seen.add(node);
      for (const entry of reused) {
        for (const node of entry.nodes) {
          if (seen.has(node)) return { derived };
        }
      }
    }
    if (large) this.disjoint = new WeakSet(encoded.map(([, entry]) => entry));
    const undefinedEntries = encoded.flatMap<[string, string]>(([id, entry]) =>
      entry.undefinedJson ? [[id, entry.undefinedJson]] : []
    );
    return {
      derived: remainder,
      topologyJson: Object.fromEntries(
        encoded.map(([id, entry]) => [id, entry.json])
      ),
      ...(undefinedEntries.length
        ? { topologyUndefined: Object.fromEntries(undefinedEntries) }
        : {})
    };
  }
}

function invalidEncoding(): never {
  throw new Error('Invalid topology encoding.');
}

/** Decode only a received, caller-owned reply. Parse all entries before adoption. */
export function unpackReplyTopologies(
  derived: Derived,
  text?: TopologyPayload,
  undefinedText?: TopologyJson
): void {
  if (text === undefined) {
    if (undefinedText !== undefined) invalidEncoding();
    return;
  }
  const bodies = derived.bodyRepresentations;
  let bytes = 0;
  for (const [id, json] of Object.entries(undefinedText ?? {})) {
    if (!Object.hasOwn(text, id) || typeof json !== 'string') invalidEncoding();
    bytes += (id.length * 2 + json.length) * 2;
  }
  const parsed: Array<[BodyId, BodyTopology]> = [];
  for (const [id, json] of Object.entries(text)) {
    if (
      !Object.hasOwn(bodies, id) ||
      (typeof json !== 'string' && !(json instanceof Uint8Array))
    )
      invalidEncoding();
    bytes +=
      id.length * 2 +
      (typeof json === 'string' ? json.length * 2 : json.byteLength);
    if (bytes > BYTE_BUDGET) invalidEncoding();
    const topology = JSON.parse(
      typeof json === 'string' ? json : decoder.decode(json)
    ) as BodyTopology | null;
    if (
      !topology ||
      !(['faces', 'edges'] as const).every(
        (key) => Object.hasOwn(topology, key) && Array.isArray(topology[key])
      ) ||
      bodies[id as BodyId]!.topology !== undefined
    )
      invalidEncoding();
    if (undefinedText && Object.hasOwn(undefinedText, id)) {
      const paths: unknown = JSON.parse(undefinedText[id]!);
      if (!Array.isArray(paths)) invalidEncoding();
      for (const path of paths) {
        if (!Array.isArray(path) || !path.length || path.length > 513)
          invalidEncoding();
        let parent: unknown = topology;
        for (let index = 0; index < path.length; index++) {
          const key: unknown = path[index];
          if (
            typeof key !== 'string' ||
            !parent ||
            typeof parent !== 'object' ||
            !Object.hasOwn(parent, key)
          )
            invalidEncoding();
          const record = parent as Record<string, unknown>;
          if (index === path.length - 1) {
            if (record[key] !== null) invalidEncoding();
            record[key] = undefined;
          } else parent = record[key];
        }
      }
    }
    parsed.push([id as BodyId, topology]);
  }
  for (const [id, topology] of parsed) bodies[id]!.topology = topology;
}
