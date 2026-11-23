import { disposeObject } from '../scene/objects';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { toBodyId } from '@openzcad/shared';
import { createBodyEdgeOverlay } from './edgeOverlay';
import { withNavigationEdges } from './navigationEdges';

const fixtures: ReturnType<typeof createBodyEdgeOverlay>[] = [];
afterEach(() => {
  for (const body of fixtures.splice(0)) disposeObject(body);
});

function fixture() {
  const rim = Array.from({ length: 301 }, (_, i) => {
    const angle = ((i % 300) * 2 * Math.PI) / 300;
    return [3 * Math.cos(angle), 3 * Math.sin(angle), 0];
  }).flat();
  // A shallow bend passes behind a foreground plane which clears its two
  // neighbours. A chord that omitted the middle vertex would draw through it.
  const path = [0, 0, 0, 1, 0, -0.02, 2, 0, 0, 1, 0, -0.02, 1, 0, -0.02];
  const body = createBodyEdgeOverlay({
    bodyId: toBodyId('plate'),
    topology: {
      faces: [],
      edges: [
        { topologyId: 'rim', hash: 10, points: rim },
        { topologyId: 'bend', hash: 11, points: path }
      ]
    }
  });
  fixtures.push(body);
  return body;
}
function camera() {
  const view = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
  view.position.z = 10;
  return view;
}
function positionBuffer(geometry: THREE.BufferGeometry) {
  return (
    geometry.getAttribute('instanceStart') as THREE.InterleavedBufferAttribute
  ).data;
}
function during(
  overlay: ReturnType<typeof fixture>,
  ratio = 0.75,
  view: THREE.Camera = camera()
) {
  let geometry: THREE.BufferGeometry = overlay.idleEdges.geometry;
  let ink: THREE.ShaderMaterial = overlay.idleEdges.material;
  withNavigationEdges([overlay], view, ratio, () => {
    geometry = overlay.idleEdges.geometry;
    ink = overlay.idleEdges.material;
  });
  return { geometry, ink };
}

describe('native navigation edges', () => {
  it('sends every original endpoint, including the occluded bend, reversal and closed rim, through the identical view-space bias', () => {
    const overlay = fixture(),
      line = overlay.idleEdges;
    const original = line.geometry,
      round = line.material;
    const { geometry, ink } = during(overlay);
    expect(geometry).not.toBe(original);
    const position = geometry.getAttribute('position');
    expect(position.array).toBe(positionBuffer(original).array);
    expect(position.count).toBe(2 * original.instanceCount);
    expect(Array.from(position.array.slice(-24))).toEqual(
      Array.from(
        new Float32Array([
          0, 0, 0, 1, 0, -0.02, 1, 0, -0.02, 2, 0, 0, 2, 0, 0, 1, 0, -0.02, 1,
          0, -0.02, 1, 0, -0.02
        ])
      )
    );
    const firstEnd = original.getAttribute('instanceEnd'),
      firstStart = original.getAttribute('instanceStart');
    // The camera is orthographic. The same bias (and same model-view and
    // projection matrix) leaves identical LESS_EQUAL visibility on both paths.
    const bias = round.uniforms.depthBias!.value as number;
    const occluder = -10 + bias - 0.01;
    const visible = (z: number) => -10 + z + bias >= occluder;
    expect(
      Array.from({ length: 3 }, (_, i) => visible(position.getZ(600 + i)))
    ).toEqual([true, false, false]);
    for (let i = 0; i < original.instanceCount; i++) {
      expect(visible(position.getZ(2 * i))).toBe(visible(firstStart.getZ(i)));
      expect(visible(position.getZ(2 * i + 1))).toBe(visible(firstEnd.getZ(i)));
    }
    const sharedBias = round.vertexShader.match(
      /void biasEdgeEndpoint[\s\S]*?\n  }/
    )![0];
    expect(ink.vertexShader).toContain(sharedBias);
    expect(round.vertexShader).toContain('biasEdgeEndpoint(start)');
    expect(round.vertexShader).toContain('biasEdgeEndpoint(end)');
    expect(ink.vertexShader).toContain('biasEdgeEndpoint(mvPosition)');
    expect(
      ink.vertexShader.indexOf('biasEdgeEndpoint(mvPosition)')
    ).toBeLessThan(
      ink.vertexShader.indexOf('gl_Position = projectionMatrix * mvPosition')
    );
    expect(ink.uniforms).toBe(round.uniforms);
    expect(ink.fragmentShader).toBe(round.fragmentShader);
    expect(ink.depthTest).toBe(round.depthTest);
    expect(ink.depthFunc).toBe(round.depthFunc);
    expect(ink.depthWrite).toBe(round.depthWrite);
    expect(ink.linewidth * 0.75).toBe(1);
  });

  it('retains scene identity and ordering during draw and restores the pickable fat line after a failed draw', () => {
    const overlay = fixture(),
      line = overlay.idleEdges;
    const geometry = line.geometry,
      material = line.material,
      render = line.onBeforeRender;
    overlay.position.set(3, -4, 0);
    const view = camera();
    view.layers.enable(2);
    line.layers.set(2);
    const sortOrder = line.renderOrder,
      id = line.id;
    overlay.setSelected([
      { bodyId: toBodyId('plate'), kind: 'edge', topologyId: 'bend' }
    ]);
    const selected = overlay.selectedEdges.geometry;
    expect(() =>
      withNavigationEdges([overlay], view, 0.75, () => {
        expect(overlay.children).toContain(line);
        expect(line).toMatchObject({
          isMesh: false,
          isLine: true,
          isLineSegments: true,
          id,
          renderOrder: sortOrder
        });
        expect(line.matrixWorld.elements.slice(12, 15)).toEqual([3, -4, 0]);
        expect(line.layers.mask).toBe(4);
        expect(line.geometry.boundingBox).toBe(geometry.boundingBox);
        expect(line.geometry.boundingSphere).toBe(geometry.boundingSphere);
        expect(overlay.selectedEdges.geometry).toBe(selected);
        throw new Error('draw failed');
      })
    ).toThrow('draw failed');
    expect(line.isMesh).toBe(true);
    expect(line).not.toHaveProperty('isLineSegments');
    expect(line.geometry).toBe(geometry);
    expect(line.material).toBe(material);
    expect(line.onBeforeRender).toBe(render);
    expect(overlay.ownerAtSegment(300)?.topologyId).toBe('bend');
  });

  it('retains round strokes for other ratios, active sections, selection styles, edited previews, hidden ancestors and near-plane geometry', () => {
    const overlay = fixture(),
      line = overlay.idleEdges,
      full = line.geometry;
    for (const ratio of [0.5, 1, 1.25, 2])
      expect(during(overlay, ratio).geometry).toBe(full);
    line.material.clippingPlanes = [new THREE.Plane()];
    expect(during(overlay).geometry).toBe(full);
    line.material.clippingPlanes = null;
    overlay.setBodySelected(true);
    expect(during(overlay).geometry).toBe(full);
    overlay.setBodySelected(false);
    const compile = line.material.onBeforeCompile;
    line.material.onBeforeCompile = () => undefined;
    expect(during(overlay).geometry).toBe(full);
    line.material.onBeforeCompile = compile;
    const group = new THREE.Group();
    group.add(overlay);
    group.visible = false;
    expect(during(overlay).geometry).toBe(full);
    group.visible = true;
    const eye = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    eye.position.z = 0.05;
    expect(during(overlay, 0.75, eye).geometry).toBe(full);
    expect(during(overlay).geometry).not.toBe(full);
    positionBuffer(full).needsUpdate = true;
    expect(during(overlay).geometry).toBe(full);
  });

  it('keeps admitted geometry across near-plane crossings at the batch limit', () => {
    const bodies = Array.from({ length: 33 }, () => fixture());
    const view = camera();
    const frames = () => {
      const geometries: THREE.BufferGeometry[] = [];
      withNavigationEdges(bodies, view, 0.75, () => {
        for (const body of bodies) geometries.push(body.idleEdges.geometry);
      });
      return geometries;
    };
    const original = bodies.map((body) => body.idleEdges.geometry);
    const first = frames();
    expect(first[0]).not.toBe(original[0]);
    expect(first.at(-1)).toBe(original.at(-1));
    bodies[0]!.position.z = view.position.z;
    expect(frames()[0]).toBe(original[0]);
    bodies[0]!.position.z = 0;
    const again = frames();
    for (let i = 0; i < bodies.length; i++) expect(again[i]).toBe(first[i]);
  });

  it('reuses one GPU attribute, updates after replacement, and disposes only the native allocation', () => {
    const overlay = fixture(),
      source = overlay.idleEdges.geometry;
    const initial = during(overlay);
    expect(during(overlay).geometry).toBe(initial.geometry);
    const disposed = vi.fn();
    initial.geometry.addEventListener('dispose', disposed);
    const next = new Float32Array(positionBuffer(source).array);
    next[0] = 1.375;
    source.setPositions(next);
    const replacement = during(overlay);
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(replacement.geometry.getAttribute('position').array).toBe(next);
    const disposedMaterial = vi.fn();
    replacement.ink.addEventListener('dispose', disposedMaterial);
    source.dispose();
    expect(disposedMaterial).toHaveBeenCalledTimes(1);
    expect(next[0]).toBe(1.375);
  });
});
