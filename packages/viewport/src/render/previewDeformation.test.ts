import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { toBodyId, type BodyRepresentation } from '@openzcad/shared';
import { createBodyEdgeOverlay } from './edgeOverlay';
import { silhouetteCandidates, updateSilhouette } from './silhouette';
import { createLinearProfilePreview } from '../gizmo/cylinderProfilePreview';
import {
  createStepStretchPreview,
  stepPreviewKey,
  type StepPreviewProfile
} from '../gizmo/stepStretchPreview';

/**
 * In-place drag previews against the batches under a body that are refilled
 * rather than fixed: the curved-surface outline, repacked per view, and the
 * hover/selection highlights, rebuilt per target. A preview that edited
 * their slots drew interior mesh edges as black specks on a moving fillet,
 * and lit a hovered edge where it was before the drag.
 */

/** A sphere (one curved face) standing in for a blend, and one edge on it. */
function sphereBody(): BodyRepresentation {
  const geometry = new THREE.SphereGeometry(5, 24, 16);
  geometry.translate(0, 20, 0);
  const vertices = Float32Array.from(geometry.getAttribute('position').array);
  const indices = Uint32Array.from(geometry.getIndex()!.array);
  geometry.dispose();
  const triangleCount = indices.length / 3;
  const points: number[] = [];
  for (let i = 0; i <= 8; i += 1) points.push(5, 16 + i, 0);
  return {
    bodyId: toBodyId('body_probe'),
    name: 'Probe',
    source: 'primitive',
    mesh: { kind: 'mesh', vertices, indices },
    faceCount: 1,
    color: '#99a0b2',
    consumed: false,
    exportableStep: true,
    volume: 1,
    bbox: { min: { x: -5, y: 15, z: -5 }, max: { x: 5, y: 25, z: 5 } },
    topology: {
      faces: [
        { topologyId: 'face:1', hash: 1, triangleStart: 0, triangleCount }
      ],
      edges: [{ topologyId: 'edge:1', hash: 11, points }]
    }
  };
}

/** The body as the viewer installs it: its mesh with the edge overlay. */
function install(body: BodyRepresentation) {
  const mesh = new THREE.Mesh(
    new THREE.BufferGeometry()
      .setAttribute(
        'position',
        new THREE.BufferAttribute(Float32Array.from(body.mesh.vertices), 3)
      )
      .setIndex(
        new THREE.BufferAttribute(Uint32Array.from(body.mesh.indices), 1)
      ),
    new THREE.MeshStandardMaterial()
  );
  const overlay = createBodyEdgeOverlay(body, { width: 800, height: 600 });
  mesh.add(overlay);
  mesh.updateMatrixWorld(true);
  return { mesh, overlay, silhouette: overlay.silhouetteEdges! };
}

function camera() {
  const view = new THREE.PerspectiveCamera(40, 4 / 3, 0.1, 1000);
  view.position.set(0, 20, 80);
  view.lookAt(0, 20, 0);
  view.updateMatrixWorld(true);
  return view;
}

/** The drawn segments of a fat-line batch, rounded for comparison. */
function drawnSegments(line: LineSegments2): string[] {
  const start = line.geometry.getAttribute(
    'instanceStart'
  ) as THREE.InterleavedBufferAttribute;
  const end = line.geometry.getAttribute(
    'instanceEnd'
  ) as THREE.InterleavedBufferAttribute;
  const segments: string[] = [];
  for (let i = 0; i < line.geometry.instanceCount; i += 1) {
    segments.push(
      [
        start.getX(i),
        start.getY(i),
        start.getZ(i),
        end.getX(i),
        end.getY(i),
        end.getZ(i)
      ]
        .map((value) => value.toFixed(3))
        .join(',')
    );
  }
  return segments.sort();
}

/**
 * The outline `view` should see once every candidate has moved by `move`:
 * the moved candidates whose neighbours straddle the eye ray.
 */
function expectedOutline(
  body: BodyRepresentation,
  view: THREE.Camera,
  move: (point: THREE.Vector3) => void
): string[] {
  const candidates = silhouetteCandidates(body.mesh, body.topology!.faces)!;
  const eye = new THREE.Vector3().setFromMatrixPosition(view.matrixWorld);
  const { positions, normalsA, normalsB } = candidates;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const outline: string[] = [];
  for (let i = 0; i < positions.length / 6; i += 1) {
    a.fromArray(positions, i * 6);
    b.fromArray(positions, i * 6 + 3);
    move(a);
    move(b);
    const to = eye.clone().sub(a.clone().add(b).multiplyScalar(0.5));
    const facingA = new THREE.Vector3().fromArray(normalsA, i * 3).dot(to);
    const facingB = new THREE.Vector3().fromArray(normalsB, i * 3).dot(to);
    if (facingA * facingB > 0) continue;
    outline.push(
      [a.x, a.y, a.z, b.x, b.y, b.z].map((value) => value.toFixed(3)).join(',')
    );
  }
  return outline.sort();
}

const origin = { x: -6, y: 10, z: -6 };
const quantum = 30 / (1 << 17);

/** Pulls the sphere's upper half, and the edge's upper samples, along +y. */
function upperHalfStep(body: BodyRepresentation): StepPreviewProfile {
  const movingKeys = new Set<number>();
  const add = (points: ArrayLike<number>) => {
    for (let i = 0; i < points.length; i += 3) {
      if (points[i + 1]! > 20.5) {
        movingKeys.add(
          stepPreviewKey(
            points[i]!,
            points[i + 1]!,
            points[i + 2]!,
            origin,
            quantum
          )
        );
      }
    }
  };
  add(body.mesh.vertices);
  add(body.topology!.edges[0]!.points);
  return {
    normal: { x: 0, y: 1, z: 0 },
    origin,
    quantum,
    movingKeys,
    span: 100,
    reach: Infinity
  };
}

const stepMove = (delta: number) => (point: THREE.Vector3) => {
  if (point.y > 20.5) point.y += delta;
};

/** Stretches everything below y = 18 and carries the rest rigidly. */
const linearProfile = {
  axisStart: { x: 0, y: 0, z: 0 },
  axisEnd: { x: 0, y: 18, z: 0 }
};
const linearMove = (delta: number) => (point: THREE.Vector3) => {
  point.y += delta * THREE.MathUtils.clamp(point.y / 18, 0, 1);
};

const previews = [
  {
    name: 'step stretch',
    begin: (mesh: THREE.Mesh, body: BodyRepresentation) =>
      createStepStretchPreview(mesh, upperHalfStep(body))!,
    move: stepMove
  },
  {
    name: 'linear profile',
    begin: (mesh: THREE.Mesh) =>
      createLinearProfilePreview(mesh, linearProfile)!,
    move: linearMove
  }
];

describe.each(previews)('a $name preview', ({ begin, move }) => {
  it('draws only the outline when it began before the body was first drawn', () => {
    const body = sphereBody();
    const { mesh, silhouette } = install(body);
    // The exact frame was just installed; the pointer moves before it draws.
    const preview = begin(mesh, body);
    expect(preview).not.toBeNull();
    const view = camera();
    updateSilhouette(silhouette, view);
    expect(drawnSegments(silhouette)).toEqual(
      expectedOutline(body, view, move(0))
    );

    expect(preview.apply(0.5)).toBe(true);
    // Same eye: the frame after the move draws without picking again, so
    // the move itself must have left the buffer holding the outline.
    expect(updateSilhouette(silhouette, view)).toBe(false);
    const drawn = drawnSegments(silhouette);
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn).toEqual(expectedOutline(body, view, move(0.5)));

    expect(preview.apply(3)).toBe(true);
    expect(drawnSegments(silhouette)).toEqual(
      expectedOutline(body, view, move(3))
    );
    // Culling sees the moved surface.
    expect(silhouette.geometry.boundingBox!.max.y).toBeCloseTo(28, 3);

    preview.restore();
    expect(drawnSegments(silhouette)).toEqual(
      expectedOutline(body, view, move(0))
    );
    expect(silhouette.geometry.boundingBox!.max.y).toBeCloseTo(25, 3);
  });

  it('keeps the outline of a body already drawn', () => {
    const body = sphereBody();
    const { mesh, silhouette } = install(body);
    const view = camera();
    updateSilhouette(silhouette, view);
    const preview = begin(mesh, body);
    preview.apply(2);
    expect(updateSilhouette(silhouette, view)).toBe(false);
    expect(drawnSegments(silhouette)).toEqual(
      expectedOutline(body, view, move(2))
    );
    // A new view picks from the moved surface too.
    view.position.set(60, 40, 50);
    view.lookAt(0, 20, 0);
    view.updateMatrixWorld(true);
    expect(updateSilhouette(silhouette, view)).toBe(true);
    expect(drawnSegments(silhouette)).toEqual(
      expectedOutline(body, view, move(2))
    );
  });

  it('lights a hovered edge where its resting line has moved to', () => {
    const body = sphereBody();
    const { mesh, overlay } = install(body);
    const preview = begin(mesh, body);
    expect(preview.apply(14)).toBe(true);
    const idle = drawnSegments(overlay.idleEdges);
    // The resting edge did move: it no longer ends at y = 24.
    expect(idle.some((segment) => segment.endsWith('38.000,0.000'))).toBe(true);

    overlay.setHovered({
      bodyId: body.bodyId,
      topologyId: 'edge:1',
      hash: 11
    });
    expect(drawnSegments(overlay.hoverEdges)).toEqual(idle);
    expect(drawnSegments(overlay.hoverHiddenEdges)).toEqual(idle);

    // A highlight already lit follows the drag, and the release puts it back.
    preview.apply(4);
    expect(drawnSegments(overlay.hoverEdges)).toEqual(
      drawnSegments(overlay.idleEdges)
    );
    preview.restore();
    const rest = drawnSegments(overlay.idleEdges);
    expect(rest.some((segment) => segment.endsWith('24.000,0.000'))).toBe(true);
    expect(drawnSegments(overlay.hoverEdges)).toEqual(rest);
    expect(drawnSegments(overlay.hoverHiddenEdges)).toEqual(rest);
  });

  it('moves a selected edge with the drag', () => {
    const body = sphereBody();
    const { mesh, overlay } = install(body);
    overlay.setSelected([
      {
        kind: 'edge',
        bodyId: body.bodyId,
        topologyId: 'edge:1',
        hash: 11
      } as never
    ]);
    const preview = begin(mesh, body);
    preview.apply(6);
    const idle = drawnSegments(overlay.idleEdges);
    expect(drawnSegments(overlay.selectedEdges)).toEqual(idle);
    expect(drawnSegments(overlay.selectedHiddenEdges)).toEqual(idle);
    // Hovering another target cannot leave the selected batch behind.
    overlay.setHovered(null);
    expect(drawnSegments(overlay.selectedEdges)).toEqual(idle);
  });
});
