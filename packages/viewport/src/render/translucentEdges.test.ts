import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { toBodyId, type BodyRepresentation } from '@openzcad/shared';
import {
  createBodyEdgeOverlay,
  SELF_HIDDEN_EDGE_OPACITY,
  type BodyEdgeOverlay
} from './edgeOverlay';
import {
  createBodyMaterial,
  createFatLineMaterial,
  FAT_LINE_SELF_OCCLUSION,
  nativeEdgeMaterial,
  updateBodyMaterialOpacity,
  VIEWPORT_RENDER_ORDER
} from './scene';
import {
  TranslucentEdgeDepth,
  translucentEdgeDepthSize,
  translucentEdgeHost
} from './translucentEdges';
import { EDGE_SELECTED_COLOR } from '../pick/edges';

/** A hollow box's twelve outer and twelve inner-wall edges. */
function boxEdges(half: number, prefix: string, hashBase: number) {
  const positions = new THREE.EdgesGeometry(
    new THREE.BoxGeometry(2 * half, 2 * half, 2 * half)
  ).getAttribute('position').array as Float32Array;
  return Array.from({ length: positions.length / 6 }, (_, index) => ({
    topologyId: `${prefix}${index}`,
    hash: hashBase + index,
    points: Array.from(positions.slice(index * 6, index * 6 + 6))
  }));
}

function body(
  id: string,
  opacity: number,
  edges: ReturnType<typeof boxEdges>
): BodyRepresentation {
  return {
    bodyId: toBodyId(id),
    name: id,
    source: 'primitive',
    mesh: {
      kind: 'mesh',
      vertices: Float32Array.from([]),
      indices: Uint32Array.from([])
    },
    faceCount: 0,
    color: '#7aa7d8',
    opacity,
    exportableStep: true,
    consumed: false,
    volume: 0,
    bbox: { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } },
    topology: { faces: [], edges }
  };
}

/**
 * A body as the viewer installs it: the mesh, its edge overlay as a child,
 * and the applied opacity the bodies pass records.
 */
function installed(id: string, opacity: number, half = 1) {
  const representation = body(id, opacity, [
    ...boxEdges(half, `${id}-outer-`, 0),
    ...boxEdges(half * 0.85, `${id}-inner-`, 100)
  ]);
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(2 * half, 2 * half, 2 * half),
    createBodyMaterial(representation)
  );
  mesh.userData.appliedOpacity = opacity;
  const overlay = createBodyEdgeOverlay(representation);
  mesh.add(overlay);
  return { mesh, overlay };
}

function resting(overlay: BodyEdgeOverlay): LineSegments2[] {
  return [
    overlay.idleEdges,
    overlay.idleTangentEdges,
    ...(overlay.silhouetteEdges ? [overlay.silhouetteEdges] : [])
  ];
}

function twins(overlay: BodyEdgeOverlay): LineSegments2[] {
  return overlay.children.filter((child) =>
    child.name.endsWith('-self-hidden')
  ) as LineSegments2[];
}

const mode = (line: LineSegments2) =>
  line.material.uniforms.selfOcclusionMode!.value as number;

/** Just enough of a WebGLRenderer for the prepass bookkeeping. */
function fakeRenderer(width = 800, height = 600) {
  let target: THREE.WebGLRenderTarget | null = null;
  const clear = new THREE.Color(0x123456);
  let clearAlpha = 1;
  const rendered: {
    scene: THREE.Scene;
    target: unknown;
    meshes: THREE.Mesh[];
  }[] = [];
  const renderer = {
    domElement: { width, height },
    autoClear: false,
    getRenderTarget: () => target,
    setRenderTarget: (next: THREE.WebGLRenderTarget | null) => {
      target = next;
    },
    getClearColor: (out: THREE.Color) => out.copy(clear),
    getClearAlpha: () => clearAlpha,
    setClearColor: (color: THREE.ColorRepresentation, alpha: number) => {
      clear.set(color);
      clearAlpha = alpha;
    },
    render: vi.fn((scene: THREE.Scene) => {
      rendered.push({
        scene,
        target,
        meshes: [...scene.children] as THREE.Mesh[]
      });
    })
  };
  return {
    renderer: renderer as unknown as THREE.WebGLRenderer,
    render: renderer.render,
    rendered,
    clear,
    clearAlpha: () => clearAlpha,
    autoClear: () => renderer.autoClear,
    target: () => target
  };
}

const camera = new THREE.PerspectiveCamera();

describe('translucentEdgeHost', () => {
  it('takes a translucent body and leaves an opaque one alone', () => {
    expect(translucentEdgeHost(installed('opaque', 1).overlay)).toBeNull();
    const { mesh, overlay } = installed('housing', 0.35);
    expect(translucentEdgeHost(overlay)).toBe(mesh);
  });

  it('follows the applied opacity, not a sketch recede fade', () => {
    const { mesh, overlay } = installed('receded', 1);
    // The sketch recede fades the material while the applied opacity stays 1.
    updateBodyMaterialOpacity(mesh.material, 0.4);
    expect(translucentEdgeHost(overlay)).toBeNull();
    mesh.userData.appliedOpacity = 0.4;
    expect(translucentEdgeHost(overlay)).toBe(mesh);
  });

  it('skips a body with no resting ink or that is not drawn', () => {
    const { mesh, overlay } = installed('housing', 0.35);
    overlay.setDisplayMode('shaded');
    expect(translucentEdgeHost(overlay)).toBeNull();
    overlay.setDisplayMode('shaded-edges');
    mesh.visible = false;
    expect(translucentEdgeHost(overlay)).toBeNull();
    mesh.visible = true;
    expect(translucentEdgeHost(overlay)).toBe(mesh);
  });
});

describe('TranslucentEdgeDepth', () => {
  it('costs nothing while no body is translucent', () => {
    const fake = fakeRenderer();
    const depth = new TranslucentEdgeDepth(fake.renderer);
    const core = installed('core', 1, 0.3);
    const draw = vi.fn(() => {
      for (const line of resting(core.overlay)) {
        expect(mode(line)).toBe(FAT_LINE_SELF_OCCLUSION.OFF);
      }
    });
    depth.draw({ camera, overlays: [core.overlay], enabled: true }, draw);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(fake.render).not.toHaveBeenCalled();
    expect(depth.activeCount).toBe(0);
    expect(twins(core.overlay)).toHaveLength(0);
  });

  it('leaves X-ray and wireframe to the display', () => {
    const fake = fakeRenderer();
    const depth = new TranslucentEdgeDepth(fake.renderer);
    const housing = installed('housing', 0.35);
    const draw = vi.fn(() => {
      for (const line of resting(housing.overlay)) {
        expect(mode(line)).toBe(FAT_LINE_SELF_OCCLUSION.OFF);
      }
    });
    depth.draw({ camera, overlays: [housing.overlay], enabled: false }, draw);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(fake.render).not.toHaveBeenCalled();
  });

  it("splits only the translucent housing's edges against its own faces", () => {
    const fake = fakeRenderer(800, 600);
    const depth = new TranslucentEdgeDepth(fake.renderer);
    const housing = installed('housing', 0.35);
    const core = installed('core', 1, 0.3);
    housing.mesh.add(core.mesh);
    let checked = false;
    depth.draw(
      { camera, overlays: [housing.overlay, core.overlay], enabled: true },
      () => {
        checked = true;
        // The prepass ran first, into its own target, with only the housing.
        expect(fake.render).toHaveBeenCalledTimes(1);
        const pass = fake.rendered[0]!;
        expect(pass.target).toBeInstanceOf(THREE.WebGLRenderTarget);
        expect(pass.meshes).toHaveLength(1);
        const proxy = pass.meshes[0]!;
        expect(proxy.geometry).toBe(housing.mesh.geometry);
        const proxyMaterial = proxy.material as THREE.ShaderMaterial;
        const bodyMaterial = housing.mesh.material as THREE.Material;
        expect(proxyMaterial.polygonOffset).toBe(bodyMaterial.polygonOffset);
        expect(proxyMaterial.polygonOffsetFactor).toBe(
          bodyMaterial.polygonOffsetFactor
        );
        expect(proxyMaterial.side).toBe(bodyMaterial.side);
        // ...and the frame itself draws to the canvas again.
        expect(fake.target()).toBeNull();
        expect(fake.autoClear()).toBe(false);
        expect(fake.clear.getHex()).toBe(0x123456);

        for (const line of resting(housing.overlay)) {
          if (!line.visible) continue;
          expect(mode(line)).toBe(FAT_LINE_SELF_OCCLUSION.UNHIDDEN);
          expect(line.material.uniforms.selfOcclusionOwner!.value).toBe(1);
        }
        const faint = twins(housing.overlay);
        expect(faint.length).toBe(resting(housing.overlay).length);
        faint.forEach((twin, index) => {
          const source = resting(housing.overlay)[index]!;
          expect(twin.geometry).toBe(source.geometry);
          expect(twin.visible).toBe(source.visible);
          if (!twin.visible) return;
          expect(mode(twin)).toBe(FAT_LINE_SELF_OCCLUSION.HIDDEN);
          expect(twin.material.opacity).toBeCloseTo(
            source.material.opacity * SELF_HIDDEN_EDGE_OPACITY
          );
          expect(twin.material.color.getHex()).toBe(
            source.material.color.getHex()
          );
          expect(twin.renderOrder).toBe(VIEWPORT_RENDER_ORDER.BODY_EDGE);
          // Translucent ink blends once per pixel, like the x-ray twins.
          expect(twin.material.stencilWrite).toBe(true);
        });

        // The opaque part inside keeps every edge at full strength.
        for (const line of resting(core.overlay)) {
          expect(mode(line)).toBe(FAT_LINE_SELF_OCCLUSION.OFF);
        }
        expect(twins(core.overlay)).toHaveLength(0);
      }
    );
    expect(checked).toBe(true);
    expect(depth.activeCount).toBe(1);
    // After the frame: off again, so a thumbnail or export render draws
    // exactly what it did.
    for (const line of resting(housing.overlay)) {
      expect(mode(line)).toBe(FAT_LINE_SELF_OCCLUSION.OFF);
    }
    for (const twin of twins(housing.overlay)) {
      expect(twin.visible).toBe(false);
    }
  });

  it('gives each translucent body its own owner', () => {
    const fake = fakeRenderer();
    const depth = new TranslucentEdgeDepth(fake.renderer);
    const a = installed('a', 0.5);
    const b = installed('b', 0.5);
    depth.draw(
      { camera, overlays: [a.overlay, b.overlay], enabled: true },
      () => {
        expect(
          a.overlay.idleEdges.material.uniforms.selfOcclusionOwner!.value
        ).toBe(1);
        expect(
          b.overlay.idleEdges.material.uniforms.selfOcclusionOwner!.value
        ).toBe(2);
        const colors = fake.rendered[0]!.meshes.map((mesh) =>
          (
            (mesh.material as THREE.ShaderMaterial).uniforms.ownerColor!
              .value as THREE.Color
          ).getHex()
        );
        expect(new Set(colors).size).toBe(2);
      }
    );
  });

  it('turns the split off even when the frame throws', () => {
    const depth = new TranslucentEdgeDepth(fakeRenderer().renderer);
    const housing = installed('housing', 0.35);
    expect(() =>
      depth.draw({ camera, overlays: [housing.overlay], enabled: true }, () => {
        throw new Error('lost context');
      })
    ).toThrow('lost context');
    expect(mode(housing.overlay.idleEdges)).toBe(FAT_LINE_SELF_OCCLUSION.OFF);
    for (const twin of twins(housing.overlay)) expect(twin.visible).toBe(false);
  });

  it("follows the body's idle style: a selected body's outline", () => {
    const depth = new TranslucentEdgeDepth(fakeRenderer().renderer);
    const housing = installed('housing', 0.35);
    housing.overlay.setBodySelected(true);
    depth.draw({ camera, overlays: [housing.overlay], enabled: true }, () => {
      const twin = twins(housing.overlay)[0]!;
      expect(twin.material.color.getHex()).toBe(EDGE_SELECTED_COLOR);
      expect(twin.material.linewidth).toBe(
        housing.overlay.idleEdges.material.linewidth
      );
    });
  });

  it('caps the prepass in pixels', () => {
    expect(translucentEdgeDepthSize(800, 600)).toEqual({
      width: 800,
      height: 600
    });
    const big = translucentEdgeDepthSize(5120, 2880, 2_600_000);
    expect(big.width * big.height).toBeLessThanOrEqual(2_600_000);
    expect(big.width / big.height).toBeCloseTo(5120 / 2880, 2);
  });
});

describe('fat-line self-occlusion shader', () => {
  it('is off by default and shared by every fat line', () => {
    const plain = createFatLineMaterial({ color: 0xffffff, linewidth: 1 });
    expect(plain.uniforms.selfOcclusionMode!.value).toBe(
      FAT_LINE_SELF_OCCLUSION.OFF
    );
    const shader = plain.fragmentShader;
    expect(shader).toContain('uniform float selfOcclusionMode;');
    // Splits after the stroke's derivatives and before the colour is written.
    const split = shader.indexOf('if ( selfOcclusionMode > 0.5 )');
    expect(split).toBeGreaterThan(shader.indexOf('fwidth'));
    expect(split).toBeLessThan(shader.indexOf('gl_FragColor'));
    expect(
      createFatLineMaterial({ color: 0, linewidth: 2, depthBias: 1 })
        .fragmentShader
    ).toBe(shader);
  });

  it('reaches the navigation stand-in through the shared uniforms', () => {
    const round = createFatLineMaterial({ color: 0xffffff, linewidth: 1 });
    const ink = nativeEdgeMaterial(round)!;
    expect(ink).not.toBeNull();
    expect(ink.uniforms).toBe(round.uniforms);
    expect(ink.fragmentShader).toContain('selfOcclusionMode');
  });
});
