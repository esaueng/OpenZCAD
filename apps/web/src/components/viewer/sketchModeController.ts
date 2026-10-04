import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import {
  createFatLine,
  createFatLineMaterial,
  VIEWPORT_RENDER_ORDER,
  type FatLineResolution
} from '@openzcad/viewport';
import type { PlaneBasis } from '@openzcad/geometry';
import type { SketchObjectData } from '@openzcad/shared';
import {
  adaptiveGridSpacing,
  type SketchInferenceSegment,
  type SketchPoint
} from '../../lib/sketch/session';
import {
  objectPolylines,
  displayObjectsWithTextBudget,
  type SketchObjectPolyline
} from '../../lib/objectPolyline';
import { triangulateRegionGeometry } from './regionOverlay';

/**
 * Scene-side rig for in-viewport sketching: a tinted plane quad with a
 * grid, blue polylines for the session sketch's committed objects, and a
 * single orange polyline for the entity being drawn. All geometry lives in
 * one group so entering/leaving sketch mode is add/remove + dispose.
 */

const PLANE_EXTENT = 400;
const TINT_COLOR = 0x10172e;
const COMMITTED_COLOR = 0x6798ff;
const CONSTRUCTION_COLOR = 0x7b8da3;
const DIAGNOSTIC_COLOR = 0xff5d73;
const SELECTED_COLOR = 0xf59e0b;
const IN_PROGRESS_COLOR = 0xf59e0b;
const INFERENCE_COLOR = 0x7da3fc;
/**
 * Fully-defined sketch geometry. Mirrors `--color-success` in
 * `apps/web/src/theme/tokens.css` as a literal because WebGL materials
 * cannot read CSS variables; the value is the dark-stage token, which the
 * light theme keeps for the canvas too (it repaints the chrome, not the
 * 3D stage), so this stays correct in both themes.
 */
export const DEFINED_COLOR = 0x48cd8f;
/** Screen-space width in CSS pixels for the sketch polylines. */
const SKETCH_LINE_WIDTH = 1.6;
/** Screen-space diameter in CSS pixels for the snap-point dots. */
const SKETCH_POINT_SIZE = 5;

export interface CommittedSketchColorState {
  /** Named by a solver residual: the conflict colour always wins. */
  diagnostic: boolean;
  selected: boolean;
  /** In the sketch-wide fully-defined id set. */
  defined: boolean;
  construction: boolean;
}

/**
 * One object's committed colour, precedence pinned: conflict red beats
 * selection orange beats fully-defined green beats construction grey beats
 * the normal blue. Construction keeps its grey even when the sketch is fully
 * defined — the dashed grey is what says "reference, not profile" — while
 * the solve pill's text carries the sketch-wide claim. Pure so tests pin it.
 */
export function committedSketchColor(state: CommittedSketchColorState): number {
  if (state.diagnostic) {
    return DIAGNOSTIC_COLOR;
  }
  if (state.selected) {
    return SELECTED_COLOR;
  }
  if (state.defined && !state.construction) {
    return DEFINED_COLOR;
  }
  return state.construction ? CONSTRUCTION_COLOR : COMMITTED_COLOR;
}

export interface SketchModeRig {
  group: THREE.Group;
  /**
   * Rebuilds the committed polylines (and their snap-point dots) from the
   * sketch's objects. `diagnosticObjectIds` paints the solver-named conflict
   * red; `definedObjectIds` paints the sketch-wide fully-defined green —
   * both default to empty so unsolved sketches render in the normal style.
   */
  setObjects(
    objects: { id: string; data: SketchObjectData }[],
    selectedObjectId: string | null,
    resolve: (value: unknown) => number,
    diagnosticObjectIds?: readonly string[],
    definedObjectIds?: readonly string[],
    textBudgetError?: string | null
  ): void;
  /**
   * Draws one object somewhere else while it is dragged, leaving every other
   * object's render resources in place: only the preview is rebuilt per
   * frame, and the stored object is hidden until `setObjects` or a null
   * call restores it. Null ends the preview.
   */
  setPreviewObject(objectId: string | null, data?: SketchObjectData): void;
  /** Updates the adaptive sketch-local grid and returns its minor spacing. */
  setGrid(worldPerPixel: number, visible: boolean): number;
  /** Closed profiles derived from the canonical sketch objects. */
  setProfiles(
    profiles: { outer: SketchPoint[]; holes: SketchPoint[][] }[],
    visible: boolean
  ): void;
  /** Returns the closest committed entity under the current ray. */
  pickObject(raycaster: THREE.Raycaster, threshold: number): string | null;
  /** Replaces the in-progress (orange) polyline; null hides it. */
  setInProgress(points: SketchPoint[] | null, closed: boolean): void;
  /** Temporary horizontal/vertical or center-cross inference guides. */
  setInference(segments: readonly SketchInferenceSegment[] | null): void;
  /** Advances the center-guide dash flow; true while another frame is useful. */
  advanceInference(now: number, reducedMotion: boolean): boolean;
  /** Highlights open/gapped endpoints requested by profile diagnostics. */
  setDiagnostics(points: SketchPoint[]): void;
  dispose(): void;
}

function liftPoint(basis: PlaneBasis, point: SketchPoint): THREE.Vector3 {
  return new THREE.Vector3(
    basis.origin.x + basis.u.x * point.x + basis.v.x * point.y,
    basis.origin.y + basis.u.y * point.x + basis.v.y * point.y,
    basis.origin.z + basis.u.z * point.x + basis.v.z * point.y
  );
}

/**
 * The constraint-schema snap points of one object — the same `start` / `end`
 * / `center` identity the rail's coincident, midpoint and distance tools
 * pick. Dots for these ride the object's own colour, so the defined-state
 * tint covers points with no second code path. Throws on unresolvable
 * values, like `objectPolylines` does; callers skip the object.
 */
export function sketchObjectMarkerPoints(
  data: SketchObjectData,
  resolve: (value: unknown) => number
): SketchPoint[] {
  if (data.objectKind === 'line') {
    return [
      { x: resolve(data.x1), y: resolve(data.y1) },
      { x: resolve(data.x2), y: resolve(data.y2) }
    ];
  }
  if (data.objectKind === 'circle') {
    return [{ x: resolve(data.centerX), y: resolve(data.centerY) }];
  }
  if (data.objectKind === 'arc') {
    const centerX = resolve(data.centerX);
    const centerY = resolve(data.centerY);
    const radius = resolve(data.radius);
    const start = (resolve(data.startAngleDeg) * Math.PI) / 180;
    const end = (resolve(data.endAngleDeg) * Math.PI) / 180;
    return [
      { x: centerX, y: centerY },
      {
        x: centerX + radius * Math.cos(start),
        y: centerY + radius * Math.sin(start)
      },
      {
        x: centerX + radius * Math.cos(end),
        y: centerY + radius * Math.sin(end)
      }
    ];
  }
  return [];
}

/**
 * @param resolution Live viewport size in CSS pixels. Read on every rebuild
 * rather than captured once, so objects drawn after a resize come out at the
 * right width even before the next resize sweep.
 */
export function buildSketchModeRig(
  basis: PlaneBasis,
  resolution: () => FatLineResolution
): SketchModeRig {
  const group = new THREE.Group();
  group.name = 'sketch-mode';

  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(basis.normal.x, basis.normal.y, basis.normal.z)
  );
  const origin = new THREE.Vector3(
    basis.origin.x,
    basis.origin.y,
    basis.origin.z
  );

  // Plane tint, slightly behind the sketch geometry to avoid z-fighting.
  const tint = new THREE.Mesh(
    new THREE.PlaneGeometry(PLANE_EXTENT, PLANE_EXTENT),
    new THREE.MeshBasicMaterial({
      color: TINT_COLOR,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      side: THREE.DoubleSide
    })
  );
  tint.quaternion.copy(quaternion);
  tint.position
    .copy(origin)
    .addScaledVector(
      new THREE.Vector3(basis.normal.x, basis.normal.y, basis.normal.z),
      -0.05
    );
  tint.renderOrder = 5;
  group.add(tint);

  // Grid oriented onto the plane. Two helpers separate major and minor lines;
  // their geometry is rebuilt only when the adaptive 1-2-5 step changes.
  const gridGroup = new THREE.Group();
  gridGroup.name = 'sketch-grid';
  gridGroup.quaternion.copy(
    quaternion
      .clone()
      .multiply(
        new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(0, 0, 1)
        )
      )
  );
  gridGroup.position.copy(origin);
  gridGroup.renderOrder = 6;
  group.add(gridGroup);
  let activeGridSpacing = 0;

  const disposeGrid = () => {
    for (const child of [...gridGroup.children]) {
      gridGroup.remove(child);
      if (child instanceof THREE.LineSegments) {
        (child.geometry as THREE.BufferGeometry).dispose();
        const material = child.material as THREE.Material | THREE.Material[];
        if (Array.isArray(material)) {
          material.forEach((entry) => entry.dispose());
        } else {
          material.dispose();
        }
      }
    }
  };

  const rebuildGrid = (spacing: number) => {
    disposeGrid();
    const extent = spacing * 100;
    const minor = new THREE.GridHelper(extent, 100, 0x8aa4cf, 0x33415a);
    const major = new THREE.GridHelper(extent, 20, 0x9db7df, 0x52698f);
    for (const [helper, opacity] of [
      [minor, 0.32],
      [major, 0.44]
    ] as const) {
      const material = helper.material;
      material.transparent = true;
      material.opacity = opacity;
      material.depthWrite = false;
      helper.renderOrder = 6;
      gridGroup.add(helper);
    }
    activeGridSpacing = spacing;
  };
  rebuildGrid(10);

  const originMaterial = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 8,
    sizeAttenuation: false,
    depthTest: true,
    depthWrite: false
  });
  const originMarker = new THREE.Points(
    new THREE.BufferGeometry().setFromPoints([origin]),
    originMaterial
  );
  originMarker.name = 'sketch-origin';
  originMarker.renderOrder = VIEWPORT_RENDER_ORDER.ACTIVE_SKETCH;
  group.add(originMarker);
  // The sketch's own axes. A face sketch's frame is not screen-aligned — on
  // a top face "X" in the entity editor can run down the screen — and the
  // grid gives no hint, so the u and v directions are drawn from the origin
  // in the axis colours, two grid steps long, and rebuilt with the grid.
  const axesGroup = new THREE.Group();
  axesGroup.name = 'sketch-axes';
  axesGroup.renderOrder = VIEWPORT_RENDER_ORDER.ACTIVE_SKETCH;
  group.add(axesGroup);
  const rebuildAxes = (spacing: number) => {
    disposeChildren(axesGroup);
    const length = spacing * 2;
    for (const [point, color] of [
      [{ x: length, y: 0 }, 0xff6b6b],
      [{ x: 0, y: length }, 0x51cf66]
    ] as const) {
      const geometry = new THREE.BufferGeometry().setFromPoints([
        origin,
        liftPoint(basis, point)
      ]);
      const axis = new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({
          color,
          depthTest: false,
          transparent: true,
          opacity: 0.9
        })
      );
      axis.renderOrder = VIEWPORT_RENDER_ORDER.ACTIVE_SKETCH;
      axesGroup.add(axis);
    }
  };

  const committedGroup = new THREE.Group();
  committedGroup.name = 'sketch-committed';
  group.add(committedGroup);

  // A dragged object's stand-in. Rebuilt per pointer frame on its own, so a
  // drag in a large sketch never rebuilds everyone else's lines and glyphs.
  const previewGroup = new THREE.Group();
  previewGroup.name = 'sketch-move-preview';
  group.add(previewGroup);

  const profileGroup = new THREE.Group();
  profileGroup.name = 'sketch-profiles';
  group.add(profileGroup);

  const inProgressMaterial = createFatLineMaterial({
    color: IN_PROGRESS_COLOR,
    linewidth: SKETCH_LINE_WIDTH,
    opacity: 0.95,
    depthTest: true,
    resolution: resolution()
  });
  const inProgress = new Line2(new LineGeometry(), inProgressMaterial);
  inProgress.renderOrder = VIEWPORT_RENDER_ORDER.ACTIVE_SKETCH;
  inProgress.visible = false;
  inProgress.frustumCulled = false;
  group.add(inProgress);

  const inferenceMaterial = createFatLineMaterial({
    color: INFERENCE_COLOR,
    linewidth: 1.4,
    opacity: 0.92,
    depthTest: false,
    resolution: resolution()
  });
  inferenceMaterial.dashed = true;
  inferenceMaterial.dashSize = 2.2;
  inferenceMaterial.gapSize = 1.2;
  const inferenceGlowMaterial = createFatLineMaterial({
    color: INFERENCE_COLOR,
    linewidth: 5,
    opacity: 0.16,
    depthTest: false,
    resolution: resolution()
  });
  const inferenceGroup = new THREE.Group();
  inferenceGroup.name = 'sketch-inference';
  inferenceGroup.visible = false;
  group.add(inferenceGroup);
  const inferenceGlowGroup = new THREE.Group();
  inferenceGlowGroup.name = 'sketch-inference-glow';
  inferenceGlowGroup.visible = false;
  group.add(inferenceGlowGroup);
  const inferenceLines: Line2[] = [];
  const inferenceGlowLines: Line2[] = [];

  const inferenceLine = (
    lines: Line2[],
    container: THREE.Group,
    material: typeof inferenceMaterial,
    index: number,
    renderOrder: number
  ): Line2 => {
    const existing = lines[index];
    if (existing) {
      return existing;
    }
    const line = new Line2(new LineGeometry(), material);
    line.renderOrder = renderOrder;
    line.frustumCulled = false;
    lines.push(line);
    container.add(line);
    return line;
  };

  const diagnosticMaterial = new THREE.PointsMaterial({
    color: 0xff5d73,
    size: 9,
    sizeAttenuation: false,
    depthTest: true,
    depthWrite: false
  });
  const diagnostics = new THREE.Points(
    new THREE.BufferGeometry(),
    diagnosticMaterial
  );
  diagnostics.name = 'sketch-profile-diagnostics';
  diagnostics.renderOrder = VIEWPORT_RENDER_ORDER.ACTIVE_SKETCH;
  diagnostics.visible = false;
  group.add(diagnostics);

  const disposeChildren = (container: THREE.Object3D) => {
    for (const child of [...container.children]) {
      container.remove(child);
      // Line2 extends Mesh, so fat lines are covered by the Mesh branch;
      // the snap-point dots are Points.
      if (
        child instanceof THREE.Line ||
        child instanceof THREE.Mesh ||
        child instanceof THREE.Points
      ) {
        (child.geometry as THREE.BufferGeometry).dispose();
        (child.material as THREE.Material).dispose();
      }
    }
  };

  interface CommittedState {
    objects: { id: string; data: SketchObjectData }[];
    selectedObjectId: string | null;
    resolve: (value: unknown) => number;
    diagnosticIds: ReadonlySet<string>;
    definedIds: ReadonlySet<string>;
    textBudgetError: string | null;
  }
  let committed: CommittedState | null = null;
  /** The object a preview stands in for; hidden from the committed draw. */
  let previewedId: string | null = null;

  const objectColor = (
    state: CommittedState,
    id: string,
    construction: boolean
  ) =>
    committedSketchColor({
      diagnostic: state.diagnosticIds.has(id),
      selected: id === state.selectedObjectId,
      defined: state.definedIds.has(id),
      construction
    });

  /**
   * One object's pick proxies and fat lines, added to `container`; its snap
   * dots are appended to the shared buffers. Tagged with the object id so a
   * preview can hide exactly this object's lines.
   */
  const appendObject = (
    container: THREE.Group,
    state: CommittedState,
    object: { id: string; data: SketchObjectData },
    dotPositions: number[],
    dotColors: number[]
  ) => {
    const diagnostic = state.diagnosticIds.has(object.id);
    const construction = object.data.construction === true;
    const color = objectColor(state, object.id, construction);
    const opacity = diagnostic ? 1 : construction ? 0.72 : 0.95;
    // One object can draw several runs — a text object is one loop per
    // glyph region plus one per counter.
    let polylines: SketchObjectPolyline[];
    try {
      polylines = objectPolylines(object.data, state.resolve);
    } catch {
      return;
    }
    for (const polyline of polylines) {
      if (polyline.points.length < 2) {
        continue;
      }
      const vertices = polyline.points.map((point) => liftPoint(basis, point));
      // The native line stays on as an invisible pick proxy. Line2 raycasts
      // against a screen-space threshold whereas pickObject's caller supplies
      // a world-unit radius, so keeping it leaves selection behaviour exactly
      // as it was. Both are siblings: an invisible parent would hide the
      // visual with it.
      const geometry = new THREE.BufferGeometry().setFromPoints(vertices);
      const pickProxy = polyline.closed
        ? new THREE.LineLoop(geometry, new THREE.LineBasicMaterial())
        : new THREE.Line(geometry, new THREE.LineBasicMaterial());
      pickProxy.visible = false;
      pickProxy.frustumCulled = false;
      pickProxy.userData.sketchObjectId = object.id;
      pickProxy.userData.pickProxy = true;
      container.add(pickProxy);

      const visual = createFatLine(vertices, {
        color,
        linewidth: SKETCH_LINE_WIDTH,
        opacity,
        depthTest: true,
        closed: polyline.closed,
        resolution: resolution()
      });
      if (object.data.construction) {
        visual.material.dashed = true;
        visual.material.dashSize = 1.4;
        visual.material.gapSize = 1;
      }
      visual.renderOrder = VIEWPORT_RENDER_ORDER.ACTIVE_SKETCH;
      visual.frustumCulled = false;
      visual.raycast = () => undefined; // the proxy is the only pick target
      visual.userData.sketchObjectId = object.id;
      container.add(visual);
    }
    // The constraint-schema snap points wear the object's own colour,
    // so the defined-state tint covers points with no second code path.
    // Dots never pick: the proxy lines above stay the only pick targets.
    try {
      const dotColor = new THREE.Color(color);
      for (const marker of sketchObjectMarkerPoints(
        object.data,
        state.resolve
      )) {
        const lifted = liftPoint(basis, marker);
        dotPositions.push(lifted.x, lifted.y, lifted.z);
        dotColors.push(dotColor.r, dotColor.g, dotColor.b);
      }
    } catch {
      // Unresolvable values: the polylines above already skipped the
      // object, so its points stay out too.
    }
  };

  const appendDots = (
    container: THREE.Group,
    dotPositions: number[],
    dotColors: number[]
  ) => {
    if (dotPositions.length === 0) {
      return;
    }
    const dotsGeometry = new THREE.BufferGeometry();
    dotsGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(dotPositions, 3)
    );
    dotsGeometry.setAttribute(
      'color',
      new THREE.Float32BufferAttribute(dotColors, 3)
    );
    const dots = new THREE.Points(
      dotsGeometry,
      new THREE.PointsMaterial({
        size: SKETCH_POINT_SIZE,
        sizeAttenuation: false,
        vertexColors: true,
        depthTest: true,
        depthWrite: false,
        transparent: true,
        opacity: 0.95
      })
    );
    dots.name =
      container === committedGroup
        ? 'sketch-snap-points'
        : 'sketch-preview-points';
    dots.renderOrder = VIEWPORT_RENDER_ORDER.ACTIVE_SKETCH;
    dots.frustumCulled = false;
    dots.raycast = () => undefined;
    container.add(dots);
  };

  /**
   * The committed dots, less the previewed object's. Every object's dots
   * share one buffer, so hiding one object's means rebuilding the buffer —
   * marker points only, no polylines or glyph layout — once per preview,
   * not per frame.
   */
  const rebuildCommittedDots = (
    state: CommittedState,
    skipId: string | null
  ) => {
    const existing = committedGroup.getObjectByName('sketch-snap-points');
    if (existing instanceof THREE.Points) {
      committedGroup.remove(existing);
      (existing.geometry as THREE.BufferGeometry).dispose();
      (existing.material as THREE.Material).dispose();
    }
    const positions: number[] = [];
    const colors: number[] = [];
    const dotColor = new THREE.Color();
    for (const object of displayObjectsWithTextBudget(
      state.objects,
      state.textBudgetError
    )) {
      if (object.id === skipId) {
        continue;
      }
      try {
        dotColor.set(
          objectColor(state, object.id, object.data.construction === true)
        );
        for (const marker of sketchObjectMarkerPoints(
          object.data,
          state.resolve
        )) {
          const lifted = liftPoint(basis, marker);
          positions.push(lifted.x, lifted.y, lifted.z);
          colors.push(dotColor.r, dotColor.g, dotColor.b);
        }
      } catch {
        // As in `appendObject`: an unresolvable object draws no dots.
      }
    }
    appendDots(committedGroup, positions, colors);
  };

  return {
    group,
    setObjects(
      objects,
      selectedObjectId,
      resolve,
      diagnosticObjectIds = [],
      definedObjectIds = [],
      textBudgetError = null
    ) {
      disposeChildren(committedGroup);
      disposeChildren(previewGroup);
      previewedId = null;
      const state: CommittedState = {
        objects,
        selectedObjectId,
        resolve,
        diagnosticIds: new Set(diagnosticObjectIds),
        definedIds: new Set(definedObjectIds),
        textBudgetError
      };
      committed = state;
      const dotPositions: number[] = [];
      const dotColors: number[] = [];
      for (const object of displayObjectsWithTextBudget(
        objects,
        textBudgetError
      )) {
        appendObject(committedGroup, state, object, dotPositions, dotColors);
      }
      appendDots(committedGroup, dotPositions, dotColors);
    },
    setPreviewObject(objectId, data) {
      const state = committed;
      if (!state) {
        return;
      }
      if (objectId === null || !data) {
        if (previewedId !== null) {
          disposeChildren(previewGroup);
          for (const child of committedGroup.children) {
            if (
              child.userData.sketchObjectId === previewedId &&
              child.userData.pickProxy !== true
            ) {
              child.visible = true;
            }
          }
          rebuildCommittedDots(state, null);
          previewedId = null;
        }
        return;
      }
      if (previewedId !== objectId) {
        // First frame of this preview: hide the stored object once.
        for (const child of committedGroup.children) {
          if (child.userData.pickProxy === true) {
            continue;
          }
          if (child.userData.sketchObjectId === previewedId) {
            child.visible = true;
          }
          if (child.userData.sketchObjectId === objectId) {
            child.visible = false;
          }
        }
        rebuildCommittedDots(state, objectId);
        previewedId = objectId;
      }
      disposeChildren(previewGroup);
      const dotPositions: number[] = [];
      const dotColors: number[] = [];
      appendObject(
        previewGroup,
        state,
        { id: objectId, data },
        dotPositions,
        dotColors
      );
      appendDots(previewGroup, dotPositions, dotColors);
    },
    setGrid(worldPerPixel, visible) {
      const spacing = adaptiveGridSpacing(worldPerPixel);
      if (Math.abs(spacing - activeGridSpacing) > activeGridSpacing * 1e-9) {
        rebuildGrid(spacing);
        rebuildAxes(spacing);
      }
      gridGroup.visible = visible;
      return spacing;
    },
    setProfiles(profiles, visible) {
      disposeChildren(profileGroup);
      profileGroup.visible = visible;
      if (!visible) {
        return;
      }
      for (const profile of profiles) {
        if (profile.outer.length < 3) {
          continue;
        }
        const { positions, indices } = triangulateRegionGeometry(
          profile.outer,
          profile.holes,
          basis
        );
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          'position',
          new THREE.BufferAttribute(positions, 3)
        );
        geometry.setIndex(indices);
        const material = new THREE.MeshBasicMaterial({
          color: 0x2f7fbd,
          toneMapped: false,
          transparent: true,
          opacity: 0.14,
          depthTest: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = VIEWPORT_RENDER_ORDER.SKETCH_FILL;
        profileGroup.add(mesh);
      }
    },
    pickObject(raycaster, threshold) {
      const priorThreshold = raycaster.params.Line?.threshold;
      raycaster.params.Line = {
        threshold: Math.max(threshold, Number.EPSILON)
      };
      const hit = raycaster.intersectObjects(committedGroup.children, false)[0];
      raycaster.params.Line = { threshold: priorThreshold ?? 1 };
      return typeof hit?.object.userData.sketchObjectId === 'string'
        ? hit.object.userData.sketchObjectId
        : null;
    },
    setInProgress(points, closed) {
      if (!points || points.length < 2) {
        inProgress.visible = false;
        return;
      }
      const vertices = points.map((point) => liftPoint(basis, point));
      if (closed && vertices.length > 2) {
        vertices.push(vertices[0]!.clone());
      }
      const geometry = new LineGeometry();
      geometry.setPositions(
        vertices.flatMap((vertex) => [vertex.x, vertex.y, vertex.z])
      );
      inProgress.geometry.dispose();
      inProgress.geometry = geometry;
      inProgress.computeLineDistances();
      const { width, height } = resolution();
      inProgressMaterial.resolution.set(
        Math.max(width, 1),
        Math.max(height, 1)
      );
      inProgress.visible = true;
    },
    setInference(segments) {
      if (!segments || segments.length === 0) {
        inferenceGroup.visible = false;
        inferenceGlowGroup.visible = false;
        return;
      }
      for (const [index, segment] of segments.entries()) {
        const positions = segment
          .map((point) => liftPoint(basis, point))
          .flatMap((point) => [point.x, point.y, point.z]);
        for (const line of [
          inferenceLine(
            inferenceLines,
            inferenceGroup,
            inferenceMaterial,
            index,
            VIEWPORT_RENDER_ORDER.ACTIVE_SKETCH
          ),
          inferenceLine(
            inferenceGlowLines,
            inferenceGlowGroup,
            inferenceGlowMaterial,
            index,
            VIEWPORT_RENDER_ORDER.ACTIVE_SKETCH - 1
          )
        ]) {
          const geometry = new LineGeometry();
          geometry.setPositions(positions);
          line.geometry.dispose();
          line.geometry = geometry;
          line.computeLineDistances();
          line.visible = true;
        }
      }
      for (
        let index = segments.length;
        index < inferenceLines.length;
        index += 1
      ) {
        inferenceLines[index]!.visible = false;
        inferenceGlowLines[index]!.visible = false;
      }
      const { width, height } = resolution();
      inferenceMaterial.resolution.set(Math.max(width, 1), Math.max(height, 1));
      inferenceGlowMaterial.resolution.set(
        Math.max(width, 1),
        Math.max(height, 1)
      );
      inferenceGroup.visible = true;
      inferenceGlowGroup.visible = true;
    },
    advanceInference(now, reducedMotion) {
      if (!inferenceGroup.visible || reducedMotion) {
        inferenceMaterial.dashOffset = 0;
        inferenceMaterial.opacity = 0.92;
        inferenceGlowMaterial.opacity = 0.16;
        return false;
      }
      const pulse = (Math.sin(now * 0.006) + 1) / 2;
      inferenceMaterial.dashOffset = -((now * 0.006) % 3.4);
      inferenceMaterial.opacity = 0.82 + pulse * 0.16;
      inferenceGlowMaterial.opacity = 0.1 + pulse * 0.14;
      return true;
    },
    setDiagnostics(points) {
      diagnostics.geometry.dispose();
      diagnostics.geometry = new THREE.BufferGeometry().setFromPoints(
        points.map((point) => liftPoint(basis, point))
      );
      diagnostics.visible = points.length > 0;
    },
    dispose() {
      group.removeFromParent();
      disposeChildren(committedGroup);
      disposeChildren(previewGroup);
      disposeChildren(profileGroup);
      disposeGrid();
      tint.geometry.dispose();
      tint.material.dispose();
      originMarker.geometry.dispose();
      originMaterial.dispose();
      inProgress.geometry.dispose();
      inProgressMaterial.dispose();
      for (const line of [...inferenceLines, ...inferenceGlowLines]) {
        line.geometry.dispose();
      }
      inferenceMaterial.dispose();
      inferenceGlowMaterial.dispose();
      diagnostics.geometry.dispose();
      diagnosticMaterial.dispose();
    }
  };
}
