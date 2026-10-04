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
import { edgeRunFrom } from '../pick/edgeChain';
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
import { SELECTION_SEMANTICS } from '../render/semantics';
import { createFaceHighlightGeometry } from './faceHighlightGeometry';
import { easeToward, fadeStepMs, SETTLE_EPSILON } from '../motion';

const HOVER_EMISSIVE = SELECTION_SEMANTICS.hover.faceEmissive;
const HOVER_FACE_COLOR = SELECTION_SEMANTICS.hover.face;
const HOVER_FACE_OPACITY = SELECTION_SEMANTICS.hover.faceOpacity;
const HOVER_FACE_HIDDEN_OPACITY = SELECTION_SEMANTICS.hover.hiddenFaceOpacity;

/** Detected sketch regions: subtle at rest, stronger on hover and selection. */
export const REGION_IDLE_OPACITY = SELECTION_SEMANTICS.region.idleOpacity;
export const REGION_COMMAND_OPACITY = SELECTION_SEMANTICS.region.commandOpacity;
export const REGION_HOVER_OPACITY = SELECTION_SEMANTICS.region.hoverOpacity;
export const REGION_SELECTED_OPACITY =
  SELECTION_SEMANTICS.region.selectedOpacity;

/** Opacity a fading overlay settles on when it declares no target. */
const DEFAULT_FADE_TARGET = SELECTION_SEMANTICS.defaultFadeTarget;

type HoverFaceMesh = THREE.Mesh<
  THREE.BufferGeometry,
  THREE.MeshLambertMaterial
>;
type HoverHiddenFaceMesh = THREE.Mesh<
  THREE.BufferGeometry,
  THREE.MeshBasicMaterial
>;

/**
 * One face film and its occluded x-ray pass. The film is a state change, so it
 * cuts on and off in the frame its hover changes; only the x-ray pass eases,
 * so a face hovered or left behind the solid does not flicker through it.
 */
class HoverFaceMeshSlot {
  readonly faceMesh: HoverFaceMesh;
  readonly hiddenFaceMesh: HoverHiddenFaceMesh;
  key: string | null = null;
  private faceTarget = 0;
  private hiddenFaceTarget = 0;

  constructor(index: number) {
    // toneMapped:false keeps the tint saturated over brightly lit faces —
    // ACES would otherwise wash the blue out to gray on hot caps.
    this.faceMesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshLambertMaterial({
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
    this.faceMesh.name = `body-face-hover-${index}`;
    this.faceMesh.visible = false;
    this.faceMesh.renderOrder = VIEWPORT_RENDER_ORDER.HOVER_HIGHLIGHT;
    this.faceMesh.userData.selectionOverlay = true;
    this.faceMesh.userData.hoverFaceSlot = index;
    this.faceMesh.userData.hoverFaceLayer = 'visible';
    this.faceMesh.raycast = () => undefined;

    this.hiddenFaceMesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color: HOVER_FACE_COLOR,
        toneMapped: false,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
        depthFunc: THREE.GreaterDepth
      })
    );
    this.hiddenFaceMesh.name = `body-face-hover-hidden-${index}`;
    this.hiddenFaceMesh.visible = false;
    this.hiddenFaceMesh.renderOrder = VIEWPORT_RENDER_ORDER.HOVER_HIGHLIGHT - 1;
    this.hiddenFaceMesh.userData.selectionOverlay = true;
    this.hiddenFaceMesh.userData.hoverFaceSlot = index;
    this.hiddenFaceMesh.userData.hoverFaceLayer = 'hidden';
    this.hiddenFaceMesh.raycast = () => undefined;
  }

  /**
   * Only the x-ray pass moves over time, so only it keeps the render loop
   * alive — including a retired slot, which stays occupied until that pass
   * has faded out and the slot detaches.
   */
  get isSettling(): boolean {
    if (this.key === null) {
      return false;
    }
    return (
      (this.faceTarget === 0 && this.hiddenFaceTarget === 0) ||
      Math.abs(this.hiddenFaceTarget - this.hiddenFaceMesh.material.opacity) >=
        SETTLE_EPSILON
    );
  }

  /**
   * The target the x-ray pass was last stepped toward. A target that differs
   * is new — installed, retired, or an x-ray change — so that step is the
   * fade's first and takes the wake step (see fadeStepMs).
   */
  private steppedHiddenFaceTarget = Number.NaN;

  install(
    parent: THREE.Object3D,
    key: string,
    geometry: THREE.BufferGeometry,
    hiddenGeometry: THREE.BufferGeometry,
    xrayEnabled: boolean
  ) {
    this.release(false);
    this.key = key;
    this.faceMesh.geometry = geometry;
    this.hiddenFaceMesh.geometry = hiddenGeometry;
    // The film cuts in at its resting opacity; the x-ray pass rises to its.
    this.faceMesh.material.opacity = HOVER_FACE_OPACITY;
    this.hiddenFaceMesh.material.opacity = 0;
    this.faceMesh.visible = true;
    this.hiddenFaceMesh.visible = xrayEnabled;
    this.faceTarget = HOVER_FACE_OPACITY;
    this.hiddenFaceTarget = xrayEnabled ? HOVER_FACE_HIDDEN_OPACITY : 0;
    this.steppedHiddenFaceTarget = Number.NaN;
    this.faceMesh.userData.hoverFaceKey = key;
    this.hiddenFaceMesh.userData.hoverFaceKey = key;
    parent.add(this.faceMesh);
    parent.add(this.hiddenFaceMesh);
  }

  /**
   * Cuts the film off now. The slot itself stays occupied only while its
   * x-ray pass still has a fade-out to play; with nothing left to ease it is
   * released on the spot, so a cut never costs the render loop a frame.
   */
  retire() {
    this.faceTarget = 0;
    this.hiddenFaceTarget = 0;
    this.faceMesh.material.opacity = 0;
    this.faceMesh.visible = false;
    this.faceMesh.removeFromParent();
    if (this.hiddenFaceMesh.material.opacity < SETTLE_EPSILON) {
      this.reset();
    }
  }

  setXrayEnabled(enabled: boolean, active: boolean) {
    this.hiddenFaceTarget = enabled && active ? HOVER_FACE_HIDDEN_OPACITY : 0;
    // A retired slot is still occupied while its pass fades out, though its
    // film has already cut off — so occupancy, not the film, decides.
    this.hiddenFaceMesh.visible =
      enabled &&
      this.key !== null &&
      (active || this.hiddenFaceMesh.material.opacity >= SETTLE_EPSILON);
  }

  step(frameMs: number) {
    if (this.key === null) {
      return;
    }
    const hiddenFirstStep =
      this.hiddenFaceTarget !== this.steppedHiddenFaceTarget;
    this.steppedHiddenFaceTarget = this.hiddenFaceTarget;
    this.hiddenFaceMesh.material.opacity = easeToward(
      this.hiddenFaceMesh.material.opacity,
      this.hiddenFaceTarget,
      fadeStepMs(frameMs, hiddenFirstStep)
    );
    if (
      this.hiddenFaceTarget === 0 &&
      this.hiddenFaceMesh.material.opacity < SETTLE_EPSILON
    ) {
      this.hiddenFaceMesh.visible = false;
    }
    if (
      this.faceTarget === 0 &&
      this.hiddenFaceTarget === 0 &&
      this.hiddenFaceMesh.material.opacity < SETTLE_EPSILON
    ) {
      this.reset();
    }
  }

  /** Detaches this slot and releases only the geometry installed in it. */
  reset() {
    this.release(true);
  }

  dispose() {
    this.release(false);
    this.faceMesh.material.dispose();
    this.hiddenFaceMesh.material.dispose();
  }

  private release(installEmptyGeometry: boolean) {
    this.key = null;
    this.faceTarget = 0;
    this.hiddenFaceTarget = 0;
    this.faceMesh.visible = false;
    this.hiddenFaceMesh.visible = false;
    this.faceMesh.removeFromParent();
    this.hiddenFaceMesh.removeFromParent();
    this.faceMesh.geometry.dispose();
    this.hiddenFaceMesh.geometry.dispose();
    if (installEmptyGeometry) {
      this.faceMesh.geometry = new THREE.BufferGeometry();
      this.hiddenFaceMesh.geometry = new THREE.BufferGeometry();
    }
    this.faceMesh.material.opacity = 0;
    this.hiddenFaceMesh.material.opacity = 0;
    delete this.faceMesh.userData.hoverFaceKey;
    delete this.hiddenFaceMesh.userData.hoverFaceKey;
  }
}

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
}

/**
 * Hover and preselection state for the viewport.
 *
 * All feedback here is imperative on purpose: hover changes on every pointer
 * move, and routing that through React would re-render the workspace at
 * pointer frequency. The manager owns the overlays and steps them itself.
 *
 * Hover and selection tints are state changes, so they cut: each lands on its
 * target in the first frame after the change. Only x-ray passes, which draw a
 * highlight through the solid in front of it, ease — see `easeOpacity`.
 */
type RegionMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;

/** A hovered region mesh plus the companions a pick of it also selects. */
function regionHoverSet(mesh: RegionMesh): RegionMesh[] {
  const companions =
    (mesh.userData.regionCompanions as RegionMesh[] | undefined) ?? [];
  return [mesh, ...companions.filter((companion) => companion !== mesh)];
}

export class SelectionManager {
  /**
   * Overlay materials on their way to `userData.targetOpacity`. Each lands on
   * it at the next step — the frame the change is drawn — unless it was
   * registered with `easeOpacity`, in which case it eases there.
   */
  readonly fadeIns = new Set<THREE.Material>();
  /**
   * The target each easing material was last stepped toward. A material that
   * is new to `fadeIns`, or whose target changed since, is on its first step.
   */
  private readonly fadeTargets = new WeakMap<THREE.Material, number>();
  /** Materials whose opacity eases rather than cuts (see `easeOpacity`). */
  private readonly easedMaterials = new WeakSet<THREE.Material>();

  hoveredBodyId: string | null = null;
  /** Legacy per-edge visual, retained while ModelViewer adopts edge batches. */
  hoveredEdge: Line2 | null = null;

  private options: SelectionManagerOptions;
  private hoveredEdgeTarget: EdgeHoverTarget | null = null;
  private hoverFaceKey: string | null = null;
  /** Last cursor written, so an unchanged one is not rewritten per frame. */
  private lastCursor: string | null = null;
  private readonly hoverFaceSlots: readonly [
    HoverFaceMeshSlot,
    HoverFaceMeshSlot
  ];
  private activeHoverFaceSlot: HoverFaceMeshSlot | null = null;
  private xrayEnabled = true;
  private hoveredRegionMesh: THREE.Mesh<
    THREE.BufferGeometry,
    THREE.MeshBasicMaterial
  > | null = null;
  /** The hovered region and its companions, all lit together. */
  private hoveredRegionMeshes: THREE.Mesh<
    THREE.BufferGeometry,
    THREE.MeshBasicMaterial
  >[] = [];

  constructor(options: SelectionManagerOptions) {
    this.options = options;
    this.hoverFaceSlots = [new HoverFaceMeshSlot(0), new HoverFaceMeshSlot(1)];
  }

  /** The face film currently entering or resting under the pointer. */
  get hoverFaceMesh(): HoverFaceMesh {
    return (
      this.activeHoverFaceSlot?.faceMesh ?? this.hoverFaceSlots[0].faceMesh
    );
  }

  /** Occluded pass paired with the current face film. */
  get hoverHiddenFaceMesh(): HoverHiddenFaceMesh {
    return (
      this.activeHoverFaceSlot?.hiddenFaceMesh ??
      this.hoverFaceSlots[0].hiddenFaceMesh
    );
  }

  /**
   * Opts a material out of the cut: whenever it is in `fadeIns`, its opacity
   * eases toward the target instead of landing there in one frame. For
   * x-ray passes — a highlight seen through the solid reads as a flicker when
   * it pops — and for mode transitions that ride a camera glide, never for a
   * hover or selection tint. Membership lasts as long as the material.
   */
  easeOpacity<T extends THREE.Material>(material: T): T {
    this.easedMaterials.add(material);
    return material;
  }

  /** True while any overlay is still on its way to its target. */
  get isSettling(): boolean {
    return (
      this.hoverFaceSlots.some((slot) => slot.isSettling) ||
      this.fadeIns.size > 0
    );
  }

  /** Hidden passes are misleading through the intentionally receded sketch solid. */
  setXrayEnabled(enabled: boolean) {
    if (this.xrayEnabled === enabled) {
      return;
    }
    this.xrayEnabled = enabled;
    for (const slot of this.hoverFaceSlots) {
      slot.setXrayEnabled(enabled, slot === this.activeHoverFaceSlot);
    }
    this.options.requestRender();
  }

  setEdgeHover(
    next: EdgeHoverTarget | null,
    topologyIds: readonly string[] = []
  ) {
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
      next.batch.setHovered(next.owner, topologyIds);
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
   * Rebuilds the preselection film over one exact face. The film being left
   * cuts off and the entering one cuts on in the same call, so a hop between
   * neighbours never shows both. Their x-ray passes cross-fade, which is why
   * there are two slots: the one being left keeps its geometry until its
   * pass has faded out, then releases it and detaches from the body.
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
    const outgoingSlot = this.activeHoverFaceSlot;
    outgoingSlot?.retire();
    this.activeHoverFaceSlot = null;
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
    if (!face || !object) {
      return;
    }
    const geometry = createFaceHighlightGeometry(object, face);
    const hiddenGeometry = createFaceHighlightGeometry(object, face);
    if (!geometry || !hiddenGeometry) {
      geometry?.dispose();
      hiddenGeometry?.dispose();
      return;
    }
    const incomingSlot =
      this.hoverFaceSlots.find(
        (slot) => slot !== outgoingSlot && slot.key === null
      ) ?? this.hoverFaceSlots.find((slot) => slot !== outgoingSlot);
    if (!incomingSlot) {
      geometry.dispose();
      hiddenGeometry.dispose();
      return;
    }
    incomingSlot.install(
      object,
      key,
      geometry,
      hiddenGeometry,
      this.xrayEnabled
    );
    this.activeHoverFaceSlot = incomingSlot;
    this.options.requestRender();
  }

  /**
   * Lights the region under the pointer, and with it every region a click
   * there would select: a mesh's `regionCompanions` (the other glyphs of one
   * text object) are built with it, so they are previewed with it.
   */
  setRegionHover(next: THREE.Object3D | null) {
    const mesh =
      next instanceof THREE.Mesh && next.userData.region !== undefined
        ? (next as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>)
        : null;
    if (this.hoveredRegionMesh === mesh) {
      return;
    }
    for (const previous of this.hoveredRegionMeshes) {
      if (previous.userData.regionSelected !== true) {
        this.setRegionVisual(previous, 'idle');
        this.fadeIns.add(previous.material);
      }
    }
    this.hoveredRegionMesh = mesh;
    this.hoveredRegionMeshes = mesh ? regionHoverSet(mesh) : [];
    for (const hovered of this.hoveredRegionMeshes) {
      if (hovered.userData.regionSelected !== true) {
        this.setRegionVisual(hovered, 'hover');
        this.fadeIns.add(hovered.material);
      }
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
      selected
        ? 'selected'
        : this.hoveredRegionMeshes.includes(mesh)
          ? 'hover'
          : 'idle'
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
          ? SELECTION_SEMANTICS.region.boundarySelected
          : state === 'hover'
            ? SELECTION_SEMANTICS.region.boundaryHover
            : SELECTION_SEMANTICS.region.boundaryIdle
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
    let hoveredTopologyIds: readonly string[] = [];
    if (
      hoveredEdge &&
      isBatchedEdgeTarget(hoveredEdge) &&
      !(
        this.hoveredEdgeTarget &&
        isSameEdgeTarget(this.hoveredEdgeTarget, hoveredEdge)
      )
    ) {
      const topology = this.options
        .bodies()
        .find((body) => body.bodyId === hoveredEdge.owner.bodyId)?.topology;
      if (topology) {
        const run = edgeRunFrom(topology.edges, hoveredEdge.owner.topologyId);
        hoveredTopologyIds = run.length > 1 ? run : [];
      }
    }
    this.setEdgeHover(hoveredEdge, hoveredTopologyIds);
    this.setHoverFace(candidate?.selection ?? null);
    const cursor = canDragFace
      ? 'grab'
      : bodyId || candidate?.sketchId || candidate?.region
        ? 'pointer'
        : '';
    // Writing the same cursor every hover frame makes sweeping across a dense
    // edge set flicker between shapes, because each frame's pick can land on
    // a different side of a boundary. Only a real change is worth a write.
    //
    // The canvas is checked as well as the cache, because this is not the only
    // writer: the viewer sets `grab` over a move handle, and the gesture
    // router saves and restores the cursor around a captured drag. Trusting
    // the cache alone made it stale the moment either of those wrote, and the
    // next hover that agreed with the stale value skipped its write — which is
    // how a `grab` from a move gizmo survived the pointer moving off onto
    // empty space, and stayed there offering to drag nothing.
    const element = this.options.domElement;
    if (cursor !== this.lastCursor || element.style.cursor !== cursor) {
      this.lastCursor = cursor;
      element.style.cursor = cursor;
    }
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
   * Advances every overlay one frame: a cut lands on its target, an eased
   * material steps toward it. `dt` is already clamped by the caller's render
   * clock; a cut does not read it, so even a zero-length frame lands one.
   */
  step(dt: number) {
    const dtMs = dt * 1000;
    for (const slot of this.hoverFaceSlots) {
      slot.step(dtMs);
    }
    for (const material of this.fadeIns) {
      const target =
        (material.userData.targetOpacity as number | undefined) ??
        DEFAULT_FADE_TARGET;
      if (this.easedMaterials.has(material)) {
        const firstStep = this.fadeTargets.get(material) !== target;
        this.fadeTargets.set(material, target);
        material.opacity = easeToward(
          material.opacity,
          target,
          fadeStepMs(dtMs, firstStep)
        );
      } else {
        material.opacity = target;
      }
      if (material.opacity === target) {
        // A material faded back to full opacity goes back to the opaque pass
        // once it settles: leaving `transparent` set keeps it in depth-sorted
        // rendering and risks sorting artifacts. This lived in the viewer's
        // own copy of this loop, which ran a second time on the same set in
        // the same frame — so every fade played at double speed, and whether
        // a material was ever restored to opaque came down to which of the
        // two passes happened to land it on its target.
        if (material.userData.restoreOpaque === true) {
          material.transparent = false;
          delete material.userData.restoreOpaque;
          material.needsUpdate = true;
        }
        this.fadeIns.delete(material);
        this.fadeTargets.delete(material);
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
    this.activeHoverFaceSlot = null;
    for (const slot of this.hoverFaceSlots) {
      slot.reset();
    }
    this.fadeIns.clear();
  }

  dispose() {
    this.hoverFaceKey = null;
    this.activeHoverFaceSlot = null;
    for (const slot of this.hoverFaceSlots) {
      slot.dispose();
    }
    this.fadeIns.clear();
  }
}
