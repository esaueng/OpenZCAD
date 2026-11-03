import type * as THREE from 'three';
import {
  normalForTriangle,
  type FatLineResolution,
  type HudLayer,
  type PickCandidate,
  type PickService
} from '@openzcad/viewport';
import {
  dragSpecFor,
  frameInWorld,
  invertTransform,
  rotateVector,
  solveAssembly,
  transformPoint,
  type BodyId,
  type GeometryBodyRepresentation,
  type Vector3
} from '@openzcad/shared';
import {
  assemblyRuntime,
  getAssemblyRuntime
} from '../../lib/assembly/assemblyRuntime';
import type { AssemblyViewModel } from '../../lib/assembly/assemblyView';
import {
  beginAssemblyDrag,
  formatAssemblyDragValue,
  readAssemblyDrag,
  type AssemblyDragReading,
  type AssemblyDragSession
} from '../../lib/assembly/assemblyDrag';
import {
  deriveJointFrame,
  type FramePickResult
} from '../../lib/assembly/framePick';
import { AssemblyGlyphLayer, ASSEMBLY_GLYPH_COLORS } from './assemblyGlyphs';

/**
 * The viewport side of the Assemble workspace (AS02/AS06): poses component
 * bodies by their solved rigid transforms, draws the joint glyphs, drags a
 * component through its joint, and picks joint frames for the joint tool.
 *
 * Posing writes each body object's `matrix` with `matrixAutoUpdate` off, so
 * the selection, hover and edge overlays parented under a body travel with
 * it and nothing re-tessellates; restoring the identity hands the object
 * back to the ordinary position/rotation fields the Move gizmo uses.
 *
 * While a view is active this owns the primary button over the canvas: its
 * listeners sit on the host in the capture phase and stop the events they
 * take, so none of the Build gestures (face drags, box select, picks) see
 * them. Right and middle buttons, Shift-orbit and the wheel pass through to
 * the camera as always.
 */

export interface AssemblyViewportDeps {
  host: HTMLElement;
  canvas: HTMLCanvasElement;
  scene: THREE.Scene;
  objectsByBodyId: ReadonlyMap<string, THREE.Object3D>;
  /** A picker that ignores the selection filter: frames need exact topology. */
  picker: PickService;
  camera(): THREE.Camera;
  bodies(): readonly GeometryBodyRepresentation[];
  worldPerPixelAt(point: THREE.Vector3): number;
  resolution(): FatLineResolution;
  requestRender(): void;
  refreshShadowMap(): void;
  /** Drops the Build hover highlight when Assemble takes the pointer. */
  clearHover(): void;
  hud: HudLayer;
}

interface Press {
  pointerId: number;
  startX: number;
  startY: number;
  componentId: string | null;
  grabPoint: Vector3 | null;
  /** The pointer ray at the press: a drag measures from here, not from the threshold. */
  ray: THREE.Ray;
  /** Set once the press turned out to have nothing to drag. */
  blocked: boolean;
}

interface Drag {
  pointerId: number;
  jointId: string;
  unit: 'deg' | 'mm';
  session: AssemblyDragSession;
  startValue: number;
  previousOverride: readonly number[] | null;
  last: AssemblyDragReading | null;
}

/** Pointer travel, CSS px, before a press on a component becomes a drag. */
const DRAG_THRESHOLD_PX = 3;
/** Vertex, centroid and axis-end snaps reach this far from the hit, CSS px. */
const SNAP_RADIUS_PX = 8;
/** Drag value steps unless Shift asks for the free value (as command rigs). */
const DRAG_STEP = { deg: 1, mm: 0.1 } as const;
/** Assemble's value chip reuses the Move readout's look. */
const CHIP_CLASS = 'move-gizmo-hud';
const ACCENT_CSS = `#${ASSEMBLY_GLYPH_COLORS.selected.toString(16).padStart(6, '0')}`;
const WARNING_CSS = `#${ASSEMBLY_GLYPH_COLORS.unsolved.toString(16).padStart(6, '0')}`;

function vec(v: THREE.Vector3): Vector3 {
  return { x: v.x, y: v.y, z: v.z };
}

/** What blocks a drag on a component, for the hint chip. */
function blockedHint(view: AssemblyViewModel, componentId: string): string {
  const role = view.solution.roles.get(componentId);
  if (role === 'grounded') return 'Grounded';
  if (role === 'free') return 'Not jointed — add a joint to move it';
  return 'No movable joint';
}

export class AssemblyViewport {
  private readonly deps: AssemblyViewportDeps;
  private readonly glyphs: AssemblyGlyphLayer;
  private readonly chip: HTMLDivElement;
  private view: AssemblyViewModel | null = null;
  private posed = new Set<string>();
  private press: Press | null = null;
  private drag: Drag | null = null;
  private hoverEvent: PointerEvent | null = null;
  private hoverFrame: number | null = null;

  constructor(deps: AssemblyViewportDeps) {
    this.deps = deps;
    this.glyphs = new AssemblyGlyphLayer(deps.resolution);
    this.glyphs.group.visible = false;
    deps.scene.add(this.glyphs.group);
    this.chip = deps.hud.create(CHIP_CLASS, { ariaHidden: true });
    this.chip.dataset.testid = 'assembly-drag-value';
    const { host } = deps;
    host.addEventListener('pointerdown', this.onPointerDown, true);
    host.addEventListener('pointermove', this.onPointerMove, true);
    host.addEventListener('pointerup', this.onPointerUp, true);
    host.addEventListener('pointercancel', this.onPointerCancel, true);
    host.addEventListener('dblclick', this.onDoubleClick, true);
    deps.canvas.addEventListener('pointerleave', this.onPointerLeave);
    window.addEventListener('keydown', this.onKeyDown, true);
  }

  get active(): boolean {
    return this.view !== null;
  }

  /**
   * Shows a view (or none): poses every component body, restores bodies
   * that are no longer posed, and redraws the glyphs. Call it whenever the
   * view model or the drawn body objects change.
   */
  setView(view: AssemblyViewModel | null): void {
    const wasActive = this.view !== null;
    this.view = view;
    if (view && !wasActive) this.deps.clearHover();
    // Leaving Assemble already dropped every transient value.
    if (!view) this.endGesture(false);
    const changed = this.applyPoses();
    this.glyphs.setGlyphs(view?.glyphs ?? []);
    this.glyphs.group.visible = view !== null;
    if (!view) {
      this.glyphs.setMarker(null);
      this.deps.hud.hide(this.chip);
      if (wasActive) this.deps.canvas.style.cursor = '';
    } else if (!this.toolPicking()) {
      this.glyphs.setMarker(null);
      if (!this.press) this.hideChip();
    }
    if (changed) this.deps.refreshShadowMap();
    this.deps.requestRender();
  }

  /** Per drawn frame, before rendering: keeps the glyphs screen-sized. */
  beforeRender(): void {
    if (this.view) this.glyphs.scaleToScreen(this.deps.worldPerPixelAt);
  }

  dispose(): void {
    const { host } = this.deps;
    host.removeEventListener('pointerdown', this.onPointerDown, true);
    host.removeEventListener('pointermove', this.onPointerMove, true);
    host.removeEventListener('pointerup', this.onPointerUp, true);
    host.removeEventListener('pointercancel', this.onPointerCancel, true);
    host.removeEventListener('dblclick', this.onDoubleClick, true);
    this.deps.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    window.removeEventListener('keydown', this.onKeyDown, true);
    if (this.hoverFrame !== null) cancelAnimationFrame(this.hoverFrame);
    this.view = null;
    this.applyPoses();
    this.deps.scene.remove(this.glyphs.group);
    this.glyphs.dispose();
  }

  // ── Posing ────────────────────────────────────────────────────────────

  /** True when any body's drawn pose changed. */
  private applyPoses(): boolean {
    const matrices = this.view?.matrices;
    let changed = false;
    const next = new Set<string>();
    for (const [bodyId, object] of this.deps.objectsByBodyId) {
      const matrix = matrices?.get(bodyId as BodyId);
      if (matrix) {
        next.add(bodyId);
        const elements = object.matrix.elements;
        const same =
          !object.matrixAutoUpdate &&
          matrix.every((value, index) => elements[index] === value);
        if (same) continue;
        object.matrixAutoUpdate = false;
        object.matrix.fromArray(matrix);
        object.matrixWorldNeedsUpdate = true;
        object.updateMatrixWorld(true);
        changed = true;
      } else if (this.posed.has(bodyId) || !object.matrixAutoUpdate) {
        object.matrixAutoUpdate = true;
        object.updateMatrix();
        object.updateMatrixWorld(true);
        changed = true;
      }
    }
    this.posed = next;
    return changed;
  }

  // ── Pointer ───────────────────────────────────────────────────────────

  private toolPicking(): boolean {
    const step = getAssemblyRuntime().jointTool?.step;
    return step === 'child' || step === 'parent';
  }

  private canvasPoint(event: PointerEvent | MouseEvent) {
    const rect = this.deps.canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      width: rect.width,
      height: rect.height
    };
  }

  private glyphAt(event: PointerEvent | MouseEvent): string | null {
    const p = this.canvasPoint(event);
    return this.glyphs.pick(p.x, p.y, this.deps.camera(), p.width, p.height);
  }

  /** The component under the pointer, with the world hit. */
  private componentAt(event: PointerEvent | MouseEvent): {
    componentId: string;
    bodyId: string;
    candidate: PickCandidate;
  } | null {
    const view = this.view;
    if (!view) return null;
    const candidate = this.deps.picker.pick(event);
    const bodyId = candidate?.selection?.bodyId;
    if (!candidate || !bodyId) return null;
    const componentId = view.componentByBody.get(bodyId);
    return componentId ? { componentId, bodyId, candidate } : null;
  }

  private showChip(
    event: { clientX: number; clientY: number },
    text: string,
    warning = false
  ) {
    this.chip.textContent = text;
    this.chip.style.setProperty(
      '--gizmo-axis-color',
      warning ? WARNING_CSS : ACCENT_CSS
    );
    this.chip.classList.toggle('is-active', this.drag !== null);
    this.deps.hud.showAtPointer(this.chip, event, 16, -12);
  }

  private hideChip() {
    this.deps.hud.hide(this.chip);
    this.chip.classList.remove('is-active');
  }

  private setCursor(cursor: string) {
    if (this.deps.canvas.style.cursor !== cursor)
      this.deps.canvas.style.cursor = cursor;
  }

  private onPointerDown = (event: PointerEvent): void => {
    const view = this.view;
    if (!view || event.target !== this.deps.canvas) return;
    // Right and middle drags navigate; Shift+left orbits.
    if (event.button !== 0 || event.shiftKey) return;
    event.stopPropagation();
    event.preventDefault();
    this.hideChip();
    const tool = getAssemblyRuntime().jointTool;
    if (tool) {
      if (tool.step !== 'review') this.pickFrame(event);
      return;
    }
    const jointId = this.glyphAt(event);
    if (jointId) {
      assemblyRuntime.selectJoint(jointId);
      return;
    }
    const hit = this.componentAt(event);
    this.deps.picker.setRayFromEvent(event);
    this.press = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      componentId: hit?.componentId ?? null,
      grabPoint: hit ? vec(hit.candidate.hit.point) : null,
      ray: this.deps.picker.raycaster.ray.clone(),
      blocked: false
    };
    if (hit) assemblyRuntime.selectComponent(hit.componentId);
    try {
      this.deps.canvas.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic or already-released pointer cannot be captured.
    }
  };

  private onPointerMove = (event: PointerEvent): void => {
    const view = this.view;
    if (!view) return;
    const press = this.press;
    if (press && event.pointerId === press.pointerId) {
      event.stopPropagation();
      event.preventDefault();
      if (!this.drag && !press.blocked) {
        const travel = Math.hypot(
          event.clientX - press.startX,
          event.clientY - press.startY
        );
        if (travel < DRAG_THRESHOLD_PX || !press.componentId) return;
        this.beginDrag(press);
      }
      if (this.drag) this.continueDrag(event);
      else if (press.blocked && press.componentId)
        this.showChip(event, blockedHint(view, press.componentId), true);
      return;
    }
    // Hover with no button: Build's preselection stays out of Assemble.
    if (event.buttons !== 0 || event.target !== this.deps.canvas) return;
    event.stopPropagation();
    this.hoverEvent = event;
    if (this.hoverFrame === null)
      this.hoverFrame = requestAnimationFrame(() => {
        this.hoverFrame = null;
        const pending = this.hoverEvent;
        this.hoverEvent = null;
        if (pending && this.view) this.hover(pending);
      });
  };

  private onPointerUp = (event: PointerEvent): void => {
    const press = this.press;
    if (!press || event.pointerId !== press.pointerId) {
      // A primary click over the canvas belongs to Assemble even when the
      // press found nothing to hold.
      if (
        this.view &&
        event.button === 0 &&
        !event.shiftKey &&
        event.target === this.deps.canvas
      )
        event.stopPropagation();
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    const drag = this.drag;
    if (drag) {
      const moved =
        drag.last !== null &&
        Math.abs(drag.last.value - drag.startValue) > 1e-12;
      if (moved) assemblyRuntime.commitOverrides();
      else assemblyRuntime.setOverride(drag.jointId, drag.previousOverride);
    } else if (!press.componentId && !press.blocked) {
      // A click on empty space (or a body outside the assembly) clears.
      assemblyRuntime.selectComponent(null);
      assemblyRuntime.selectJoint(null);
    }
    this.endGesture(false);
    this.hover(event);
  };

  private onPointerCancel = (event: PointerEvent): void => {
    if (this.press && event.pointerId === this.press.pointerId) {
      event.stopPropagation();
      this.endGesture(true);
    }
  };

  private onPointerLeave = (): void => {
    if (!this.view || this.press) return;
    this.hoverEvent = null;
    this.glyphs.setMarker(null);
    this.hideChip();
    this.deps.requestRender();
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.drag) return;
    event.stopPropagation();
    event.preventDefault();
    this.endGesture(true);
  };

  private onDoubleClick = (event: MouseEvent): void => {
    // Double-click on a part would select it as a Build body; empty space
    // still frames the view.
    if (!this.view || event.target !== this.deps.canvas) return;
    if (this.componentAt(event) || this.glyphAt(event)) event.stopPropagation();
  };

  /** Ends a press or drag; `cancel` puts a dragged joint back. */
  private endGesture(cancel: boolean) {
    const drag = this.drag;
    if (drag && cancel)
      assemblyRuntime.setOverride(drag.jointId, drag.previousOverride);
    if (this.press) {
      try {
        if (this.deps.canvas.hasPointerCapture(this.press.pointerId))
          this.deps.canvas.releasePointerCapture(this.press.pointerId);
      } catch {
        // Already released.
      }
    }
    this.press = null;
    this.drag = null;
    this.hideChip();
  }

  private beginDrag(press: Press) {
    const view = this.view;
    if (!view || !press.componentId || !press.grabPoint) return;
    // Motion playing owns the values; a drag takes them over from rest.
    if (getAssemblyRuntime().playback) assemblyRuntime.stop();
    const runtime = getAssemblyRuntime();
    const solution = solveAssembly(view.set, runtime.overrides);
    const spec = dragSpecFor(view.set, solution, press.componentId);
    const joint = spec
      ? view.set.joints.find((j) => j.id === spec.jointId)
      : null;
    if (!spec || !joint) {
      press.blocked = true;
      return;
    }
    const session = beginAssemblyDrag(
      spec,
      {
        kind: joint.kind,
        values: solution.values.get(joint.id) ?? joint.values
      },
      press.ray,
      press.grabPoint
    );
    if (!session) {
      press.blocked = true;
      return;
    }
    this.drag = {
      pointerId: press.pointerId,
      jointId: joint.id,
      unit: spec.unit,
      session,
      startValue: spec.startValue,
      previousOverride: runtime.overrides.get(joint.id) ?? null,
      last: null
    };
    this.glyphs.setMarker(null);
    this.setCursor('grabbing');
  }

  private continueDrag(event: PointerEvent) {
    const drag = this.drag;
    if (!drag) return;
    this.deps.picker.setRayFromEvent(event);
    const reading = readAssemblyDrag(
      drag.session,
      this.deps.picker.raycaster.ray,
      event.shiftKey ? 0 : DRAG_STEP[drag.unit]
    );
    if (reading) {
      const previous = drag.last;
      drag.last = reading;
      if (!previous || previous.value !== reading.value)
        assemblyRuntime.setOverride(drag.jointId, reading.values);
    }
    const shown = drag.last;
    if (shown)
      this.showChip(
        event,
        formatAssemblyDragValue(shown.value, drag.unit, shown.atLimit),
        shown.atLimit !== null
      );
  }

  // ── Hover and frame picking ───────────────────────────────────────────

  private hover(event: PointerEvent) {
    const view = this.view;
    if (!view || this.drag || this.press) return;
    if (this.toolPicking()) {
      const found = this.framePickAt(event);
      if (found) {
        const pose = view.solution.poses.get(found.componentId);
        this.glyphs.setMarker(
          pose ? frameInWorld(pose, found.pick.frame) : null,
          found.pick.source.kind
        );
        this.showChip(event, found.pick.source.label);
        this.setCursor('crosshair');
      } else {
        this.glyphs.setMarker(null);
        this.hideChip();
        this.setCursor('');
      }
      this.deps.requestRender();
      return;
    }
    if (getAssemblyRuntime().jointTool) {
      this.setCursor('');
      return;
    }
    if (this.glyphAt(event)) {
      this.setCursor('pointer');
      return;
    }
    const hit = this.componentAt(event);
    if (!hit) {
      this.setCursor('');
      return;
    }
    const draggable =
      dragSpecFor(view.set, view.solution, hit.componentId) !== null;
    this.setCursor(draggable ? 'grab' : 'pointer');
  }

  private pickFrame(event: PointerEvent) {
    const found = this.framePickAt(event);
    if (!found) return;
    assemblyRuntime.pickJointFrame({
      componentId: found.componentId,
      bodyId: found.bodyId as BodyId,
      frame: found.pick.frame,
      source: found.pick.source
    });
    this.glyphs.setMarker(null);
    this.hideChip();
    this.deps.requestRender();
  }

  /**
   * The joint frame under the pointer, in its component's modelled
   * coordinates: the world hit is taken back through the component's pose
   * before the exact topology is read.
   */
  private framePickAt(event: PointerEvent): {
    componentId: string;
    bodyId: string;
    pick: FramePickResult;
  } | null {
    const view = this.view;
    const tool = getAssemblyRuntime().jointTool;
    if (!view || !tool) return null;
    const hit = this.componentAt(event);
    if (!hit) return null;
    // The moving end and the target must be different components.
    if (tool.step === 'parent' && tool.child?.componentId === hit.componentId)
      return null;
    const pose = view.solution.poses.get(hit.componentId);
    if (!pose) return null;
    const toLocal = invertTransform(pose);
    const { candidate } = hit;
    const onLine = (candidate.hit as { pointOnLine?: THREE.Vector3 })
      .pointOnLine;
    const worldPoint = onLine ?? candidate.hit.point;
    const point = transformPoint(toLocal, vec(worldPoint));
    const body = this.deps.bodies().find((b) => b.bodyId === hit.bodyId);
    let normal: Vector3 | undefined;
    if (candidate.kind === 'face' && body) {
      // The body mesh is uploaded in modelled coordinates, so its triangle
      // normal is already local.
      const triangle =
        typeof candidate.hit.faceIndex === 'number'
          ? normalForTriangle(body, candidate.hit.faceIndex)
          : null;
      if (triangle) normal = vec(triangle);
    }
    if (!normal && candidate.faceNormal) {
      const world = candidate.faceNormal
        .clone()
        .transformDirection(candidate.hit.object.matrixWorld);
      normal = rotateVector(toLocal.q, vec(world));
    }
    const selection = candidate.selection;
    const kind =
      selection?.kind === 'face' || selection?.kind === 'edge'
        ? selection.kind
        : 'body';
    const snapTolerance =
      this.deps.worldPerPixelAt(worldPoint) * SNAP_RADIUS_PX;
    const pick = deriveJointFrame(
      body?.topology,
      {
        kind,
        ...(selection?.topologyId ? { topologyId: selection.topologyId } : {}),
        point,
        ...(normal ? { normal } : {})
      },
      { snapTolerance }
    );
    return pick
      ? { componentId: hit.componentId, bodyId: hit.bodyId, pick }
      : null;
  }
}
