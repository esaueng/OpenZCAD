import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AMBIENT_OCCLUSION,
  AmbientOcclusionSettle,
  FrameSignature,
  SettledAmbientOcclusion,
  ambientOcclusionBufferSize,
  collectOccluders,
  depthParamsFor,
  receivesAmbientOcclusion,
  signOccluders,
  withBodyAmbientOcclusion
} from './ambientOcclusion';
import { withCoplanarDepth } from './coplanarBodies';

/** The shader object three hands `onBeforeCompile`, from the real sources. */
function physicalShader() {
  const source = THREE.ShaderLib.physical;
  return {
    uniforms: THREE.UniformsUtils.clone(source.uniforms),
    vertexShader: source.vertexShader,
    fragmentShader: source.fragmentShader
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
}

function bodyMaterial() {
  return withBodyAmbientOcclusion(
    withCoplanarDepth(new THREE.MeshStandardMaterial())
  );
}

/** Compiles the hooks and returns the uniforms the shader would read. */
function compiledUniforms(material: THREE.Material) {
  const shader = physicalShader();
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return { shader, uniforms: shader.uniforms };
}

/**
 * Just enough renderer for the controller: it records the passes it is asked
 * to draw and reports a fixed drawing buffer. No GL is involved.
 */
function fakeRenderer(width = 800, height = 600) {
  const passes: string[] = [];
  let target: THREE.WebGLRenderTarget | null = null;
  const renderer = {
    domElement: { width, height },
    autoClear: true,
    getRenderTarget: () => target,
    setRenderTarget: (next: THREE.WebGLRenderTarget | null) => {
      target = next;
    },
    getClearAlpha: () => 1,
    getClearColor: (color: THREE.Color) => color.set(0x000000),
    setClearColor: () => undefined,
    render: (scene: THREE.Scene) => {
      const first = scene.children[0] as THREE.Mesh | undefined;
      passes.push(
        first?.material instanceof THREE.MeshNormalMaterial ? 'prepass' : 'quad'
      );
    },
    // The coplanar depth hook reads the depth bits.
    getContext: () => ({
      finish: () => undefined,
      DEPTH_BITS: 0x0d56,
      getParameter: () => 24
    })
  };
  return { renderer: renderer as unknown as THREE.WebGLRenderer, passes };
}

function solid(material: THREE.Material = bodyMaterial()) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), material);
  mesh.add(
    new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial()
    )
  );
  return mesh;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('settled ambient occlusion timing', () => {
  const { settleMs, fadeMs } = AMBIENT_OCCLUSION;

  it('waits for the view to rest, computes once, then fades in', () => {
    const settle = new AmbientOcclusionSettle(settleMs, fadeMs);
    const moving = settle.step(0, true, true);
    expect(moving).toMatchObject({
      compute: false,
      strength: 0,
      state: 'waiting'
    });
    expect(moving.wakeInMs).toBe(settleMs);

    const early = settle.step(settleMs / 2, false, true);
    expect(early).toMatchObject({
      compute: false,
      strength: 0,
      state: 'waiting'
    });
    expect(early.wakeInMs).toBeCloseTo(settleMs / 2);

    const computed = settle.step(settleMs, false, true);
    expect(computed).toMatchObject({
      compute: true,
      animating: true,
      state: 'fading'
    });
    expect(computed.strength).toBe(0);

    const half = settle.step(settleMs + fadeMs / 2, false, true);
    expect(half.compute).toBe(false);
    expect(half.strength).toBeCloseTo(0.5);
    expect(half.animating).toBe(true);

    const shown = settle.step(settleMs + fadeMs, false, true);
    expect(shown).toMatchObject({
      compute: false,
      strength: 1,
      animating: false,
      wakeInMs: null,
      state: 'shown'
    });
    // Resting further asks for nothing: the loop can sleep.
    expect(settle.step(settleMs + fadeMs + 5000, false, true)).toMatchObject({
      compute: false,
      animating: false,
      wakeInMs: null
    });
  });

  it('hides the occlusion the moment anything changes', () => {
    const settle = new AmbientOcclusionSettle(settleMs, fadeMs);
    settle.step(0, true, true);
    settle.step(settleMs, false, true);
    settle.step(settleMs + fadeMs, false, true);
    expect(settle.step(1000, true, true)).toMatchObject({
      strength: 0,
      compute: false,
      state: 'waiting'
    });
    // Each further change restarts the wait.
    expect(settle.step(1000 + settleMs - 1, true, true).wakeInMs).toBe(
      settleMs
    );
  });

  it('shows at once under reduced motion', () => {
    const settle = new AmbientOcclusionSettle(settleMs, fadeMs);
    settle.step(0, true, true, true);
    expect(settle.step(settleMs, false, true, true)).toMatchObject({
      compute: true,
      strength: 1,
      animating: false,
      state: 'shown'
    });
  });

  it('is off while disabled and recomputes when re-enabled', () => {
    const settle = new AmbientOcclusionSettle(settleMs, fadeMs);
    settle.step(0, true, true);
    settle.step(settleMs, false, true);
    expect(settle.step(400, false, false)).toMatchObject({
      strength: 0,
      compute: false,
      wakeInMs: null,
      state: 'off'
    });
    expect(settle.step(500, false, true).compute).toBe(true);
  });
});

describe('frame signature', () => {
  it('reports the first frame and any real change', () => {
    const signature = new FrameSignature();
    signature.pushArray([1, 2, 3]);
    expect(signature.commit()).toBe(true);
    signature.pushArray([1, 2, 3]);
    expect(signature.commit()).toBe(false);
    signature.pushArray([1, 2, 3.001]);
    expect(signature.commit()).toBe(true);
    signature.pushArray([1, 2]);
    expect(signature.commit()).toBe(true);
  });

  it('ignores last-bit float wobble in a camera at rest', () => {
    const signature = new FrameSignature();
    signature.pushArray([-89.48249794078401, 0.4445699345978112]);
    signature.commit();
    signature.pushArray([-89.48249794078276, 0.4445699345978111]);
    expect(signature.commit()).toBe(false);
  });
});

describe('occlusion buffer size', () => {
  it('is half the drawing buffer', () => {
    expect(ambientOcclusionBufferSize(1600, 1000)).toEqual({
      width: 800,
      height: 500
    });
  });

  it('is capped in pixels on a Retina iPad-class canvas', () => {
    const size = ambientOcclusionBufferSize(2048, 2732);
    expect(size.width * size.height).toBeLessThanOrEqual(
      AMBIENT_OCCLUSION.maxPixels * 1.001
    );
    expect(size.width / size.height).toBeCloseTo(2048 / 2732, 2);
    const huge = ambientOcclusionBufferSize(5120, 2880);
    expect(huge.width * huge.height).toBeLessThanOrEqual(
      AMBIENT_OCCLUSION.maxPixels * 1.001
    );
  });
});

describe('stored depth to view z', () => {
  // The body shader's bodyAoViewZ, transcribed.
  const viewZ = (depth: number, params: THREE.Vector3) => {
    const ndc = depth * 2 - 1;
    return params.z > 0.5
      ? (ndc - params.y) / params.x
      : -params.y / (ndc + params.x);
  };
  const storedDepth = (camera: THREE.Camera, z: number) => {
    const clip = new THREE.Vector4(0, 0, z, 1).applyMatrix4(
      camera.projectionMatrix
    );
    return (clip.z / clip.w) * 0.5 + 0.5;
  };

  it('inverts a perspective projection', () => {
    const camera = new THREE.PerspectiveCamera(40, 1.5, 0.2, 4000);
    const params = depthParamsFor(camera);
    expect(params.z).toBe(0);
    for (const z of [-0.5, -12, -350, -3900]) {
      expect(viewZ(storedDepth(camera, z), params)).toBeCloseTo(z, 4);
    }
  });

  it('inverts an orthographic projection', () => {
    const camera = new THREE.OrthographicCamera(-50, 50, 40, -40, 0.1, 900);
    const params = depthParamsFor(camera);
    expect(params.z).toBe(1);
    for (const z of [-1, -77, -899]) {
      expect(viewZ(storedDepth(camera, z), params)).toBeCloseTo(z, 6);
    }
  });
});

describe('body shader hook', () => {
  it('marks the material and extends its program key', () => {
    const material = bodyMaterial();
    expect(receivesAmbientOcclusion(material)).toBe(true);
    expect(receivesAmbientOcclusion(new THREE.MeshStandardMaterial())).toBe(
      false
    );
    expect(material.customProgramCacheKey()).toBe(
      'coplanar-body-face-depth-v1|body-ao-v1'
    );
  });

  it('injects the upsample before main and scales lighting after aomap', () => {
    const { shader, uniforms } = compiledUniforms(bodyMaterial());
    const fragment = shader.fragmentShader;
    expect(fragment.indexOf('float bodyAmbientOcclusion()')).toBeLessThan(
      fragment.indexOf('void main() {')
    );
    const apply = fragment.indexOf('float bodyAo = bodyAmbientOcclusion();');
    expect(apply).toBeGreaterThan(
      fragment.indexOf('#include <aomap_fragment>')
    );
    expect(apply).toBeLessThan(fragment.indexOf('#include <opaque_fragment>'));
    expect(fragment).toContain('if (bodyAoStrength > 0.0)');
    // The coplanar depth hook still runs.
    expect(shader.vertexShader).toContain('coplanarDepthEnabled');
    expect(uniforms.bodyAoStrength!.value).toBe(0);
    expect(uniforms.bodyAoDirect!.value).toBe(
      AMBIENT_OCCLUSION.directOcclusion
    );
  });

  it('refuses a shader that lost its anchor', () => {
    const material = bodyMaterial();
    const shader = physicalShader();
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <aomap_fragment>',
      ''
    );
    expect(() =>
      material.onBeforeCompile(shader, {} as THREE.WebGLRenderer)
    ).toThrow(/ambient occlusion anchor/);
  });

  it('draws without occlusion on a renderer that never computed any', () => {
    const material = bodyMaterial();
    const { uniforms } = compiledUniforms(material);
    const { renderer } = fakeRenderer();
    material.onBeforeRender(
      renderer,
      new THREE.Scene(),
      new THREE.PerspectiveCamera(),
      new THREE.BufferGeometry(),
      new THREE.Mesh(),
      null as unknown as THREE.Group
    );
    expect(uniforms.bodyAoStrength!.value).toBe(0);
  });
});

describe('occluders', () => {
  it('takes opaque visible bodies, section caps and exact section fills', () => {
    const root = new THREE.Group();
    const body = solid();
    const cap = new THREE.Mesh(
      new THREE.PlaneGeometry(),
      new THREE.MeshStandardMaterial()
    );
    cap.userData.sectionCap = true;
    body.add(cap);
    const exact = new THREE.Mesh(
      new THREE.PlaneGeometry(),
      new THREE.MeshBasicMaterial()
    );
    exact.userData.exactSection = true;
    const xray = solid(bodyMaterial());
    xray.material.transparent = true;
    xray.material.opacity = 0.35;
    const wireframe = solid();
    wireframe.material.visible = false;
    const hidden = new THREE.Group();
    hidden.visible = false;
    hidden.add(solid());
    const overlay = solid();
    overlay.userData.selectionOverlay = true;
    const decoration = new THREE.Mesh(
      new THREE.PlaneGeometry(),
      new THREE.MeshBasicMaterial()
    );
    root.add(body, exact, xray, wireframe, hidden, overlay, decoration);
    expect(collectOccluders([root])).toEqual([body, cap, exact]);
  });

  it('signs what the occlusion depends on', () => {
    const mesh = solid();
    mesh.updateMatrixWorld();
    const signature = new FrameSignature();
    const sign = () => {
      signOccluders([mesh], signature);
      return signature.commit();
    };
    expect(sign()).toBe(true);
    expect(sign()).toBe(false);
    // Moved.
    mesh.position.x = 4;
    mesh.updateMatrixWorld();
    expect(sign()).toBe(true);
    expect(sign()).toBe(false);
    // Edited in place (buffer reuse).
    mesh.geometry.getAttribute('position').needsUpdate = true;
    expect(sign()).toBe(true);
    // Section plane moved.
    const material = mesh.material;
    material.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 0, -1), 3)];
    expect(sign()).toBe(true);
    material.clippingPlanes[0]!.constant = 4;
    expect(sign()).toBe(true);
    expect(sign()).toBe(false);
  });
});

describe('settled ambient occlusion controller', () => {
  function rig() {
    vi.useFakeTimers();
    const { renderer, passes } = fakeRenderer();
    const requestRender = vi.fn();
    const ao = new SettledAmbientOcclusion(renderer, requestRender);
    const camera = new THREE.PerspectiveCamera(40, 800 / 600, 0.1, 1000);
    camera.position.set(30, -30, 30);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const root = new THREE.Group();
    const material = bodyMaterial();
    root.add(solid(material));
    const { uniforms } = compiledUniforms(material);
    const draw = () =>
      material.onBeforeRender(
        renderer,
        new THREE.Scene(),
        camera,
        new THREE.BufferGeometry(),
        new THREE.Mesh(),
        null as unknown as THREE.Group
      );
    const frame = (now: number, enabled = true) =>
      ao.beforeRender({ now, camera, roots: [root], enabled });
    return {
      ao,
      renderer,
      passes,
      requestRender,
      camera,
      uniforms,
      draw,
      frame
    };
  }

  it('wakes the loop after the settle, computes four passes and fades in', () => {
    const { ao, passes, requestRender, uniforms, draw, frame } = rig();
    expect(frame(0)).toMatchObject({ state: 'waiting', animating: false });
    draw();
    expect(uniforms.bodyAoStrength!.value).toBe(0);
    expect(requestRender).not.toHaveBeenCalled();
    vi.advanceTimersByTime(AMBIENT_OCCLUSION.settleMs + 2);
    expect(requestRender).toHaveBeenCalledTimes(1);

    // The first still frame still compares solids against nothing.
    expect(frame(AMBIENT_OCCLUSION.settleMs + 2).state).toBe('waiting');
    vi.advanceTimersByTime(AMBIENT_OCCLUSION.settleMs + 2);
    const computed = frame(2 * AMBIENT_OCCLUSION.settleMs + 4);
    expect(computed.computedMs).not.toBeNull();
    expect(computed).toMatchObject({ state: 'fading', animating: true });
    expect(passes).toEqual(['prepass', 'quad', 'quad', 'quad']);

    const shown = frame(10_000);
    expect(shown).toMatchObject({ state: 'shown', animating: false });
    draw();
    expect(uniforms.bodyAoStrength!.value).toBeCloseTo(
      AMBIENT_OCCLUSION.strength
    );
    expect(uniforms.bodyAoMap!.value).not.toBeNull();
    expect(ao.state).toBe('shown');
    ao.dispose();
  });

  it('hides the occlusion when the camera moves and for any other camera', () => {
    const { renderer, passes, camera, uniforms, draw, frame } = rig();
    frame(0);
    frame(1000);
    frame(2000);
    frame(10_000);
    draw();
    expect(uniforms.bodyAoStrength!.value).toBeGreaterThan(0);
    // A thumbnail or export camera on the same renderer draws plain.
    const other = new THREE.PerspectiveCamera();
    const material = bodyMaterial();
    const second = compiledUniforms(material).uniforms;
    material.onBeforeRender(
      renderer,
      new THREE.Scene(),
      other,
      new THREE.BufferGeometry(),
      new THREE.Mesh(),
      null as unknown as THREE.Group
    );
    expect(second.bodyAoStrength!.value).toBe(0);

    passes.length = 0;
    camera.position.x += 1;
    expect(frame(10_016)).toMatchObject({ state: 'waiting' });
    draw();
    expect(uniforms.bodyAoStrength!.value).toBe(0);
    expect(passes).toEqual([]);
  });

  it('switches off when the viewer disables it (X-ray, wireframe)', () => {
    const { frame, draw, uniforms } = rig();
    frame(0);
    frame(1000);
    frame(2000);
    expect(frame(10_000).state).toBe('shown');
    expect(frame(10_016, false)).toMatchObject({
      state: 'off',
      animating: false
    });
    draw();
    expect(uniforms.bodyAoStrength!.value).toBe(0);
  });
});
