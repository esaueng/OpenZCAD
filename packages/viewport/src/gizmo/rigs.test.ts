import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { DragRig } from './DragRig';
import {
  HANDLE_WARNING_COLOR,
  buildCylinderRadiusHandle,
  buildEdgeRadiusHandle,
  buildOffsetFaceHandle,
  offsetHandlePlacement,
  sweepGhostLayout
} from './rigs';

function offsetRig(direction = { x: 0, y: 0, z: 1 }): DragRig {
  return buildOffsetFaceHandle({
    origin: { x: 1, y: 2, z: 3 },
    direction,
    ghostGeometry: null
  });
}

describe('placement is pure', () => {
  it('normalizes the face normal into a unit drag direction', () => {
    const { origin, direction } = offsetHandlePlacement(
      { x: 5, y: 6, z: 7 },
      { x: 0, y: 0, z: 4 }
    );
    expect(origin).toEqual({ x: 5, y: 6, z: 7 });
    expect(direction).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('survives a degenerate normal instead of producing NaN', () => {
    const { direction } = offsetHandlePlacement(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 }
    );
    expect(Number.isNaN(direction.x)).toBe(false);
    expect(Number.isNaN(direction.z)).toBe(false);
  });
});

describe('the offset-face rig', () => {
  it('travels along its direction as the value changes', () => {
    const rig = offsetRig();
    rig.setValue(4);
    expect(rig.value()).toBe(4);
    expect(rig.group.position.z).toBeCloseTo(7, 6);
    // The anchor and direction describe the gesture, not the current pose.
    expect(rig.origin.z).toBe(3);
  });

  it('rides the face to its new level while cutting', () => {
    const rig = offsetRig();
    rig.setValue(-2);
    expect(rig.value()).toBe(-2);
    expect(rig.group.position.z).toBeCloseTo(3 - 2, 6);
  });

  it('anchors its chip on the pin itself, whatever the frame scale', () => {
    // The viewport adds the screen-space gap; a world-space reach past the
    // head is what used to fold the chip onto the arrow when the face
    // normal pointed at the camera.
    const rig = offsetRig();
    rig.setValue(5);
    expect(rig.chipAnchor(2).z).toBeCloseTo(3 + 5, 6);
    expect(rig.chipAnchor(20).z).toBeCloseTo(3 + 5, 6);
    // Cutting, the pin rides the face down to its new level too.
    rig.setValue(-4);
    expect(rig.chipAnchor(2).z).toBeCloseTo(3 - 4, 6);
    // The label rides the dashed dimension from the old level to the pin.
    const line = rig.chipLine?.();
    expect(line?.start.z).toBeCloseTo(3, 6);
    expect(line!.end.z).toBeLessThan(3);
    expect(line!.end.z).toBeGreaterThan(3 - 4);
    rig.setValue(0);
    expect(rig.chipLine?.()).toBeNull();
  });

  it('keeps its arrow on the face normal and rolls its face to the camera', () => {
    const rig = offsetRig({ x: 1, y: 0, z: 0 });
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, -50, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    rig.orient?.(camera);
    const localY = new THREE.Vector3(0, 1, 0).applyQuaternion(
      rig.group.quaternion
    );
    const localZ = new THREE.Vector3(0, 0, 1).applyQuaternion(
      rig.group.quaternion
    );
    // The axis is the normal itself, not its screen projection.
    expect(localY.x).toBeCloseTo(1, 6);
    // The pin's flat face looks at the camera.
    expect(localZ.y).toBeCloseTo(-1, 1);
  });

  it('stays on the normal even when it points straight at the camera', () => {
    const rig = offsetRig({ x: 0, y: -1, z: 0 });
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(1, -50, 3);
    camera.lookAt(1, 0, 3);
    camera.updateMatrixWorld();
    rig.orient?.(camera);
    const localY = new THREE.Vector3(0, 1, 0).applyQuaternion(
      rig.group.quaternion
    );
    expect(localY.y).toBeCloseTo(-1, 6);
    // No roll is preferable here; whichever it picked must be a real one.
    const q = rig.group.quaternion;
    expect(Number.isFinite(q.x + q.y + q.z + q.w)).toBe(true);
  });

  it('carries a ring in the face plane for the head-on view', () => {
    const rig = offsetRig({ x: 0, y: 0, z: 1 });
    const ring = rig.group.children.find(
      (child) =>
        child instanceof THREE.Mesh &&
        child.geometry instanceof THREE.RingGeometry
    ) as THREE.Mesh;
    expect(ring).toBeDefined();
    // Its own normal lies along the rig's local +Y, the face normal.
    const ringNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(
      ring.quaternion
    );
    expect(Math.abs(ringNormal.y)).toBeCloseTo(1, 6);
  });

  it('measures the change with a dashed white dimension between the two levels', () => {
    const rig = offsetRig();
    const arrow = rig.worldGroup.getObjectByName('offset-change-arrow')!;
    const ring = rig.worldGroup.getObjectByName('offset-old-level')!;
    expect(arrow.children.map((child) => child.type)).toEqual([
      'Line2',
      'Mesh',
      'Mesh'
    ]);
    const line = arrow.children[0] as THREE.Object3D & {
      material: { gapSize: number; color: THREE.Color };
    };
    // Dashed, like a drawing's dimension.
    expect(line.material.gapSize).toBeGreaterThan(0);
    expect(line.material.color.getHex()).toBe(0xffffff);
    // Nothing to measure at rest.
    expect(arrow.visible).toBe(false);
    expect(ring.visible).toBe(false);
    rig.setValue(4);
    expect(arrow.visible).toBe(true);
    // The old level is marked where the change starts, on the axis.
    expect(ring.visible).toBe(true);
    expect(ring.position.z).toBeCloseTo(3, 6);
    rig.setValue(0);
    expect(arrow.visible).toBe(false);
  });

  it('marks the old level in coral while cutting', () => {
    const rig = offsetRig();
    const ring = rig.worldGroup.getObjectByName('offset-old-level')!;
    const ringLine = ring.children[0] as THREE.Object3D & {
      material: { color: THREE.Color };
    };
    rig.setValue(3);
    expect(ringLine.material.color.getHex()).toBe(0xffffff);
    rig.setValue(-3);
    expect(ringLine.material.color.getHex()).toBe(0xff644d);
  });

  it.each([false, true])(
    'keeps face offsets free of overlay geometry when the body preview is %s',
    (shown) => {
      const rig = offsetRig();
      rig.setChangeShownByBody?.(shown);
      for (const value of [4, -3, 0, 2]) {
        rig.setValue(value);
        rig.setWarning?.(value < 0);
        expect(rig.worldGroup.children.map((child) => child.name)).toEqual([
          'offset-change-arrow',
          'offset-old-level'
        ]);
        expect(rig.group.position.z).toBeCloseTo(3 + value, 6);
      }
      rig.dispose();
    }
  );

  it('keeps world-space parts out of the rescaled group', () => {
    const rig = buildOffsetFaceHandle({
      origin: { x: 0, y: 0, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      ghostGeometry: new THREE.BufferGeometry()
    });
    // The change arrow, the old level and the ghost are true world geometry:
    // rescaling `group` for the screen-constant arrow must never reach them.
    expect(rig.worldGroup.children.length).toBe(3);
    expect(rig.group.children).not.toContain(rig.worldGroup.children[0]);
    const ghost = rig.worldGroup.children[2]!;
    rig.setValue(4);
    expect(ghost.visible).toBe(true);
    expect(ghost.position).toMatchObject({ x: 0, y: 0, z: 0 });
  });

  it('separates reference ghost styling from invalid-preview warning styling', () => {
    const rig = buildOffsetFaceHandle({
      origin: { x: 0, y: 0, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      ghostGeometry: new THREE.BufferGeometry()
    });
    const ghost = rig.worldGroup.children[2] as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.MeshBasicMaterial
    >;
    const ghostColor = ghost.material.color.getHex();
    rig.setWarning?.(true);
    const visibleArrow = rig.group.children.find(
      (child) =>
        child instanceof THREE.Mesh &&
        child.material instanceof THREE.MeshStandardMaterial &&
        child.material.visible
    ) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    const dimensionLine = rig.worldGroup.getObjectByName('offset-change-arrow')!
      .children[0] as THREE.Object3D & {
      material: { color: THREE.Color };
    };
    expect(visibleArrow.material.color.getHex()).toBe(HANDLE_WARNING_COLOR);
    expect(dimensionLine.material.color.getHex()).toBe(HANDLE_WARNING_COLOR);
    expect(ghost.material.color.getHex()).toBe(ghostColor);
    expect(rig.group.userData.previewWarning).toBe(true);
    rig.setWarning?.(false);
    expect(rig.group.userData.previewWarning).toBe(false);
    rig.dispose();
  });
});

describe('the edge-radius rig', () => {
  it('stands a double-headed pin on the bisector it is given', () => {
    const rig = buildEdgeRadiusHandle({
      origin: { x: 1, y: 2, z: 3 },
      direction: { x: 1, y: 0, z: 0 }
    });
    // Local +Y is the arrow's axis, as on every pin.
    const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(
      rig.group.quaternion
    );
    expect(axis.x).toBeCloseTo(1, 12);
    expect(axis.y).toBeCloseTo(0, 12);
    const cones = rig.group.children.filter(
      (child) =>
        child instanceof THREE.Mesh &&
        child.geometry instanceof THREE.ConeGeometry
    );
    expect(cones).toHaveLength(2);
    rig.dispose();
  });

  it('rides the blend surface by its travel, chip and all', () => {
    const rig = buildEdgeRadiusHandle({
      origin: { x: 4, y: 0, z: 0 },
      direction: { x: -1, y: 0, z: 0 },
      travel: 0.5
    });
    rig.setValue(3);
    expect(rig.value()).toBe(3);
    expect(rig.group.position.x).toBeCloseTo(2.5, 12);
    expect(rig.chipAnchor(2).x).toBeCloseTo(2.5, 12);
    // The anchor and direction describe the gesture, not the current pose.
    expect(rig.origin.x).toBe(4);
  });

  it('stays on the edge without a travel', () => {
    const rig = buildEdgeRadiusHandle({
      origin: { x: 4, y: 0, z: 0 },
      direction: { x: 1, y: 0, z: 0 }
    });
    rig.setValue(3);
    expect(rig.group.position.x).toBe(4);
  });
});

describe('the cylinder-radius rig', () => {
  it('tracks an absolute radius while moving only by the radial delta', () => {
    const rig = buildCylinderRadiusHandle({
      origin: { x: 14, y: 0, z: 8 },
      direction: { x: 1, y: 0, z: 0 },
      originalRadius: 14
    });
    expect(rig.value()).toBe(14);
    rig.setValue(18);
    expect(rig.value()).toBe(18);
    expect(rig.group.position).toMatchObject({ x: 18, y: 0, z: 8 });
    expect(rig.origin).toMatchObject({ x: 14, y: 0, z: 8 });
  });

  it('carries a radius dimension line with two arrowheads, no face ghost', () => {
    const rig = buildCylinderRadiusHandle({
      origin: { x: 0, y: 5, z: 0 },
      direction: { x: 0, y: 1, z: 0 },
      originalRadius: 5
    });
    // One nested graphic rather than three loose children: the renderer moved
    // out so the measurement tape draws the same dimension rather than a
    // second one that would drift from this.
    expect(rig.worldGroup.children).toHaveLength(1);
    const dimension = rig.worldGroup.children[0]!;
    expect(dimension.name).toBe('dimension-graphic');
    // Still a dashed line and two arrowheads, and still no face ghost.
    expect(dimension.children.map((child) => child.type)).toEqual([
      'Line2',
      'Mesh',
      'Mesh'
    ]);
  });

  it('turns its pin to face the camera along the projected radial', () => {
    const rig = buildCylinderRadiusHandle({
      origin: { x: 14, y: 0, z: 8 },
      direction: { x: 1, y: 0, z: 0 },
      originalRadius: 14
    });
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(14, -60, 8);
    camera.lookAt(14, 0, 8);
    camera.updateMatrixWorld();
    rig.orient?.(camera);
    const localY = new THREE.Vector3(0, 1, 0).applyQuaternion(
      rig.group.quaternion
    );
    const localZ = new THREE.Vector3(0, 0, 1).applyQuaternion(
      rig.group.quaternion
    );
    expect(localY.x).toBeCloseTo(1, 1);
    expect(localZ.y).toBeCloseTo(-1, 1);
    rig.dispose();
  });

  it('anchors the label at the pin and rides no line', () => {
    const rig = buildCylinderRadiusHandle({
      origin: { x: 14, y: 0, z: 8 },
      direction: { x: 1, y: 0, z: 0 },
      originalRadius: 14
    });
    // The viewer hangs the label beside the pin; a line to ride would flip
    // it between two layouts as the bore grew on screen.
    rig.setValue(16);
    expect(rig.chipAnchor(1)).toMatchObject({ x: 16, y: 0, z: 8 });
    expect(rig.chipLine).toBeUndefined();
  });

  it('draws the dimension it names: rim to rim for Ø, axis to rim for R', () => {
    const rig = buildCylinderRadiusHandle({
      origin: { x: 14, y: 0, z: 8 },
      direction: { x: 1, y: 0, z: 0 },
      originalRadius: 14
    });
    const [, startHead, endHead] = rig.worldGroup.children[0]!.children;
    const span = () => endHead!.position.x - startHead!.position.x;
    rig.setValue(10);
    // Diameter is the default: the far tip sits on the opposite wall.
    expect(startHead!.position.x).toBeLessThan(-9);
    expect(span()).toBeGreaterThan(18);
    rig.setSpanMode?.('radius');
    expect(startHead!.position.x).toBeGreaterThan(-1);
    expect(span()).toBeLessThan(10);
    rig.setSpanMode?.('diameter');
    expect(startHead!.position.x).toBeLessThan(-9);
    rig.dispose();
  });
});

describe('every rig honours the shared contract', () => {
  const rigs: [string, () => DragRig][] = [
    ['offset-face', () => offsetRig()],
    [
      'edge-radius',
      () =>
        buildEdgeRadiusHandle({
          origin: { x: 0, y: 0, z: 0 },
          direction: { x: 0, y: 0, z: 1 }
        })
    ],
    [
      'cylinder-radius',
      () =>
        buildCylinderRadiusHandle({
          origin: { x: 1, y: 0, z: 0 },
          direction: { x: 1, y: 0, z: 0 },
          originalRadius: 0
        })
    ]
  ];

  for (const [kind, make] of rigs) {
    it(`${kind}: exposes a pickable hit target tagged with its kind`, () => {
      const rig = make();
      expect(rig.kind).toBe(kind);
      const hits: THREE.Object3D[] = [];
      rig.group.traverse((child) => {
        if (child.userData.directHandle === true) {
          hits.push(child);
        }
      });
      expect(hits).toHaveLength(1);
      expect(hits[0]!.userData.handleKind).toBe(kind);
    });

    it(`${kind}: starts at zero and reports what it is set to`, () => {
      const rig = make();
      expect(rig.value()).toBe(0);
      rig.setValue(2.5);
      expect(rig.value()).toBe(2.5);
    });

    it(`${kind}: detaches both groups on dispose`, () => {
      const rig = make();
      const scene = new THREE.Scene();
      scene.add(rig.group, rig.worldGroup);
      rig.dispose();
      expect(rig.group.parent).toBeNull();
      expect(rig.worldGroup.parent).toBeNull();
    });
  }
});

describe('offset rig entrance and hover', () => {
  const settle = (rig: DragRig) => {
    for (let frame = 0; frame < 120 && rig.step?.(16); frame += 1) {
      // step until the rig reports nothing left to move
    }
  };
  const arrowColor = (rig: DragRig) => {
    let hex = -1;
    rig.group.traverse((child) => {
      const material = (child as THREE.Mesh).material;
      // The arrow is lit geometry now; the halo and hit target are not.
      if (
        hex === -1 &&
        material instanceof THREE.MeshStandardMaterial &&
        material.visible
      ) {
        hex = material.color.getHex();
      }
    });
    return hex;
  };

  it('arrives rather than appearing at full strength', () => {
    const rig = offsetRig();

    // On the frame it is built the rig is invisible; the render loop's steps
    // are what bring it in. Its scale is untouched on purpose — scaling would
    // shrink the hit mesh with it and make the handle briefly unpressable.
    expect(rig.group.scale.x).toBe(1);
    let opacity = 0;
    rig.group.traverse((child) => {
      const material = (child as THREE.Mesh).material;
      if (material && !Array.isArray(material)) {
        opacity = Math.max(opacity, material.opacity);
      }
    });
    expect(opacity).toBe(0);

    settle(rig);
    let settled = 0;
    rig.group.traverse((child) => {
      const material = (child as THREE.Mesh).material;
      if (material && !Array.isArray(material)) {
        settled = Math.max(settled, material.opacity);
      }
    });
    expect(settled).toBeGreaterThan(0.5);
    expect(rig.group.scale.x).toBe(1);
    expect(rig.step?.(16)).toBe(false);
  });

  it('deepens under the pointer and recovers when it leaves', () => {
    const rig = offsetRig();
    settle(rig);
    const resting = arrowColor(rig);

    rig.setHot!(true);
    settle(rig);
    const hot = arrowColor(rig);
    expect(hot).not.toBe(resting);
    // Darker, not lighter: a handle that washes out under the hand reads as
    // disabled rather than grabbed.
    const luminance = (hex: number) => {
      const color = new THREE.Color(hex);
      return color.r + color.g + color.b;
    };
    expect(luminance(hot)).toBeLessThan(luminance(resting));

    rig.setHot!(false);
    settle(rig);
    expect(arrowColor(rig)).toBe(resting);
  });

  it('keeps a refused value looking refused while hovered', () => {
    const rig = offsetRig();
    settle(rig);

    rig.setWarning!(true);
    rig.setHot!(true);
    settle(rig);
    // Hover must not soften a value the kernel will reject.
    expect(arrowColor(rig)).toBe(HANDLE_WARNING_COLOR);
  });
});

describe('the swept-volume ghost', () => {
  const square = [
    { x: 0, y: 0, z: 0 },
    { x: 2, y: 0, z: 0 },
    { x: 2, y: 2, z: 0 },
    { x: 0, y: 2, z: 0 }
  ];
  const cap = {
    positions: new Float32Array(square.flatMap((p) => [p.x, p.y, p.z])),
    indices: [0, 1, 2, 0, 2, 3]
  };

  it('lays out a base copy, a moving copy, and one wall quad per loop edge', () => {
    const layout = sweepGhostLayout({ cap, loops: [square] });
    // 4 cap vertices twice, 4 ring vertices twice.
    expect(layout.base.length).toBe(16 * 3);
    // Two caps of 2 triangles, plus 4 wall quads of 2 triangles.
    expect(layout.indices.length).toBe((2 + 2 + 8) * 3);
    expect(layout.moving).toHaveLength(8);
    for (const { top, base } of layout.moving) {
      expect(Array.from(layout.base.slice(top * 3, top * 3 + 3))).toEqual(
        Array.from(layout.base.slice(base * 3, base * 3 + 3))
      );
    }
  });

  it('skips degenerate loops instead of emitting walls for them', () => {
    const layout = sweepGhostLayout({ cap, loops: [square, [square[0]!]] });
    expect(layout.indices.length).toBe((2 + 2 + 8) * 3);
  });

  it('extrudes the moving half by the value every time it is set', () => {
    const rig = buildOffsetFaceHandle({
      origin: { x: 1, y: 1, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      ghostGeometry: null,
      sweep: { cap, loops: [square] }
    });
    const ghost = rig.worldGroup.children.find(
      (child) => child instanceof THREE.Mesh && child.frustumCulled === false
    ) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    expect(ghost).toBeDefined();
    expect(ghost.visible).toBe(false);

    rig.setValue(3);
    expect(ghost.visible).toBe(true);
    const positions = ghost.geometry.getAttribute('position');
    // Base cap stays on the plane; the moving cap and ring sit at z = 3.
    expect(positions.getZ(0)).toBe(0);
    expect(positions.getZ(4)).toBeCloseTo(3, 6);
    expect(positions.getZ(8)).toBe(0);
    expect(positions.getZ(12)).toBeCloseTo(3, 6);

    rig.setValue(-2);
    expect(positions.getZ(4)).toBeCloseTo(-2, 6);
    expect(positions.getX(4)).toBe(0);

    rig.setValue(0);
    expect(ghost.visible).toBe(false);
  });
});

describe('the edge-radius rig', () => {
  it('paints a refused radius as a warning, even while hovered', () => {
    const rig = buildEdgeRadiusHandle({
      origin: { x: 0, y: 0, z: 0 },
      direction: { x: 0, y: 0, z: 1 }
    });
    const shaft = rig.group.children.find(
      (child) =>
        child instanceof THREE.Mesh &&
        child.geometry instanceof THREE.CylinderGeometry &&
        child.userData.directHandle !== true
    ) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    expect(shaft).toBeDefined();

    rig.setHot?.(true);
    rig.step?.(1000);
    rig.setWarning?.(true);
    expect(shaft.material.color.getHex()).toBe(HANDLE_WARNING_COLOR);
    expect(rig.group.userData.previewWarning).toBe(true);
    // Hover ticks must not soften a refused value back to the hot colour.
    rig.step?.(16);
    expect(shaft.material.color.getHex()).toBe(HANDLE_WARNING_COLOR);

    rig.setWarning?.(false);
    rig.step?.(1000);
    expect(shaft.material.color.getHex()).not.toBe(HANDLE_WARNING_COLOR);
    expect(rig.group.userData.previewWarning).toBe(false);
  });
});
