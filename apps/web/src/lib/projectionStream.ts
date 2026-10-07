import type {
  BodyId,
  BodyRepresentation,
  GeometryBodyRepresentation,
  GeometryReadyState,
  DerivedState,
  MeshGeometry,
  BodyTopology
} from '@openzcad/shared';

type State = DerivedState | GeometryReadyState;
type Body = BodyRepresentation | GeometryBodyRepresentation;
type Metadata = Omit<Body, 'mesh' | 'topology'>;
type Revision = NonNullable<Body['projectionRevision']>;

/** An owned change packet; omitted buffers reuse the acknowledged base. */
export interface ProjectionPacket {
  session: string;
  projectId: string;
  publication: number;
  base: number | null;
  state: Omit<State, 'bodyRepresentations'>;
  changes: Record<
    BodyId,
    {
      metadata: Metadata;
      revision: Revision;
      mesh?: MeshGeometry;
      replaceTopology: boolean;
      topology?: BodyTopology;
    }
  >;
  removed: BodyId[];
  /** Worker timings, separate from canonical model data. */
  metrics?: Record<string, number>;
}

/** Exact comparison performed in the worker, including every typed value. */
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    a === null ||
    b === null ||
    typeof a !== 'object' ||
    typeof b !== 'object'
  )
    return false;
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (
      !(a instanceof Float32Array || a instanceof Uint32Array) ||
      !(b instanceof Float32Array || b instanceof Uint32Array) ||
      a.constructor !== b.constructor ||
      a.length !== b.length
    )
      return false;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => equal(x, b[i]))
    );
  }
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.hasOwn(right, key) && equal(left[key], right[key])
    )
  );
}

function metadata(body: Body): Metadata {
  const {
    mesh: _mesh,
    topology: _topology,
    projectionRevision: _revision,
    ...rest
  } = body;
  return rest;
}

function facePartitions(body: Body): number[] | undefined {
  return body.topology?.faces.flatMap((face) => [
    face.triangleStart,
    face.triangleCount
  ]);
}

/** Retains one immutable projection; outgoing buffers never alias it. */
export class ProjectionSender {
  private projectId: string | null = null;
  private publication = 0;
  private serial = 0;
  private bodies: Record<string, Body> = {};
  private unretained = false;

  constructor(private readonly session: string = crypto.randomUUID()) {}

  encode(projectId: string, state: State, full = false): ProjectionPacket {
    const reset = full || this.unretained || projectId !== this.projectId;
    const previous = reset ? {} : this.bodies;
    const changes: ProjectionPacket['changes'] = {};
    const next: Record<string, Body> = {};
    for (const [id, body] of Object.entries(state.bodyRepresentations)) {
      const before = previous[id];
      const sameMesh = before !== undefined && equal(before.mesh, body.mesh);
      const sameGeometry =
        sameMesh && equal(facePartitions(before), facePartitions(body));
      const sameTopology =
        before !== undefined && equal(before.topology, body.topology);
      const sameMetadata =
        before !== undefined && equal(metadata(before), metadata(body));
      if (sameGeometry && sameTopology && sameMetadata) {
        next[id] = before;
        continue;
      }
      const revision: Revision = {
        session: this.session,
        geometry: sameGeometry
          ? before.projectionRevision!.geometry
          : ++this.serial,
        topology: sameTopology
          ? before.projectionRevision!.topology
          : ++this.serial,
        metadata: sameMetadata
          ? before.projectionRevision!.metadata
          : ++this.serial
      };
      next[id] = { ...body, projectionRevision: revision };
      // Only the packet owns transferable storage. The retained source stays live.
      changes[id as BodyId] = structuredClone({
        metadata: metadata(body),
        revision,
        ...(!sameMesh ? { mesh: body.mesh } : {}),
        replaceTopology: !sameTopology,
        ...(!sameTopology && body.topology ? { topology: body.topology } : {})
      });
    }
    const { bodyRepresentations: _bodies, ...rest } = state;
    const packet: ProjectionPacket = {
      session: this.session,
      projectId,
      base: reset ? null : this.publication,
      publication: ++this.publication,
      state: rest,
      changes,
      removed: Object.keys(previous).filter((id) => !(id in next)) as BodyId[]
    };
    this.projectId = projectId;
    // Large projections use full publications instead of retaining another
    // unbounded mesh copy. The receiver still replaces the frame atomically.
    this.unretained =
      Object.values(next).reduce(
        (sum, body) =>
          sum + body.mesh.vertices.byteLength + body.mesh.indices.byteLength,
        0
      ) >
      32 * 1024 * 1024;
    this.bodies = this.unretained ? {} : next;
    return packet;
  }
}

/** Rejects a missing base atomically, allowing the host to request a full frame. */
export class ProjectionReceiver {
  private session: string | null = null;
  private projectId: string | null = null;
  private publication = 0;
  private bodies: Record<BodyId, Body> = {};

  apply(packet: ProjectionPacket): State | null {
    if (
      packet.base !== null &&
      (packet.session !== this.session ||
        packet.projectId !== this.projectId ||
        packet.base !== this.publication)
    )
      return null;
    const bodies =
      packet.base === null ? ({} as Record<BodyId, Body>) : { ...this.bodies };
    for (const id of packet.removed) delete bodies[id];
    for (const [id, change] of Object.entries(packet.changes)) {
      const before = bodies[id as BodyId];
      const mesh = change.mesh ?? before?.mesh;
      if (!mesh) return null;
      bodies[id as BodyId] = {
        ...change.metadata,
        mesh,
        projectionRevision: change.revision,
        ...((change.replaceTopology ? change.topology : before?.topology)
          ? {
              topology: change.replaceTopology
                ? change.topology
                : before?.topology
            }
          : {})
      };
    }
    const pending = 'analysis' in packet.state;
    if (
      !pending &&
      Object.values(bodies).some(
        (body) => !('volume' in body) || !Number.isFinite(body.volume)
      )
    )
      return null;
    this.session = packet.session;
    this.projectId = packet.projectId;
    this.publication = packet.publication;
    this.bodies = bodies;
    // Each body is reconstructed from full metadata and checked above before a
    // completed result can enter canonical state. Geometry-only packets omit it.
    return { ...packet.state, bodyRepresentations: bodies } as State;
  }
}

export function projectionTransferables(
  packet: ProjectionPacket
): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const change of Object.values(packet.changes)) {
    if (change.mesh) {
      for (const array of [change.mesh.vertices, change.mesh.indices]) {
        if (array.buffer instanceof ArrayBuffer) buffers.add(array.buffer);
      }
    }
  }
  return [...buffers];
}
