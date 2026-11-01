import * as THREE from 'three';
import { mark, measure, timed } from '../../lib/perf';

/** Prepares the bounded set of highlight variants once per renderer lifetime. */
export class InteractionShaderWarmup {
  private started = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly materials: THREE.Material[] = [];
  private releaseGeometry: (() => void) | undefined;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene
  ) {}

  get isScheduled() {
    return this.started;
  }

  schedule(
    camera: THREE.Camera,
    faces: readonly THREE.Mesh[],
    edges: readonly THREE.Mesh[]
  ) {
    if (this.started || this.disposed) return;
    this.started = true;
    // Let the first model frame present before preparing interaction shaders.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.prepare(camera, faces, edges).catch((error: unknown) => {
        if (!this.disposed) {
          console.warn('Could not prepare viewport highlight shaders', error);
        }
      });
    }, 0);
  }

  private async prepare(
    camera: THREE.Camera,
    faces: readonly THREE.Mesh[],
    edges: readonly THREE.Mesh[]
  ) {
    const warmup = new THREE.Scene();
    warmup.environment = this.scene.environment;
    warmup.environmentIntensity = this.scene.environmentIntensity;
    warmup.environmentRotation.copy(this.scene.environmentRotation);
    warmup.fog = this.scene.fog;
    this.scene.traverseVisible((object) => {
      if (object instanceof THREE.Light) warmup.add(object.clone());
    });

    // Empty slot geometry compiles flat-shaded Lambert and position-less Basic
    // variants. Real face slices always have both position and normal buffers.
    const faceGeometry = new THREE.BufferGeometry();
    faceGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([], 3)
    );
    faceGeometry.setAttribute(
      'normal',
      new THREE.Float32BufferAttribute([], 3)
    );
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([], 3)
    );
    // LineSegmentsGeometry has no normals; that flag is in Three's program key
    // even for a ShaderMaterial that does not use the normal itself.
    // Start beyond the empty buffers so renderBufferDirect returns after
    // preparing uniforms, before issuing even a zero-count GL draw. Drivers
    // still validate samplers on zero-count draws against cloned lights.
    faceGeometry.setDrawRange(1, 0);
    lineGeometry.setDrawRange(1, 0);
    const retain = (source: THREE.Material) => {
      const material = source.clone();
      material.onBeforeCompile = source.onBeforeCompile;
      material.customProgramCacheKey = source.customProgramCacheKey;
      this.materials.push(material);
      return material;
    };
    for (const mesh of faces) {
      // Three's compileAsync tracks only currentProgram per material. Split
      // the transparent double-sided passes so readiness covers both sides.
      for (const side of [THREE.BackSide, THREE.FrontSide] as const) {
        const material = retain(mesh.material as THREE.Material);
        material.side = side;
        warmup.add(new THREE.Mesh(faceGeometry, material));
      }
    }
    for (const mesh of edges) {
      // Keep programs cached when body rebuilds dispose their edge materials.
      const material = retain(mesh.material as THREE.Material);
      warmup.add(new THREE.Mesh(lineGeometry, material));
    }
    warmup.traverse((object) => {
      object.frustumCulled = false;
    });
    this.releaseGeometry = () => {
      faceGeometry.dispose();
      lineGeometry.dispose();
      warmup.clear();
      this.releaseGeometry = undefined;
    };

    mark('viewer.interactionShaders:begin');
    try {
      await this.renderer.compileAsync(warmup, camera);
      if (this.disposed) return;

      // compileAsync waits for linking, but Three defers shader diagnostics and
      // uniform reflection to first use. A zero-count pass initializes those
      // too, using the real framebuffer's color space and antialiasing. No
      // primitives, clears or shadow draws may touch the visible framebuffer.
      const meshes = warmup.children.filter(
        (object) => object instanceof THREE.Mesh
      );
      for (const mesh of meshes) mesh.visible = false;
      for (let index = 0; index < meshes.length; index++) {
        // Driver diagnostics/reflection can still block after parallel link
        // completion. Yield between variants instead of one large startup task.
        if (index > 0)
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (this.disposed) return;
        const mesh = meshes[index]!;
        mesh.visible = true;
        const { renderer } = this;
        const autoClear = renderer.autoClear;
        const shadowAutoUpdate = renderer.shadowMap.autoUpdate;
        const shadowNeedsUpdate = renderer.shadowMap.needsUpdate;
        renderer.autoClear = false;
        renderer.shadowMap.autoUpdate = false;
        renderer.shadowMap.needsUpdate = false;
        try {
          timed('viewer.interactionShaderReflection', () =>
            renderer.render(warmup, camera)
          );
        } finally {
          mesh.visible = false;
          renderer.autoClear = autoClear;
          renderer.shadowMap.autoUpdate = shadowAutoUpdate;
          renderer.shadowMap.needsUpdate = shadowNeedsUpdate;
        }
      }
      mark('viewer.interactionShaders:ready');
      measure(
        'viewer.interactionShaders',
        'viewer.interactionShaders:begin',
        'viewer.interactionShaders:ready'
      );
    } finally {
      this.releaseGeometry?.();
    }
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.releaseGeometry?.();
    for (const material of this.materials) material.dispose();
    this.materials.length = 0;
  }
}
