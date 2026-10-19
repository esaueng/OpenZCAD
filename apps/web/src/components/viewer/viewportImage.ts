import * as THREE from 'three';
import { OutputShader } from 'three/examples/jsm/shaders/OutputShader.js';
import {
  IMAGE_EXPORT_MAX_PIXELS,
  IMAGE_EXPORT_MAX_SIDE
} from '../../lib/imageExport';

/**
 * Offscreen capture of the current view for image export (ZC-192).
 *
 * The live renderer draws the live scene from the live camera into render
 * targets of the requested size, and the pixels are read back from there.
 * Nothing is presented: every change made for the capture — the camera's
 * aspect, what is shown, the background — is put back before the function
 * returns, all inside one synchronous call, so the canvas never draws a frame
 * of it. A second renderer could not do this: the environment map and every
 * uploaded mesh belong to the live context.
 */

export interface ViewportImageRequest {
  /** Output size in device pixels. */
  width: number;
  height: number;
  /** Clear to alpha 0 and leave the backdrop out. */
  transparent: boolean;
  /** Keep the construction grid and world axes in the picture. */
  showGrid: boolean;
  /**
   * The bodies to draw, by id; absent draws every body the view shows. A
   * selection export passes the selected body alone.
   */
  bodyIds?: readonly string[];
}

export interface ViewportImagePixels {
  width: number;
  height: number;
  /** Top-down rows of straight (not premultiplied) 8-bit RGBA. */
  rgba: Uint8Array;
}

/** What the viewer installs for the workspace while its scene lives. */
export interface ViewportImageSource {
  capture(request: ViewportImageRequest): ViewportImagePixels;
  /** The live canvas's drawing buffer, in device pixels. */
  viewSize(): { width: number; height: number };
  /** The largest side this renderer can draw. */
  maxSide: number;
}

export interface ViewportImageScene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  /** The opaque backdrop: the scene background and the gradient behind it. */
  backdrop: THREE.Object3D;
  /** Grid and axes, shown only when the request asks for them. */
  grid: readonly THREE.Object3D[];
  /**
   * Scene children that are the model and its stage — lights, bodies,
   * sketches, the ground shadow. Every other child (gizmos, drag rigs,
   * measurements, previews) is UI and is left out of the picture.
   */
  content: readonly THREE.Object3D[];
  /**
   * The members of `content` that draw sketches and their profile fills,
   * left out when the request names bodies: a body export draws the body.
   */
  sketches: readonly THREE.Object3D[];
  objectsByBodyId: ReadonlyMap<string, THREE.Object3D>;
  /**
   * Marks the live viewer's frozen shadow map for a refresh. A body-scoped
   * capture redraws that map without the other bodies, so the live view
   * needs it rebuilt afterwards.
   */
  refreshShadowMap(): void;
}

/**
 * Projection for an image whose aspect differs from the view's. Whatever the
 * view shows stays in the picture: a wider image keeps the vertical extent
 * and shows more at the sides, a narrower one keeps the horizontal extent.
 * Returns the restore.
 */
export function fitCameraToAspect(
  camera: THREE.Camera,
  aspect: number
): () => void {
  if (camera instanceof THREE.PerspectiveCamera) {
    const { aspect: viewAspect, fov } = camera;
    const grow = aspect >= viewAspect ? 1 : viewAspect / aspect;
    camera.aspect = aspect;
    camera.fov =
      (2 * Math.atan(Math.tan((fov * Math.PI) / 360) * grow) * 180) / Math.PI;
    camera.updateProjectionMatrix();
    return () => {
      camera.aspect = viewAspect;
      camera.fov = fov;
      camera.updateProjectionMatrix();
    };
  }
  if (camera instanceof THREE.OrthographicCamera) {
    const { left, right, top, bottom } = camera;
    const halfWidth = (right - left) / 2;
    const halfHeight = (top - bottom) / 2;
    const viewAspect = halfWidth / halfHeight;
    const centerX = (left + right) / 2;
    const centerY = (top + bottom) / 2;
    const half =
      aspect >= viewAspect ? halfHeight : (halfHeight * viewAspect) / aspect;
    camera.left = centerX - half * aspect;
    camera.right = centerX + half * aspect;
    camera.top = centerY + half;
    camera.bottom = centerY - half;
    camera.updateProjectionMatrix();
    return () => {
      Object.assign(camera, { left, right, top, bottom });
      camera.updateProjectionMatrix();
    };
  }
  return () => undefined;
}

/** An edge batch (`BodyEdgeOverlay`) that can draw without highlights. */
interface SuspendsHighlights {
  suspendHighlights(): () => void;
}

/** The group ModelViewer hangs a picked face's fill and ghost in. */
const SELECTION_OVERLAY_GROUP = 'body-selection-overlay';

/**
 * Multisampling stops at 4K (about 8.3 MP): four half-float samples cost
 * 32 bytes a pixel before depth, already some 265 MB there, and a larger
 * picture has the resolution to do without it.
 */
export const MSAA_MAX_PIXELS = 3840 * 2160;

/** MSAA samples for a capture of this size. */
export function captureSamples(
  width: number,
  height: number,
  maxSamples: number
): number {
  return width * height <= MSAA_MAX_PIXELS ? Math.min(4, maxSamples) : 0;
}

const TONE_MAPPING_DEFINES: Partial<Record<THREE.ToneMapping, string>> = {
  [THREE.LinearToneMapping]: 'LINEAR_TONE_MAPPING',
  [THREE.ReinhardToneMapping]: 'REINHARD_TONE_MAPPING',
  [THREE.CineonToneMapping]: 'CINEON_TONE_MAPPING',
  [THREE.ACESFilmicToneMapping]: 'ACES_FILMIC_TONE_MAPPING',
  [THREE.AgXToneMapping]: 'AGX_TONE_MAPPING',
  [THREE.NeutralToneMapping]: 'NEUTRAL_TONE_MAPPING'
};

const TEXTURE_READ = 'gl_FragColor = texture2D( tDiffuse, vUv );';

/**
 * A render target gets linear, un-tone-mapped colour — three applies the
 * output transform only on the way to the canvas — so this pass applies the
 * renderer's own tone mapping and sRGB encoding, as the canvas would. It
 * first divides out alpha: blending onto a transparent clear leaves colour
 * premultiplied, and PNG stores it straight.
 */
function outputPass(renderer: THREE.WebGLRenderer) {
  if (!OutputShader.fragmentShader.includes(TEXTURE_READ)) {
    throw new Error('The output shader changed shape; update viewportImage.');
  }
  const defines: Record<string, string> = {};
  const toneMapping = TONE_MAPPING_DEFINES[renderer.toneMapping];
  if (toneMapping) defines[toneMapping] = '';
  if (
    THREE.ColorManagement.getTransfer(renderer.outputColorSpace) ===
    THREE.SRGBTransfer
  ) {
    defines.SRGB_TRANSFER = '';
  }
  const material = new THREE.RawShaderMaterial({
    name: 'ViewportImageOutput',
    defines,
    uniforms: {
      tDiffuse: { value: null },
      toneMappingExposure: { value: renderer.toneMappingExposure }
    },
    vertexShader: OutputShader.vertexShader,
    fragmentShader: OutputShader.fragmentShader.replace(
      TEXTURE_READ,
      `${TEXTURE_READ}\n\t\t\tif ( gl_FragColor.a > 0.0 ) gl_FragColor.rgb /= gl_FragColor.a;`
    ),
    depthTest: false,
    depthWrite: false
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  return {
    render(source: THREE.Texture, target: THREE.WebGLRenderTarget) {
      material.uniforms.tDiffuse!.value = source;
      renderer.setRenderTarget(target);
      renderer.render(quad, camera);
    },
    dispose() {
      quad.geometry.dispose();
      material.dispose();
    }
  };
}

/** Reverses GL's bottom-up rows in place. */
function flipRows(pixels: Uint8Array, width: number, height: number): void {
  const stride = width * 4;
  const row = new Uint8Array(stride);
  for (let top = 0, bottom = height - 1; top < bottom; top += 1, bottom -= 1) {
    const a = top * stride;
    const b = bottom * stride;
    row.set(pixels.subarray(a, a + stride));
    pixels.copyWithin(a, b, b + stride);
    pixels.set(row, b);
  }
}

/** The largest side this renderer can draw, within the export's own cap. */
export function viewportImageMaxSide(renderer: THREE.WebGLRenderer): number {
  return Math.min(IMAGE_EXPORT_MAX_SIDE, renderer.capabilities.maxTextureSize);
}

/**
 * Draw the current view into a `width × height` image and read it back.
 * Throws, with everything restored, if the size is out of range or the GPU
 * refuses.
 */
export function renderViewportImage(
  parts: ViewportImageScene,
  request: ViewportImageRequest
): ViewportImagePixels {
  const { renderer, scene, camera } = parts;
  const width = Math.round(request.width);
  const height = Math.round(request.height);
  const maxSide = viewportImageMaxSide(renderer);
  if (
    !(width >= 1 && height >= 1) ||
    width > maxSide ||
    height > maxSide ||
    width * height > IMAGE_EXPORT_MAX_PIXELS
  ) {
    throw new Error(
      `Image size ${width}×${height} is outside what this device can render (up to ${maxSide} px a side).`
    );
  }

  const restores: Array<() => void> = [];
  const show = (object: THREE.Object3D, visible: boolean) => {
    const was = object.visible;
    object.visible = visible;
    restores.push(() => {
      object.visible = was;
    });
  };
  const hide = (object: THREE.Object3D, visible: boolean) =>
    show(object, object.visible && visible);
  const bodyScoped = request.bodyIds !== undefined;
  const keep = new Set(parts.content);
  for (const child of scene.children) {
    if (child === parts.backdrop) hide(child, !request.transparent);
    else if (parts.grid.includes(child)) hide(child, request.showGrid);
    else if (bodyScoped && parts.sketches.includes(child)) hide(child, false);
    else hide(child, keep.has(child));
  }
  if (request.bodyIds) {
    // The named bodies are drawn even if the view hides them: a selected
    // body exports alone whatever its viewing state, as the mesh export
    // writes it.
    const wanted = new Set(request.bodyIds);
    for (const [bodyId, object] of parts.objectsByBodyId) {
      show(object, wanted.has(bodyId));
    }
  }
  // Selection is a viewing state: its glow, and the face fills and ghosts
  // hung under a body for a picked face, are not part of the part.
  for (const object of parts.objectsByBodyId.values()) {
    object.traverse((node) => {
      if (
        node.name === SELECTION_OVERLAY_GROUP ||
        node.userData.selectionOverlay === true
      ) {
        hide(node, false);
        return;
      }
      // Selected and hovered edges, face rims and a selected body's
      // outline live in its edge batch, which knows its own tiers.
      const edges = node as Partial<SuspendsHighlights>;
      if (typeof edges.suspendHighlights === 'function') {
        restores.push(edges.suspendHighlights());
      }
      const material = (node as THREE.Mesh).material as
        THREE.MeshStandardMaterial | undefined;
      if (material && 'emissive' in material && material.emissive) {
        const was = material.emissive.getHex();
        material.emissive.setHex(0x000000);
        restores.push(() => material.emissive.setHex(was));
      }
    });
  }
  const background = scene.background;
  if (request.transparent) scene.background = null;
  restores.push(() => {
    scene.background = background;
  });
  const clearColor = renderer.getClearColor(new THREE.Color());
  const clearAlpha = renderer.getClearAlpha();
  renderer.setClearColor(0x000000, request.transparent ? 0 : 1);
  restores.push(() => renderer.setClearColor(clearColor, clearAlpha));
  const shadowUpdate = renderer.shadowMap.needsUpdate;
  // The live map holds every visible body's shadow. A body-scoped picture
  // casts from its own bodies only, and the live view rebuilds afterwards.
  if (bodyScoped) renderer.shadowMap.needsUpdate = true;
  restores.push(() => {
    if (bodyScoped) parts.refreshShadowMap();
    else renderer.shadowMap.needsUpdate = shadowUpdate;
  });
  const previousTarget = renderer.getRenderTarget();
  restores.push(() => renderer.setRenderTarget(previousTarget));
  restores.push(fitCameraToAspect(camera, width / height));

  const scene3d = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    samples: captureSamples(width, height, renderer.capabilities.maxSamples),
    depthBuffer: true,
    stencilBuffer: true
  });
  const output = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.UnsignedByteType,
    depthBuffer: false
  });
  const pass = outputPass(renderer);
  try {
    renderer.setRenderTarget(scene3d);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
    pass.render(scene3d.texture, output);
    const rgba = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(output, 0, 0, width, height, rgba);
    flipRows(rgba, width, height);
    return { width, height, rgba };
  } finally {
    for (const restore of restores.reverse()) restore();
    pass.dispose();
    scene3d.dispose();
    output.dispose();
  }
}
