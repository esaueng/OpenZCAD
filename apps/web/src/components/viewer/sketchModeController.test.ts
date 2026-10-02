import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { PLANE_BASES } from '@openzcad/geometry';
import type { SketchObjectData } from '@openzcad/shared';
import {
  buildSketchModeRig,
  committedSketchColor,
  DEFINED_COLOR,
  sketchObjectMarkerPoints
} from './sketchModeController';

const resolve = (value: unknown) => {
  if (typeof value !== 'number') {
    throw new Error('Test resolve handles numbers only.');
  }
  return value;
};

const line = (
  overrides: Partial<Extract<SketchObjectData, { objectKind: 'line' }>> = {}
) =>
  ({
    objectKind: 'line',
    x1: 0,
    y1: 0,
    x2: 10,
    y2: 0,
    ...overrides
  }) as SketchObjectData;

function committedGroupOf(rig: { group: THREE.Group }): THREE.Object3D {
  const group = rig.group.getObjectByName('sketch-committed');
  if (!group) {
    throw new Error('Missing sketch-committed group.');
  }
  return group;
}

function visualColors(rig: { group: THREE.Group }): number[] {
  return committedGroupOf(rig)
    .children.filter((child): child is Line2 => child instanceof Line2)
    .map((child) => child.material.color.getHex());
}

function dotColors(rig: { group: THREE.Group }): number[] {
  const dots = rig.group.getObjectByName('sketch-snap-points');
  if (!dots || !(dots instanceof THREE.Points)) {
    return [];
  }
  const geometry = dots.geometry as unknown;
  if (!(geometry instanceof THREE.BufferGeometry)) {
    throw new Error('Snap points have no buffer geometry.');
  }
  const raw = geometry.getAttribute('color') as unknown;
  if (!(raw instanceof THREE.BufferAttribute)) {
    throw new Error('Missing snap-point colors.');
  }
  const hexes: number[] = [];
  const color = new THREE.Color();
  for (let index = 0; index < raw.count; index += 1) {
    color.setRGB(
      raw.getX(index),
      raw.getY(index),
      raw.getZ(index),
      THREE.LinearSRGBColorSpace
    );
    hexes.push(color.getHex());
  }
  return hexes;
}

describe('committedSketchColor', () => {
  it('keeps the normal blue for an unsolved sketch', () => {
    expect(
      committedSketchColor({
        diagnostic: false,
        selected: false,
        defined: false,
        construction: false
      })
    ).toBe(0x6798ff);
  });

  it('paints the success token green when the sketch is fully defined', () => {
    // The green mirrors --color-success in theme/tokens.css.
    expect(DEFINED_COLOR).toBe(0x48cd8f);
    expect(
      committedSketchColor({
        diagnostic: false,
        selected: false,
        defined: true,
        construction: false
      })
    ).toBe(DEFINED_COLOR);
  });

  it('pins the conflict/selection/construction precedence', () => {
    const selectedDefined = committedSketchColor({
      diagnostic: false,
      selected: true,
      defined: true,
      construction: false
    });
    expect(selectedDefined).toBe(0xf59e0b);
    const conflictDefined = committedSketchColor({
      diagnostic: true,
      selected: true,
      defined: true,
      construction: false
    });
    expect(conflictDefined).toBe(0xff5d73);
    // Construction keeps its grey even when fully defined: the dashed grey
    // is what says "reference, not profile".
    expect(
      committedSketchColor({
        diagnostic: false,
        selected: false,
        defined: true,
        construction: true
      })
    ).toBe(0x7b8da3);
  });
});

describe('sketchObjectMarkerPoints', () => {
  it('returns the constraint-schema points of lines, circles and arcs', () => {
    expect(sketchObjectMarkerPoints(line(), resolve)).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 }
    ]);
    const circle: SketchObjectData = {
      objectKind: 'circle',
      radius: 3,
      centerX: 4,
      centerY: 5
    };
    expect(sketchObjectMarkerPoints(circle, resolve)).toEqual([{ x: 4, y: 5 }]);
    const arc: SketchObjectData = {
      objectKind: 'arc',
      centerX: 0,
      centerY: 0,
      radius: 2,
      startAngleDeg: 0,
      endAngleDeg: 90
    };
    const markers = sketchObjectMarkerPoints(arc, resolve);
    expect(markers).toHaveLength(3);
    expect(markers[0]).toEqual({ x: 0, y: 0 });
    expect(markers[1]!.x).toBeCloseTo(2, 10);
    expect(markers[1]!.y).toBeCloseTo(0, 10);
    expect(markers[2]!.x).toBeCloseTo(0, 10);
    expect(markers[2]!.y).toBeCloseTo(2, 10);
  });

  it('has no schema points for text', () => {
    const text: SketchObjectData = {
      objectKind: 'text',
      text: 'A',
      fontFamily: 'open-sans',
      fontStyle: 'regular',
      size: 5,
      x: 0,
      y: 0
    };
    expect(sketchObjectMarkerPoints(text, resolve)).toEqual([]);
  });
});

describe('sketch mode defined colours', () => {
  const basis = PLANE_BASES.XY;
  const resolution = () => ({ width: 800, height: 600 });

  it('paints lines and their snap-point dots fully-defined green', () => {
    const rig = buildSketchModeRig(basis, resolution);
    try {
      rig.setObjects(
        [{ id: 'ent_line', data: line() }],
        null,
        resolve,
        [],
        ['ent_line']
      );
      expect(visualColors(rig)).toEqual([DEFINED_COLOR]);
      // One dot per endpoint, wearing the line's own colour.
      expect(dotColors(rig)).toEqual([DEFINED_COLOR, DEFINED_COLOR]);
    } finally {
      rig.dispose();
    }
  });

  it('leaves under-defined geometry in the normal style', () => {
    const rig = buildSketchModeRig(basis, resolution);
    try {
      rig.setObjects([{ id: 'ent_line', data: line() }], null, resolve, [], []);
      expect(visualColors(rig)).toEqual([0x6798ff]);
      expect(dotColors(rig)).toEqual([0x6798ff, 0x6798ff]);
    } finally {
      rig.dispose();
    }
  });

  it('lets the conflict residual beat the defined state', () => {
    const rig = buildSketchModeRig(basis, resolution);
    try {
      rig.setObjects(
        [{ id: 'ent_line', data: line() }],
        null,
        resolve,
        ['ent_line'],
        ['ent_line']
      );
      expect(visualColors(rig)).toEqual([0xff5d73]);
      expect(dotColors(rig)).toEqual([0xff5d73, 0xff5d73]);
    } finally {
      rig.dispose();
    }
  });

  it('keeps the dots out of picking', () => {
    const rig = buildSketchModeRig(basis, resolution);
    try {
      rig.setObjects([{ id: 'ent_line', data: line() }], null, resolve, [], []);
      const dots = rig.group.getObjectByName('sketch-snap-points');
      expect(dots).toBeDefined();
      // A Points raycast would answer without a sketchObjectId and make
      // pickObject return null over a dot; the proxy lines stay the only
      // pick targets.
      const raycaster = new THREE.Raycaster();
      expect(() => (dots as THREE.Points).raycast(raycaster, [])).not.toThrow();
      expect(
        committedGroupOf(rig).children.filter(
          (child) => child.userData.sketchObjectId === 'ent_line'
        )
      ).not.toHaveLength(0);
    } finally {
      rig.dispose();
    }
  });
});
