/**
 * Reducing an imported payload to something a cache key can carry.
 *
 * Shared rather than duplicated because two independent caches key on the same
 * documents — the geometry worker's rebuild cache and the kernel adapter's
 * per-feature history digest — and a digest that drifted between them would
 * silently stop matching, which is the failure both caches exist to avoid.
 */
/**
 * A 64-bit content digest over numbers, carried as two 32-bit accumulators.
 *
 * Hashing the IEEE-754 bits rather than a decimal rendering keeps it exactly
 * as content-sensitive as embedding the values: any change to any component,
 * including `0` against `-0`, changes the digest. The scratch buffer is reused
 * so a 900,000-float mesh allocates nothing while being walked.
 */
const digestScratch = new ArrayBuffer(8);
const digestFloat = new Float64Array(digestScratch);
const digestWords = new Uint32Array(digestScratch);

function digestNumbers(values: readonly number[]): string {
  let low = 0x811c9dc5;
  let high = 0x01000193;
  for (let index = 0; index < values.length; index += 1) {
    digestFloat[0] = values[index]!;
    const first = digestWords[0]!;
    const second = digestWords[1]!;
    low = Math.imul(low ^ first, 0x01000193) >>> 0;
    low = Math.imul(low ^ second, 0x01000193) >>> 0;
    high = Math.imul(high ^ second, 0x85ebca6b) >>> 0;
    high = Math.imul(high ^ first, 0x85ebca6b) >>> 0;
  }
  return `${values.length}:${low.toString(36)}${high.toString(36)}`;
}

function digestText(value: string): string {
  let low = 0x811c9dc5;
  let high = 0x01000193;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    low = Math.imul(low ^ code, 0x01000193) >>> 0;
    high = Math.imul(high ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${value.length}:${low.toString(36)}${high.toString(36)}`;
}

/**
 * Replaces an imported payload with a digest of itself.
 *
 * The key is built BEFORE the cache can be consulted, so every sync paid for
 * serialising whatever the document happened to carry inline. An imported mesh
 * holds `vertices` and `indices` as plain arrays: measured at 100,000
 * triangles the key was 7.5 million characters and 107 ms, and at the 200,000
 * import cap 15.1 million and 227 ms — spent in full on undo and redo, which
 * are guaranteed hits and the scenario this cache exists for. A digest is the
 * same input reduced to a constant-size token, so the key stays exactly as
 * sensitive to content while costing a walk instead of a 15 MB string.
 */
export function keyableImportedNodeData(data: Record<string, unknown>): unknown {
  const featureKind = data.featureKind;
  if (
    featureKind === 'imported-mesh' &&
    Array.isArray(data.vertices) &&
    Array.isArray(data.indices)
  ) {
    return {
      ...data,
      vertices: digestNumbers(data.vertices as number[]),
      indices: digestNumbers(data.indices as number[])
    };
  }
  if (featureKind === 'imported-step' && typeof data.stepText === 'string') {
    return { ...data, stepText: digestText(data.stepText) };
  }
  return data;
}

export function keyableImportedNodes(nodes: unknown): unknown {
  if (nodes === null || typeof nodes !== 'object' || Array.isArray(nodes)) {
    return nodes;
  }
  let replaced: Record<string, unknown> | null = null;
  for (const [id, node] of Object.entries(nodes as Record<string, unknown>)) {
    if (node === null || typeof node !== 'object') {
      continue;
    }
    const data = (node as { data?: unknown }).data;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      continue;
    }
    const keyable = keyableImportedNodeData(data as Record<string, unknown>);
    if (keyable === data) {
      continue;
    }
    replaced ??= { ...(nodes as Record<string, unknown>) };
    replaced[id] = { ...(node as Record<string, unknown>), data: keyable };
  }
  return replaced ?? nodes;
}

