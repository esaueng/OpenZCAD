/** Loaded only by the E2E canvas hook; never touches document geometry. */
import * as THREE from 'three';
import { createBodyEdgeOverlay, disposeObject } from '@openzcad/viewport';
import { toBodyId } from '@openzcad/shared';

export interface EdgeOverlayGrowthSample {
  tier: 'hover' | 'selection' | 'face boundary';
  hidden: boolean;
  segments: number;
  triangles: number;
  highlightedQuadrants: number;
}

/** Exercise the real renderer's instance limit, not just CPU buffer counts. */
export function probeEdgeOverlayGrowth(
  renderer: THREE.WebGLRenderer
): EdgeOverlayGrowthSample[] {
  const size = 256;
  const bodyId = toBodyId('edge-overlay-growth-probe');
  const circle = (segments: number) =>
    Array.from({ length: segments + 1 }, (_, index) => {
      const angle = (index / segments) * Math.PI * 2;
      return [Math.cos(angle), Math.sin(angle), 0];
    }).flat();
  const topology = {
    faces: [],
    edges: [1, 64, 128].map((segments, index) => ({
      topologyId: `edge-${index}`,
      hash: index + 1,
      adjacentFaceHashes: [index + 101],
      points: segments === 1 ? [-1, 0, 0, 1, 0, 0] : circle(segments)
    }))
  };
  const camera = new THREE.OrthographicCamera(-1.4, 1.4, 1.4, -1.4, 0.1, 10);
  camera.position.z = 5;
  const target = new THREE.WebGLRenderTarget(size, size);
  const previousTarget = renderer.getRenderTarget();
  const previousColor = renderer.getClearColor(new THREE.Color());
  const previousAlpha = renderer.getClearAlpha();
  const previousAutoClear = renderer.autoClear;
  const pixels = new Uint8Array(size * size * 4);
  const results: EdgeOverlayGrowthSample[] = [];
  const scene = new THREE.Scene();
  const occluder = new THREE.Mesh(
    new THREE.PlaneGeometry(4, 4),
    new THREE.MeshBasicMaterial({ color: 0x000000 })
  );
  occluder.position.z = 1;
  scene.add(occluder);
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 1);
  renderer.autoClear = true;
  try {
    for (const tier of ['hover', 'selection', 'face boundary'] as const) {
      const overlay = createBodyEdgeOverlay(
        { bodyId, topology },
        { width: size, height: size }
      );
      scene.add(overlay);
      try {
        const lines =
          tier === 'hover'
            ? [overlay.hoverEdges, overlay.hoverHiddenEdges]
            : tier === 'selection'
              ? [overlay.selectedEdges, overlay.selectedHiddenEdges]
              : [
                  overlay.selectedFaceBoundaryEdges,
                  overlay.selectedFaceBoundaryHiddenEdges
                ];
        // Each larger curve follows a completed WebGL draw at the smaller
        // capacity. The last transition also checks reuse after shrinking.
        for (const index of [0, 1, 2, 0, 1]) {
          const edge = topology.edges[index]!;
          if (tier === 'hover') overlay.setHovered({ bodyId, ...edge });
          else if (tier === 'selection')
            overlay.setSelected([{ bodyId, kind: 'edge', ...edge }]);
          else overlay.setSelectedFaceBoundary(index + 101);
          for (let frame = 0; frame < 60; frame += 1) overlay.step(16);
          for (const [lineIndex, line] of lines.entries()) {
            for (const child of overlay.children)
              child.visible = child === line;
            const hidden = lineIndex === 1;
            // A real foreground surface makes the GreaterDepth pass visible.
            occluder.visible = hidden;
            renderer.render(scene, camera);
            renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
            let highlightedQuadrants = 0;
            for (const [x, y] of [
              [219, 128],
              [128, 219],
              [37, 128],
              [128, 37]
            ]) {
              let highlighted = false;
              for (let dx = -3; dx <= 3; dx += 1) {
                for (let dy = -3; dy <= 3; dy += 1) {
                  const offset = ((y! + dy) * size + x! + dx) * 4;
                  if (
                    Math.max(
                      pixels[offset]!,
                      pixels[offset + 1]!,
                      pixels[offset + 2]!
                    ) > 20
                  )
                    highlighted = true;
                }
              }
              if (highlighted) highlightedQuadrants += 1;
            }
            results.push({
              tier,
              hidden,
              segments: line.geometry.instanceCount,
              triangles: renderer.info.render.triangles - (hidden ? 2 : 0),
              highlightedQuadrants
            });
          }
        }
      } finally {
        scene.remove(overlay);
        disposeObject(overlay);
      }
    }
  } finally {
    disposeObject(occluder);
    target.dispose();
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousColor, previousAlpha);
    renderer.autoClear = previousAutoClear;
  }
  return results;
}
