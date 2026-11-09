import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  createFatLineSegments,
  TRANSLUCENT_LINE_STENCIL,
  VIEWPORT_RENDER_ORDER
} from '../render/scene';
import { createBodyGhost, GHOST_SURFACE_STENCIL } from './bodyGhost';

function body() {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  const edges = createFatLineSegments([0, 0, 0, 1, 0, 0], {
    color: 0,
    linewidth: 1
  });
  edges.name = 'body-edge';
  mesh.add(edges);
  return mesh;
}

function materials(object: THREE.Object3D) {
  const found: THREE.Material[] = [];
  object.traverse((child) => {
    const material = (child as THREE.Mesh).material;
    if (material)
      found.push(...(Array.isArray(material) ? material : [material]));
  });
  return found;
}

describe('the offset body ghost', () => {
  it('copies the body with its edges and the dragged face, all behind the solid', () => {
    const source = body();
    const ghost = createBodyGhost(source, {
      faceRange: { triangleStart: 0, triangleCount: 2 }
    });
    const names = ghost.object.children.map((child) => child.name);
    expect(names).toEqual([
      'offset-body-ghost-depth',
      'offset-body-ghost-shell',
      'offset-body-ghost-face',
      'offset-body-ghost-face-outline',
      'offset-body-ghost-edges'
    ]);
    // A copy, not a share: deforming the body later must not move the ghost.
    const shell = ghost.object.getObjectByName(
      'offset-body-ghost-shell'
    ) as THREE.Mesh;
    expect(shell.geometry.getAttribute('position')).not.toBe(
      source.geometry.getAttribute('position')
    );
    // Every part but the old face's rim is pushed behind coincident solid
    // surfaces, edges included, and only the invisible depth pass writes
    // depth.
    for (const child of ghost.object.children) {
      const material = (child as THREE.Mesh).material as THREE.Material;
      expect(material.depthWrite).toBe(
        child.name === 'offset-body-ghost-depth'
      );
      if (child.name === 'offset-body-ghost-face-outline') continue;
      expect(material.polygonOffset).toBe(true);
      expect(material.polygonOffsetUnits).toBeGreaterThan(0);
    }
    ghost.dispose();
  });

  it('rims the old face with an outline that still shows on a pulled solid', () => {
    const ghost = createBodyGhost(body(), {
      faceRange: { triangleStart: 0, triangleCount: 2 }
    });
    const outline = ghost.object.getObjectByName(
      'offset-body-ghost-face-outline'
    ) as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    // The box face's two triangles: four rim sides, not their diagonal.
    const start = outline.geometry.getAttribute(
      'instanceStart'
    ) as THREE.InterleavedBufferAttribute;
    expect(start.count).toBe(4);
    const xs = new Set<number>();
    for (let i = 0; i < start.count; i++) xs.add(start.getX(i));
    expect([...xs]).toEqual([1]); // all on the +x face
    // Drawn like the body's own edges: pulled forward through the face's
    // chord error, depth-tested, outside the ghost's stencil mask, so it
    // lies visibly on the live surface and only hides behind the part.
    expect(outline.material.uniforms.depthBias!.value).toBeGreaterThan(0);
    expect(outline.material.depthTest).toBe(true);
    // Blended once per pixel, not masked to the ghost's own surface.
    expect(outline.material.alphaToCoverage).toBe(false);
    expect(outline.material.stencilFuncMask).toBe(TRANSLUCENT_LINE_STENCIL);
    expect(outline.material.polygonOffset).toBe(false);
    const edges = ghost.object.getObjectByName('offset-body-ghost-edges')!;
    expect(outline.renderOrder).toBeGreaterThan(edges.renderOrder);
    expect(outline.material.opacity).toBeGreaterThan(0.5);
    expect(outline.material.opacity).toBeLessThan(1);
    ghost.dispose();
    // No dragged face, no rim.
    const plain = createBodyGhost(body());
    expect(
      plain.object.getObjectByName('offset-body-ghost-face-outline')
    ).toBeUndefined();
    plain.dispose();
  });

  it('hides its own far side: depth first, then one fill, then edges in front of it', () => {
    const source = body();
    const tangent = createFatLineSegments([0, 1, 0, 1, 1, 0], {
      color: 0,
      linewidth: 1
    });
    tangent.name = 'body-edge-tangent';
    source.add(tangent);
    const ghost = createBodyGhost(source);
    const part = (name: string) =>
      ghost.object.getObjectByName(name) as THREE.Mesh<
        THREE.BufferGeometry,
        THREE.Material
      >;
    const depth = part('offset-body-ghost-depth');
    const shell = part('offset-body-ghost-shell');
    const edges = part('offset-body-ghost-edges');
    // Draws nothing itself; sorts after the live body's edges.
    expect(depth.material.colorWrite).toBe(false);
    expect(depth.material.transparent).toBe(true);
    expect(depth.renderOrder).toBeGreaterThan(8);
    expect(shell.renderOrder).toBeGreaterThan(depth.renderOrder);
    expect(edges.renderOrder).toBeGreaterThan(shell.renderOrder);
    // The fill passes exactly where its own depth pass wrote.
    expect(shell.material.depthFunc).toBe(THREE.LessEqualDepth);
    expect(shell.material.polygonOffsetUnits).toBe(
      depth.material.polygonOffsetUnits
    );
    expect(shell.material.polygonOffsetFactor).toBe(
      depth.material.polygonOffsetFactor
    );
    // Edges sit in front of the ghost's depth, still behind the live solid.
    expect(edges.material.polygonOffsetUnits).toBeLessThan(
      depth.material.polygonOffsetUnits
    );
    expect(edges.material.polygonOffsetUnits).toBeGreaterThan(0);
    // Edges draw only where the ghost's own surface marked the stencil, so a
    // flat line quad cannot poke through a grazing face the solid keeps.
    expect(depth.material.stencilWrite).toBe(true);
    expect(depth.material.stencilZPass).toBe(THREE.ReplaceStencilOp);
    expect(depth.material.stencilWriteMask).toBe(GHOST_SURFACE_STENCIL);
    expect(depth.material.stencilRef).toBe(GHOST_SURFACE_STENCIL);
    expect(edges.material.stencilWrite).toBe(true);
    expect(edges.material.stencilFunc).toBe(THREE.EqualStencilFunc);
    // ...and draw each pixel once: inside the mask, before the
    // translucent-line bit is set, which the first fragment flips.
    expect(edges.material.stencilFuncMask).toBe(
      GHOST_SURFACE_STENCIL | TRANSLUCENT_LINE_STENCIL
    );
    expect(edges.material.stencilZPass).toBe(THREE.InvertStencilOp);
    expect(edges.material.alphaToCoverage).toBe(false);
    expect(edges.material.stencilRef).toBe(GHOST_SURFACE_STENCIL);
    expect(edges.material.stencilWriteMask).toBe(TRANSLUCENT_LINE_STENCIL);
    // Not the opaque bodies' bit 1 or the translucent lines' bit 2.
    expect(GHOST_SURFACE_STENCIL & 0b11).toBe(0);
    // Smooth seams are not copied: only the sharp edge's one segment.
    expect(
      (edges.geometry.getAttribute('instanceStart') as THREE.BufferAttribute)
        .count
    ).toBe(1);
    ghost.dispose();
  });

  it('is cut by the active section like the body it copies', () => {
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const ghost = createBodyGhost(body(), {
      faceRange: { triangleStart: 0, triangleCount: 2 },
      clippingPlane: plane
    });
    for (const material of materials(ghost.object))
      expect(material.clippingPlanes).toEqual([plane]);
    // A section that moves or closes under a kept ghost takes it along.
    const moved = new THREE.Plane(new THREE.Vector3(0, 0, 1), 1);
    ghost.setClippingPlane(moved);
    for (const material of materials(ghost.object))
      expect(material.clippingPlanes).toEqual([moved]);
    ghost.setClippingPlane(null);
    for (const material of materials(ghost.object))
      expect(material.clippingPlanes).toBeNull();
    const uncut = createBodyGhost(body());
    for (const material of materials(uncut.object))
      expect(material.clippingPlanes ?? null).toBeNull();
    ghost.dispose();
    uncut.dispose();
  });

  it('keeps the original face neutral and reads as a frosted shape behind the live solid', () => {
    const ghost = createBodyGhost(body(), {
      faceRange: { triangleStart: 0, triangleCount: 2 }
    });
    const shell = ghost.object.getObjectByName(
      'offset-body-ghost-shell'
    ) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    const face = ghost.object.getObjectByName(
      'offset-body-ghost-face'
    ) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    expect(face.material.color.getHex()).toBe(shell.material.color.getHex());
    // Solid enough to read on the dark stage, never as solid as the part.
    expect(shell.material.opacity).toBeGreaterThanOrEqual(0.25);
    expect(shell.material.opacity).toBeLessThanOrEqual(0.4);
    for (const material of materials(ghost.object)) {
      expect(material.depthTest).toBe(true);
      if (!material.colorWrite) continue; // the invisible depth pass
      expect(material.opacity).toBeGreaterThan(0);
      expect(material.opacity).toBeLessThan(1);
      expect(material.depthTest).toBe(true);
    }
    ghost.dispose();
  });

  describe('while the face is held', () => {
    // BoxGeometry's first two triangles are its +x face: x = 1 in body().
    const pulled = () => {
      const live = new THREE.Mesh(
        new THREE.BoxGeometry(4, 2, 2).translate(1, 0, 0),
        new THREE.MeshStandardMaterial()
      );
      const highlight = new THREE.Mesh(
        new THREE.BufferGeometry(),
        new THREE.MeshBasicMaterial()
      );
      live.add(highlight);
      const edges = createFatLineSegments([0, 0, 0, 1, 0, 0], {
        color: 0,
        linewidth: 1
      });
      edges.name = 'body-edge';
      live.add(edges);
      return { live, highlight, edges };
    };
    const veilParts = (ghost: { object: THREE.Object3D }) =>
      ghost.object.children
        .filter((child) => child.name.startsWith('offset-body-ghost-veil'))
        .map((child) => child.name);
    const at = (x: number) => new THREE.Vector3(x, 0, 0);

    it('draws the material beyond the old face as ghost, and the rest solid up to it', () => {
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 5);
      const ghost = createBodyGhost(body(), {
        faceRange: { triangleStart: 0, triangleCount: 2 },
        clippingPlane: plane
      });
      const { live, highlight, edges } = pulled();
      // As the section pass leaves it.
      live.material.clippingPlanes = [plane];
      ghost.veilAddedMaterial(live);
      expect(veilParts(ghost)).toEqual([
        'offset-body-ghost-veil-depth',
        'offset-body-ghost-veil-fill',
        'offset-body-ghost-veil-cap'
      ]);
      // The solid keeps what lies up to the old face; its own cut stays.
      const planes = live.material.clippingPlanes;
      expect(planes[0]).toBe(plane);
      const keep = planes[1]!;
      expect(keep.distanceToPoint(at(0.99))).toBeGreaterThan(0);
      expect(keep.distanceToPoint(at(1.01))).toBeLessThan(0);
      // The selection drawn on it is cut with it; its edges are not, so the
      // proposed shape keeps its outline.
      expect(highlight.material.clippingPlanes).toContain(keep);
      expect(edges.material.clippingPlanes ?? []).not.toContain(keep);
      const part = (name: string) =>
        ghost.object.getObjectByName(name) as THREE.Mesh<
          THREE.BufferGeometry,
          THREE.Material
        >;
      const fill = part('offset-body-ghost-veil-fill');
      const depth = part('offset-body-ghost-veil-depth');
      const cap = part('offset-body-ghost-veil-cap');
      // The ghost shares the live shape and keeps only what lies beyond.
      expect(fill.geometry).toBe(live.geometry);
      expect(fill.material.clippingPlanes![0]).toBe(plane);
      const beyond = fill.material.clippingPlanes![1]!;
      expect(beyond.distanceToPoint(at(1.01))).toBeGreaterThan(0);
      expect(beyond.distanceToPoint(at(0.99))).toBeLessThan(0);
      expect(fill.material.transparent).toBe(true);
      expect(fill.material.opacity).toBeGreaterThan(0.3);
      expect(fill.material.opacity).toBeLessThan(1);
      // Its far side hides behind it, edges included: depth goes down first.
      expect(depth.material.colorWrite).toBe(false);
      expect(depth.material.depthWrite).toBe(true);
      expect(depth.renderOrder).toBeLessThan(fill.renderOrder);
      // Both before the body's edges, which keep their ink over the frost.
      expect(fill.renderOrder).toBeLessThan(VIEWPORT_RENDER_ORDER.BODY_EDGE);
      // The old face closes the solid in the body's own finish.
      expect(cap.material).toBe(live.material);

      // A new object (an exact preview) moves the veil with it.
      const next = pulled();
      ghost.veilAddedMaterial(next.live);
      expect(live.material.clippingPlanes).toEqual([plane]);
      expect(highlight.material.clippingPlanes ?? []).not.toContain(keep);
      expect(fill.parent).toBeNull();
      expect(next.live.material.clippingPlanes).toHaveLength(1);

      // Letting go: everything solid again.
      ghost.veilAddedMaterial(null);
      expect(veilParts(ghost)).toEqual([]);
      expect(next.live.material.clippingPlanes).toBeNull();
      expect(next.highlight.material.clippingPlanes).toBeNull();
      ghost.dispose();
    });

    it('re-applies its cut after the section pass rewrites the body', () => {
      const ghost = createBodyGhost(body(), {
        faceRange: { triangleStart: 0, triangleCount: 2 }
      });
      const { live } = pulled();
      ghost.veilAddedMaterial(live);
      const section = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      live.material.clippingPlanes = [section];
      ghost.setClippingPlane(section);
      ghost.veilAddedMaterial(live);
      expect(live.material.clippingPlanes).toHaveLength(2);
      expect(live.material.clippingPlanes[0]).toBe(section);
      const fill = ghost.object.getObjectByName(
        'offset-body-ghost-veil-fill'
      ) as THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
      expect(fill.material.clippingPlanes![0]).toBe(section);
      // Disposing a held ghost leaves the body as it found it.
      ghost.dispose();
      expect(live.material.clippingPlanes).toEqual([section]);
    });

    it('keeps old material beyond the old plane solid', () => {
      // A second box past the first one's +x face, as a boss stands above a
      // pulled top face.
      const ghost = createBodyGhost(
        new THREE.Mesh(
          mergeGeometries([
            new THREE.BoxGeometry(2, 2, 2),
            new THREE.BoxGeometry(2, 2, 2).translate(2, 2, 0)
          ])
        ),
        { faceRange: { triangleStart: 0, triangleCount: 2 } }
      );
      ghost.veilAddedMaterial(pulled().live);
      expect(veilParts(ghost)).toContain('offset-body-ghost-veil-rest');
      const rest = ghost.object.getObjectByName(
        'offset-body-ghost-veil-rest'
      ) as THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
      expect(rest.material.transparent).toBe(false);
      ghost.veilAddedMaterial(null);
      expect(veilParts(ghost)).toEqual([]);
      ghost.dispose();
    });

    it('stays solid for a face that is not flat', () => {
      const ghost = createBodyGhost(
        new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6)),
        { faceRange: { triangleStart: 0, triangleCount: 20 } }
      );
      const { live } = pulled();
      ghost.veilAddedMaterial(live);
      expect(veilParts(ghost)).toEqual([]);
      expect(live.material.clippingPlanes ?? []).toHaveLength(0);
      ghost.dispose();
    });
  });
});

/** One indexed geometry from several, positions only. */
function mergeGeometries(parts: THREE.BufferGeometry[]) {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const part of parts) {
    const base = positions.length / 3;
    positions.push(...(part.getAttribute('position').array as Float32Array));
    for (const i of part.index!.array) indices.push(base + i);
  }
  return new THREE.BufferGeometry()
    .setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    .setIndex(indices);
}
