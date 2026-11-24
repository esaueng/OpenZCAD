import * as THREE from 'three';
import type { BodyEdgeOverlay } from './edgeOverlay';
import { isBodyMaterial, type FatLineSelfOcclusion } from './scene';

/**
 * A translucent body's own hidden edges, drawn faint (#2018).
 *
 * An opaque body hides its far and inner edges through the depth buffer. A
 * translucent one writes no depth — its interior has to show through — so
 * nothing hid its own back and inner-wall edges, and a thin-walled housing
 * inked its outer and inner wall edges at full strength a wall-thickness
 * apart: doubled outlines along every rim, fillet and opening, competing
 * with the opaque parts inside.
 *
 * Before the frame, the translucent bodies' faces alone are drawn into a
 * private target: their depth, and which body is nearest at each pixel. Each
 * translucent body's resting edge ink then splits against it. A fragment
 * behind that body's *own* nearest face draws in a faint twin at the x-ray
 * hidden-edge strength; the rest draws exactly as before. Nothing else reads
 * the target, so:
 *
 * - the main depth buffer is untouched — a translucent body still occludes
 *   nothing: not the opaque parts inside it, other bodies, sketches,
 *   hover and selection overlays, the grid or the axes;
 * - only a body's own faces dim its edges. Where another translucent body is
 *   nearer at a pixel, that pixel's edges draw as before;
 * - opaque bodies, the X-ray display (the viewer turns this off there) and
 *   every highlight tier are unchanged, and the exact B-rep edge batches
 *   stay the one source of edge ink: the twin shares their geometry.
 *
 * The cost is one depth-and-id draw of the translucent bodies per frame, and
 * nothing at all — no target, no pass — while no body is translucent. Renders
 * outside {@link TranslucentEdgeDepth.draw} (thumbnails, image export) see
 * the lines' self-occlusion off.
 */
export const TRANSLUCENT_EDGE_DEPTH = {
  /** Ceiling on the prepass's pixel count; it scales down beyond it. */
  maxPixels: 2_600_000
} as const;

/** The prepass size for a drawing buffer: full size, capped in pixels. */
export function translucentEdgeDepthSize(
  width: number,
  height: number,
  maxPixels: number = TRANSLUCENT_EDGE_DEPTH.maxPixels
): { width: number; height: number } {
  const pixels = width * height;
  const scale = pixels > maxPixels ? Math.sqrt(maxPixels / pixels) : 1;
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale))
  };
}

/**
 * The translucent body an overlay outlines, when its self-occlusion applies:
 * a visible body mesh drawn blended at an applied opacity below one, with
 * edges showing. A body faded only by the sketch recede (`appliedOpacity`
 * still 1) is not translucent; it keeps its edges as they were.
 */
export function translucentEdgeHost(
  overlay: BodyEdgeOverlay
): THREE.Mesh | null {
  const host = overlay.parent as THREE.Mesh | null;
  if (!host?.isMesh) return null;
  const material = host.material;
  if (Array.isArray(material) || !isBodyMaterial(material)) return null;
  if (!material.visible || !material.transparent || material.depthWrite)
    return null;
  const applied = host.userData.appliedOpacity as number | undefined;
  if (!((applied ?? material.opacity) < 1)) return null;
  if (!overlay.restingInkVisible) return null;
  for (
    let object: THREE.Object3D | null = overlay;
    object;
    object = object.parent
  ) {
    if (!object.visible) return null;
  }
  return host;
}

const OWNER_VERTEX = /* glsl */ `
#include <common>
#include <clipping_planes_pars_vertex>
void main() {
  #include <begin_vertex>
  #include <project_vertex>
  #include <clipping_planes_vertex>
}
`;

const OWNER_FRAGMENT = /* glsl */ `
#include <clipping_planes_pars_fragment>
uniform vec3 ownerColor;
void main() {
  #include <clipping_planes_fragment>
  gl_FragColor = vec4( ownerColor, 1.0 );
}
`;

interface Proxy {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
}

export interface TranslucentEdgeFrame {
  camera: THREE.Camera;
  overlays: Iterable<BodyEdgeOverlay>;
  /** False in X-ray and wireframe, where the display already decides. */
  enabled: boolean;
}

/** One viewer's prepass; see the module comment. */
export class TranslucentEdgeDepth {
  private target: THREE.WebGLRenderTarget | null = null;
  private readonly scene = new THREE.Scene();
  private readonly proxies = new WeakMap<THREE.Mesh, Proxy>();
  private readonly active: BodyEdgeOverlay[] = [];
  private readonly hosts: THREE.Mesh[] = [];
  private readonly clearColor = new THREE.Color();
  /** What the split lines read; one object, re-pointed each frame. */
  private binding: FatLineSelfOcclusion | null = null;
  private lastActiveCount = 0;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.scene.matrixWorldAutoUpdate = false;
  }

  /** How many bodies the last frame split; for tests and the e2e hook. */
  get activeCount(): number {
    return this.lastActiveCount;
  }

  /**
   * Runs `draw` (the frame's own render) with the translucent bodies' edges
   * split against their own faces, and turns the split off again after it.
   */
  draw(frame: TranslucentEdgeFrame, draw: () => void): void {
    const active = this.active;
    const hosts = this.hosts;
    active.length = 0;
    hosts.length = 0;
    if (frame.enabled) {
      for (const overlay of frame.overlays) {
        const host = translucentEdgeHost(overlay);
        if (!host) continue;
        active.push(overlay);
        hosts.push(host);
      }
    }
    this.lastActiveCount = active.length;
    if (active.length === 0) {
      draw();
      return;
    }
    try {
      const binding = this.render(frame.camera);
      // Each overlay copies what it needs into its uniforms, so one binding
      // serves them all with only the owner changing.
      for (let index = 0; index < active.length; index += 1) {
        binding.owner = index + 1;
        active[index]!.setSelfOcclusion(binding);
      }
      draw();
    } finally {
      for (const overlay of active) overlay.setSelfOcclusion(null);
      active.length = 0;
      hosts.length = 0;
      this.scene.clear();
    }
  }

  private ensureTarget(width: number, height: number) {
    const size = translucentEdgeDepthSize(width, height);
    if (!this.target) {
      this.target = new THREE.WebGLRenderTarget(size.width, size.height, {
        type: THREE.UnsignedByteType,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        stencilBuffer: false,
        generateMipmaps: false,
        depthTexture: new THREE.DepthTexture(
          size.width,
          size.height,
          THREE.FloatType
        )
      });
    } else if (
      this.target.width !== size.width ||
      this.target.height !== size.height
    ) {
      this.target.setSize(size.width, size.height);
    }
    this.binding ??= {
      ownerMap: this.target.texture,
      depthMap: this.target.depthTexture!,
      screen: new THREE.Vector2(1, 1),
      owner: 0
    };
    return this.target;
  }

  private proxyFor(host: THREE.Mesh, owner: number): THREE.Mesh {
    let proxy = this.proxies.get(host);
    if (!proxy) {
      const material = new THREE.ShaderMaterial({
        uniforms: { ownerColor: { value: new THREE.Color() } },
        vertexShader: OWNER_VERTEX,
        fragmentShader: OWNER_FRAGMENT,
        clipping: true
      });
      const mesh = new THREE.Mesh(host.geometry, material);
      mesh.matrixAutoUpdate = false;
      mesh.matrixWorldAutoUpdate = false;
      proxy = { mesh, material };
      this.proxies.set(host, proxy);
    }
    const source = host.material as THREE.Material;
    const { mesh, material } = proxy;
    mesh.geometry = host.geometry;
    host.updateWorldMatrix(true, false);
    mesh.matrixWorld.copy(host.matrixWorld);
    mesh.frustumCulled = host.frustumCulled;
    // The face's own depth as the frame draws it: its side, its section
    // planes and its one-unit push behind the edges it carries.
    material.side = source.side;
    material.clippingPlanes = source.clippingPlanes;
    material.polygonOffset = source.polygonOffset;
    material.polygonOffsetFactor = source.polygonOffsetFactor;
    material.polygonOffsetUnits = source.polygonOffsetUnits;
    (material.uniforms.ownerColor!.value as THREE.Color).setRGB(
      (owner % 256) / 255,
      Math.floor(owner / 256) / 255,
      0,
      THREE.LinearSRGBColorSpace
    );
    return mesh;
  }

  private render(camera: THREE.Camera): FatLineSelfOcclusion {
    const renderer = this.renderer;
    const width = renderer.domElement.width;
    const height = renderer.domElement.height;
    const target = this.ensureTarget(width, height);
    const binding = this.binding!;
    binding.screen.set(1 / Math.max(width, 1), 1 / Math.max(height, 1));
    const scene = this.scene;
    scene.clear();
    for (let index = 0; index < this.hosts.length; index += 1) {
      scene.add(this.proxyFor(this.hosts[index]!, index + 1));
    }
    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    const previousClearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clearColor);
    try {
      renderer.autoClear = true;
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.setClearColor(this.clearColor, previousClearAlpha);
      renderer.autoClear = previousAutoClear;
    }
    return binding;
  }

  dispose() {
    this.scene.clear();
    this.target?.depthTexture?.dispose();
    this.target?.dispose();
    this.target = null;
    this.binding = null;
  }
}
