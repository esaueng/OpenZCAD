import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { ViewportCameraState } from '@openzcad/viewport';
import { startRequestedView } from './ModelViewer';

/**
 * I03: a stored-unit conversion lands the camera on the rescaled pose at
 * once. A glide reported its frames as live poses, and a reload or an undo
 * made before it landed saved or rescaled a frame that was neither unit.
 */
describe('startRequestedView', () => {
  const pose: ViewportCameraState = {
    position: [10, -10, 5],
    target: [1, 0, 0],
    orthographicZoom: 1
  };

  function context() {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(254, -254, 127);
    return {
      camera,
      controls: { target: new THREE.Vector3(25.4, 0, 0) },
      hasFitCamera: false,
      startCameraTween: vi.fn(),
      restoreView: vi.fn(),
      cancelCameraTween: vi.fn(),
      requestRender: vi.fn()
    };
  }

  it('lands an instant pose at once and cancels any glide', () => {
    const scene = context();
    const handled = { current: null };
    startRequestedView(
      scene as never,
      {
        view: { pose, projection: 'perspective', instant: true },
        nonce: 1
      } as never,
      handled
    );
    expect(scene.cancelCameraTween).toHaveBeenCalledTimes(1);
    expect(scene.restoreView).toHaveBeenCalledWith(pose, 'perspective');
    expect(scene.startCameraTween).not.toHaveBeenCalled();
    expect(scene.requestRender).toHaveBeenCalled();
    expect(scene.hasFitCamera).toBe(true);
  });

  it('still glides to a saved view', () => {
    const scene = context();
    startRequestedView(
      scene as never,
      { view: { pose, projection: 'orthographic' }, nonce: 1 } as never,
      { current: null }
    );
    expect(scene.startCameraTween).toHaveBeenCalledTimes(1);
    expect(scene.restoreView).not.toHaveBeenCalled();
    expect(scene.cancelCameraTween).not.toHaveBeenCalled();
  });
});
