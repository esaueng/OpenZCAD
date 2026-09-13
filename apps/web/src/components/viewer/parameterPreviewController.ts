import * as THREE from 'three';
import type { ParameterVisualPreview } from '../../lib/parameterVisualPreview';

/** Retains mesh buffers through a gesture; subsequent values update matrices only. */
export class ParameterPreviewController {
  readonly group = new THREE.Group();
  private geometries = new Map<
    Float32Array,
    { indices: Uint32Array; geometry: THREE.BufferGeometry; references: number }
  >();
  private objects = new Map<
    string,
    {
      mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
      vertices: Float32Array;
      indices: Uint32Array;
      shared: {
        indices: Uint32Array;
        geometry: THREE.BufferGeometry;
        references: number;
      };
    }
  >();

  update(preview: ParameterVisualPreview | null): void {
    const keep = new Set<string>();
    for (const body of preview ?? [])
      for (const part of body.parts) {
        const key = `${body.bodyId}:${part.key}`;
        keep.add(key);
        let entry = this.objects.get(key);
        if (
          entry &&
          (entry.vertices !== part.mesh.vertices ||
            entry.indices !== part.mesh.indices)
        ) {
          this.remove(key);
          entry = undefined;
        }
        if (!entry) {
          let shared = this.geometries.get(part.mesh.vertices);
          if (!shared || shared.indices !== part.mesh.indices) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute(
              'position',
              new THREE.BufferAttribute(part.mesh.vertices, 3)
            );
            geometry.setIndex(new THREE.BufferAttribute(part.mesh.indices, 1));
            geometry.computeVertexNormals();
            shared = { indices: part.mesh.indices, geometry, references: 0 };
            this.geometries.set(part.mesh.vertices, shared);
          }
          shared.references++;
          const geometry = shared.geometry;
          const material = new THREE.MeshStandardMaterial({
            color: body.color,
            roughness: 0.55,
            metalness: 0.05
          });
          const mesh = new THREE.Mesh(geometry, material);
          mesh.matrixAutoUpdate = false;
          // Approximate display never contributes selection or topology.
          mesh.raycast = () => undefined;
          this.group.add(mesh);
          entry = {
            mesh,
            vertices: part.mesh.vertices,
            indices: part.mesh.indices,
            shared
          };
          this.objects.set(key, entry);
        }
        entry.mesh.material.color.set(body.color);
        entry.mesh.material.opacity = body.opacity ?? 1;
        entry.mesh.material.transparent = entry.mesh.material.opacity < 1;
        entry.mesh.matrix.fromArray(part.matrix);
        entry.mesh.matrixWorldNeedsUpdate = true;
      }
    for (const key of this.objects.keys()) if (!keep.has(key)) this.remove(key);
  }

  private remove(key: string) {
    const entry = this.objects.get(key)!;
    this.group.remove(entry.mesh);
    const shared = entry.shared;
    if (--shared.references === 0) {
      shared.geometry.dispose();
      if (this.geometries.get(entry.vertices) === shared)
        this.geometries.delete(entry.vertices);
    }
    entry.mesh.material.dispose();
    this.objects.delete(key);
  }

  dispose(): void {
    this.update(null);
    this.group.removeFromParent();
  }
}
