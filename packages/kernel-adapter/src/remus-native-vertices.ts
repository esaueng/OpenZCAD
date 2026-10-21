/** GRID-only native construction evidence; none of these handles are persisted. */
import type {
  EdgeTopologyReferenceV5,
  EdgeWitnessV1,
  FeatureId,
  QuantizedTopologyPoint,
  RuntimeVertexReference,
  RuntimeVertexUnavailableReason,
  Vector3
} from '@openzcad/shared';
import type { RemusKernel } from './remus-runtime';
import type { RemusLineageState } from './remus-lineage';
import { edgeWitnessOf, quantizedPoint } from './exact-witnesses';
import { edgeEndPoint } from './topology-fingerprint';
import {
  topologyHashOfWitness,
  topologyWitnessesEqual
} from './topology-lineage';

export interface RemusNativeVertexState {
  readonly bySolid: ReadonlyMap<
    number,
    ReadonlyMap<number, RuntimeVertexReference>
  >;
  readonly withheldBySolid: ReadonlyMap<
    number,
    ReadonlyMap<number, RuntimeVertexUnavailableReason>
  >;
}

export type NativeVertexPointEvidence =
  | {
      readonly status: 'qualified';
      readonly point: Vector3;
      readonly reference: RuntimeVertexReference;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: RuntimeVertexUnavailableReason;
    };

interface NativePoint {
  readonly point: Vector3;
  readonly key: QuantizedTopologyPoint;
}
interface NativeEdge {
  readonly handle: number;
  readonly ends: readonly [number, number];
  readonly witness: EdgeWitnessV1;
  readonly supported: boolean;
}
interface NativeSolid {
  readonly vertices: Map<number, NativePoint>;
  readonly edges: Map<number, NativeEdge>;
  readonly ambiguous: Set<number>;
}

function samePoint(
  a: QuantizedTopologyPoint,
  b: QuantizedTopologyPoint
): boolean {
  return a.every((value, index) => value === b[index]);
}

export function nativeVertexPoint(
  kernel: RemusKernel,
  handle: number
): NativePoint | null {
  try {
    const values = Array.from(kernel.getVertexPosition(handle));
    if (values.length !== 3 || values.some((value) => !Number.isFinite(value)))
      return null;
    const point = { x: values[0]!, y: values[1]!, z: values[2]! };
    const key = quantizedPoint(point);
    return key.every(Number.isSafeInteger) ? { point, key } : null;
  } catch {
    return null;
  }
}

function nativeSolid(kernel: RemusKernel, solid: number): NativeSolid | null {
  try {
    const handles = Array.from(kernel.getSolidVertices(solid));
    if (new Set(handles).size !== handles.length) return null;
    const vertices = new Map<number, NativePoint>();
    const atPoint = new Map<string, number[]>();
    for (const handle of handles) {
      if (!Number.isSafeInteger(handle) || handle < 0) return null;
      const point = nativeVertexPoint(kernel, handle);
      if (!point) return null;
      vertices.set(handle, point);
      const key = point.key.join(',');
      atPoint.set(key, [...(atPoint.get(key) ?? []), handle]);
    }
    const ambiguous = new Set(
      [...atPoint.values()].filter((group) => group.length !== 1).flat()
    );
    const edges = new Map<number, NativeEdge>();
    for (const handle of kernel.getSolidEdges(solid)) {
      if (edges.has(handle)) return null;
      const ends = Array.from(kernel.getEdgeVertexHandles(handle));
      if (ends.length !== 2 || ends.some((end) => !vertices.has(end)))
        return null;
      const a = vertices.get(ends[0]!)!;
      const b = vertices.get(ends[1]!)!;
      const endpoints = Array.from(kernel.getEdgeVertices(handle));
      const witness = edgeWitnessOf(kernel, handle);
      const supported =
        endpoints.length === 6 &&
        endpoints.every(Number.isFinite) &&
        samePoint(
          a.key,
          quantizedPoint({
            x: endpoints[0]!,
            y: endpoints[1]!,
            z: endpoints[2]!
          })
        ) &&
        samePoint(
          b.key,
          quantizedPoint({
            x: endpoints[3]!,
            y: endpoints[4]!,
            z: endpoints[5]!
          })
        ) &&
        !witness.closed &&
        ends[0] !== ends[1] &&
        !samePoint(a.key, b.key);
      const first =
        edgeEndPoint([a.point, b.point], 0) === a.point ? ends[0]! : ends[1]!;
      edges.set(handle, {
        handle,
        ends: first === ends[0] ? [first, ends[1]!] : [first, ends[0]!],
        witness,
        supported
      });
    }
    return { vertices, edges, ambiguous };
  } catch {
    return null;
  }
}

function currentEdge(
  reference: EdgeTopologyReferenceV5 | undefined,
  edge: NativeEdge
): reference is EdgeTopologyReferenceV5 {
  try {
    return (
      reference !== undefined &&
      reference.kind === 'edge' &&
      typeof reference.lineageName === 'string' &&
      reference.lineageName.length > 0 &&
      typeof reference.producingFeatureId === 'string' &&
      reference.producingFeatureId.length > 0 &&
      reference.currentHash === topologyHashOfWitness('edge', edge.witness) &&
      topologyWitnessesEqual('edge', reference.witness, edge.witness)
    );
  } catch {
    return false;
  }
}

interface SourceAnchor {
  readonly name: string;
  readonly end: 0 | 1;
}
export interface NativeGridInstance {
  readonly solid: number;
  readonly instance: string;
  readonly matrix: ArrayLike<number>;
  readonly journalVertices?: ReadonlySet<number>;
  readonly unavailableReason?: RuntimeVertexUnavailableReason;
}

/**
 * Public journal outputs prove the complete construction subject set, not
 * Generated.sources. ALL supported incident edge roles must independently
 * select the same native vertex under the authored cell translation.
 */
export function qualifyGridNativeVertices(input: {
  readonly kernel: RemusKernel;
  readonly producingFeatureId: FeatureId;
  readonly sourceSolid: number;
  readonly sourceLineage: RemusLineageState | undefined;
  readonly resultLineage: RemusLineageState;
  readonly instances: readonly NativeGridInstance[];
}): RemusNativeVertexState {
  const { kernel, sourceLineage, resultLineage } = input;
  const bySolid = new Map<number, Map<number, RuntimeVertexReference>>();
  const withheldBySolid = new Map<
    number,
    Map<number, RuntimeVertexUnavailableReason>
  >();
  const source = nativeSolid(kernel, input.sourceSolid);
  const anchors = new Map<number, SourceAnchor[]>();
  const blocked = new Set(source?.ambiguous);
  const sourceNames = new Map<string, NativeEdge[]>();
  for (const edge of source?.edges.values() ?? []) {
    const reference = sourceLineage?.edgeReferences.get(edge.handle);
    if (!edge.supported || (reference && !currentEdge(reference, edge))) {
      edge.ends.forEach((handle) => blocked.add(handle));
      continue;
    }
    if (!currentEdge(reference, edge)) continue;
    sourceNames.set(reference.lineageName, [
      ...(sourceNames.get(reference.lineageName) ?? []),
      edge
    ]);
    edge.ends.forEach((handle, end) =>
      anchors.set(handle, [
        ...(anchors.get(handle) ?? []),
        { name: reference.lineageName, end: end === 0 ? 0 : 1 }
      ])
    );
  }
  for (const edges of sourceNames.values())
    if (edges.length !== 1)
      edges.forEach((edge) =>
        edge.ends.forEach((handle) => blocked.add(handle))
      );
  for (const instance of input.instances) {
    const refs = new Map<number, RuntimeVertexReference>();
    const withheld = new Map<number, RuntimeVertexUnavailableReason>();
    bySolid.set(instance.solid, refs);
    withheldBySolid.set(instance.solid, withheld);
    const result = nativeSolid(kernel, instance.solid);
    if (!result) continue;
    const refuseAll = (reason: RuntimeVertexUnavailableReason) =>
      result.vertices.forEach((_point, handle) => withheld.set(handle, reason));
    if (!source || !sourceLineage) {
      refuseAll('unsupported-source');
      continue;
    }
    if (
      !instance.journalVertices ||
      instance.journalVertices.size !== result.vertices.size ||
      [...result.vertices.keys()].some(
        (handle) => !instance.journalVertices!.has(handle)
      )
    ) {
      refuseAll(instance.unavailableReason ?? 'journal-unavailable');
      continue;
    }
    const m = Array.from(instance.matrix);
    if (
      m.length !== 16 ||
      m.some((value) => !Number.isFinite(value)) ||
      m[0] !== 1 ||
      m[5] !== 1 ||
      m[10] !== 1 ||
      m[15] !== 1 ||
      [1, 2, 4, 6, 8, 9, 12, 13, 14].some((index) => m[index] !== 0)
    ) {
      refuseAll('unsupported-source');
      continue;
    }
    const resultsByName = new Map<string, NativeEdge[]>();
    for (const edge of result.edges.values()) {
      const reference = resultLineage.edgeReferences.get(edge.handle);
      if (
        !edge.supported ||
        !currentEdge(reference, edge) ||
        reference.producingFeatureId !== input.producingFeatureId
      )
        continue;
      resultsByName.set(reference.lineageName, [
        ...(resultsByName.get(reference.lineageName) ?? []),
        edge
      ]);
    }
    const claimants = new Map<number, RuntimeVertexReference[]>();
    for (const [sourceHandle, point] of source.vertices) {
      const roles = anchors.get(sourceHandle);
      if (blocked.has(sourceHandle) || !roles?.length) continue;
      const expected = quantizedPoint({
        x: point.point.x + m[3]!,
        y: point.point.y + m[7]!,
        z: point.point.z + m[11]!
      });
      if (!expected.every(Number.isSafeInteger)) continue;
      const claims: number[] = [];
      let valid = true;
      for (const role of roles) {
        const edges = resultsByName.get(
          `pattern.edge.instance.${instance.instance}.${role.name}`
        );
        if (edges?.length !== 1) {
          valid = false;
          break;
        }
        const matches = edges[0]!.ends.filter((handle) =>
          samePoint(result.vertices.get(handle)!.key, expected)
        );
        if (matches.length !== 1) {
          valid = false;
          break;
        }
        claims.push(matches[0]!);
      }
      if (!valid || new Set(claims).size !== 1) continue;
      const handle = claims[0]!;
      if (result.ambiguous.has(handle)) continue;
      const anchorName = JSON.stringify(
        roles
          .map((role) => [role.name, role.end])
          .sort((a, b) => {
            const left = JSON.stringify(a);
            const right = JSON.stringify(b);
            return left < right ? -1 : left > right ? 1 : 0;
          })
      );
      const reference: RuntimeVertexReference = {
        kind: 'vertex',
        producingFeatureId: input.producingFeatureId,
        lineageName: `pattern.vertex.instance.${instance.instance}.${anchorName}`,
        witnessVersion: 1,
        witness: { position: result.vertices.get(handle)!.key }
      };
      claimants.set(handle, [...(claimants.get(handle) ?? []), reference]);
    }
    for (const handle of result.vertices.keys()) {
      const claims = claimants.get(handle);
      if (claims?.length === 1) refs.set(handle, claims[0]!);
      else
        withheld.set(
          handle,
          result.ambiguous.has(handle)
            ? 'ambiguous-anchor'
            : 'conflicting-anchors'
        );
    }
  }
  return { bySolid, withheldBySolid };
}

/** Re-read native geometry before a runtime reference can authorize a datum. */
export function nativeVertexEvidence(
  kernel: RemusKernel,
  state: RemusNativeVertexState | undefined,
  solid: number,
  handle: number,
  members: ReadonlySet<number>
): NativeVertexPointEvidence | undefined {
  const references = state?.bySolid.get(solid);
  const reference = references?.get(handle);
  if (!reference)
    return references?.size && !state?.withheldBySolid.get(solid)?.has(handle)
      ? { status: 'unavailable', reason: 'stale-evidence' }
      : undefined;
  try {
    const actual = nativeVertexPoint(kernel, handle);
    const position = reference.witness?.position;
    if (
      !members.has(handle) ||
      !actual ||
      reference.kind !== 'vertex' ||
      reference.witnessVersion !== 1 ||
      typeof reference.producingFeatureId !== 'string' ||
      !reference.producingFeatureId ||
      typeof reference.lineageName !== 'string' ||
      !reference.lineageName ||
      !Array.isArray(position) ||
      position.length !== 3 ||
      !position.every(Number.isSafeInteger) ||
      !samePoint(actual.key, position)
    )
      return { status: 'unavailable', reason: 'stale-evidence' };
    return { status: 'qualified', point: actual.point, reference };
  } catch {
    return { status: 'unavailable', reason: 'stale-evidence' };
  }
}
