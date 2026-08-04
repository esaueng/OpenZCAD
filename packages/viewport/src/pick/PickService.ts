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
 * Raycasting and topology resolution for the viewport.
 *
 * `pick` answers "what did the user click", applying the layered precedence
 * the workspace depends on. `pickAll` returns everything under the pointer in
 * depth order, which is what select-other / depth cycling consumes.
 */
export class PickService {
  readonly raycaster = new THREE.Raycaster();

  private options: PickServiceOptions;
  private pointer = new THREE.Vector2();

  constructor(options: PickServiceOptions) {
    this.options = options;
    configureEdgeRaycasting(this.raycaster);
  }

  /** Points the shared raycaster at an event's position. */
  setRayFromEvent(event: PointerEvent | MouseEvent) {
    const rect = this.options.domElement.getBoundingClientRect();
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

  private bodyIntersections(): THREE.Intersection<THREE.Object3D>[] {
    return this.raycaster
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
    const faceIndex = hit.faceIndex;
    const face =
      typeof faceIndex === 'number'
        ? data.topology?.faces.find(
            (candidate) =>
              faceIndex >= candidate.triangleStart &&
              faceIndex < candidate.triangleStart + candidate.triangleCount
          )
        : undefined;
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
      prioritizeVisibleEdgeHit(bodyIntersections())
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
