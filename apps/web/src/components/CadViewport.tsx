import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Check, MousePointer2, Radius, X } from 'lucide-react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createObjectForBody, fitCameraToObjects } from '@openzcad/viewport';
import type {
  BodyId,
  BodyRepresentation,
  EditableDimension,
  PrimitiveGeometry
} from '@openzcad/shared';
import type {
  EdgeSelection,
  FaceSelection,
  GeometrySelection,
  ModelingTool
} from '../lib/selection';
import type { ViewPreset } from '../lib/view';

interface CadViewportProps {
  bodies: BodyRepresentation[];
  selectedBodyId: string | null;
  selection: GeometrySelection | null;
  activeTool: ModelingTool;
  viewPreset: ViewPreset;
  fitToken: number;
  onViewPresetChange(preset: ViewPreset): void;
  onSelectionChange(selection: GeometrySelection | null): void;
  onToolChange(tool: ModelingTool): void;
  onResizeCommit(
    bodyId: BodyId,
    dimension: EditableDimension,
    value: number
  ): void;
  onFilletCommit(bodyId: BodyId, edgeIds: string[], radius: number): void;
}

interface EdgeRecord {
  line: THREE.LineSegments;
  hitTarget: THREE.LineSegments;
  highlight: THREE.LineSegments;
  meshRecord: MeshRecord;
}

type CadMesh = THREE.Mesh<
  THREE.BufferGeometry,
  THREE.Material | THREE.Material[]
>;

interface MeshRecord {
  body: BodyRepresentation;
  bodyId: BodyId;
  mesh: CadMesh;
  meshIndex: number;
  materials: THREE.MeshStandardMaterial[];
  edges: EdgeRecord;
}

interface RuntimeState {
  refreshHighlights(): void;
}

interface DragState {
  pointerId: number;
  selection: FaceSelection;
  mesh: CadMesh;
  startX: number;
  startY: number;
  screenDirection: THREE.Vector2;
  basePosition: THREE.Vector3;
  baseScale: THREE.Vector3;
  baseValue: number;
  nextValue: number;
  moved: boolean;
}

type HoverSelection =
  | Pick<FaceSelection, 'kind' | 'bodyId' | 'materialIndex'>
  | Pick<EdgeSelection, 'kind' | 'bodyId' | 'meshIndex' | 'segmentIndex'>
  | null;

const neutralBody = new THREE.Color('#b8bec6');
const selectedBody = new THREE.Color('#d9e1e8');
const selectedFace = new THREE.Color('#23a9c4');
const hoverFace = new THREE.Color('#8bd7e6');

export function CadViewport(props: CadViewportProps) {
  const {
    bodies,
    selectedBodyId,
    selection,
    activeTool,
    viewPreset,
    fitToken,
    onViewPresetChange,
    onSelectionChange,
    onToolChange,
    onResizeCommit,
    onFilletCommit
  } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<RuntimeState | null>(null);
  const bodiesRef = useRef(bodies);
  bodiesRef.current = bodies;
  const bodiesSignature = useMemo(() => JSON.stringify(bodies), [bodies]);
  const latestRef = useRef({
    selectedBodyId,
    selection,
    activeTool,
    onSelectionChange,
    onResizeCommit
  });
  latestRef.current = {
    selectedBodyId,
    selection,
    activeTool,
    onSelectionChange,
    onResizeCommit
  };
  const [filletRadius, setFilletRadius] = useState(2);

  useEffect(() => {
    runtimeRef.current?.refreshHighlights();
  }, [selection, selectedBodyId, activeTool]);

  useEffect(() => {
    if (selection?.kind === 'edge') {
      setFilletRadius((current) =>
        clamp(current, 0.1, Math.max(0.1, selection.maxFilletRadius))
      );
    }
  }, [selection?.kind, selection?.kind === 'edge' ? selection.edgeKey : null]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const renderedBodies = bodiesRef.current;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#171a1e');
    scene.fog = new THREE.Fog('#171a1e', 220, 520);

    const camera = new THREE.PerspectiveCamera(
      38,
      Math.max(host.clientWidth, 1) / Math.max(host.clientHeight, 1),
      0.1,
      1600
    );
    camera.up.set(0, 0, 1);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance'
    });
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.16;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.setAttribute('aria-label', 'Interactive CAD viewport');
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;
    controls.target.set(0, 0, 0);

    scene.add(new THREE.HemisphereLight('#edf7ff', '#111419', 1.5));
    const keyLight = new THREE.DirectionalLight('#ffffff', 3.2);
    keyLight.position.set(110, -90, 150);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = 500;
    keyLight.shadow.bias = -0.0008;
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight('#73bfe7', 1.1);
    fillLight.position.set(-100, 40, 70);
    scene.add(fillLight);
    const rimLight = new THREE.DirectionalLight('#ffe2c4', 0.8);
    rimLight.position.set(30, 120, 50);
    scene.add(rimLight);

    const grid = new THREE.GridHelper(320, 64, '#394149', '#242a30');
    grid.rotateX(Math.PI / 2);
    const gridMaterial = grid.material as THREE.Material | THREE.Material[];
    const gridMaterials: THREE.Material[] = Array.isArray(gridMaterial)
      ? gridMaterial
      : [gridMaterial];
    for (const material of gridMaterials) {
      material.transparent = true;
      material.opacity = 0.42;
      material.depthWrite = false;
    }
    scene.add(grid);

    const bodyById = new Map(renderedBodies.map((body) => [body.bodyId, body]));
    const sceneObjects: THREE.Object3D[] = [];
    const meshRecords: MeshRecord[] = [];
    const meshObjects: CadMesh[] = [];
    const edgeObjects: THREE.LineSegments[] = [];
    const edgeByUuid = new Map<string, EdgeRecord>();
    let hover: HoverSelection = null;

    for (const body of renderedBodies) {
      const object = createObjectForBody(body);
      scene.add(object);
      sceneObjects.push(object);

      const meshes: CadMesh[] = [];
      object.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          meshes.push(child as CadMesh);
        }
      });

      meshes.forEach((mesh, meshIndex) => {
        const bodyId =
          (mesh.userData.bodyId as BodyId | undefined) ?? body.bodyId;
        const representedBody = bodyById.get(bodyId) ?? body;
        const sourceColor = new THREE.Color(representedBody.color).lerp(
          neutralBody,
          0.76
        );
        const groupMaterialCount = Math.max(
          1,
          ...mesh.geometry.groups.map((group) => (group.materialIndex ?? 0) + 1)
        );
        const materials = Array.from(
          { length: groupMaterialCount },
          () =>
            new THREE.MeshStandardMaterial({
              color: sourceColor,
              metalness: 0.1,
              roughness: 0.42,
              envMapIntensity: 0.8
            })
        );
        const previousMaterials = Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material];
        previousMaterials.forEach((material) => material.dispose());
        mesh.material = materials;

        const silhouette = new THREE.Mesh(
          mesh.geometry,
          new THREE.MeshBasicMaterial({
            color: '#07090b',
            side: THREE.BackSide,
            transparent: true,
            opacity: 0.94
          })
        );
        silhouette.scale.setScalar(1.009);
        silhouette.renderOrder = -2;
        mesh.add(silhouette);

        const edgeGeometry = new THREE.EdgesGeometry(mesh.geometry, 18);
        const edgeLine = new THREE.LineSegments(
          edgeGeometry,
          new THREE.LineBasicMaterial({
            color: '#090b0d',
            transparent: true,
            opacity: 0.92
          })
        );
        edgeLine.userData.bodyId = bodyId;
        edgeLine.userData.meshIndex = meshIndex;
        edgeLine.renderOrder = 8;
        mesh.add(edgeLine);

        const selectionSource =
          representedBody.geometry.kind === 'box'
            ? new THREE.BoxGeometry(
                representedBody.geometry.dimensions.width ?? 1,
                representedBody.geometry.dimensions.height ?? 1,
                representedBody.geometry.dimensions.depth ?? 1
              )
            : mesh.geometry;
        const selectionEdgeGeometry = new THREE.EdgesGeometry(
          selectionSource,
          18
        );
        if (selectionSource !== mesh.geometry) {
          selectionSource.dispose();
        }
        const hitLine = new THREE.LineSegments(
          selectionEdgeGeometry,
          new THREE.LineBasicMaterial({
            transparent: true,
            opacity: 0,
            depthWrite: false,
            colorWrite: false
          })
        );
        hitLine.userData.bodyId = bodyId;
        hitLine.userData.meshIndex = meshIndex;
        mesh.add(hitLine);

        const highlightGeometry = selectionEdgeGeometry.clone();
        highlightGeometry.setDrawRange(0, 0);
        const highlightLine = new THREE.LineSegments(
          highlightGeometry,
          new THREE.LineBasicMaterial({ color: '#63e6ff', depthTest: false })
        );
        highlightLine.visible = false;
        highlightLine.renderOrder = 12;
        mesh.add(highlightLine);

        const record: MeshRecord = {
          body: representedBody,
          bodyId,
          mesh,
          meshIndex,
          materials,
          edges: undefined as unknown as EdgeRecord
        };
        const edgeRecord = {
          line: edgeLine,
          hitTarget: hitLine,
          highlight: highlightLine,
          meshRecord: record
        };
        record.edges = edgeRecord;
        meshRecords.push(record);
        meshObjects.push(mesh);
        edgeObjects.push(hitLine);
        edgeByUuid.set(hitLine.uuid, edgeRecord);
      });
    }

    const objectBounds = new THREE.Box3();
    sceneObjects.forEach((object) => objectBounds.expandByObject(object));
    if (!objectBounds.isEmpty()) {
      grid.position.z = objectBounds.min.z - 0.12;
      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(480, 480),
        new THREE.ShadowMaterial({ color: '#000000', opacity: 0.25 })
      );
      floor.position.z = objectBounds.min.z - 0.08;
      floor.receiveShadow = true;
      scene.add(floor);
    }

    function refreshHighlights() {
      const selected = latestRef.current.selection;
      const bodySelection = latestRef.current.selectedBodyId;
      for (const record of meshRecords) {
        const isSelectedBody = record.bodyId === bodySelection;
        record.materials.forEach((material, materialIndex) => {
          const faceIsSelected =
            selected?.kind === 'face' &&
            selected.bodyId === record.bodyId &&
            selected.materialIndex === materialIndex;
          const faceIsHovered =
            hover?.kind === 'face' &&
            hover.bodyId === record.bodyId &&
            hover.materialIndex === materialIndex;
          material.color.copy(
            faceIsSelected
              ? selectedFace
              : faceIsHovered
                ? hoverFace
                : isSelectedBody
                  ? selectedBody
                  : new THREE.Color(record.body.color).lerp(neutralBody, 0.76)
          );
          material.emissive.set(
            faceIsSelected ? '#062e36' : faceIsHovered ? '#071d22' : '#000000'
          );
        });

        const edgeSelection =
          selected?.kind === 'edge' &&
          selected.bodyId === record.bodyId &&
          selected.meshIndex === record.meshIndex
            ? selected
            : hover?.kind === 'edge' &&
                hover.bodyId === record.bodyId &&
                hover.meshIndex === record.meshIndex
              ? hover
              : null;
        record.edges.highlight.visible = Boolean(edgeSelection);
        record.edges.highlight.geometry.setDrawRange(
          edgeSelection ? edgeSelection.segmentIndex * 2 : 0,
          edgeSelection ? 2 : 0
        );
        const lineMaterial = record.edges.line
          .material as THREE.LineBasicMaterial;
        lineMaterial.color.set(isSelectedBody ? '#101820' : '#090b0d');
        lineMaterial.opacity = isSelectedBody ? 1 : 0.9;
      }
    }

    runtimeRef.current = { refreshHighlights };
    refreshHighlights();

    const applyViewPreset = (preset: ViewPreset) => {
      const box = new THREE.Box3();
      sceneObjects.forEach((object) => box.expandByObject(object));
      if (box.isEmpty()) {
        fitCameraToObjects(camera, controls.target, sceneObjects);
        return;
      }
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const distance = Math.max(size.x, size.y, size.z, 16) * 2.55;
      const direction =
        preset === 'top'
          ? new THREE.Vector3(0, 0, 1)
          : preset === 'front'
            ? new THREE.Vector3(0, -1, 0.12)
            : preset === 'right'
              ? new THREE.Vector3(1, -0.08, 0.16)
              : new THREE.Vector3(1, -1, 0.72).normalize();
      camera.position.copy(
        center.clone().add(direction.normalize().multiplyScalar(distance))
      );
      controls.target.copy(center);
      camera.near = 0.1;
      camera.far = Math.max(distance * 20, 1000);
      camera.updateProjectionMatrix();
      controls.update();
    };
    applyViewPreset(viewPreset);

    const raycaster = new THREE.Raycaster();
    // Keep the rendered edge crisp while giving it a forgiving, touch-like pick target.
    raycaster.params.Line = { threshold: 1.6 };
    const pointer = new THREE.Vector2();
    let drag: DragState | null = null;

    function setPointer(event: PointerEvent) {
      const bounds = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
      pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      return bounds;
    }

    function pick(event: PointerEvent): GeometrySelection | null {
      const bounds = setPointer(event);
      const edgeHit = raycaster.intersectObjects(edgeObjects, false)[0];
      const faceHit = raycaster.intersectObjects(meshObjects, false)[0];
      let edgeRecord = edgeHit
        ? edgeByUuid.get(edgeHit.object.uuid)
        : undefined;
      let segmentIndex = edgeHit ? Math.floor((edgeHit.index ?? 0) / 2) : -1;
      let edgeDistance = edgeHit?.distanceToRay ?? Number.POSITIVE_INFINITY;

      if (faceHit?.object instanceof THREE.Mesh) {
        const meshRecord = meshRecords.find(
          (record) => record.mesh === faceHit.object
        );
        if (meshRecord) {
          const nearest = nearestEdgeSegment(
            meshRecord.edges.hitTarget,
            faceHit.point
          );
          if (!edgeRecord || nearest.distance < edgeDistance) {
            edgeRecord = meshRecord.edges;
            segmentIndex = nearest.segmentIndex;
            edgeDistance = nearest.distance;
          }
        }
      }

      const edgeTolerance =
        latestRef.current.activeTool === 'fillet' ? 2.8 : 1.8;
      const shouldPreferEdge =
        Boolean(edgeRecord) && edgeDistance <= edgeTolerance;

      if (edgeRecord && shouldPreferEdge) {
        const { body, bodyId, meshIndex } = edgeRecord.meshRecord;
        return {
          kind: 'edge',
          bodyId,
          bodyName: body.name,
          edgeKey: `${bodyId}:m${meshIndex}:e${segmentIndex}`,
          meshIndex,
          segmentIndex,
          anchor: {
            x: event.clientX - bounds.left,
            y: event.clientY - bounds.top
          },
          filletSupported: body.geometry.kind === 'box',
          maxFilletRadius: maximumFilletRadius(body.geometry)
        };
      }

      if (
        !faceHit ||
        !(faceHit.object instanceof THREE.Mesh) ||
        !faceHit.face
      ) {
        return null;
      }
      const meshRecord = meshRecords.find(
        (record) => record.mesh === faceHit.object
      );
      if (!meshRecord) {
        return null;
      }
      return faceSelectionFromHit(meshRecord, faceHit, bounds, event);
    }

    function onPointerDown(event: PointerEvent) {
      if (event.button !== 0) {
        return;
      }
      const picked = pick(event);
      if (!picked) {
        latestRef.current.onSelectionChange(null);
        hover = null;
        refreshHighlights();
        return;
      }

      latestRef.current.onSelectionChange(picked);
      hover = null;
      refreshHighlights();
      controls.enabled = false;
      renderer.domElement.setPointerCapture(event.pointerId);
      event.preventDefault();

      if (picked.kind !== 'face') {
        drag = null;
        return;
      }
      const faceHit = raycaster.intersectObjects(meshObjects, false)[0];
      if (!faceHit || !(faceHit.object instanceof THREE.Mesh)) {
        return;
      }
      const faceMesh = faceHit.object as CadMesh;
      const direction = projectedNormalDirection(
        faceHit.point,
        faceHit.face?.normal ?? new THREE.Vector3(0, 0, 1),
        faceMesh,
        camera,
        renderer.domElement
      );
      drag = {
        pointerId: event.pointerId,
        selection: picked,
        mesh: faceMesh,
        startX: event.clientX,
        startY: event.clientY,
        screenDirection: direction,
        basePosition: faceHit.object.position.clone(),
        baseScale: faceHit.object.scale.clone(),
        baseValue: picked.value,
        nextValue: picked.value,
        moved: false
      };
    }

    function onPointerMove(event: PointerEvent) {
      if (drag && drag.pointerId === event.pointerId) {
        const movement = new THREE.Vector2(
          event.clientX - drag.startX,
          event.clientY - drag.startY
        );
        const projectedPixels = movement.dot(drag.screenDirection);
        if (movement.length() > 3) {
          drag.moved = true;
        }
        if (!drag.moved) {
          return;
        }
        const unitsPerPixel = clamp(drag.baseValue / 150, 0.025, 0.5);
        drag.nextValue = clamp(
          drag.baseValue + projectedPixels * unitsPerPixel,
          0.5,
          10000
        );
        applyDimensionPreview(drag);
        const bounds = renderer.domElement.getBoundingClientRect();
        latestRef.current.onSelectionChange({
          ...drag.selection,
          value: drag.nextValue,
          anchor: {
            x: event.clientX - bounds.left,
            y: event.clientY - bounds.top
          }
        });
        return;
      }

      const picked = pick(event);
      hover = picked
        ? picked.kind === 'face'
          ? {
              kind: 'face',
              bodyId: picked.bodyId,
              materialIndex: picked.materialIndex
            }
          : {
              kind: 'edge',
              bodyId: picked.bodyId,
              meshIndex: picked.meshIndex,
              segmentIndex: picked.segmentIndex
            }
        : null;
      renderer.domElement.style.cursor = picked
        ? latestRef.current.activeTool === 'fillet' || picked.kind === 'edge'
          ? 'crosshair'
          : 'grab'
        : 'default';
      refreshHighlights();
    }

    function finishPointer(event: PointerEvent, commit: boolean) {
      if (renderer.domElement.hasPointerCapture(event.pointerId)) {
        renderer.domElement.releasePointerCapture(event.pointerId);
      }
      controls.enabled = true;
      if (drag && drag.pointerId === event.pointerId) {
        const completedDrag = drag;
        drag = null;
        if (completedDrag.moved && commit) {
          latestRef.current.onResizeCommit(
            completedDrag.selection.bodyId,
            completedDrag.selection.dimension,
            Number(completedDrag.nextValue.toFixed(2))
          );
        } else if (!commit) {
          completedDrag.mesh.position.copy(completedDrag.basePosition);
          completedDrag.mesh.scale.copy(completedDrag.baseScale);
        }
      }
    }

    const onPointerUp = (event: PointerEvent) => finishPointer(event, true);
    const onPointerCancel = (event: PointerEvent) =>
      finishPointer(event, false);
    const onPointerLeave = () => {
      if (!drag) {
        hover = null;
        refreshHighlights();
      }
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown, {
      capture: true
    });
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointercancel', onPointerCancel);
    renderer.domElement.addEventListener('pointerleave', onPointerLeave);

    const resizeObserver = new ResizeObserver(() => {
      const width = Math.max(host.clientWidth, 1);
      const height = Math.max(host.clientHeight, 1);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    });
    resizeObserver.observe(host);

    let animationFrame = 0;
    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
      animationFrame = window.requestAnimationFrame(animate);
    };
    animate();

    return () => {
      runtimeRef.current = null;
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown, {
        capture: true
      });
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointercancel', onPointerCancel);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      controls.dispose();
      scene.traverse((object) => {
        if (
          object instanceof THREE.Mesh ||
          object instanceof THREE.LineSegments
        ) {
          const renderable = object as THREE.Mesh<
            THREE.BufferGeometry,
            THREE.Material | THREE.Material[]
          >;
          renderable.geometry.dispose();
          const materials: THREE.Material[] = Array.isArray(renderable.material)
            ? renderable.material
            : [renderable.material];
          materials.forEach((material) => material.dispose());
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [bodiesSignature, viewPreset, fitToken]);

  const filletSelection = selection?.kind === 'edge' ? selection : null;
  const faceSelection = selection?.kind === 'face' ? selection : null;

  return (
    <div className={`viewport-shell is-tool-${activeTool}`}>
      <div className="viewport" ref={hostRef} />

      <div className="viewport-overlay viewport-overlay--top">
        <div
          className={`mode-indicator ${activeTool === 'fillet' ? 'is-active' : ''}`}
        >
          {activeTool === 'fillet' ? (
            <Radius size={15} />
          ) : (
            <MousePointer2 size={15} />
          )}
          <span>{activeTool === 'fillet' ? 'Fillet tool' : 'Select'}</span>
        </div>
        <div className="view-dock" aria-label="View orientation">
          {(['top', 'front', 'right', 'iso'] as ViewPreset[]).map((preset) => (
            <button
              key={preset}
              className={`view-dock__button ${viewPreset === preset ? 'is-active' : ''}`}
              onClick={() => onViewPresetChange(preset)}
            >
              {preset === 'iso' ? 'ISO' : capitalize(preset)}
            </button>
          ))}
        </div>
      </div>

      {activeTool === 'fillet' && !filletSelection ? (
        <div className="tool-coach" role="status">
          <Radius size={18} />
          <div>
            <strong>Select an edge</strong>
            <span>Pick a box edge to set its fillet radius.</span>
          </div>
          <button
            onClick={() => onToolChange('select')}
            aria-label="Exit fillet tool"
          >
            <X size={16} />
          </button>
        </div>
      ) : null}

      {faceSelection ? (
        <FaceValueControl
          selection={faceSelection}
          onCommit={(value) =>
            onResizeCommit(faceSelection.bodyId, faceSelection.dimension, value)
          }
        />
      ) : null}

      {filletSelection ? (
        <div
          className="direct-control direct-control--edge"
          style={{
            left: filletSelection.anchor.x,
            top: filletSelection.anchor.y
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {activeTool === 'fillet' ? (
            <>
              <div className="direct-control__heading">
                <span className="selection-glyph selection-glyph--edge" />
                <div>
                  <strong>Fillet edge</strong>
                  <small>{filletSelection.bodyName}</small>
                </div>
              </div>
              {filletSelection.filletSupported ? (
                <>
                  <label className="direct-control__field">
                    <span>Radius</span>
                    <div>
                      <input
                        type="number"
                        min="0.1"
                        max={filletSelection.maxFilletRadius}
                        step="0.1"
                        value={filletRadius}
                        onChange={(event) =>
                          setFilletRadius(Number(event.target.value))
                        }
                      />
                      <span>mm</span>
                    </div>
                  </label>
                  <input
                    className="direct-control__range"
                    type="range"
                    min="0.1"
                    max={filletSelection.maxFilletRadius}
                    step="0.1"
                    value={filletRadius}
                    onChange={(event) =>
                      setFilletRadius(Number(event.target.value))
                    }
                  />
                  <p>
                    Selected-edge intent is saved; the beta preview rounds the
                    box edge set.
                  </p>
                  <div className="direct-control__actions">
                    <button
                      className="control-button"
                      onClick={() => onToolChange('select')}
                    >
                      Cancel
                    </button>
                    <button
                      className="control-button control-button--primary"
                      onClick={() =>
                        onFilletCommit(
                          filletSelection.bodyId,
                          [filletSelection.edgeKey],
                          clamp(
                            filletRadius,
                            0.1,
                            filletSelection.maxFilletRadius
                          )
                        )
                      }
                    >
                      <Check size={15} /> Apply
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p>
                    This preview kernel supports fillets on box solids. The edge
                    remains selected.
                  </p>
                  <button
                    className="control-button"
                    onClick={() => onToolChange('select')}
                  >
                    Done
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <div className="direct-control__heading">
                <span className="selection-glyph selection-glyph--edge" />
                <div>
                  <strong>Edge selected</strong>
                  <small>{filletSelection.bodyName}</small>
                </div>
              </div>
              <button
                className="control-button control-button--primary control-button--wide"
                disabled={!filletSelection.filletSupported}
                onClick={() => onToolChange('fillet')}
              >
                <Radius size={15} /> Fillet this edge
              </button>
            </>
          )}
        </div>
      ) : null}

      <div className="viewport-overlay viewport-overlay--bottom">
        <div className="axis-widget">
          <button
            className="axis-widget__button axis-widget__button--x"
            onClick={() => onViewPresetChange('right')}
          >
            X
          </button>
          <button
            className="axis-widget__button axis-widget__button--y"
            onClick={() => onViewPresetChange('front')}
          >
            Y
          </button>
          <button
            className="axis-widget__button axis-widget__button--z"
            onClick={() => onViewPresetChange('top')}
          >
            Z
          </button>
        </div>
        <p className="viewport-hint">
          Drag a face to resize · Click an edge for fillet · Drag empty space to
          orbit
        </p>
      </div>
    </div>
  );
}

function FaceValueControl({
  selection,
  onCommit
}: {
  selection: FaceSelection;
  onCommit(value: number): void;
}) {
  const [value, setValue] = useState(selection.value.toFixed(2));

  useEffect(() => {
    setValue(selection.value.toFixed(2));
  }, [selection.faceKey, selection.value]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const nextValue = Number(value);
    if (Number.isFinite(nextValue) && nextValue > 0.1) {
      onCommit(Number(nextValue.toFixed(2)));
    }
  }

  return (
    <form
      className="direct-control direct-control--face"
      style={{ left: selection.anchor.x, top: selection.anchor.y }}
      onSubmit={submit}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="direct-control__heading">
        <span className="selection-glyph selection-glyph--face" />
        <div>
          <strong>{capitalize(selection.dimension)}</strong>
          <small>Drag face or enter a value</small>
        </div>
      </div>
      <div className="direct-value">
        <input
          aria-label={`${selection.dimension} value`}
          type="number"
          min="0.1"
          step="0.1"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <span>mm</span>
        <button type="submit" aria-label="Apply dimension">
          <Check size={14} />
        </button>
      </div>
    </form>
  );
}

function faceSelectionFromHit(
  record: MeshRecord,
  hit: THREE.Intersection<THREE.Object3D>,
  bounds: DOMRect,
  event: PointerEvent
): FaceSelection | null {
  if (
    record.body.geometry.kind === 'mesh' ||
    record.body.geometry.kind === 'composite'
  ) {
    return null;
  }
  const normal = hit.face?.normal.clone() ?? new THREE.Vector3(0, 0, 1);
  const axis = dominantAxis(normal);
  const side = normal[axis] >= 0 ? 1 : -1;
  const dimension = dimensionForFace(record.body.geometry, axis);
  const value = record.body.geometry.dimensions[dimension];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const materialIndex = hit.face?.materialIndex ?? 0;
  return {
    kind: 'face',
    primitiveKind: record.body.geometry.kind,
    bodyId: record.bodyId,
    bodyName: record.body.name,
    faceKey: `${record.bodyId}:m${record.meshIndex}:f${materialIndex}`,
    materialIndex,
    dimension,
    axis,
    side,
    value,
    anchor: { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
  };
}

function dimensionForFace(
  geometry: PrimitiveGeometry,
  axis: 'x' | 'y' | 'z'
): EditableDimension {
  if (geometry.kind === 'sphere') {
    return 'radius';
  }
  if (geometry.kind === 'cylinder') {
    return axis === 'y' ? 'height' : 'radius';
  }
  return axis === 'x' ? 'width' : axis === 'y' ? 'height' : 'depth';
}

function dominantAxis(vector: THREE.Vector3): 'x' | 'y' | 'z' {
  const x = Math.abs(vector.x);
  const y = Math.abs(vector.y);
  const z = Math.abs(vector.z);
  return x >= y && x >= z ? 'x' : y >= z ? 'y' : 'z';
}

function projectedNormalDirection(
  point: THREE.Vector3,
  localNormal: THREE.Vector3,
  mesh: THREE.Mesh,
  camera: THREE.Camera,
  canvas: HTMLCanvasElement
): THREE.Vector2 {
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const worldNormal = localNormal
    .clone()
    .applyMatrix3(normalMatrix)
    .normalize();
  const start = point.clone().project(camera);
  const end = point.clone().add(worldNormal.multiplyScalar(10)).project(camera);
  const direction = new THREE.Vector2(
    (end.x - start.x) * canvas.clientWidth * 0.5,
    -(end.y - start.y) * canvas.clientHeight * 0.5
  );
  return direction.lengthSq() > 0.001
    ? direction.normalize()
    : new THREE.Vector2(0, -1);
}

function applyDimensionPreview(drag: DragState) {
  const ratio = drag.nextValue / drag.baseValue;
  drag.mesh.scale.copy(drag.baseScale);
  drag.mesh.position.copy(drag.basePosition);

  if (drag.selection.dimension === 'radius') {
    drag.mesh.scale.x = drag.baseScale.x * ratio;
    drag.mesh.scale.z = drag.baseScale.z * ratio;
    if (drag.selection.primitiveKind === 'sphere') {
      drag.mesh.scale.y = drag.baseScale.y * ratio;
    }
    return;
  }

  const axis = drag.selection.axis;
  drag.mesh.scale[axis] = drag.baseScale[axis] * ratio;
  const delta = drag.nextValue - drag.baseValue;
  const offset = new THREE.Vector3();
  offset[axis] = (delta / 2) * drag.selection.side;
  offset.applyQuaternion(drag.mesh.quaternion);
  drag.mesh.position.add(offset);
}

function maximumFilletRadius(geometry: BodyRepresentation['geometry']): number {
  if (geometry.kind !== 'box') {
    return 0.1;
  }
  return Math.max(
    0.1,
    Math.min(
      geometry.dimensions.width ?? 1,
      geometry.dimensions.height ?? 1,
      geometry.dimensions.depth ?? 1
    ) /
      2 -
      0.05
  );
}

function nearestEdgeSegment(
  line: THREE.LineSegments,
  worldPoint: THREE.Vector3
) {
  const point = line.worldToLocal(worldPoint.clone());
  const positions = line.geometry.getAttribute('position');
  const segment = new THREE.Line3();
  const closest = new THREE.Vector3();
  let nearestDistance = Number.POSITIVE_INFINITY;
  let nearestIndex = 0;

  for (
    let vertexIndex = 0;
    vertexIndex + 1 < positions.count;
    vertexIndex += 2
  ) {
    segment.start.fromBufferAttribute(positions, vertexIndex);
    segment.end.fromBufferAttribute(positions, vertexIndex + 1);
    segment.closestPointToPoint(point, true, closest);
    const distance = closest.distanceTo(point);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = vertexIndex / 2;
    }
  }

  return { distance: nearestDistance, segmentIndex: nearestIndex };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function capitalize(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
