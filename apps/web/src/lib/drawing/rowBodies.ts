import type { BodyRepresentation } from '@openzcad/shared';

/**
 * F06: the bodies of a configuration row other than the active one, which
 * dimensions on a drawing view pinned to that row measure. A row's build
 * answers with every body of the model; a drawing keeps only those its views
 * draw, and bounds what it keeps for sheets not on screen.
 */
export type RowBodies = Readonly<
  Record<string, BodyRepresentation | undefined>
>;

/** The body ids a scope names, as one comparable string. */
export function rowBodiesScope(bodyIds: Iterable<string>): string {
  return [...new Set(bodyIds)].sort().join('\n');
}

/** Whether a build kept at `scope` holds every body `needed` names. */
export function rowBodiesCover(scope: string, needed: string): boolean {
  if (needed === '') return true;
  const held = new Set(scope === '' ? [] : scope.split('\n'));
  return needed.split('\n').every((bodyId) => held.has(bodyId));
}

/**
 * `bodies` with only the bodies `scope` names: the rest of the model's
 * meshes and topology are not the drawing's to keep alive.
 */
export function scopedRowBodies(bodies: RowBodies, scope: string): RowBodies {
  const scoped: Record<string, BodyRepresentation | undefined> = {};
  if (scope !== '')
    for (const bodyId of scope.split('\n'))
      if (bodies[bodyId]) scoped[bodyId] = bodies[bodyId];
  return scoped;
}

/** A record that is not a typed buffer: a face, an edge, a vertex. */
const TOPOLOGY_RECORD_BYTES = 256;

const bytesByBodies = new WeakMap<RowBodies, number>();

/**
 * About how much `bodies` holds, in bytes. Approximate: the mesh buffers
 * exactly, each edge's polyline at eight bytes a number, and a flat
 * allowance per face, edge and vertex record. Counted once per record.
 */
export function rowBodiesBytes(bodies: RowBodies): number {
  const known = bytesByBodies.get(bodies);
  if (known !== undefined) return known;
  let bytes = 0;
  for (const body of Object.values(bodies)) {
    if (!body) continue;
    bytes += body.mesh.vertices.byteLength + body.mesh.indices.byteLength;
    const topology = body.topology;
    if (!topology) continue;
    bytes +=
      (topology.faces.length +
        topology.edges.length +
        (topology.vertices?.length ?? 0)) *
      TOPOLOGY_RECORD_BYTES;
    for (const edge of topology.edges) bytes += edge.points.length * 8;
  }
  bytesByBodies.set(bodies, bytes);
  return bytes;
}

/** Something that keeps rows' bodies alive: a kept drawing, say. */
export interface RowBodiesHolder<T> {
  holder: T;
  /** The bodies it holds, each build's one object however many hold it. */
  records: readonly RowBodies[];
  /** Never evicted, and what it holds costs the others nothing. */
  active: boolean;
}

/**
 * The holders to let go, oldest first, so that what the rest keep alive
 * beyond the `active` ones' bodies fits `budgetBytes`. `holders` is oldest
 * first. A build several holders share is counted once, and is freed only
 * when the last of them goes; `free` are builds kept alive elsewhere anyway.
 */
export function rowBodiesEvictions<T>(
  holders: readonly RowBodiesHolder<T>[],
  budgetBytes: number,
  free: ReadonlySet<RowBodies> = new Set(),
  bytesOf: (bodies: RowBodies) => number = rowBodiesBytes
): T[] {
  const held = new Set<RowBodies>(free);
  for (const entry of holders)
    if (entry.active) for (const record of entry.records) held.add(record);
  const users = new Map<RowBodies, number>();
  for (const entry of holders)
    if (!entry.active)
      for (const record of new Set(entry.records))
        if (!held.has(record)) users.set(record, (users.get(record) ?? 0) + 1);
  let inactive = 0;
  for (const record of users.keys()) inactive += bytesOf(record);
  const evicted: T[] = [];
  for (const entry of holders) {
    if (inactive <= budgetBytes) break;
    if (entry.active) continue;
    const records = [...new Set(entry.records)].filter((record) =>
      users.has(record)
    );
    // Holds nothing of its own: letting it go would free nothing.
    if (records.length === 0) continue;
    for (const record of records) {
      const left = users.get(record)! - 1;
      if (left > 0) users.set(record, left);
      else {
        users.delete(record);
        inactive -= bytesOf(record);
      }
    }
    evicted.push(entry.holder);
  }
  return evicted;
}
