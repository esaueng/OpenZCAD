import {
  isCanonicalEdgeTopologyReference,
  walkQuantities,
  type ProjectDocument,
  type SketchRegionProfileReference,
  type TopologyReferenceV5
} from '@openzcad/shared';
import {
  unitsConversionNodeScope,
  unitsConversionSubject
} from './units-convert';

/**
 * I03 stored-unit conversion, phase 4 (plan
 * `docs/plans/i03-stored-unit-conversion-plan.md` §3.2, §5.1): the pure half
 * of reference re-capture.
 *
 * Every persisted topology identity is a quantized witness or a hash of one,
 * on a frozen 1e-6 document-unit quantum, so a unit conversion cannot scale
 * it arithmetically. The kernel adapter's `computeConversionReferenceMap`
 * re-captures each one from a rebuild of the converted document and returns
 * a map from the place each identity is stored to its new value. This module
 * names those places ({@link listConversionReferenceSites}) and applies the
 * map ({@link applyReferenceMap}) without a kernel, so replaying a recorded
 * conversion (phase 5) stays pure, as ADR-021 does for stored extrude
 * inference.
 *
 * A place is a JSON pointer from the document root (RFC 6901), such as
 * `/nodes/feat_1/data/edgeReferences/0` or
 * `/nodes/feat_1/data/edgeHashes/0`. What is stored there:
 *
 * - `topology`: a schema-v5 face or edge reference. Its witness and
 *   `currentHash` are re-captured together, so the whole object is the unit.
 * - `hash`: any other number the quantity registry classes as `hash`: a
 *   legacy `faceHash`, `edgeHashes` entry, `oppositeFaceHash`, an emboss
 *   face hash or a sketch profile's `regionFingerprint`.
 * - `profile-id`: a sketch profile reference's `profileId`, a string hash of
 *   the same quantized boundary as its fingerprint.
 * - `edge-end`: a value that names one of an edge reference's two witness
 *   ends: a datum vertex's `end`, a variable fillet's `vertexRadii[…].end`
 *   or its `edgeRuns[…]` flag. The witness orders its ends by quantized
 *   coordinates, so a conversion can swap them; re-capture then remaps the
 *   value from the ends it actually matched (or refuses).
 *
 * Drawings and PMI hold references too; phase 2 refuses documents that have
 * them, so they have no sites here.
 */

/**
 * A new value for one site: a reference object, a hash, a profile id, or
 * (for an `edge-end` site) an end index or edge-run flag.
 */
export type ConversionReferenceValue =
  TopologyReferenceV5 | number | string | boolean;

/** Old place → new value, for every reference site of a converted document. */
export type ConversionReferenceMap = Readonly<
  Record<string, ConversionReferenceValue>
>;

interface SiteBase {
  /** JSON pointer from the document root. */
  pointer: string;
  /** The id of the node that stores it. */
  nodeId: string;
  /** The node, as refusals name it: `Name (id)`. */
  subject: string;
  /** The field below the node's registry scope, dot-joined. */
  field: string;
}

/**
 * How an edge reference's consumer reads its witness end order
 * (`witness.endpoints`, sorted by quantized coordinates):
 *
 * - `irrelevant`: not at all (a plain fillet or chamfer edge);
 * - `indexed`: only through `edge-end` sites that point at it, which a
 *   re-capture remaps when the ends swap;
 * - `significant`: some other way (an axis that runs from end 0 to end 1, a
 *   fraction measured from end 0, a projected curve's direction), so a
 *   re-capture refuses unless the ends keep their order.
 *
 * A consumer not listed in {@link edgeEndpointOrder} is `significant`.
 */
export type EdgeEndpointOrder = 'irrelevant' | 'indexed' | 'significant';

export type ConversionReferenceSite =
  | (SiteBase & {
      kind: 'topology';
      reference: TopologyReferenceV5;
      /** For an edge reference: how its consumer reads its end order. */
      endpointOrder?: EdgeEndpointOrder;
    })
  | (SiteBase & {
      kind: 'edge-end';
      /** An end index, or an `edgeRuns` flag (true: kernel runs end 0 → 1). */
      value: 0 | 1 | boolean;
      /**
       * The pointer of the edge `topology` site whose ends it names, or
       * undefined when the document names no such reference (refused).
       */
      edgePointer: string | undefined;
    })
  | (SiteBase & {
      kind: 'hash';
      hash: number;
      /** The profile reference holding this hash, for a `regionFingerprint`. */
      profile?: SketchRegionProfileReference;
    })
  | (SiteBase & {
      kind: 'profile-id';
      profileId: string;
      profile: SketchRegionProfileReference;
    });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A stored schema-v5 face or edge reference (shape only). */
export function isStoredTopologyReference(
  value: unknown
): value is TopologyReferenceV5 {
  return (
    isRecord(value) &&
    (value.kind === 'face' || value.kind === 'edge') &&
    typeof value.producingFeatureId === 'string' &&
    typeof value.lineageName === 'string' &&
    typeof value.currentHash === 'number' &&
    value.witnessVersion === 1 &&
    isRecord(value.witness)
  );
}

function isRegionProfileReference(
  value: unknown
): value is SketchRegionProfileReference {
  return (
    isRecord(value) &&
    value.all !== true &&
    typeof value.regionFingerprint === 'number' &&
    isRecord(value.samplePoint)
  );
}

function escapeSegment(segment: string | number): string {
  return String(segment).replaceAll('~', '~0').replaceAll('/', '~1');
}

function pointerOf(segments: readonly (string | number)[]): string {
  return segments.map((segment) => `/${escapeSegment(segment)}`).join('');
}

function parsePointer(pointer: string): string[] | undefined {
  if (!pointer.startsWith('/')) return undefined;
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function valueAt(root: unknown, path: readonly (string | number)[]): unknown {
  let value = root;
  for (const segment of path) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = (value as Record<string | number, unknown>)[segment];
  }
  return value;
}

interface FilletEndData {
  featureKind?: unknown;
  edgeHashes?: unknown;
  edgeReferences?: unknown;
  vertexRadii?: unknown;
  edgeRuns?: unknown;
  radiusStations?: unknown;
}

/** The `edgeReferences` index a fillet's edge `edge` resolves through. */
function filletReferenceIndex(
  data: FilletEndData,
  edge: number
): number | undefined {
  const hashes: readonly unknown[] = Array.isArray(data.edgeHashes)
    ? data.edgeHashes
    : [];
  const references: readonly unknown[] = Array.isArray(data.edgeReferences)
    ? data.edgeReferences
    : [];
  const hash = hashes[edge];
  // As `perEdgeVertexRadii` reads it: the reference whose hash is the edge's.
  const index = references.findIndex(
    (reference) =>
      isStoredTopologyReference(reference) && reference.currentHash === hash
  );
  return index >= 0 ? index : undefined;
}

/**
 * How the consumer of the edge reference at `path` (below the node's scope
 * `scope`) reads its witness end order; see {@link EdgeEndpointOrder}.
 */
function edgeEndpointOrder(
  scope: object,
  path: readonly (string | number)[]
): EdgeEndpointOrder {
  const holder = valueAt(scope, path.slice(0, -1));
  if (
    path.at(-1) === 'edgeReference' &&
    isRecord(holder) &&
    holder.type === 'edge-vertex'
  )
    return 'indexed';
  const data = scope as FilletEndData;
  if (
    path.length === 2 &&
    path[0] === 'edgeReferences' &&
    (data.featureKind === 'fillet' || data.featureKind === 'chamfer')
  ) {
    if (data.featureKind === 'chamfer') return 'irrelevant';
    // One station fraction, measured from end 0, is shared by every edge.
    if (Array.isArray(data.radiusStations) && data.radiusStations.length > 0)
      return 'significant';
    return data.edgeRuns !== undefined || data.vertexRadii !== undefined
      ? 'indexed'
      : 'irrelevant';
  }
  return 'significant';
}

/**
 * Every place a converted (or source) document stores a topology identity,
 * in a stable order (node id, then registry path). Driven by the quantity
 * registry's `hash` class, so a hash field added to the registry is a site
 * without a change here.
 */
export function listConversionReferenceSites(
  document: ProjectDocument
): ConversionReferenceSite[] {
  const sites: ConversionReferenceSite[] = [];
  const seen = new Set<string>();
  for (const id of Object.keys(document.nodes).sort()) {
    const node = document.nodes[id]!;
    const scope = unitsConversionNodeScope(node);
    if (!scope) continue;
    const base: (string | number)[] =
      scope.value === node ? ['nodes', id] : ['nodes', id, 'data'];
    const subject = unitsConversionSubject(node);
    walkQuantities(scope.value, scope.map, (leaf) => {
      if (leaf.quantity !== 'hash' || typeof leaf.value !== 'number') return;
      // The shortest enclosing v5 reference owns its witness and hash.
      for (let length = 0; length < leaf.path.length; length += 1) {
        const prefix = leaf.path.slice(0, length);
        const owner = length === 0 ? scope.value : valueAt(scope.value, prefix);
        if (!isStoredTopologyReference(owner)) continue;
        const pointer = pointerOf([...base, ...prefix]);
        if (!seen.has(pointer)) {
          seen.add(pointer);
          sites.push({
            kind: 'topology',
            pointer,
            nodeId: id,
            subject,
            field: prefix.join('.'),
            reference: owner,
            ...(owner.kind === 'edge'
              ? { endpointOrder: edgeEndpointOrder(scope.value, prefix) }
              : {})
          });
          const holder = valueAt(scope.value, prefix.slice(0, -1));
          if (
            owner.kind === 'edge' &&
            prefix.at(-1) === 'edgeReference' &&
            isRecord(holder) &&
            holder.type === 'edge-vertex' &&
            (holder.end === 0 || holder.end === 1)
          ) {
            const endPath = [...prefix.slice(0, -1), 'end'];
            sites.push({
              kind: 'edge-end',
              pointer: pointerOf([...base, ...endPath]),
              nodeId: id,
              subject,
              field: endPath.join('.'),
              value: holder.end,
              edgePointer: pointer
            });
          }
        }
        return;
      }
      const pointer = pointerOf([...base, ...leaf.path]);
      if (seen.has(pointer)) return;
      seen.add(pointer);
      const profile =
        leaf.key === 'regionFingerprint' &&
        isRegionProfileReference(leaf.holder)
          ? leaf.holder
          : undefined;
      sites.push({
        kind: 'hash',
        pointer,
        nodeId: id,
        subject,
        field: leaf.path.join('.'),
        hash: leaf.value,
        ...(profile ? { profile } : {})
      });
      if (profile && typeof profile.profileId === 'string') {
        const idPath = [...leaf.path.slice(0, -1), 'profileId'];
        sites.push({
          kind: 'profile-id',
          pointer: pointerOf([...base, ...idPath]),
          nodeId: id,
          subject,
          field: idPath.join('.'),
          profileId: profile.profileId,
          profile
        });
      }
    });
    // A variable fillet's per-end radii and edge runs name witness ends.
    const data = scope.value as FilletEndData;
    if (node.kind === 'feature' && data.featureKind === 'fillet') {
      const edgePointer = (edge: unknown) => {
        const index =
          typeof edge === 'number'
            ? filletReferenceIndex(data, edge)
            : undefined;
        return index === undefined
          ? undefined
          : pointerOf([...base, 'edgeReferences', index]);
      };
      if (Array.isArray(data.vertexRadii))
        data.vertexRadii.forEach((entry: unknown, index) => {
          if (!isRecord(entry) || (entry.end !== 0 && entry.end !== 1)) return;
          sites.push({
            kind: 'edge-end',
            pointer: pointerOf([...base, 'vertexRadii', index, 'end']),
            nodeId: id,
            subject,
            field: `vertexRadii.${index}.end`,
            value: entry.end,
            edgePointer: edgePointer(entry.edge)
          });
        });
      if (Array.isArray(data.edgeRuns))
        data.edgeRuns.forEach((run: unknown, index) => {
          if (typeof run !== 'boolean') return;
          sites.push({
            kind: 'edge-end',
            pointer: pointerOf([...base, 'edgeRuns', index]),
            nodeId: id,
            subject,
            field: `edgeRuns.${index}`,
            value: run,
            edgePointer: edgePointer(index)
          });
        });
    }
  }
  return sites;
}

export type ApplyReferenceMapRefusalCode =
  'unknown-site' | 'missing-site' | 'wrong-type' | 'invalid-reference';

export interface ApplyReferenceMapRefusal {
  code: ApplyReferenceMapRefusalCode;
  pointer: string;
  subject?: string;
  field?: string;
  message: string;
}

export type ApplyReferenceMapResult =
  | { ok: true; document: ProjectDocument }
  | { ok: false; refusals: ApplyReferenceMapRefusal[] };

function validReplacement(
  site: ConversionReferenceSite,
  value: ConversionReferenceValue
): string | undefined {
  switch (site.kind) {
    case 'topology': {
      if (!isStoredTopologyReference(value))
        return 'expects a schema-v5 topology reference';
      if (value.kind !== site.reference.kind)
        return `expects a ${site.reference.kind} reference, not a ${value.kind}`;
      if (!Number.isSafeInteger(value.currentHash) || value.currentHash <= 0)
        return 'carries an invalid hash';
      if (value.kind === 'edge' && !isCanonicalEdgeTopologyReference(value))
        return 'carries an edge witness that does not hash to its currentHash';
      return undefined;
    }
    case 'hash':
      return typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value > 0
        ? undefined
        : 'expects a positive integer hash';
    case 'profile-id':
      return typeof value === 'string' && value.length > 0
        ? undefined
        : 'expects a profile id';
    case 'edge-end':
      return typeof site.value === 'boolean'
        ? typeof value === 'boolean'
          ? undefined
          : 'expects an edge-run flag'
        : value === 0 || value === 1
          ? undefined
          : 'expects an end index (0 or 1)';
  }
}

/**
 * Writes a re-captured reference map into a converted document. Pure: the
 * input is not mutated. It refuses, without applying anything, when the map
 * misses a site the document has (a stale witness would survive), names a
 * place that is not a site, or holds the wrong kind of value for one.
 */
export function applyReferenceMap(
  document: ProjectDocument,
  references: ConversionReferenceMap
): ApplyReferenceMapResult {
  const sites = new Map(
    listConversionReferenceSites(document).map((site) => [site.pointer, site])
  );
  const refusals: ApplyReferenceMapRefusal[] = [];
  for (const pointer of Object.keys(references).sort())
    if (!sites.has(pointer))
      refusals.push({
        code: 'unknown-site',
        pointer,
        message: `${pointer} is not a stored topology reference of this document.`
      });
  for (const site of sites.values()) {
    if (!Object.hasOwn(references, site.pointer)) {
      refusals.push({
        code: 'missing-site',
        pointer: site.pointer,
        subject: site.subject,
        field: site.field,
        message: `${site.subject}: ${site.field} has no re-captured value.`
      });
      continue;
    }
    const problem = validReplacement(site, references[site.pointer]!);
    if (problem)
      refusals.push({
        code:
          site.kind === 'topology' &&
          isStoredTopologyReference(references[site.pointer])
            ? 'invalid-reference'
            : 'wrong-type',
        pointer: site.pointer,
        subject: site.subject,
        field: site.field,
        message: `${site.subject}: ${site.field} ${problem}.`
      });
  }
  if (refusals.length > 0) return { ok: false, refusals };

  const { derived, editHistory, ...content } = document;
  const next = {
    ...(structuredClone(content) as Omit<
      ProjectDocument,
      'derived' | 'editHistory'
    >),
    derived,
    ...(editHistory ? { editHistory } : {})
  } as ProjectDocument;
  for (const [pointer, value] of Object.entries(references)) {
    const path = parsePointer(pointer)!;
    const holder = valueAt(next, path.slice(0, -1)) as Record<string, unknown>;
    holder[path.at(-1)!] =
      typeof value === 'object' ? structuredClone(value) : value;
  }
  return { ok: true, document: next };
}
