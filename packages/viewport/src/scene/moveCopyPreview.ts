import type * as THREE from 'three';
import { disposeObject } from './objects';

/** Owns a temporary body projection, independent of the source's overlays. */
export class MoveCopyPreview {
  private source: THREE.Object3D | null = null;
  private copy: THREE.Object3D | null = null;

  get active(): boolean {
    return !!this.copy?.parent;
  }

  target(
    source: THREE.Object3D,
    copy: boolean,
    createCopy: () => THREE.Object3D
  ): THREE.Object3D {
    if (!copy) {
      this.clear();
      return source;
    }
    if (this.source !== source) {
      this.clear();
      this.source = source;
      this.copy = createCopy();
      // A pending copy is visual only; selection still names committed bodies.
      this.copy.traverse((child) => {
        child.raycast = () => undefined;
      });
      source.parent?.add(this.copy);
    }
    source.position.set(0, 0, 0);
    source.rotation.set(0, 0, 0);
    source.scale.set(1, 1, 1);
    // Sections must continue refusing geometry while an extra body is shown.
    source.userData.moveCopyPreview = true;
    return this.copy!;
  }

  clear(): void {
    this.copy?.removeFromParent();
    if (this.copy) disposeObject(this.copy);
    if (this.source) delete this.source.userData.moveCopyPreview;
    this.copy = null;
    this.source = null;
  }
}
