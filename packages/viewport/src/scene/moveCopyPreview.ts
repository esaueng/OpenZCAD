import type * as THREE from 'three';
import { disposeObject } from './objects';
import { forEachMesh } from '../pick/meshes';
import { BodyEdgeOverlay } from '../render/edgeOverlay';
import { updateBodyMaterialOpacity } from '../render/scene';
import type { DisplayMode } from '../types';

/** Owns a temporary body projection, independent of the source's overlays. */
export class MoveCopyPreview {
  private source: THREE.Object3D | null = null;
  private copy: THREE.Object3D | null = null;
  /** M10: the further stamps of a repeated copy, after the first. */
  private stampObjects: THREE.Object3D[] = [];

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

  /**
   * M10: show `count` further stamps of the copy, each the copy's pose
   * applied once more, as the build stamps them. Call after posing the copy.
   */
  poseStamps(count: number, createCopy: () => THREE.Object3D): void {
    const copy = this.copy;
    if (!copy || !this.source) count = 0;
    while (this.stampObjects.length > count) {
      const stamp = this.stampObjects.pop()!;
      stamp.removeFromParent();
      disposeObject(stamp);
    }
    if (!copy) return;
    while (this.stampObjects.length < count) {
      const stamp = createCopy();
      stamp.traverse((child) => {
        child.raycast = () => undefined;
      });
      stamp.matrixAutoUpdate = false;
      copy.parent?.add(stamp);
      this.stampObjects.push(stamp);
    }
    copy.updateMatrix();
    const step = copy.matrix;
    const pose = step.clone();
    for (const stamp of this.stampObjects) {
      pose.premultiply(step);
      stamp.matrix.copy(pose);
      stamp.matrixWorldNeedsUpdate = true;
    }
  }

  /** How many further stamps are on screen (for tests and e2e hooks). */
  get stampCount(): number {
    return this.stampObjects.length;
  }

  /** Match the installed source without replacing the cached copy or its pose. */
  refreshAppearance(mode: DisplayMode, xray: boolean): void {
    if (!this.source || !this.copy) return;
    let opacity = 1;
    forEachMesh(this.source, (mesh) => {
      opacity = mesh.material.opacity;
    });
    for (const shown of [this.copy, ...this.stampObjects]) {
      forEachMesh(shown, (mesh) => {
        updateBodyMaterialOpacity(mesh.material, opacity);
        mesh.material.visible = mode !== 'wireframe' || xray;
      });
      shown.traverse((child) => {
        if (child instanceof BodyEdgeOverlay) {
          child.setDisplayMode(mode);
          child.setXrayView(xray);
        }
      });
    }
  }

  clear(): void {
    for (const stamp of this.stampObjects) {
      stamp.removeFromParent();
      disposeObject(stamp);
    }
    this.stampObjects = [];
    this.copy?.removeFromParent();
    if (this.copy) disposeObject(this.copy);
    if (this.source) delete this.source.userData.moveCopyPreview;
    this.copy = null;
    this.source = null;
  }
}
