import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { AssemblyDragSpec } from '@openzcad/shared';
import {
  assemblyDragReading,
  beginAssemblyDrag,
  formatAssemblyDragValue,
  readAssemblyDrag
} from './assemblyDrag';

const PIVOT_FRAME = {
  origin: { x: 0, y: 0, z: 0 },
  zAxis: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 }
};

function revolute(overrides: Partial<AssemblyDragSpec> = {}): AssemblyDragSpec {
  return {
    jointId: 'pivot',
    dof: 0,
    unit: 'deg',
    axisFrame: PIVOT_FRAME,
    axis: { x: 0, y: 0, z: 1 },
    direction: 1,
    startValue: 0,
    limit: { min: 0, max: 35 },
    ...overrides
  };
}

/** A ray straight down onto the XY plane at polar (radius, deg). */
function downAt(radius: number, deg: number, height = 50): THREE.Ray {
  const a = THREE.MathUtils.degToRad(deg);
  return new THREE.Ray(
    new THREE.Vector3(radius * Math.cos(a), radius * Math.sin(a), height),
    new THREE.Vector3(0, 0, -1)
  );
}

describe('assembly drag', () => {
  it('turns a revolute by the pointer angle about the axis', () => {
    const session = beginAssemblyDrag(
      revolute(),
      { kind: 'revolute', values: [0] },
      downAt(40, 0),
      { x: 40, y: 0, z: 2 }
    )!;
    expect(session.mode).toBe('angle');
    const reading = readAssemblyDrag(session, downAt(40, 12))!;
    expect(reading.value).toBeCloseTo(12, 9);
    expect(reading.values).toEqual([reading.value]);
    expect(reading.atLimit).toBeNull();
  });

  it('measures from where the pointer pressed, not from the grab point', () => {
    const session = beginAssemblyDrag(
      revolute(),
      { kind: 'revolute', values: [0] },
      downAt(40, 5),
      { x: 40, y: 0, z: 0 }
    )!;
    expect(readAssemblyDrag(session, downAt(40, 5))!.value).toBeCloseTo(0, 9);
    expect(readAssemblyDrag(session, downAt(40, 15))!.value).toBeCloseTo(10, 9);
  });

  it('soft-stops at the limits and comes straight back', () => {
    const session = beginAssemblyDrag(
      revolute(),
      { kind: 'revolute', values: [0] },
      downAt(40, 0),
      { x: 40, y: 0, z: 0 }
    )!;
    const past = readAssemblyDrag(session, downAt(40, 60))!;
    expect(past.value).toBe(35);
    expect(past.atLimit).toBe('max');
    const below = readAssemblyDrag(session, downAt(40, -10))!;
    expect(below.value).toBe(0);
    expect(below.atLimit).toBe('min');
    expect(readAssemblyDrag(session, downAt(40, 20))!.value).toBeCloseTo(20, 9);
  });

  it('keeps turning past half a turn without wrapping', () => {
    const session = beginAssemblyDrag(
      revolute({ limit: null }),
      { kind: 'revolute', values: [0] },
      downAt(40, 0),
      { x: 40, y: 0, z: 0 }
    )!;
    for (const deg of [60, 120, 170, 200, 260])
      readAssemblyDrag(session, downAt(40, deg));
    expect(readAssemblyDrag(session, downAt(40, 300))!.value).toBeCloseTo(
      300,
      9
    );
  });

  it('reverses for a joint reached from its child side', () => {
    const session = beginAssemblyDrag(
      revolute({ direction: -1, startValue: 20, limit: null }),
      { kind: 'revolute', values: [20] },
      downAt(40, 0),
      { x: 40, y: 0, z: 0 }
    )!;
    expect(readAssemblyDrag(session, downAt(40, 5))!.value).toBeCloseTo(15, 9);
  });

  it('keeps the joint’s other motions while one is dragged', () => {
    const session = beginAssemblyDrag(
      revolute({ limit: null }),
      { kind: 'cylindrical', values: [0, 7.5] },
      downAt(40, 0),
      { x: 40, y: 0, z: 0 }
    )!;
    expect(readAssemblyDrag(session, downAt(40, 30))!.values[1]).toBe(7.5);
  });

  it('reads nothing from a turn plane seen edge-on', () => {
    const session = beginAssemblyDrag(
      revolute(),
      { kind: 'revolute', values: [0] },
      downAt(40, 0),
      { x: 40, y: 0, z: 0 }
    )!;
    const edgeOn = new THREE.Ray(
      new THREE.Vector3(-100, 10, 0),
      new THREE.Vector3(1, 0, 0)
    );
    expect(readAssemblyDrag(session, edgeOn)).toBeNull();
  });

  it('slides along the axis where the ray passes closest', () => {
    const spec: AssemblyDragSpec = {
      ...revolute(),
      unit: 'mm',
      axis: { x: 1, y: 0, z: 0 },
      startValue: 2,
      limit: { min: -5, max: 10 }
    };
    const session = beginAssemblyDrag(
      spec,
      { kind: 'slider', values: [2] },
      new THREE.Ray(new THREE.Vector3(3, 1, 50), new THREE.Vector3(0, 0, -1)),
      { x: 3, y: 1, z: 0 }
    )!;
    expect(session.mode).toBe('linear');
    const reading = readAssemblyDrag(
      session,
      new THREE.Ray(new THREE.Vector3(7, 4, 50), new THREE.Vector3(0, 0, -1))
    )!;
    expect(reading.value).toBeCloseTo(6, 9);
    const far = readAssemblyDrag(
      session,
      new THREE.Ray(new THREE.Vector3(30, 0, 50), new THREE.Vector3(0, 0, -1))
    )!;
    expect(far.value).toBe(10);
    expect(far.atLimit).toBe('max');
  });

  it('steps before clamping, so a limit is reached exactly', () => {
    const session = { spec: revolute(), baseValues: [0] };
    expect(assemblyDragReading(session, 12.34, 1).value).toBe(12);
    expect(assemblyDragReading(session, 34.8, 1).value).toBe(35);
    expect(
      assemblyDragReading(
        { ...session, spec: revolute({ limit: null }) },
        0.3000001,
        0.1
      ).value
    ).toBe(0.3);
  });

  it('formats the chip with its unit and the limit it rests on', () => {
    expect(formatAssemblyDragValue(12, 'deg', null)).toBe('12.0°');
    expect(formatAssemblyDragValue(35, 'deg', 'max')).toBe('35.0° · max');
    expect(formatAssemblyDragValue(-0.01, 'mm', 'min')).toBe('0.0 mm · min');
  });
});
