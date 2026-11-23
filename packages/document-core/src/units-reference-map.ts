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
 *
 * Drawings and PMI hold references too; phase 2 refuses documents that have
 * them, so they have no sites here.
 */

/** A new value for one site: a reference object, a hash or a profile id. */
export type ConversionReferenceValue = TopologyReferenceV5 | number | string;

/** Old place → new value, for every reference site of a converted document. */
export type ConversionReferenceMap = Readonly<
  Record<string, ConversionReferenceValue>
>;

interface SiteBase {
  /** JSON pointer from the document root. */
  pointer: string;
  /** The node, as refusals name it: `Name (id)`. */
  subject: string;
  /** The field below the node's registry scope, dot-joined. */
  field: string;
}

export type ConversionReferenceSite =
  | (SiteBase & { kind: 'topology'; reference: TopologyReferenceV5 })
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
            subject,
            field: prefix.join('.'),
            reference: owner
          });
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
          subject,
          field: idPath.join('.'),
          profileId: profile.profileId,
          profile
        });
      }
    });
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
