import * as THREE from 'three';
import type { BodyTopology, TopologySelection } from '@openzcad/shared';
import type { RegionPickData, SelectionFilter } from '../types';
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
}

interface TopologyUserData {
  bodyId?: string;
  topologyKind?: 'edge';
  topologyId?: string;
  topologyHash?: number;
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

  private regionCandidate(
    bodyIntersections: () => THREE.Intersection<THREE.Object3D>[]
  ): PickCandidate | null {
    if (this.filter !== 'any' && this.filter !== 'sketch') {
      return null;
    }
    const regionHit = this.raycaster
      .intersectObjects(this.options.regionGroup.children, true)
      .find((hit) => hit.object.userData.region !== undefined);
    if (!regionHit) {
      return null;
    }
    // With nothing filtered out, a region only wins while it is genuinely the
    // frontmost thing under the cursor — a solid standing on the sketch plane
    // occludes it. Under a sketch filter the solids are not competing for the
    // click at all, so letting one block the region would leave a sketch
    // behind a solid unreachable, which is the case the filter exists for.
    if (this.filter === 'any') {
      const bodyBlock = bodyIntersections()[0];
      if (bodyBlock && regionHit.distance > bodyBlock.distance + 1e-6) {
        return null;
      }
    }
    return {
      kind: 'region',
      distance: regionHit.distance,
      hit: regionHit,
      selection: null,
      region: regionHit.object.userData.region as RegionPickData
    };
  }

  private bodyIntersections(): THREE.Intersection<THREE.Object3D>[] {
    return this.raycaster
      .intersectObjects(this.options.bodyGroup.children, true)
      .filter((hit) => hit.object.visible);
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
    if (data.topologyKind === 'edge' && data.topologyId) {
      return {
        kind: 'edge',
        distance: hit.distance,
        hit,
        selection: {
          bodyId: bodyId as TopologySelection['bodyId'],
          kind: 'edge',
          topologyId: data.topologyId,
          hash: data.topologyHash
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
          hash: face.hash
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
      this.regionCandidate(bodyIntersections) ??
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
    const region = this.regionCandidate(bodyIntersections);
    const sketch = this.sketchCandidate();
    const ordered = [
      ...(region ? [region] : []),
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
