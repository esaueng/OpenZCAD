import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { composeMoveTransform } from '../gizmo/moveTransform';
import { moveEuler } from '../gizmo/move';
import {
  DrawnBodyReport,
  bodiesDrawnElsewhere,
  bodyDrawnAsBuilt
} from './drawnBodies';

/**
 * The viewport's answer to "am I still drawing the document's own geometry?"
 *
 * It is asked of the objects rather than of the mechanisms on purpose. Three
 * separate mechanisms have now drawn something other than the document while
 * the exact section went on describing the document — the last of them, the
 * Move gizmo, by posing a body's mesh with no state outside the viewer at
 * all. These tests pose objects the way each mechanism does, and one of them
 * poses an object the way nothing does, which is the case that matters most:
 * a mechanism that does not exist yet has to be covered by the same rule.
 */

function bodyObject(): THREE.Object3D {
  return new THREE.Object3D();
}

function drawing(...bodies: [string, THREE.Object3D][]) {
  return new Map(bodies);
}

describe('a body drawn as the document built it', () => {
  it('is a fresh object: untranslated, unturned, unscaled, visible', () => {
    expect(bodyDrawnAsBuilt(bodyObject())).toBe(true);
  });

  it('is not one the Move gizmo has translated', () => {
    // Exactly what applyMovePreview does for a typed Z of 10 with no
    // rotation: compose the transform about the body centre and set it.
    const object = bodyObject();
    const final = composeMoveTransform(
      { x: 10, y: 5, z: 3 },
      { x: 0, y: 0, z: 10 },
      { x: 0, y: 0, z: 0 }
    );
    object.rotation.copy(moveEuler({ x: 0, y: 0, z: 0 }));
    object.position.set(final.x, final.y, final.z);

    expect(object.position.z).toBe(10);
    expect(bodyDrawnAsBuilt(object)).toBe(false);
  });

  it('is not one the Move gizmo has turned in place', () => {
    // A rotation is the worse half of the same defect: it changes the true
    // cross-section shape, not just where it is.
    const object = bodyObject();
    const rotationDeg = { x: 0, y: 0, z: 45 };
    const final = composeMoveTransform(
      { x: 10, y: 5, z: 3 },
      { x: 0, y: 0, z: 0 },
      rotationDeg
    );
    object.rotation.copy(moveEuler(rotationDeg));
    object.position.set(final.x, final.y, final.z);

    expect(bodyDrawnAsBuilt(object)).toBe(false);
  });

  it('is not one a face drag has scaled', () => {
    // The primitive face drag scales and re-centres the mesh in place for
    // the length of the drag, and reaches no state outside the viewer either.
    const object = bodyObject();
    object.scale.x = 1.4;
    object.position.x = 2;

    expect(bodyDrawnAsBuilt(object)).toBe(false);
  });

  it('is not one that has been hidden under something else', () => {
    const object = bodyObject();
    object.visible = false;

    expect(bodyDrawnAsBuilt(object)).toBe(false);
  });

  it('is not one posed by a mechanism nobody has written yet', () => {
    // No mechanism in the app poses a body this way today. That is the
    // point: the rule is about the object, so a future one is covered
    // without this file, the section, or the workspace learning its name.
    const object = bodyObject();
    object.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.2);

    expect(bodyDrawnAsBuilt(object)).toBe(false);
  });

  it('has no tolerance: a hair off the document pose is off it', () => {
    const object = bodyObject();
    object.position.z = 1e-9;

    expect(bodyDrawnAsBuilt(object)).toBe(false);
  });
});

describe('which bodies the viewport is drawing elsewhere', () => {
  it('names the posed ones and leaves the rest alone', () => {
    const moved = bodyObject();
    moved.position.z = 10;

    expect(
      bodiesDrawnElsewhere(drawing(['body_a', bodyObject()], ['body_b', moved]))
    ).toEqual(['body_b']);
  });

  it('is empty while every body rests where the document put it', () => {
    expect(
      bodiesDrawnElsewhere(
        drawing(['body_a', bodyObject()], ['body_b', bodyObject()])
      )
    ).toEqual([]);
  });
});

describe('the per-frame report', () => {
  it('speaks when a body starts and stops being posed, not per frame', () => {
    const object = bodyObject();
    const objects = drawing(['body_a', object]);
    const report = new DrawnBodyReport();

    // A scene drawing the document has nothing to report: the workspace
    // starts out believing exactly that, so silence is the honest answer.
    expect(report.sample(objects)).toBeNull();

    object.position.z = 10;
    expect(report.sample(objects)).toEqual(['body_a']);
    // Sixty of these a second during a drag, and only the first speaks.
    object.position.z = 11;
    expect(report.sample(objects)).toBeNull();

    object.position.z = 0;
    expect(report.sample(objects)).toEqual([]);
  });

  it('forgets a torn-down scene rather than leaving it posed for good', () => {
    const object = bodyObject();
    object.position.z = 10;
    const objects = drawing(['body_a', object]);
    const report = new DrawnBodyReport();
    expect(report.sample(objects)).toEqual(['body_a']);

    // A viewer that has been disposed draws nothing at all. Reporting its
    // last pose forever would refuse every section until a reload.
    expect(report.reset()).toEqual([]);
    expect(report.sample(objects)).toEqual(['body_a']);
  });

  it('drops a body that is no longer drawn', () => {
    const object = bodyObject();
    object.visible = false;
    const report = new DrawnBodyReport();
    expect(report.sample(drawing(['body_a', object]))).toEqual(['body_a']);

    expect(report.sample(drawing())).toEqual([]);
  });
});
