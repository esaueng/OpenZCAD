import * as THREE from 'three';

/**
 * The studio light rig every shaded solid is lit by (U10 slice 2), in one
 * place so the viewport, project thumbnails and image export agree.
 *
 * The look it aims for is the one a CAD part reads best in: each face
 * orientation gets its own value — tops lightest, walls in between, undersides
 * darkest — and the walls facing different ways separate from each other too.
 * Two things do that:
 *
 * - A world-fixed, Z-up gradient environment (bright overhead, mid-grey
 *   horizon, dark floor) gives every physically based material its ambient
 *   term. Its value depends only on which way a face points, so it is what
 *   separates tops from walls from undersides from every view. It is blurred
 *   and holds no small features, so the tessellation-crawl that the old
 *   RoomEnvironment reflections caused (the reason bodies were Phong) has
 *   nothing sharp to reflect.
 * - A key light that turns with the camera, from above and to the right of
 *   the viewer. Walls facing different ways around the vertical then always
 *   come out at different values, where a world-fixed key lit two visible
 *   walls identically from some views.
 *
 * A world-fixed light still casts the ground shadow (the shadow map is frozen
 * while orbiting, so its light must not move with the camera), but it is kept
 * dim so the camera key does the modelling.
 */
export const STUDIO_RIG = {
  /**
   * Linear radiance overhead and underfoot, joined by one smooth curve
   * (`falloff` shapes it; the horizon lands near 0.4). A curve with a kink at
   * the horizon reflected as a faint ring across spheres and fillets.
   */
  environment: {
    zenith: 1.0,
    // Not black: viewed from below, the camera key (which keeps the
    // camera's world-up) no longer reaches an underside, and at 0.05 one went
    // nearly black and lost its edges against the stage.
    nadir: 0.15,
    falloff: 1.4,
    /** A broad overhead softbox lobe, so tops and fillets catch a sheen. */
    softbox: 0.9,
    softboxDirection: [0.25, -0.35, 0.9] as const,
    /** Lobe sharpness: higher is tighter. Kept broad to stay crawl-free. */
    softboxFocus: 6
  },
  /** Strength `scene.environmentIntensity` is set to. */
  environmentIntensity: 0.85,
  /**
   * The key's direction in camera space: +x right, +y up, +z toward the
   * viewer. Above and to the right, a little in front.
   */
  cameraKeyDirection: [0.55, 0.65, 0.52] as const,
  cameraKeyIntensity: 1.25,
  /** The world-fixed light that casts the ground shadow. */
  shadowKeyIntensity: 0.45,
  /** Neutral sky with a dark floor bounce. */
  hemisphere: { sky: '#ffffff', ground: '#4a4d55', intensity: 0.2 },
  /**
   * Hemisphere strength when no environment map is built (E2E builds skip
   * it): enough ambient that undersides stay legible without one.
   */
  hemisphereWithoutEnvironment: 0.95,
  /** Body material response: a satin, non-metallic finish. */
  material: { roughness: 0.52, metalness: 0 },
  toneMapping: THREE.NeutralToneMapping,
  toneMappingExposure: 1
} as const;

/**
 * The studio environment, baked once to a PMREM texture. See
 * {@link STUDIO_RIG} for why it is a plain gradient with one broad lobe.
 */
export function createStudioEnvironment(
  renderer: THREE.WebGLRenderer
): THREE.Texture {
  const { zenith, nadir, falloff, softbox, softboxDirection, softboxFocus } =
    STUDIO_RIG.environment;
  const scene = new THREE.Scene();
  const geometry = new THREE.SphereGeometry(10, 64, 32);
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      zenith: { value: zenith },
      nadir: { value: nadir },
      falloff: { value: falloff },
      softbox: { value: softbox },
      softboxDirection: {
        value: new THREE.Vector3(...softboxDirection).normalize()
      },
      softboxFocus: { value: softboxFocus }
    },
    vertexShader: /* glsl */ `
      varying vec3 vDirection;
      void main() {
        vDirection = normalize((modelMatrix * vec4(position, 0.0)).xyz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float zenith;
      uniform float nadir;
      uniform float falloff;
      uniform float softbox;
      uniform vec3 softboxDirection;
      uniform float softboxFocus;
      varying vec3 vDirection;
      void main() {
        vec3 direction = normalize(vDirection);
        float value = mix(nadir, zenith, pow(0.5 + 0.5 * direction.z, falloff));
        value += softbox * exp(softboxFocus * (dot(direction, softboxDirection) - 1.0));
        gl_FragColor = vec4(vec3(value), 1.0);
      }
    `
  });
  scene.add(new THREE.Mesh(geometry, material));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0.04, 0.1, 100);
  pmrem.dispose();
  geometry.dispose();
  material.dispose();
  return target.texture;
}

/** The sky/floor fill. Dim beside the environment; see {@link STUDIO_RIG}. */
export function createStudioHemisphereLight(): THREE.HemisphereLight {
  const { sky, ground, intensity } = STUDIO_RIG.hemisphere;
  const light = new THREE.HemisphereLight(sky, ground, intensity);
  light.position.set(0, 0, 1);
  return light;
}

/**
 * The key light that turns with the camera. It casts no shadow; call
 * {@link aimCameraKey} before each frame. Its target is never moved, so it
 * need not be in the scene: only the light's position relative to the
 * target's origin sets a directional light's direction.
 */
export function createCameraKeyLight(): THREE.DirectionalLight {
  const light = new THREE.DirectionalLight(
    '#ffffff',
    STUDIO_RIG.cameraKeyIntensity
  );
  light.name = 'camera-key';
  light.castShadow = false;
  aimCameraKey(light, new THREE.Quaternion());
  return light;
}

const keyDirection = new THREE.Vector3();

/** Points the camera key from the camera-space direction in the rig. */
export function aimCameraKey(
  light: THREE.DirectionalLight,
  cameraQuaternion: THREE.Quaternion
): void {
  keyDirection
    .set(...STUDIO_RIG.cameraKeyDirection)
    .normalize()
    .applyQuaternion(cameraQuaternion);
  if (light.position.equals(keyDirection)) return;
  light.position.copy(keyDirection);
  light.updateMatrixWorld();
}
