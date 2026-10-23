import type {
  EdgeTopologyReferenceV5,
  EdgeWitnessV1,
  QuantizedTopologyPoint
} from './index';

/** Frozen ADR-011 fingerprint, shared by document ingress and exact kernels. */
export function fingerprintOfTopologySignature(signature: string): number {
  let hash = 2166136261;
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const unsigned = hash >>> 0;
  return unsigned === 0 ? 1 : unsigned;
}

/** The existing exact-witness signature; field order and hashes stay frozen. */
export function edgeTopologyWitnessSignature(witness: EdgeWitnessV1): string {
  if (witness.closed) {
    return [
      witness.curveType,
      witness.length,
      'C',
      witness.center.join(','),
      witness.axis ? witness.axis.join(',') : 'na'
    ].join(':');
  }
  return [
    witness.curveType,
    witness.length,
    ...witness.endpoints[0],
    ...witness.endpoints[1],
    ...witness.midpoint
  ].join(':');
}

export function edgeTopologyWitnessHash(witness: EdgeWitnessV1): number {
  return fingerprintOfTopologySignature(edgeTopologyWitnessSignature(witness));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPoint(value: unknown): value is QuantizedTopologyPoint {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    Number.isSafeInteger(value[0]) &&
    Number.isSafeInteger(value[1]) &&
    Number.isSafeInteger(value[2])
  );
}

function comparePoints(
  a: QuantizedTopologyPoint,
  b: QuantizedTopologyPoint
): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Canonical, supported edge witnesses accepted by the ADR-013 exact resolver. */
export function isCanonicalEdgeWitness(value: unknown): value is EdgeWitnessV1 {
  if (
    !isRecord(value) ||
    !nonEmpty(value.curveType) ||
    !Number.isSafeInteger(value.length) ||
    (value.length as number) < 0
  ) {
    return false;
  }
  if (value.closed === false) {
    return (
      Array.isArray(value.endpoints) &&
      value.endpoints.length === 2 &&
      isPoint(value.endpoints[0]) &&
      isPoint(value.endpoints[1]) &&
      comparePoints(value.endpoints[0], value.endpoints[1]) <= 0 &&
      isPoint(value.midpoint)
    );
  }
  if (value.closed !== true || !isPoint(value.center)) return false;
  if (value.axis !== null) {
    if (!isPoint(value.axis)) return false;
    const first = value.axis.find((component) => component !== 0);
    if (first === undefined || first < 0) return false;
  }
  const curveType = value.curveType
    .toLowerCase()
    .replaceAll('_', '')
    .replaceAll('-', '');
  return !curveType.includes('bspline') && !curveType.includes('nurbs');
}

/** Shape, canonical witness and exact hash, without resolving model identity. */
export function isCanonicalEdgeTopologyReference(
  value: unknown
): value is EdgeTopologyReferenceV5 {
  return (
    isRecord(value) &&
    value.kind === 'edge' &&
    nonEmpty(value.producingFeatureId) &&
    nonEmpty(value.lineageName) &&
    Number.isSafeInteger(value.currentHash) &&
    (value.currentHash as number) > 0 &&
    value.witnessVersion === 1 &&
    isCanonicalEdgeWitness(value.witness) &&
    edgeTopologyWitnessHash(value.witness) === value.currentHash
  );
}
