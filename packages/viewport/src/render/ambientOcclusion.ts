import * as THREE from 'three';

/**
 * Settled-frame ambient occlusion for shaded solids (U10 follow-up).
 *
 * Contact darkening where two surfaces meet in a concave corner — a boss
 * standing on a block, a pocket's floor against its walls — computed in
 * screen space, but only once the view has come to rest. While anything
 * moves the bodies draw exactly as they did before; a short while after the
 * camera and the bodies stop, one extra pass computes the occlusion and it
 * fades in. Orbiting, panning and zooming therefore cost nothing, and a
 * still view pays once, at reduced resolution.
 *
 * Why it is shaped like this rather than a post-processing chain:
 *
 * - **It is applied inside the body material**, not composited over the
 *   frame. The body shader samples the occlusion texture at its own pixel
 *   and darkens only its own lighting, so edge ink, silhouettes, selection
 *   and hover overlays, the grid and the backdrop are never touched, and
 *   the canvas keeps its own multisampled antialiasing and the stencil the
 *   ground decorations read. A screen-space multiply over the final image
 *   would have darkened every edge line and needed its own antialiasing.
 * - **The estimator is the "alchemy" family** (McGuire et al., Scalable
 *   Ambient Obscurance): each sample counts only as far as it rises above
 *   the surface's tangent plane. A planar face therefore occludes nothing,
 *   exactly, so large flat faces stay clean instead of collecting grain; a
 *   convex fillet occludes nothing either. Samples farther than the radius
 *   count for nothing, which is what keeps a part's silhouette from casting
 *   a halo onto the stage or onto a face far behind it.
 * - **Half resolution, bilateral everywhere.** The pass runs at half the
 *   drawing buffer (capped in pixels), is blurred along the surface (depth
 *   plane and normal aware, so it never bleeds across a crease), and the
 *   body shader upsamples it against its own depth, so a thin rim of one
 *   surface never borrows another's darkening.
 *
 * The rest of the viewer gates it: X-ray (translucent bodies neither cast nor
 * receive), wireframe (no faces), E2E builds (no GPU), and anything rendered
 * off the canvas — project thumbnails, image export — which draws without it.
 */
export const AMBIENT_OCCLUSION = {
  /** The one switch. Off, nothing is allocated and bodies draw as before. */
  enabled: true,
  /** Stillness, in ms, before the occlusion is computed. */
  settleMs: 150,
  /** The fade-in once computed, in ms (none under reduced motion). */
  fadeMs: 180,
  /** Occlusion buffer size relative to the drawing buffer. */
  resolutionScale: 0.5,
  /** Ceiling on the occlusion buffer's pixel count (about 1280 × 1250). */
  maxPixels: 1_600_000,
  samples: 12,
  /** Spiral turns the samples wind through; coprime with `samples`. */
  spiralTurns: 5,
  /** World radius as a fraction of the solids' bounding-box diagonal. */
  radiusFraction: 0.05,
  /** The radius's screen extent is clamped, in occlusion-buffer pixels. */
  minRadiusPx: 3,
  maxRadiusPx: 36,
  /** Cosine a sample must rise above the tangent plane before it counts. */
  bias: 0.12,
  /** Occlusion gain before `strength`. */
  intensity: 2,
  /** How far the darkest corner goes: 0 none, 1 the full estimate. */
  strength: 0.85,
  /**
   * Share of the direct (key light) term the occlusion also scales. Ambient
   * light alone is physically right, but the camera key fills a corner that
   * faces it so fully that the darkening would vanish from most views.
   */
  directOcclusion: 0.55
} as const;

export type AmbientOcclusionSettings = typeof AMBIENT_OCCLUSION;

/** What the controller is doing, as the e2e canvas hook reports it. */
export type AmbientOcclusionState = 'off' | 'waiting' | 'fading' | 'shown';

/**
 * Marks a material as one that receives occlusion; also how the controller
 * finds the solids that cast it.
 */
const RECEIVES = 'bodyAmbientOcclusion';

/** What the body shaders read, per renderer (a thumbnail renderer has none). */
interface AmbientOcclusionBinding {
  camera: THREE.Camera | null;
  /** 0 hides the occlusion; the fade ramps it to 1. */
  strength: number;
  map: THREE.Texture | null;
  depth: THREE.Texture | null;
  /** The drawing buffer the occlusion was computed for. */
  width: number;
  height: number;
  /** 1 / occlusion buffer size. */
  texel: THREE.Vector2;
  /** 1 / drawing buffer size. */
  screen: THREE.Vector2;
  /** Projection terms that turn a stored depth into view-space z. */
  depthParams: THREE.Vector3;
}

const bindings = new WeakMap<object, AmbientOcclusionBinding>();

/** Whether `material` takes the settled occlusion. */
export function receivesAmbientOcclusion(material: THREE.Material): boolean {
  return material.userData[RECEIVES] === true;
}

/**
 * The body-shader half: declarations and the joint-bilateral upsample. It
 * reads `vViewPosition`, which every lit three.js material declares.
 */
export const BODY_AO_PARS = /* glsl */ `
uniform sampler2D bodyAoMap;
uniform sampler2D bodyAoDepth;
uniform float bodyAoStrength;
uniform float bodyAoDirect;
uniform vec2 bodyAoTexel;
uniform vec2 bodyAoScreen;
uniform vec3 bodyAoDepthParams;

float bodyAoViewZ(float depth) {
  float ndc = depth * 2.0 - 1.0;
  return bodyAoDepthParams.z > 0.5
    ? (ndc - bodyAoDepthParams.y) / bodyAoDepthParams.x
    : -bodyAoDepthParams.y / (ndc + bodyAoDepthParams.x);
}

void bodyAoTap(vec2 cell, float bilinear, float z, float tolerance,
               inout float occlusion, inout float weight) {
  vec2 uv = (cell + 0.5) * bodyAoTexel;
  float dz = abs(bodyAoViewZ(texture2D(bodyAoDepth, uv).r) - z);
  float w = bilinear * (1.0 - smoothstep(0.0, 1.0, dz / tolerance));
  occlusion += texture2D(bodyAoMap, uv).r * w;
  weight += w;
}

// The half-resolution occlusion at this fragment, from the four nearest
// texels that lie on this fragment's own surface. A fragment none of them
// matches (a sliver thinner than a texel) is left unoccluded.
float bodyAmbientOcclusion() {
  vec2 st = gl_FragCoord.xy * bodyAoScreen / bodyAoTexel - 0.5;
  vec2 base = floor(st);
  vec2 f = st - base;
  float z = -vViewPosition.z;
  // Derivatives first: they are undefined after a divergent return.
  float tolerance = abs(z) * 0.01 + fwidth(z) * 3.0 + 1e-6;
  // Most of a part is nowhere near a corner. One filtered fetch of the same
  // four texels settles those fragments; only shaded ones pay for the
  // depth-matched taps.
  if (texture2D(bodyAoMap, (base + 1.0) * bodyAoTexel).r > 0.998) return 1.0;
  float occlusion = 0.0;
  float weight = 0.0;
  bodyAoTap(base, (1.0 - f.x) * (1.0 - f.y), z, tolerance, occlusion, weight);
  bodyAoTap(base + vec2(1.0, 0.0), f.x * (1.0 - f.y), z, tolerance, occlusion, weight);
  bodyAoTap(base + vec2(0.0, 1.0), (1.0 - f.x) * f.y, z, tolerance, occlusion, weight);
  bodyAoTap(base + vec2(1.0, 1.0), f.x * f.y, z, tolerance, occlusion, weight);
  float ao = weight > 1e-4 ? occlusion / weight : 1.0;
  return mix(1.0, ao, bodyAoStrength);
}
`;

/** Applied after three's own `aomap_fragment`, which the body never uses. */
export const BODY_AO_APPLY = /* glsl */ `
#include <aomap_fragment>
if (bodyAoStrength > 0.0) {
  float bodyAo = bodyAmbientOcclusion();
  reflectedLight.indirectDiffuse *= bodyAo;
  reflectedLight.indirectSpecular *= bodyAo;
  float bodyAoDirectScale = mix(1.0, bodyAo, bodyAoDirect);
  reflectedLight.directDiffuse *= bodyAoDirectScale;
  reflectedLight.directSpecular *= bodyAoDirectScale;
}
`;

const MAIN_ANCHOR = 'void main() {';
const APPLY_ANCHOR = '#include <aomap_fragment>';

/**
 * Lets a lit body material take the settled occlusion. It composes with the
 * material's existing compile and render hooks (the coplanar depth slot) and
 * extends its program cache key, so every body still shares one program.
 * Nothing changes until a {@link SettledAmbientOcclusion} on the same
 * renderer has computed a frame for the camera being drawn: until then, and
 * for any render into a target (thumbnails, image export), the strength
 * uniform is 0 and the shader skips the work.
 */
export function withBodyAmbientOcclusion<T extends THREE.Material>(
  material: T,
  settings: AmbientOcclusionSettings = AMBIENT_OCCLUSION
): T {
  const uniforms = {
    bodyAoMap: { value: null as THREE.Texture | null },
    bodyAoDepth: { value: null as THREE.Texture | null },
    bodyAoStrength: { value: 0 },
    bodyAoDirect: { value: settings.directOcclusion },
    bodyAoTexel: { value: new THREE.Vector2(1, 1) },
    bodyAoScreen: { value: new THREE.Vector2(1, 1) },
    bodyAoDepthParams: { value: new THREE.Vector3(-1, -1, 0) }
  };
  material.userData[RECEIVES] = true;
  const compile = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    compile(shader, renderer);
    if (
      !shader.fragmentShader.includes(MAIN_ANCHOR) ||
      !shader.fragmentShader.includes(APPLY_ANCHOR)
    ) {
      throw new Error('Body shader changed: ambient occlusion anchor missing.');
    }
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace(MAIN_ANCHOR, `${BODY_AO_PARS}\n${MAIN_ANCHOR}`)
      .replace(APPLY_ANCHOR, BODY_AO_APPLY);
  };
  const render = material.onBeforeRender.bind(material);
  material.onBeforeRender = (
    renderer,
    scene,
    camera,
    geometry,
    object,
    group
  ) => {
    render(renderer, scene, camera, geometry, object, group);
    const binding = bindings.get(renderer);
    const active =
      binding !== undefined &&
      binding.strength > 0 &&
      binding.map !== null &&
      binding.camera === camera &&
      renderer.getRenderTarget() === null &&
      renderer.domElement.width === binding.width &&
      renderer.domElement.height === binding.height &&
      !material.transparent;
    uniforms.bodyAoStrength.value = active ? binding.strength : 0;
    if (!active) return;
    uniforms.bodyAoMap.value = binding.map;
    uniforms.bodyAoDepth.value = binding.depth;
    uniforms.bodyAoTexel.value.copy(binding.texel);
    uniforms.bodyAoScreen.value.copy(binding.screen);
    uniforms.bodyAoDepthParams.value.copy(binding.depthParams);
  };
  const cacheKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${cacheKey()}|body-ao-v1`;
  return material;
}

/** The occlusion buffer for a drawing buffer: scaled, then capped. */
export function ambientOcclusionBufferSize(
  width: number,
  height: number,
  settings: Pick<
    AmbientOcclusionSettings,
    'resolutionScale' | 'maxPixels'
  > = AMBIENT_OCCLUSION
): { width: number; height: number } {
  let scale = settings.resolutionScale;
  const pixels = width * height * scale * scale;
  if (pixels > settings.maxPixels) {
    scale *= Math.sqrt(settings.maxPixels / pixels);
  }
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

/**
 * The stored-depth → view-z terms for `camera` (the shader's
 * `bodyAoDepthParams`): A and B of the projection's z row, and 1 for an
 * orthographic projection.
 */
export function depthParamsFor(
  camera: THREE.Camera,
  target = new THREE.Vector3()
): THREE.Vector3 {
  const e = camera.projectionMatrix.elements;
  const orthographic = (camera as THREE.OrthographicCamera).isOrthographicCamera
    ? 1
    : 0;
  return target.set(e[10], e[14], orthographic);
}

/** One step of {@link AmbientOcclusionSettle}. */
export interface SettleStep {
  /** Compute the occlusion before this frame draws. */
  compute: boolean;
  /** Strength the bodies draw with this frame. */
  strength: number;
  /** The frame after this one is needed (fading in). */
  animating: boolean;
  /** A frame is needed in this many ms, once the loop has gone to sleep. */
  wakeInMs: number | null;
  state: AmbientOcclusionState;
}

/**
 * When to compute and how strongly to draw, from whether this frame's view
 * differs from the last one's. Pure, so the timing contract is testable
 * without a GPU.
 */
export class AmbientOcclusionSettle {
  private dirty = true;
  private changedAt = Number.NEGATIVE_INFINITY;
  private computedAt = Number.NEGATIVE_INFINITY;
  private instant = false;

  constructor(
    private readonly settleMs: number,
    private readonly fadeMs: number
  ) {}

  /** Forget the computed occlusion (context loss, a disable). */
  invalidate(now = Number.NEGATIVE_INFINITY) {
    this.dirty = true;
    this.changedAt = now;
  }

  step(
    now: number,
    changed: boolean,
    enabled: boolean,
    reducedMotion = false
  ): SettleStep {
    if (!enabled) {
      this.invalidate();
      return {
        compute: false,
        strength: 0,
        animating: false,
        wakeInMs: null,
        state: 'off'
      };
    }
    if (changed || this.dirty) {
      if (changed) {
        this.dirty = true;
        this.changedAt = now;
      }
      const still = now - this.changedAt;
      if (!changed && still >= this.settleMs) {
        this.dirty = false;
        this.computedAt = now;
        this.instant = reducedMotion || this.fadeMs <= 0;
        const strength = this.instant ? 1 : 0;
        return {
          compute: true,
          strength,
          animating: strength < 1,
          wakeInMs: null,
          state: strength < 1 ? 'fading' : 'shown'
        };
      }
      return {
        compute: false,
        strength: 0,
        animating: false,
        wakeInMs: Math.max(this.settleMs - Math.max(still, 0), 0),
        state: 'waiting'
      };
    }
    const t = this.instant
      ? 1
      : Math.min(Math.max((now - this.computedAt) / this.fadeMs, 0), 1);
    const strength = t * t * (3 - 2 * t);
    return {
      compute: false,
      strength,
      animating: t < 1,
      wakeInMs: null,
      state: t < 1 ? 'fading' : 'shown'
    };
  }
}

/** Relative difference below which two signature values are the same. */
export const SIGNATURE_TOLERANCE = 1e-9;

/**
 * A list of numbers compared against the previous frame's, so "did anything
 * the occlusion depends on change" is one pass with no allocation.
 */
export class FrameSignature {
  private current: number[] = [];
  private previous: number[] = [];
  private seeded = false;

  push(value: number) {
    this.current.push(value);
  }

  pushArray(values: ArrayLike<number>) {
    for (let i = 0; i < values.length; i++) this.current.push(values[i]!);
  }

  /**
   * Ends the frame's signature: true if it differs from the last one by more
   * than float noise. A camera at rest is re-derived from its orbit target
   * every frame, and its pose wobbles in the last bits (about 1e-12 relative)
   * without moving a pixel; an exact compare re-armed the settle forever.
   */
  commit(): boolean {
    const a = this.current;
    const b = this.previous;
    let changed = !this.seeded || a.length !== b.length;
    for (let i = 0; !changed && i < a.length; i++) {
      const x = a[i]!;
      const y = b[i]!;
      changed =
        x !== y &&
        !(
          Math.abs(x - y) <=
          SIGNATURE_TOLERANCE * Math.max(1, Math.abs(x), Math.abs(y))
        );
    }
    this.previous = a;
    this.current = b;
    this.current.length = 0;
    this.seeded = true;
    return changed;
  }

  reset() {
    this.current.length = 0;
    this.seeded = false;
  }
}

/**
 * The opaque solids under `roots` that cast occlusion: every visible mesh
 * whose material receives it (the bodies) and the section caps and exact
 * section fills drawn with them. Translucent bodies (X-ray), wireframe-hidden
 * faces and selection overlays neither cast nor receive.
 */
export function collectOccluders(
  roots: readonly (THREE.Object3D | null | undefined)[],
  out: THREE.Mesh[] = []
): THREE.Mesh[] {
  out.length = 0;
  for (const root of roots) {
    root?.traverseVisible((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || object.userData.selectionOverlay === true) return;
      const material = mesh.material;
      if (Array.isArray(material) || !material.visible) return;
      if (material.transparent || material.opacity < 1) return;
      if ((material as THREE.MeshStandardMaterial).wireframe) return;
      if (
        receivesAmbientOcclusion(material) ||
        object.userData.sectionCap === true ||
        object.userData.exactSection === true
      ) {
        out.push(mesh);
      }
    });
  }
  return out;
}

/** Everything about the solids an occlusion buffer depends on. */
export function signOccluders(
  occluders: readonly THREE.Mesh[],
  signature: FrameSignature
) {
  signature.push(occluders.length);
  for (const mesh of occluders) {
    const geometry = mesh.geometry;
    const position = geometry.getAttribute('position') as
      THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
    signature.push(mesh.id);
    signature.push(geometry.id);
    signature.push(
      position === undefined
        ? -1
        : (position as THREE.InterleavedBufferAttribute)
              .isInterleavedBufferAttribute
          ? (position as THREE.InterleavedBufferAttribute).data.version
          : (position as THREE.BufferAttribute).version
    );
    signature.push(geometry.index?.version ?? -1);
    signature.push(geometry.drawRange.start);
    signature.push(geometry.drawRange.count);
    signature.pushArray(mesh.matrixWorld.elements);
    const material = mesh.material as THREE.Material;
    signature.push(material.side);
    signature.push(
      (material as THREE.MeshStandardMaterial).flatShading ? 1 : 0
    );
    const planes = material.clippingPlanes;
    signature.push(planes?.length ?? 0);
    for (const plane of planes ?? []) {
      signature.push(plane.normal.x);
      signature.push(plane.normal.y);
      signature.push(plane.normal.z);
      signature.push(plane.constant);
    }
  }
}

const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** The occlusion estimate, at the occlusion buffer's resolution. */
export function ambientOcclusionFragment(
  settings: Pick<AmbientOcclusionSettings, 'samples' | 'spiralTurns'>
) {
  return /* glsl */ `
#define SAMPLES ${Math.max(1, Math.round(settings.samples))}
#define SPIRAL_TURNS ${settings.spiralTurns.toFixed(1)}
uniform sampler2D tNormal;
uniform sampler2D tDepth;
uniform mat4 projection;
uniform mat4 projectionInverse;
uniform vec2 resolution;
uniform float radius;
uniform float minRadiusPx;
uniform float maxRadiusPx;
uniform float intensity;
uniform float bias;
varying vec2 vUv;

vec3 viewPositionAt(vec2 uv, float depth) {
  vec4 view = projectionInverse * vec4(vec3(uv, depth) * 2.0 - 1.0, 1.0);
  return view.xyz / view.w;
}

void main() {
  float depth = texture2D(tDepth, vUv).r;
  if (depth >= 1.0) {
    gl_FragColor = vec4(1.0);
    return;
  }
  vec3 p = viewPositionAt(vUv, depth);
  vec3 n = normalize(texture2D(tNormal, vUv).xyz * 2.0 - 1.0);
  // The world radius's extent on screen here, clamped: a distant part still
  // gets a few pixels of contact shade, a close one no more than a band.
  vec4 edge = projection * vec4(p + vec3(radius, 0.0, 0.0), 1.0);
  float radiusPx = abs((edge.x / edge.w) * 0.5 + 0.5 - vUv.x) * resolution.x;
  float px = clamp(radiusPx, minRadiusPx, maxRadiusPx);
  float r = radius * px / max(radiusPx, 1e-4);
  // Interleaved gradient noise turns each pixel's spiral; the blur that
  // follows averages the rotations away.
  float spin = 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float occlusion = 0.0;
  for (int i = 0; i < SAMPLES; i++) {
    float alpha = (float(i) + 0.5) / float(SAMPLES);
    float angle = alpha * (SPIRAL_TURNS * 6.2831853) + spin;
    vec2 uv = vUv + vec2(cos(angle), sin(angle)) * (alpha * px) / resolution;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) continue;
    float sampleDepth = texture2D(tDepth, uv).r;
    if (sampleDepth >= 1.0) continue;
    vec3 v = viewPositionAt(uv, sampleDepth) - p;
    float distance = length(v);
    if (distance < 1e-6 * r) continue;
    // Rising above the tangent plane: 0 on a plane or a convex surface.
    float rise = max(dot(v, n) / distance - bias, 0.0);
    // Nothing beyond the radius: no halo across a silhouette.
    float falloff = max(1.0 - (distance * distance) / (r * r), 0.0);
    occlusion += rise * falloff;
  }
  float ao = clamp(1.0 - intensity * 2.0 * occlusion / float(SAMPLES), 0.0, 1.0);
  gl_FragColor = vec4(ao, ao, ao, 1.0);
}
`;
}

/** One axis of the edge-preserving blur. */
export const AMBIENT_OCCLUSION_BLUR_FRAGMENT = /* glsl */ `
uniform sampler2D tAo;
uniform sampler2D tNormal;
uniform sampler2D tDepth;
uniform mat4 projectionInverse;
uniform vec2 direction;
varying vec2 vUv;

vec3 viewPositionAt(vec2 uv, float depth) {
  vec4 view = projectionInverse * vec4(vec3(uv, depth) * 2.0 - 1.0, 1.0);
  return view.xyz / view.w;
}

void main() {
  float depth = texture2D(tDepth, vUv).r;
  if (depth >= 1.0) {
    gl_FragColor = vec4(1.0);
    return;
  }
  vec3 p = viewPositionAt(vUv, depth);
  vec3 n = normalize(texture2D(tNormal, vUv).xyz * 2.0 - 1.0);
  float tolerance = abs(p.z) * 0.003 + 1e-6;
  float sum = 0.0;
  float weight = 0.0;
  for (int i = -4; i <= 4; i++) {
    vec2 uv = vUv + direction * float(i);
    float sampleDepth = texture2D(tDepth, uv).r;
    if (sampleDepth >= 1.0) continue;
    vec3 q = viewPositionAt(uv, sampleDepth);
    vec3 m = normalize(texture2D(tNormal, uv).xyz * 2.0 - 1.0);
    // Same surface only: near this pixel's tangent plane, facing its way.
    float plane = abs(dot(q - p, n)) / (tolerance + abs(float(i)) * tolerance);
    float w = exp(-float(i * i) / 10.0)
      * max(1.0 - plane, 0.0)
      * pow(max(dot(m, n), 0.0), 8.0);
    sum += texture2D(tAo, uv).r * w;
    weight += w;
  }
  float ao = weight > 1e-4 ? sum / weight : texture2D(tAo, vUv).r;
  gl_FragColor = vec4(ao, ao, ao, 1.0);
}
`;

function fullscreenTriangle(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3)
  );
  geometry.setAttribute(
    'uv',
    new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2)
  );
  return geometry;
}

/**
 * An occlusion buffer. Linear filtering serves the body shader's one-fetch
 * early out; every other read lands on a texel centre, where it is exact.
 */
function colorTarget(width: number, height: number) {
  return new THREE.WebGLRenderTarget(width, height, {
    format: THREE.RedFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false
  });
}

export interface AmbientOcclusionFrame {
  now: number;
  camera: THREE.Camera;
  /** The groups whose solids cast and receive (the viewer's body group). */
  roots: readonly (THREE.Object3D | null | undefined)[];
  /** False in X-ray, wireframe, or wherever the viewer wants it off. */
  enabled: boolean;
  reducedMotion?: boolean;
}

export interface AmbientOcclusionResult {
  /** The loop should draw another frame (the fade-in). */
  animating: boolean;
  /** Milliseconds spent computing the occlusion this frame, if it did. */
  computedMs: number | null;
  state: AmbientOcclusionState;
}

/**
 * Owns the occlusion buffers for one renderer and decides, frame by frame,
 * whether the bodies draw with them. Call {@link beforeRender} immediately
 * before the frame's `renderer.render`.
 */
export class SettledAmbientOcclusion {
  private readonly settle: AmbientOcclusionSettle;
  private readonly cameraSignature = new FrameSignature();
  private readonly solidSignature = new FrameSignature();
  private readonly occluders: THREE.Mesh[] = [];
  private readonly binding: AmbientOcclusionBinding;
  private readonly prepassScene = new THREE.Scene();
  private readonly proxies = new WeakMap<THREE.Mesh, THREE.Mesh>();
  /** Prepass materials by side, shading and clipping planes. */
  private readonly normalMaterials = new Map<
    string,
    THREE.MeshNormalMaterial
  >();
  private readonly usedNormalMaterials = new Set<string>();
  private readonly quadCamera = new THREE.OrthographicCamera(
    -1,
    1,
    1,
    -1,
    0,
    1
  );
  private readonly quad: THREE.Mesh;
  private readonly quadScene = new THREE.Scene();
  private readonly aoMaterial: THREE.ShaderMaterial;
  private readonly blurMaterial: THREE.ShaderMaterial;
  private prepassTarget: THREE.WebGLRenderTarget | null = null;
  private aoTarget: THREE.WebGLRenderTarget | null = null;
  private blurTarget: THREE.WebGLRenderTarget | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly bounds = new THREE.Box3();
  private readonly box = new THREE.Box3();
  private readonly clearColor = new THREE.Color();
  private currentState: AmbientOcclusionState = 'waiting';

  private readonly settings: AmbientOcclusionSettings;
  private readonly measureGpu: boolean;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly requestRender: () => void,
    options: {
      settings?: AmbientOcclusionSettings;
      /** Wait for the GPU inside the compute timing (perf builds only). */
      measureGpu?: boolean;
    } = {}
  ) {
    const settings = options.settings ?? AMBIENT_OCCLUSION;
    this.settings = settings;
    this.measureGpu = options.measureGpu === true;
    this.settle = new AmbientOcclusionSettle(
      settings.settleMs,
      settings.fadeMs
    );
    this.binding = {
      camera: null,
      strength: 0,
      map: null,
      depth: null,
      width: 0,
      height: 0,
      texel: new THREE.Vector2(1, 1),
      screen: new THREE.Vector2(1, 1),
      depthParams: new THREE.Vector3()
    };
    bindings.set(renderer, this.binding);
    this.aoMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tNormal: { value: null },
        tDepth: { value: null },
        projection: { value: new THREE.Matrix4() },
        projectionInverse: { value: new THREE.Matrix4() },
        resolution: { value: new THREE.Vector2() },
        radius: { value: 1 },
        minRadiusPx: { value: settings.minRadiusPx },
        maxRadiusPx: { value: settings.maxRadiusPx },
        intensity: { value: settings.intensity },
        bias: { value: settings.bias }
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: ambientOcclusionFragment(settings),
      depthTest: false,
      depthWrite: false
    });
    this.blurMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tAo: { value: null },
        tNormal: { value: null },
        tDepth: { value: null },
        projectionInverse: { value: new THREE.Matrix4() },
        direction: { value: new THREE.Vector2() }
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: AMBIENT_OCCLUSION_BLUR_FRAGMENT,
      depthTest: false,
      depthWrite: false
    });
    this.quad = new THREE.Mesh(fullscreenTriangle(), this.aoMaterial);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  get state(): AmbientOcclusionState {
    return this.currentState;
  }

  /** Drops the computed occlusion; the next still frame recomputes it. */
  invalidate() {
    this.settle.invalidate();
    this.cameraSignature.reset();
    this.solidSignature.reset();
    this.binding.strength = 0;
  }

  beforeRender(frame: AmbientOcclusionFrame): AmbientOcclusionResult {
    const { camera } = frame;
    const width = this.renderer.domElement.width;
    const height = this.renderer.domElement.height;
    // The camera has no parent, so its pose is its own transform; its
    // matrixWorld is only brought up to date by the render about to run.
    const cameraSignature = this.cameraSignature;
    const { position, quaternion } = camera;
    cameraSignature.push(camera.id);
    cameraSignature.push(position.x);
    cameraSignature.push(position.y);
    cameraSignature.push(position.z);
    cameraSignature.push(quaternion.x);
    cameraSignature.push(quaternion.y);
    cameraSignature.push(quaternion.z);
    cameraSignature.push(quaternion.w);
    cameraSignature.pushArray(camera.projectionMatrix.elements);
    cameraSignature.push(width);
    cameraSignature.push(height);
    let changed = cameraSignature.commit();
    if (frame.enabled && !changed) {
      // Only a still camera pays for walking the solids: the occlusion is
      // hidden while it moves whatever they do, and the first still frame
      // compares against the last solids it saw.
      for (const root of frame.roots) root?.updateMatrixWorld();
      collectOccluders(frame.roots, this.occluders);
      signOccluders(this.occluders, this.solidSignature);
      changed = this.solidSignature.commit() || changed;
    }
    const step = this.settle.step(
      frame.now,
      changed,
      frame.enabled,
      frame.reducedMotion
    );
    let computedMs: number | null = null;
    if (step.compute) {
      const started = performance.now();
      if (this.occluders.length > 0) {
        this.compute(camera, width, height);
        if (this.measureGpu) this.renderer.getContext().finish();
        this.binding.camera = camera;
      } else {
        // Nothing to occlude (an empty model, everything in X-ray).
        this.binding.map = null;
      }
      computedMs = performance.now() - started;
    }
    const drawn =
      this.binding.map !== null &&
      (step.state === 'fading' || step.state === 'shown');
    this.binding.strength = drawn ? step.strength * this.settings.strength : 0;
    this.scheduleWake(step.wakeInMs);
    const state = drawn || step.state === 'waiting' ? step.state : 'off';
    this.currentState = state;
    return { animating: drawn && step.animating, computedMs, state };
  }

  private scheduleWake(delayMs: number | null) {
    if (this.wakeTimer !== null) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    if (delayMs === null) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.requestRender();
    }, delayMs + 1);
  }

  /**
   * The prepass material for a solid: its side, its shading and the section
   * planes it is clipped by, so the buffer holds what the frame shows.
   */
  private normalMaterialFor(source: THREE.Material): THREE.MeshNormalMaterial {
    const planes = source.clippingPlanes;
    const flat = (source as THREE.MeshStandardMaterial).flatShading === true;
    let key = `${source.side}:${flat ? 1 : 0}`;
    for (const plane of planes ?? []) {
      key += `:${plane.normal.x},${plane.normal.y},${plane.normal.z},${plane.constant}`;
    }
    this.usedNormalMaterials.add(key);
    let material = this.normalMaterials.get(key);
    if (!material) {
      material = new THREE.MeshNormalMaterial({
        side: source.side,
        flatShading: flat
      });
      material.clippingPlanes = planes
        ? planes.map((plane) => plane.clone())
        : null;
      this.normalMaterials.set(key, material);
    }
    return material;
  }

  /** Disposes the prepass materials the last compute did not use. */
  private pruneNormalMaterials() {
    for (const [key, material] of this.normalMaterials) {
      if (!this.usedNormalMaterials.has(key)) {
        material.dispose();
        this.normalMaterials.delete(key);
      }
    }
    this.usedNormalMaterials.clear();
  }

  private ensureTargets(width: number, height: number) {
    const size = ambientOcclusionBufferSize(width, height, this.settings);
    if (!this.prepassTarget) {
      this.prepassTarget = new THREE.WebGLRenderTarget(
        size.width,
        size.height,
        {
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
        }
      );
      this.aoTarget = colorTarget(size.width, size.height);
      this.blurTarget = colorTarget(size.width, size.height);
    } else if (
      this.prepassTarget.width !== size.width ||
      this.prepassTarget.height !== size.height
    ) {
      this.prepassTarget.setSize(size.width, size.height);
      this.aoTarget!.setSize(size.width, size.height);
      this.blurTarget!.setSize(size.width, size.height);
    }
    return size;
  }

  private compute(camera: THREE.Camera, width: number, height: number) {
    const renderer = this.renderer;
    const size = this.ensureTargets(width, height);
    const prepass = this.prepassTarget!;
    const ao = this.aoTarget!;
    const blur = this.blurTarget!;

    // The solids alone, as view-space normals and depth. Proxies share each
    // body's geometry and world matrix, so nothing is copied.
    this.prepassScene.clear();
    this.bounds.makeEmpty();
    for (const mesh of this.occluders) {
      let proxy = this.proxies.get(mesh);
      if (!proxy) {
        proxy = new THREE.Mesh();
        proxy.matrixAutoUpdate = false;
        this.proxies.set(mesh, proxy);
      }
      proxy.geometry = mesh.geometry;
      proxy.material = this.normalMaterialFor(mesh.material as THREE.Material);
      proxy.matrix.copy(mesh.matrixWorld);
      proxy.frustumCulled = mesh.frustumCulled;
      this.prepassScene.add(proxy);
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      this.bounds.union(
        this.box.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld)
      );
    }
    const diagonal = this.bounds.isEmpty()
      ? 1
      : this.bounds.max.distanceTo(this.bounds.min);

    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    const previousClearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clearColor);
    renderer.autoClear = true;
    renderer.setClearColor(0x8080ff, 1);

    renderer.setRenderTarget(prepass);
    renderer.render(this.prepassScene, camera);

    const projection = camera.projectionMatrix;
    const inverse = camera.projectionMatrixInverse;
    const aoUniforms = this.aoMaterial.uniforms;
    aoUniforms.tNormal!.value = prepass.texture;
    aoUniforms.tDepth!.value = prepass.depthTexture;
    (aoUniforms.projection!.value as THREE.Matrix4).copy(projection);
    (aoUniforms.projectionInverse!.value as THREE.Matrix4).copy(inverse);
    (aoUniforms.resolution!.value as THREE.Vector2).set(
      size.width,
      size.height
    );
    aoUniforms.radius!.value = diagonal * this.settings.radiusFraction;
    this.quad.material = this.aoMaterial;
    renderer.setRenderTarget(ao);
    renderer.render(this.quadScene, this.quadCamera);

    const blurUniforms = this.blurMaterial.uniforms;
    blurUniforms.tNormal!.value = prepass.texture;
    blurUniforms.tDepth!.value = prepass.depthTexture;
    (blurUniforms.projectionInverse!.value as THREE.Matrix4).copy(inverse);
    this.quad.material = this.blurMaterial;
    blurUniforms.tAo!.value = ao.texture;
    (blurUniforms.direction!.value as THREE.Vector2).set(1 / size.width, 0);
    renderer.setRenderTarget(blur);
    renderer.render(this.quadScene, this.quadCamera);
    blurUniforms.tAo!.value = blur.texture;
    (blurUniforms.direction!.value as THREE.Vector2).set(0, 1 / size.height);
    renderer.setRenderTarget(ao);
    renderer.render(this.quadScene, this.quadCamera);

    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(this.clearColor, previousClearAlpha);
    renderer.autoClear = previousAutoClear;
    this.prepassScene.clear();
    this.pruneNormalMaterials();

    const binding = this.binding;
    binding.map = ao.texture;
    binding.depth = prepass.depthTexture;
    binding.width = width;
    binding.height = height;
    binding.texel.set(1 / size.width, 1 / size.height);
    binding.screen.set(1 / width, 1 / height);
    depthParamsFor(camera, binding.depthParams);
  }

  dispose() {
    if (this.wakeTimer !== null) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    bindings.delete(this.renderer);
    this.prepassTarget?.depthTexture?.dispose();
    this.prepassTarget?.dispose();
    this.aoTarget?.dispose();
    this.blurTarget?.dispose();
    this.aoMaterial.dispose();
    this.blurMaterial.dispose();
    this.quad.geometry.dispose();
    for (const material of this.normalMaterials.values()) material.dispose();
    this.normalMaterials.clear();
  }
}
