import * as THREE from 'three';
import type { Line2 } from 'three/examples/jsm/lines/Line2.js';
import type { BodyRepresentation, TopologySelection } from '@openzcad/shared';
import type { PickCandidate } from '../pick/PickService';
import {
  batchedEdgeTarget,
  isSameBatchedEdge,
  type BatchedEdgeTarget
} from '../render/edgeOverlay';
import { findBodyId, forEachMesh } from '../pick/meshes';
import {
  EDGE_HOVER_COLOR,
  EDGE_HOVER_WIDTH,
  EDGE_IDLE_OPACITY,
  EDGE_IDLE_WIDTH,
  EDGE_SELECTED_COLOR,
  EDGE_SELECTED_WIDTH,
  idleEdgeColor
} from '../pick/edges';
import { VIEWPORT_RENDER_ORDER } from '../render/scene';

const HOVER_EMISSIVE = 0x101d2c;
const HOVER_FACE_COLOR = 0x8fc8ff;
const HOVER_FACE_OPACITY = 0.3;

/** Detected sketch regions: subtle at rest, stronger on hover and selection. */
export const REGION_IDLE_OPACITY = 0.22;
export const REGION_COMMAND_OPACITY = 0.28;
export const REGION_HOVER_OPACITY = 0.38;
export const REGION_SELECTED_OPACITY = 0.52;

/** Opacity a fading overlay settles on when it declares no target. */
const DEFAULT_FADE_TARGET = 0.34;
/** Below this delta a fade has visually arrived and stops being stepped. */
const FADE_EPSILON = 0.004;

/** Whether an edge is part of the committed selection, not just hovered. */
export interface EdgeVisualState {
  selected: boolean;
}

type EdgeHoverTarget = Line2 | BatchedEdgeTarget;

function isBatchedEdgeTarget(
  target: EdgeHoverTarget
): target is BatchedEdgeTarget {
  return 'batch' in target;
}

function isSameEdgeTarget(left: EdgeHoverTarget, right: EdgeHoverTarget) {
  return (
    left === right ||
    (isBatchedEdgeTarget(left) &&
      isBatchedEdgeTarget(right) &&
      isSameBatchedEdge(left, right))
  );
}

export interface SelectionManagerOptions {
  bodyGroup: THREE.Group;
  /** Body id → its scene object, for parenting the hover overlay. */
  objectsByBodyId: Map<string, THREE.Object3D>;
  /** The canvas whose cursor communicates what the pointer can do. */
  domElement: HTMLElement;
  requestRender(): void;
  /** Current derived bodies; the hover overlay is rebuilt from their meshes. */
  bodies(): BodyRepresentation[];
  /** Faces of these bodies drive document dimensions, so they read draggable. */
  isEditableBody(bodyId: string): boolean;
  /** An extrude gizmo is armed and owns the drag. */
  extrudeArmed(): boolean;
}

/**
 * Hover and preselection state for the viewport.
 *
 * All feedback here is imperative on purpose: hover changes on every pointer
 * move, and routing that through React would re-render the workspace at
 * pointer frequency. The manager owns the overlays and eases them itself.
 */
export class SelectionManager {
  /** Single reusable preselection overlay for the face under the pointer. */
  readonly hoverFaceMesh: THREE.Mesh<
    THREE.BufferGeometry,
    THREE.MeshBasicMaterial
  >;

  /** Overlay materials easing toward their resting opacity. */
  readonly fadeIns = new Set<THREE.MeshBasicMaterial>();

  hoveredBodyId: string | null = null;
  /** Legacy per-edge visual, retained while ModelViewer adopts edge batches. */
  hoveredEdge: Line2 | null = null;

  private options: SelectionManagerOptions;
  private hoveredEdgeTarget: EdgeHoverTarget | null = null;
  private hoverFaceTarget = 0;
  private hoverFaceKey: string | null = null;
  private hoveredRegionMesh: THREE.Mesh<
    THREE.BufferGeometry,
    THREE.MeshBasicMaterial
  > | null = null;

  constructor(options: SelectionManagerOptions) {
    this.options = options;
    // toneMapped:false keeps the tint saturated over brightly lit faces —
    // ACES would otherwise wash the blue out to gray on hot caps.
    this.hoverFaceMesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color: HOVER_FACE_COLOR,
        toneMapped: false,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2
      })
    );
    this.hoverFaceMesh.visible = false;
    this.hoverFaceMesh.renderOrder = VIEWPORT_RENDER_ORDER.HOVER_HIGHLIGHT;
    this.hoverFaceMesh.raycast = () => undefined;
  }

  /** True while any hover overlay is still easing toward its target. */
  get isSettling(): boolean {
    return (
      Math.abs(this.hoverFaceTarget - this.hoverFaceMesh.material.opacity) >=
        FADE_EPSILON || this.fadeIns.size > 0
    );
  }

  setEdgeHover(next: EdgeHoverTarget | null) {
    if (
      this.hoveredEdgeTarget === next ||
      (this.hoveredEdgeTarget &&
        next &&
        isSameEdgeTarget(this.hoveredEdgeTarget, next))
    ) {
      return;
    }
    const restore = this.hoveredEdgeTarget;
    if (restore) {
      if (isBatchedEdgeTarget(restore)) {
        restore.batch.setHovered(null);
      } else {
        const material = restore.material;
        const state = restore.userData as EdgeVisualState;
        material.color.setHex(
          state.selected ? EDGE_SELECTED_COLOR : idleEdgeColor(restore)
        );
        material.linewidth = state.selected
          ? EDGE_SELECTED_WIDTH
          : EDGE_IDLE_WIDTH;
        material.opacity = state.selected ? 1 : EDGE_IDLE_OPACITY;
        restore.renderOrder = state.selected
          ? VIEWPORT_RENDER_ORDER.SELECTED_GEOMETRY
          : VIEWPORT_RENDER_ORDER.BODY_EDGE;
      }
    }
    this.hoveredEdgeTarget = next;
    this.hoveredEdge = next && !isBatchedEdgeTarget(next) ? next : null;
    if (next && isBatchedEdgeTarget(next)) {
      next.batch.setHovered(next.owner);
    } else if (next && !(next.userData as EdgeVisualState).selected) {
      const material = next.material;
      material.color.setHex(EDGE_HOVER_COLOR);
      material.linewidth = EDGE_HOVER_WIDTH;
      material.opacity = 1;
      next.renderOrder = VIEWPORT_RENDER_ORDER.HOVER_HIGHLIGHT;
    }
    this.options.requestRender();
  }

  /**
   * Rebuilds the preselection film over one exact face. The overlay is a
   * single reused mesh reparented to the hovered body, so hovering across a
   * model does not allocate per face.
   */
  setHoverFace(selection: TopologySelection | null) {
    const key =
      selection?.kind === 'face' && selection.topologyId
        ? `${selection.bodyId}:${selection.topologyId}`
        : null;
    if (this.hoverFaceKey === key) {
      return;
    }
    this.hoverFaceKey = key;
    this.hoverFaceTarget = 0;
    this.options.requestRender();
    if (!key || selection?.kind !== 'face') {
      return;
    }
    const body = this.options
      .bodies()
      .find((candidate) => candidate.bodyId === selection.bodyId);
    const face = body?.topology?.faces.find(
      (candidate) => candidate.topologyId === selection.topologyId
    );
    const object = this.options.objectsByBodyId.get(selection.bodyId);
    if (!body || !face || !object) {
      return;
    }
    const oldGeometry = this.hoverFaceMesh.geometry;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(body.mesh.vertices, 3)
    );
    geometry.setIndex(
      body.mesh.indices.slice(
        face.triangleStart * 3,
        (face.triangleStart + face.triangleCount) * 3
      )
    );
    this.hoverFaceMesh.geometry = geometry;
    oldGeometry.dispose();
    object.add(this.hoverFaceMesh);
    this.hoverFaceMesh.visible = true;
    this.hoverFaceTarget = HOVER_FACE_OPACITY;
    this.options.requestRender();
  }

  setRegionHover(next: THREE.Object3D | null) {
    const mesh =
      next instanceof THREE.Mesh && next.userData.region !== undefined
        ? (next as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>)
        : null;
    if (this.hoveredRegionMesh === mesh) {
      return;
    }
    if (
      this.hoveredRegionMesh &&
      this.hoveredRegionMesh.userData.regionSelected !== true
    ) {
      this.setRegionVisual(this.hoveredRegionMesh, 'idle');
      this.fadeIns.add(this.hoveredRegionMesh.material);
    }
    this.hoveredRegionMesh = mesh;
    if (mesh && mesh.userData.regionSelected !== true) {
      this.setRegionVisual(mesh, 'hover');
      this.fadeIns.add(mesh.material);
    }
    this.options.requestRender();
  }

  /**
   * Synchronizes persistent profile state without rebuilding its triangulated
   * mesh. Selection and command-mode changes are visual-only; geometry stays
   * cached until the owning sketch regenerates.
   */
  updateRegionState(
    mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>,
    selected: boolean,
    baseOpacity: number
  ) {
    mesh.userData.regionSelected = selected;
    mesh.userData.regionBaseOpacity = baseOpacity;
    this.setRegionVisual(
      mesh,
      selected ? 'selected' : this.hoveredRegionMesh === mesh ? 'hover' : 'idle'
    );
    const target =
      (mesh.material.userData.targetOpacity as number | undefined) ??
      baseOpacity;
    mesh.material.opacity = target;
    this.fadeIns.delete(mesh.material);
    this.options.requestRender();
  }

  private setRegionVisual(
    mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>,
    state: 'idle' | 'hover' | 'selected'
  ) {
    const baseOpacity =
      (mesh.userData.regionBaseOpacity as number | undefined) ?? 0;
    mesh.material.userData.targetOpacity =
      state === 'selected'
        ? REGION_SELECTED_OPACITY
        : state === 'hover'
          ? REGION_HOVER_OPACITY
          : baseOpacity;
    const boundaries =
      (mesh.userData.regionBoundaries as Line2[] | undefined) ?? [];
    for (const boundary of boundaries) {
      boundary.visible = state !== 'idle';
      boundary.renderOrder =
        state === 'selected'
          ? VIEWPORT_RENDER_ORDER.SELECTED_GEOMETRY
          : VIEWPORT_RENDER_ORDER.HOVER_HIGHLIGHT;
      boundary.material.color.setHex(
        state === 'selected'
          ? 0xffc45c
          : state === 'hover'
            ? 0xaed5ff
            : 0x79b8ff
      );
      boundary.material.linewidth =
        state === 'selected' ? 3 : state === 'hover' ? 2.5 : 1.6;
      boundary.material.opacity =
        state === 'selected' ? 1 : state === 'hover' ? 0.95 : 0.72;
    }
    const marker = mesh.userData.regionMarker as THREE.Points | undefined;
    if (marker) {
      marker.visible = state === 'selected';
    }
  }

  /**
   * Applies every preselection effect for what is under the pointer: the
   * region fill, the topology edge, the face film, the cursor, and — only for
   * whole-body picks, which are imported meshes without face topology — a
   * body-wide emissive lift.
   */
  applyHover(candidate: PickCandidate | null) {
    this.setRegionHover(candidate?.region ? candidate.hit.object : null);
    const bodyId = candidate?.selection?.bodyId ?? null;
    const canDragFace =
      candidate?.selection?.kind === 'face' &&
      this.options.isEditableBody(candidate.selection.bodyId);
    const hoveredEdge =
      candidate?.selection?.kind === 'edge'
        ? (batchedEdgeTarget(candidate.hit.object, candidate.hit.faceIndex) ??
          (candidate.hit.object.userData as { visual?: Line2 }).visual ??
          null)
        : null;
    this.setEdgeHover(hoveredEdge);
    this.setHoverFace(candidate?.selection ?? null);
    this.options.domElement.style.cursor = this.options.extrudeArmed()
      ? 'grab'
      : canDragFace
        ? 'grab'
        : bodyId || candidate?.sketchId || candidate?.region
          ? 'pointer'
          : '';
    const emissiveBodyId =
      candidate?.selection?.kind === 'body' ? bodyId : null;
    if (this.hoveredBodyId === emissiveBodyId) {
      return;
    }
    this.hoveredBodyId = emissiveBodyId;
    forEachMesh(this.options.bodyGroup, (mesh) => {
      const meshBodyId = findBodyId(mesh);
      const base =
        (mesh.userData as { baseEmissive?: number }).baseEmissive ?? 0x000000;
      mesh.material.emissive.setHex(
        emissiveBodyId && meshBodyId === emissiveBodyId && base === 0
          ? HOVER_EMISSIVE
          : base
      );
    });
  }

  /**
   * Eases every overlay one frame toward its target. `dt` is already clamped
   * by the caller's render clock.
   */
  step(dt: number) {
    const ease = 1 - Math.exp(-dt * 16);
    const hoverMaterial = this.hoverFaceMesh.material;
    const hoverNext =
      hoverMaterial.opacity +
      (this.hoverFaceTarget - hoverMaterial.opacity) * ease;
    hoverMaterial.opacity = hoverNext;
    if (
      this.hoverFaceTarget === 0 &&
      hoverNext < FADE_EPSILON &&
      this.hoverFaceMesh.visible
    ) {
      this.hoverFaceMesh.visible = false;
    }
    for (const material of this.fadeIns) {
      const target =
        (material.userData.targetOpacity as number | undefined) ??
        DEFAULT_FADE_TARGET;
      const next = material.opacity + (target - material.opacity) * ease;
      material.opacity = next;
      if (Math.abs(target - next) < FADE_EPSILON) {
        material.opacity = target;
        this.fadeIns.delete(material);
      }
    }
  }

  /**
   * Drops hover state pointing at scene objects that are about to be
   * disposed. The overlay mesh itself survives so it can be reparented to the
   * rebuilt bodies. The region hover is left alone: regions live in their own
   * group with its own rebuild.
   */
  resetForRebuild() {
    if (this.hoveredEdgeTarget && isBatchedEdgeTarget(this.hoveredEdgeTarget)) {
      this.hoveredEdgeTarget.batch.setHovered(null);
    }
    this.hoveredBodyId = null;
    this.hoveredEdgeTarget = null;
    this.hoveredEdge = null;
    this.hoverFaceKey = null;
    this.hoverFaceTarget = 0;
    this.hoverFaceMesh.visible = false;
    this.fadeIns.clear();
  }

  dispose() {
    this.hoverFaceMesh.geometry.dispose();
    this.hoverFaceMesh.material.dispose();
    this.fadeIns.clear();
  }
}
