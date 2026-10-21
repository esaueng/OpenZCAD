import * as THREE from 'three';
import { VIEWPORT_RENDER_ORDER } from '@openzcad/viewport';
import type { ReferenceImageDisplay } from '../../lib/referenceImageDisplay';

/**
 * Scene-side rig for I05 reference images: one textured quad per image, at
 * its true size on its plane, plus an outline that marks the selected one.
 *
 * Presentation only. The group is added to the scene directly, never under
 * the body, region or sketch groups, so the PNG viewport export (an
 * allowlist of those groups) leaves it out, and nothing in the click path
 * raycasts it: a picture under the model never steals a face pick. Depth is
 * tested but never written, so bodies in front hide the picture and bodies
 * behind still show through its transparent parts.
 */

export interface ReferenceImageRig {
  group: THREE.Group;
  dispose(): void;
}

const PLACEHOLDER_COLOR = 0x9aa5b8;
const OUTLINE_COLOR = 0x8b9cff;

export function buildReferenceImageRig(
  images: readonly ReferenceImageDisplay[],
  textures: ReadonlyMap<string, THREE.Texture>
): ReferenceImageRig {
  const group = new THREE.Group();
  group.name = 'reference-images';
  const geometry = new THREE.PlaneGeometry(1, 1);
  // Bitmaps decode top row first, which WebGL uploads as v = 0; flipping
  // the quad's v keeps the picture upright without asking the decoder to
  // flip it (`imageOrientation` is not supported everywhere the app runs).
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
  for (let index = 0; index < uv.count; index += 1) {
    uv.setY(index, 1 - uv.getY(index));
  }
  const outlineGeometry = new THREE.EdgesGeometry(geometry);
  const disposables: { dispose(): void }[] = [geometry, outlineGeometry];
  for (const image of images) {
    const { center, xAxis, yAxis, normal } = image.frame;
    const basis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(xAxis.x, xAxis.y, xAxis.z),
      new THREE.Vector3(yAxis.x, yAxis.y, yAxis.z),
      new THREE.Vector3(normal.x, normal.y, normal.z)
    );
    const texture = textures.get(image.checksumSha256);
    const material = new THREE.MeshBasicMaterial({
      ...(texture
        ? { map: texture, opacity: image.opacity }
        : // Still loading, or unavailable here: a faint frame of the right
          // size, so the image's place is visible and selectable.
          { color: PLACEHOLDER_COLOR, opacity: 0.12 * image.opacity }),
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      // A picture laid on a face would otherwise fight it for depth.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4
    });
    disposables.push(material);
    const quad = new THREE.Mesh(geometry, material);
    quad.renderOrder = VIEWPORT_RENDER_ORDER.SKETCH_FILL;
    const objects: THREE.Object3D[] = [quad];
    if (image.selected || !texture) {
      const outlineMaterial = new THREE.LineBasicMaterial({
        color: image.selected ? OUTLINE_COLOR : PLACEHOLDER_COLOR,
        transparent: true,
        opacity: image.selected ? 0.95 : 0.6,
        depthWrite: false
      });
      disposables.push(outlineMaterial);
      const outline = new THREE.LineSegments(outlineGeometry, outlineMaterial);
      outline.renderOrder = VIEWPORT_RENDER_ORDER.SKETCH_CURVE;
      objects.push(outline);
    }
    for (const object of objects) {
      object.name = `reference-image-${image.imageId}`;
      object.userData.referenceImageId = image.imageId;
      object.raycast = () => undefined;
      object.quaternion.setFromRotationMatrix(basis);
      object.position.set(center.x, center.y, center.z);
      object.scale.set(image.width, image.height, 1);
      group.add(object);
    }
  }
  return {
    group,
    dispose() {
      for (const item of disposables) item.dispose();
      group.clear();
    }
  };
}

/**
 * Turns a picture's bytes into a texture. The bytes go straight to the
 * decoder as a Blob — never through a data URL, which the CSP's
 * `connect-src` would refuse to fetch — and a decoded bitmap is closed with
 * its texture.
 */
export async function referenceImageTexture(
  bytes: Blob
): Promise<THREE.Texture> {
  const bitmap = await createImageBitmap(bytes);
  const texture = new THREE.Texture(bitmap);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  texture.addEventListener('dispose', () => bitmap.close());
  return texture;
}

/** A picture the viewport wants: its bytes' identity and where they live. */
export interface ReferenceTextureRequest {
  checksumSha256: string;
  /**
   * Where the bytes can come from. A load that found nothing is retried when
   * this changes — a collaborator's device-only picture becomes resolvable
   * the moment its owner archives it and the id is rewritten.
   */
  artifactId: string;
}

/**
 * One texture per picture, decoded once and kept while any shown image uses
 * it. `sync` starts at most one load per picture — however many images place
 * it, and however many archives hold it, since the loader already tries every
 * record — and remembers the locations a failed load was tried at, so the
 * same set is not loaded again but a rewritten artifact id (a device-only
 * picture archived by its owner) retries. `clear` drops every texture and
 * orphans the loads in flight, which then dispose what they decode; the cache
 * stays usable, as a remounted viewer needs it to be.
 */
export class ReferenceTextureCache {
  readonly textures = new Map<string, THREE.Texture>();
  private loading = new Set<string>();
  /** Per picture: the locations its last unsuccessful load was tried at. */
  private failedAt = new Map<string, string>();
  private wanted = new Set<string>();
  /** Per picture: the locations the latest `sync` named. */
  private latest = new Map<string, string>();
  private lastSync: Parameters<ReferenceTextureCache['sync']> | null = null;
  private generation = 0;

  constructor(
    private readonly decode: (
      bytes: Blob
    ) => Promise<THREE.Texture> = referenceImageTexture
  ) {}

  sync(
    requests: readonly ReferenceTextureRequest[],
    load: (checksumSha256: string) => Promise<Blob | null>,
    onReady: () => void
  ): void {
    const locations = new Map<string, Set<string>>();
    for (const { checksumSha256, artifactId } of requests) {
      const known = locations.get(checksumSha256) ?? new Set<string>();
      known.add(artifactId);
      locations.set(checksumSha256, known);
    }
    this.wanted = new Set(locations.keys());
    this.lastSync = [requests, load, onReady];
    this.latest = new Map(
      [...locations].map(([checksum, ids]) => [
        checksum,
        [...ids].sort().join('|')
      ])
    );
    for (const [checksum, texture] of this.textures) {
      if (this.wanted.has(checksum)) continue;
      texture.dispose();
      this.textures.delete(checksum);
    }
    for (const checksum of this.failedAt.keys()) {
      if (!this.wanted.has(checksum)) this.failedAt.delete(checksum);
    }
    const generation = this.generation;
    for (const checksumSha256 of locations.keys()) {
      const where = this.latest.get(checksumSha256)!;
      if (
        this.textures.has(checksumSha256) ||
        this.loading.has(checksumSha256) ||
        this.failedAt.get(checksumSha256) === where
      )
        continue;
      this.loading.add(checksumSha256);
      const loading = this.loading;
      let retry = false;
      const failed = () => {
        if (generation !== this.generation) return;
        this.failedAt.set(checksumSha256, where);
        // A sync during this load named new locations and was skipped while
        // it ran: try them once this load is out of the way.
        const latest = this.latest.get(checksumSha256);
        retry = latest !== undefined && latest !== where;
      };
      void load(checksumSha256)
        .then((bytes) => (bytes ? this.decode(bytes) : null))
        .then((texture) => {
          if (!texture) return failed();
          if (
            generation !== this.generation ||
            !this.wanted.has(checksumSha256) ||
            this.textures.has(checksumSha256)
          ) {
            texture.dispose();
            return;
          }
          this.failedAt.delete(checksumSha256);
          this.textures.set(checksumSha256, texture);
          onReady();
        }, failed)
        .finally(() => {
          loading.delete(checksumSha256);
          if (retry && generation === this.generation && this.lastSync)
            this.sync(...this.lastSync);
        });
    }
  }

  clear(): void {
    this.generation += 1;
    for (const texture of this.textures.values()) texture.dispose();
    this.textures.clear();
    this.loading = new Set();
    this.failedAt = new Map();
    this.wanted = new Set();
    this.latest = new Map();
    this.lastSync = null;
  }
}
