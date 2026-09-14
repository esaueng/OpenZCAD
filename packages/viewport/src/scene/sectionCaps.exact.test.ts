import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { sectionCapGeometry } from './sectionCaps';
import {
  exactSolidSection,
  type ExactSectionKernel,
  type ExactSectionPlane
} from '../../../kernel-adapter/src/exact-section';
import { RemusKernel } from '../../../kernel-adapter/src/remus-runtime';

/**
 * The two section pipelines, held against each other.
 *
 * The display cap triangulates the clipped tessellation; the exact section
 * asks the kernel for real cross-section faces. They answer different
 * questions — one is a picture that has to keep up with a drag, the other is
 * a drawing someone exports — and they must still agree on how much material
 * the plane cuts, to within what the tessellation can resolve. If they stop
 * agreeing, one of them is lying about the part.
 *
 * The test lives in the viewport package (and reaches across to the kernel
 * adapter's source, which the package itself does not depend on) because
 * `three` resolves only from inside here, and comparing the two is the whole
 * point of the test.
 */

const DEFLECTION = 0.02;

function kernelFixture() {
  return new RemusKernel() as unknown as ExactSectionKernel & {
    makeBox(dx: number, dy: number, dz: number): number;
    makeCylinder(radius: number, height: number): number;
    cut(a: number, b: number): number;
    transformSolid(solid: number, matrix: Float64Array): void;
  };
}

/** The solid's tessellation as the viewport receives it. */
function displayGeometry(
  kernel: ExactSectionKernel,
  solid: number
): THREE.BufferGeometry {
  const mesh = kernel.tessellateSolid(solid, DEFLECTION);
  try {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(Array.from(mesh.positions), 3)
    );
    geometry.setIndex(Array.from(mesh.indices));
    return geometry;
  } finally {
    mesh.free();
  }
}

function capArea(geometry: THREE.BufferGeometry | null): number {
  expect(geometry).not.toBeNull();
  const positions = geometry!.getAttribute('position');
  let total = 0;
  for (let i = 0; i < positions.count; i += 3) {
    total += new THREE.Triangle(
      ...([0, 1, 2].map((j) =>
        new THREE.Vector3().fromBufferAttribute(positions, i + j)
      ) as [THREE.Vector3, THREE.Vector3, THREE.Vector3])
    ).getArea();
  }
  return total;
}

/** The clipping plane the viewport draws, as the exact pipeline sees it. */
function planeOf(plane: THREE.Plane): ExactSectionPlane {
  const origin = plane.coplanarPoint(new THREE.Vector3());
  return {
    origin: [origin.x, origin.y, origin.z],
    normal: [plane.normal.x, plane.normal.y, plane.normal.z]
  };
}

describe('exact section versus the display cap', () => {
  it('agrees on the cut area of a bored bar, within tessellation tolerance', () => {
    const kernel = kernelFixture();
    const bar = kernel.makeBox(20, 10, 6);
    const bore = kernel.makeCylinder(2, 20);
    kernel.transformSolid(
      bore,
      Float64Array.of(1, 0, 0, 10, 0, 1, 0, 5, 0, 0, 1, -5, 0, 0, 0, 1)
    );
    const solid = kernel.cut(bar, bore);
    const clip = new THREE.Plane(new THREE.Vector3(0, 0, -1), 3);
    const cap = capArea(
      sectionCapGeometry(displayGeometry(kernel, solid), clip)
    );

    const section = exactSolidSection(kernel, solid, planeOf(clip), {
      deflection: DEFLECTION
    });
    expect(section.status).toBe('ok');
    if (section.status !== 'ok') return;
    expect(Math.abs(section.area - cap)).toBeLessThanOrEqual(
      section.areaTolerance
    );
    // Both see the bore, rather than agreeing on an undrilled rectangle:
    // the missing material is the bore's cross-section, near pi r^2 = 12.57.
    expect(200 - cap).toBeGreaterThan(12);
    expect(200 - cap).toBeLessThan(13);
  });

  it('agrees on an oblique cut through a plain block', () => {
    const kernel = kernelFixture();
    const block = kernel.makeBox(20, 10, 6);
    const normal = new THREE.Vector3(-1, -1, -1).normalize();
    const clip = new THREE.Plane(
      normal,
      -normal.dot(new THREE.Vector3(10, 5, 3))
    );
    const cap = capArea(
      sectionCapGeometry(displayGeometry(kernel, block), clip)
    );
    const section = exactSolidSection(kernel, block, planeOf(clip), {
      deflection: DEFLECTION
    });
    expect(section.status).toBe('ok');
    if (section.status !== 'ok') return;
    expect(Math.abs(section.area - cap)).toBeLessThanOrEqual(
      section.areaTolerance
    );
  });
});
