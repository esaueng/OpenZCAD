import * as THREE from 'three';
import type {
  BodyTopology,
  EdgeTopologyReferenceV5,
  TopologySelection
} from '@openzcad/shared';
import type { RegionPickData, SelectionFilter } from '../types';
import { batchedEdgeTarget } from '../render/edgeOverlay';
import { configureEdgeRaycasting, prioritizeVisibleEdgeHit } from './edges';
import { findBodyId } from './meshes';

/**
 * What the pointer is over.
 *
 * `region` and `sketch` candidates carry no `selection` because they are not
 * document topology — the app turns them into their own intents.
 */
export interface PickCandidate {
  kind: 'region' | 'sketch' | 'edge' | 'face' | 'body';
  distance: number;
  hit: THREE.Intersection<THREE.Object3D>;
  selection: TopologySelection | null;
  sketchId?: string;
  region?: RegionPickData;
  /** World-space outward normal at the hit, for face candidates. */
  faceNormal?: THREE.Vector3;
}

export interface ProfilePickTarget {
  pick: RegionPickData;
  object: THREE.Object3D;
  basis: {
    origin: { x: number; y: number; z: number };
    u: { x: number; y: number; z: number };
    v: { x: number; y: number; z: number };
    normal: { x: number; y: number; z: number };
  };
  outer: { x: number; y: number }[];
  holes: { x: number; y: number }[][];
}

/**
 * Stable identity for a pick: the same entity picked twice keys the same,
 * a different one does not. Deduplication and depth cycling both need to
 * answer "is this the same thing I already have", so they share one answer.
 */
export function candidateKey(candidate: PickCandidate): string {
  return JSON.stringify([
    candidate.kind,
    candidate.selection?.bodyId ?? '',
    candidate.selection?.topologyId ?? '',
    candidate.sketchId ?? '',
    candidate.region?.profileId ?? '',
    candidate.region?.regionFingerprint ?? ''
  ]);
}

export interface PickServiceOptions {
  domElement: HTMLElement;
  /** Read per call: the active camera changes with the projection. */
  camera(): THREE.Camera;
  /** Detected sketch regions (orange hover fills). */
  regionGroup: THREE.Object3D;
  /** Sketch profile outlines. */
  sketchGroup: THREE.Object3D;
  /** Solid bodies and their exact topology overlays. */
  bodyGroup: THREE.Object3D;
  /** Read per call, like the camera: the filter changes with the tool. */
  filter?(): SelectionFilter;
  /** Cached plane-local profiles used for command-aware 2D picking. */
  profiles?(): readonly ProfilePickTarget[];
  selectionContext?(): 'default' | 'sketch-edit' | 'profile-command';
}

interface TopologyUserData {
  bodyId?: string;
  topologyKind?: 'edge';
  topologyId?: string;
  topologyHash?: number;
  topologyReference?: EdgeTopologyReferenceV5;
  topology?: BodyTopology;
}

/**
 * How far in front of an edge point, relative to its camera distance, another
 * surface may sit and still count as that same boundary rather than an
 * occluder. Tessellated curved faces meet their exact edges only to chord
 * precision, so this is looser than the coplanar allowance in `edges.ts`; a
 * genuine occluder — the lip over a blind hole's floor — is far outside it.
 */
const BOUNDARY_OCCLUSION_RELATIVE_EPSILON = 1e-3;

/**
 * Raycasting and topology resolution for the viewport.
 *
 * `pick` answers "what did the user click", applying the layered precedence
 * the workspace depends on. `pickAll` returns everything under the pointer in
 * depth order, which is what select-other / depth cycling consumes.
 */
export class PickService {
  readonly raycaster = new THREE.Raycaster();
  /** Separate so an occlusion probe never re-aims the ray callers read. */
  private readonly occlusionRaycaster = new THREE.Raycaster();

  private options: PickServiceOptions;
  private pointer = new THREE.Vector2();

  /** Event the cached rect was measured for; see `setRayFromEvent`. */
  private rectEvent: PointerEvent | MouseEvent | null = null;
  private rect: DOMRect | null = null;

  constructor(options: PickServiceOptions) {
    this.options = options;
    configureEdgeRaycasting(this.raycaster);
  }

  /**
   * Points the shared raycaster at an event's position.
   *
   * The canvas rect is cached because reading it forces the browser to settle
   * layout, and a single hover frame aims the ray several times — once for
   * the gizmo, once for the pick, again for a measure preview. The cache is
   * per event: within one event the canvas cannot have moved, and across
   * events it can (a panel drag, a scroll, a window resize), so nothing has
   * to remember to invalidate it.
   */
  setRayFromEvent(event: PointerEvent | MouseEvent) {
    if (event !== this.rectEvent) {
      this.rectEvent = event;
      this.rect = this.options.domElement.getBoundingClientRect();
    }
    const rect = this.rect ?? this.options.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.options.camera());
  }

  /** Ray-tests an arbitrary object list with the already-aimed ray. */
  intersect(
    objects: THREE.Object3D[],
    recursive = true
  ): THREE.Intersection<THREE.Object3D>[] {
    return this.raycaster.intersectObjects(objects, recursive);
  }

  private get filter(): SelectionFilter {
    return this.options.filter?.() ?? 'any';
  }

  /**
   * Narrows the solid candidates to the kind the filter asks for.
   *
   * `body` resolves rather than rejects: clicking a face while filtering to
   * bodies selects the body that face belongs to, which is what the filter is
   * for. The other kinds reject, so anything of the wrong kind is passed
   * through to whatever sits behind it.
   */
  private applyFilter(candidates: PickCandidate[]): PickCandidate[] {
    const filter = this.filter;
    if (filter === 'any') {
      return candidates;
    }
    if (filter === 'sketch') {
      return [];
    }
    if (filter === 'body') {
      return candidates.map((candidate) =>
        candidate.kind === 'body'
          ? candidate
          : {
              kind: 'body' as const,
              distance: candidate.distance,
              hit: candidate.hit,
              selection: candidate.selection
                ? { bodyId: candidate.selection.bodyId, kind: 'body' as const }
                : null
            }
      );
    }
    return candidates.filter((candidate) => candidate.kind === filter);
  }

  private pointInLoop(
    point: { x: number; y: number },
    loop: { x: number; y: number }[]
  ): boolean {
    let inside = false;
    for (
      let current = 0, prior = loop.length - 1;
      current < loop.length;
      prior = current, current += 1
    ) {
      const a = loop[current]!;
      const b = loop[prior]!;
      if (
        a.y > point.y !== b.y > point.y &&
        point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
      ) {
        inside = !inside;
      }
    }
    return inside;
  }

  /**
   * Profile interiors are picked in sketch-local 2D, not by mesh ray order.
   * This makes a profile deterministic when it lies exactly on a body face.
   */
  private projectedRegionCandidates(): PickCandidate[] {
    const targets = this.options.profiles?.() ?? [];
    const candidates: PickCandidate[] = [];
    for (const target of targets) {
      if (!target.object.visible) {
        continue;
      }
      const normal = new THREE.Vector3(
        target.basis.normal.x,
        target.basis.normal.y,
        target.basis.normal.z
      );
      const origin = new THREE.Vector3(
        target.basis.origin.x,
        target.basis.origin.y,
        target.basis.origin.z
      );
      const denominator = normal.dot(this.raycaster.ray.direction);
      if (Math.abs(denominator) <= Number.EPSILON * 64) {
        continue;
      }
      const distance =
        normal.dot(origin.clone().sub(this.raycaster.ray.origin)) / denominator;
      if (distance < 0) {
        continue;
      }
      const point = this.raycaster.ray.at(distance, new THREE.Vector3());
      const localOffset = point.clone().sub(origin);
      const local = {
        x: localOffset.dot(
          new THREE.Vector3(
            target.basis.u.x,
            target.basis.u.y,
            target.basis.u.z
          )
        ),
        y: localOffset.dot(
          new THREE.Vector3(
            target.basis.v.x,
            target.basis.v.y,
            target.basis.v.z
          )
        )
      };
      const bounds = target.pick.boundingBox;
      if (
        local.x < bounds.min.x ||
        local.x > bounds.max.x ||
        local.y < bounds.min.y ||
        local.y > bounds.max.y ||
        !this.pointInLoop(local, target.outer) ||
        target.holes.some((hole) => this.pointInLoop(local, hole))
      ) {
        continue;
      }
      candidates.push({
        kind: 'region',
        distance,
        hit: {
          distance,
          point,
          object: target.object
        },
        selection: null,
        region: target.pick
      });
    }
    return candidates.sort((left, right) => left.distance - right.distance);
  }

  /**
   * Compatibility path for callers that only provide rendered region meshes.
   *
   * A populated profile cache always uses the projected 2D path above. This
   * fallback exists for older integrations and tests; it must never become the
   * deciding mechanism for an active profile-selection command.
   */
  private renderedRegionCandidates(): PickCandidate[] {
    return this.raycaster
      .intersectObjects(this.options.regionGroup.children, true)
      .filter(
        (
          hit
        ): hit is THREE.Intersection<
          THREE.Object3D & { userData: { region: RegionPickData } }
        > => hit.object.visible && Boolean(hit.object.userData.region)
      )
      .map((hit) => ({
        kind: 'region' as const,
        distance: hit.distance,
        hit,
        selection: null,
        region: hit.object.userData.region
      }));
  }

  private regionCandidates(
    bodyIntersections: () => THREE.Intersection<THREE.Object3D>[]
  ): PickCandidate[] {
    if (this.filter !== 'any' && this.filter !== 'sketch') {
      return [];
    }
    const targets = this.options.profiles?.() ?? [];
    const projected =
      targets.length > 0
        ? this.projectedRegionCandidates()
        : this.renderedRegionCandidates();
    if (projected.length === 0) {
      return [];
    }
    // With nothing filtered out, a region only wins while it is genuinely the
    // frontmost thing under the cursor — a solid standing on the sketch plane
    // occludes it. Under a sketch filter the solids are not competing for the
    // click at all, so letting one block the region would leave a sketch
    // behind a solid unreachable, which is the case the filter exists for.
    if (
      this.filter === 'any' &&
      (this.options.selectionContext?.() ?? 'default') === 'default'
    ) {
      const bodyBlock = bodyIntersections()[0];
      if (bodyBlock) {
        const epsilon = Math.max(1, bodyBlock.distance) * 1e-7;
        return projected.filter(
          (candidate) => candidate.distance <= bodyBlock.distance + epsilon
        );
      }
    }
    return projected;
  }

  private bodyIntersections(
    raycaster: THREE.Raycaster = this.raycaster
  ): THREE.Intersection<THREE.Object3D>[] {
    return raycaster
      .intersectObjects(this.options.bodyGroup.children, true)
      .filter((hit) => {
        let object: THREE.Object3D | null = hit.object;
        while (object) {
          if (!object.visible) {
            return false;
          }
          if (object === this.options.bodyGroup) {
            break;
          }
          object = object.parent;
        }
        return true;
      });
  }

  private sketchCandidate(): PickCandidate | null {
    if (this.filter !== 'any' && this.filter !== 'sketch') {
      return null;
    }
    const sketchHit = this.raycaster
      .intersectObjects(this.options.sketchGroup.children, true)
      .find((hit) => typeof hit.object.userData.sketchId === 'string');
    return sketchHit
      ? {
          kind: 'sketch',
          distance: sketchHit.distance,
          hit: sketchHit,
          selection: null,
          sketchId: sketchHit.object.userData.sketchId as string
        }
      : null;
  }

  /** The exact face owning a body-mesh triangle hit, if the body has one. */
  private faceAt(hit: THREE.Intersection<THREE.Object3D>) {
    const faceIndex = hit.faceIndex;
    const data = hit.object.userData as TopologyUserData;
    return typeof faceIndex === 'number'
      ? data.topology?.faces.find(
          (candidate) =>
            faceIndex >= candidate.triangleStart &&
            faceIndex < candidate.triangleStart + candidate.triangleCount
        )
      : undefined;
  }

  /**
   * The faces an edge hit bounds, as the kernel published them. Null for
   * anything that is not an edge, and for adapters that predate the field.
   */
  private edgeBoundary(
    hit: THREE.Intersection<THREE.Object3D>
  ): { bodyId: string; adjacentFaceHashes: readonly number[] } | null {
    const batchTarget = batchedEdgeTarget(hit.object, hit.faceIndex);
    if (batchTarget) {
      const hashes = batchTarget.owner.adjacentFaceHashes;
      return hashes
        ? { bodyId: batchTarget.owner.bodyId, adjacentFaceHashes: hashes }
        : null;
    }
    const data = hit.object.userData as TopologyUserData;
    if (data.topologyKind !== 'edge' || !data.topologyId) {
      return null;
    }
    const bodyId = data.bodyId ?? findBodyId(hit.object);
    const hashes = data.topology?.edges.find(
      (edge) => edge.topologyId === data.topologyId
    )?.adjacentFaceHashes;
    return bodyId && hashes ? { bodyId, adjacentFaceHashes: hashes } : null;
  }

  /**
   * Whether nothing solid stands between the camera and a point on an edge.
   * One extra ray, cast only when a boundary edge is about to be promoted.
   */
  private edgePointVisible(point: THREE.Vector3): boolean {
    const camera = this.options.camera();
    const ndc = point.clone().project(camera);
    this.occlusionRaycaster.setFromCamera(
      new THREE.Vector2(ndc.x, ndc.y),
      camera
    );
    const reach = this.occlusionRaycaster.ray.origin.distanceTo(point);
    const blocker = this.bodyIntersections(this.occlusionRaycaster).find(
      (hit) => hit.face
    );
    return (
      !blocker ||
      blocker.distance >= reach * (1 - BOUNDARY_OCCLUSION_RELATIVE_EPSILON)
    );
  }

  /**
   * Promotes an edge in the pick band that bounds the face under the pointer.
   *
   * `prioritizeVisibleEdgeHit` settles edge-versus-face by depth, which only
   * works for outside corners: there the edge is the nearest thing along a
   * ray a few pixels off it. At an inside corner — a wall meeting the
   * underside of a lip, a boss meeting its plate — both faces rise toward
   * the camera away from the crease, so the face always wins and the edge
   * answered only to a pointer exactly on its line. Adjacency is the depth-
   * free question: if the edge bounds the face being hovered and nothing
   * hides it, the pointer is on that boundary for picking purposes, the same
   * band an outside corner already gets.
   *
   * When several boundary edges qualify (near a vertex), the one drawn
   * nearest the pointer wins.
   */
  private promoteBoundaryEdge(
    hits: THREE.Intersection<THREE.Object3D>[]
  ): THREE.Intersection<THREE.Object3D>[] {
    const nearest = hits[0];
    // Only a surface hit can hand the click to its boundary; an edge already
    // in front was placed there by the depth rule.
    if (!nearest?.face) {
      return hits;
    }
    const face = this.faceAt(nearest);
    const bodyId =
      (nearest.object.userData as TopologyUserData).bodyId ??
      findBodyId(nearest.object);
    if (!face || !bodyId) {
      return hits;
    }
    const camera = this.options.camera();
    const pointer = nearest.point.clone().project(camera);
    const boundary = hits
      .map((hit) => {
        const edge = this.edgeBoundary(hit);
        const onLine = (hit as { pointOnLine?: THREE.Vector3 }).pointOnLine;
        if (
          !edge ||
          !onLine ||
          edge.bodyId !== bodyId ||
          !edge.adjacentFaceHashes.includes(face.hash)
        ) {
          return null;
        }
        const drawn = onLine.clone().project(camera);
        return {
          hit,
          onLine,
          offset: Math.hypot(drawn.x - pointer.x, drawn.y - pointer.y)
        };
      })
      .filter((entry) => entry !== null)
      .sort((left, right) => left.offset - right.offset)
      .find((entry) => this.edgePointVisible(entry.onLine));
    return boundary
      ? [boundary.hit, ...hits.filter((hit) => hit !== boundary.hit)]
      : hits;
  }

  /** Resolves one body-group intersection into edge, face, or whole body. */
  private topologyCandidate(
    hit: THREE.Intersection<THREE.Object3D>
  ): PickCandidate | null {
    const data = hit.object.userData as TopologyUserData;
    const bodyId = data.bodyId ?? findBodyId(hit.object);
    if (!bodyId) {
      return null;
    }
    const batchTarget = batchedEdgeTarget(hit.object, hit.faceIndex);
    if (batchTarget) {
      return {
        kind: 'edge',
        distance: hit.distance,
        hit,
        selection: {
          bodyId: batchTarget.owner.bodyId,
          kind: 'edge',
          topologyId: batchTarget.owner.topologyId,
          hash: batchTarget.owner.hash,
          ...(batchTarget.owner.reference
            ? { reference: batchTarget.owner.reference }
            : {})
        }
      };
    }
    if (data.topologyKind === 'edge' && data.topologyId) {
      return {
        kind: 'edge',
        distance: hit.distance,
        hit,
        selection: {
          bodyId: bodyId as TopologySelection['bodyId'],
          kind: 'edge',
          topologyId: data.topologyId,
          hash: data.topologyHash,
          ...(data.topologyReference
            ? { reference: data.topologyReference }
            : {})
        }
      };
    }
    const face = this.faceAt(hit);
    if (face) {
      return {
        kind: 'face',
        distance: hit.distance,
        hit,
        selection: {
          bodyId: bodyId as TopologySelection['bodyId'],
          kind: 'face',
          topologyId: face.topologyId,
          hash: face.hash,
          ...(face.reference ? { reference: face.reference } : {})
        },
        faceNormal: hit.face?.normal
          .clone()
          .transformDirection(hit.object.matrixWorld)
      };
    }
    return {
      kind: 'body',
      distance: hit.distance,
      hit,
      selection: { bodyId: bodyId as TopologySelection['bodyId'], kind: 'body' }
    };
  }

  /**
   * Every body-group candidate under the pointer, nearest first.
   *
   * Edges are promoted ahead of a face they are effectively coplanar with, so
   * a boundary stays selectable from the surface it bounds; an edge genuinely
   * behind the face keeps its depth order.
   */
  private topologyCandidates(
    bodyIntersections: () => THREE.Intersection<THREE.Object3D>[]
  ): PickCandidate[] {
    return this.applyFilter(
      this.promoteBoundaryEdge(prioritizeVisibleEdgeHit(bodyIntersections()))
        .map((hit) => this.topologyCandidate(hit))
        .filter((candidate): candidate is PickCandidate => candidate !== null)
    );
  }

  /**
   * The single thing a click selects.
   *
   * Precedence is layered rather than purely nearest-first: a detected region
   * outranks the sketch curves that bound it, and both outrank solids, because
   * those layers are drawn on top of the model and are what the user is aiming
   * at when they are visible.
   */
  pick(event: PointerEvent | MouseEvent): PickCandidate | null {
    this.setRayFromEvent(event);
    let bodyHits: THREE.Intersection<THREE.Object3D>[] | undefined;
    const bodyIntersections = () => (bodyHits ??= this.bodyIntersections());
    return (
      this.regionCandidates(bodyIntersections)[0] ??
      this.sketchCandidate() ??
      this.topologyCandidates(bodyIntersections)[0] ??
      null
    );
  }

  /**
   * Everything under the pointer, in the order depth cycling should step
   * through it. The first entry always matches `pick`.
   *
   * Entities appear once each. A single ray routinely returns several hits on
   * the same face — a triangle pair shares an edge, and a ray down that edge
   * intersects both — and stepping through the same face twice would read as
   * a stuck control.
   */
  pickAll(event: PointerEvent | MouseEvent): PickCandidate[] {
    this.setRayFromEvent(event);
    let bodyHits: THREE.Intersection<THREE.Object3D>[] | undefined;
    const bodyIntersections = () => (bodyHits ??= this.bodyIntersections());
    const regions = this.regionCandidates(bodyIntersections);
    const sketch = this.sketchCandidate();
    const ordered = [
      ...regions,
      ...(sketch ? [sketch] : []),
      ...this.topologyCandidates(bodyIntersections)
    ];
    const seen = new Set<string>();
    return ordered.filter((candidate) => {
      const key = candidateKey(candidate);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }
}
