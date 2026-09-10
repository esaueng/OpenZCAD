/** Shared construction for the growing-holder perf harness (mirrors test/hammer-holder-growing.test.ts). */
import { readFileSync } from 'node:fs';
import {
  addSketchFeature,
  booleanBodies,
  createProjectDocument,
  extrudeSketch,
  findSketch,
  importStepBody,
  setParameter,
  transformBody
} from '@openzcad/document-core';
import { toUserId, type SketchObjectData } from '@openzcad/shared';
import { sanitizeStepHeaderPrivacy } from '@openzcad/io-step';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';

const move = (x: number, y = 0, z = 0) =>
  Float64Array.of(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1);

export async function precutEnds(sourcePath: string) {
  const io = await loadRemusTranslators();
  const kernel = new RemusKernel();
  try {
    const [source] = kernel.deserializeSolids(
      io.importStep(readFileSync(sourcePath))
    );
    const cut = (x: number, right: boolean) => {
      const box = kernel.makeBox(x + 100, 200, 200);
      const mask = kernel.copyAndTransformSolid(box, move(-100, -100, -100));
      const solid = right
        ? kernel.cut(source!, mask)
        : kernel.intersect(source!, mask);
      if (kernel.validateSolid(solid) !== 0) throw new Error('precut invalid');
      return sanitizeStepHeaderPrivacy(
        new TextDecoder().decode(
          io.exportStep(kernel.serializeSolids(Uint32Array.of(solid)))
        ),
        'holder-end.step'
      );
    };
    return { leftText: cut(-4, false), rightText: cut(26, true) };
  } finally {
    kernel.free();
  }
}

export function buildHammerDocument(
  width: number,
  leftText: string,
  rightText: string,
  withUnion = true
) {
  let document = setParameter(
    createProjectDocument('Hammer growing opening', toUserId('local_hammer')),
    { name: 'opening_width', expression: String(width) }
  );
  const left = importStepBody(document, {
    name: 'Left arm and mounting hole',
    artifactId: 'left_end',
    sourceName: 'left-end.step',
    stepText: leftText
  });
  const right = importStepBody(left.document, {
    name: 'Right arm and mounting hole',
    artifactId: 'right_end',
    sourceName: 'right-end.step',
    stepText: rightText
  });
  const w = 'require_min(opening_width, 16.1)';
  const objects: SketchObjectData[] = [
    { objectKind: 'line', x1: 39.5, y1: 4.5, x2: 59.5, y2: 4.5 },
    { objectKind: 'line', x1: 59.5, y1: 4.5, x2: 59.5, y2: 9.5 },
    { objectKind: 'arc', centerX: 56.5, centerY: 9.5, radius: 3, startAngleDeg: 0, endAngleDeg: 90 },
    { objectKind: 'line', x1: 56.5, y1: 12.5, x2: 42.5, y2: 12.5 },
    { objectKind: 'arc', centerX: 42.5, centerY: 9.5, radius: 3, startAngleDeg: 90, endAngleDeg: 180 },
    { objectKind: 'line', x1: 39.5, y1: 9.5, x2: 39.5, y2: 4.5 }
  ];
  const sketch = addSketchFeature(right.document, {
    name: 'Bridge section',
    planeRef: { type: 'canonical', plane: 'YZ', offset: `19 - (${w}) / 2` },
    objects
  });
  const bridge = extrudeSketch(sketch.document, {
    name: 'Opening bridge',
    sketchId: sketch.sketchId,
    distance: `(${w}) - 16`,
    profile: {
      all: true,
      sourceEntityIds: findSketch(sketch.document, sketch.sketchId)!.objectIds
    }
  });
  const movedLeft = transformBody(bridge.document, {
    name: 'Left arm position',
    targetBodyId: left.bodyId,
    translation: { x: `(46 - (${w})) / 2`, y: 0, z: 0 }
  });
  const movedRight = transformBody(movedLeft.document, {
    name: 'Right arm position',
    targetBodyId: right.bodyId,
    translation: { x: `((${w}) - 46) / 2`, y: 0, z: 0 }
  });
  document = movedRight.document;
  let holderBodyId: string | undefined;
  if (withUnion) {
    const joined = booleanBodies(movedRight.document, {
      name: 'Holder',
      operation: 'union',
      targetBodyIds: [movedLeft.bodyId, bridge.bodyId, movedRight.bodyId]
    });
    document = joined.document;
    holderBodyId = joined.bodyId;
  }
  return {
    document,
    leftBodyId: movedLeft.bodyId,
    bridgeBodyId: bridge.bodyId,
    rightBodyId: movedRight.bodyId,
    holderBodyId
  };
}

export function setWidth(document: ReturnType<typeof buildHammerDocument>['document'], width: number) {
  return setParameter(document, { name: 'opening_width', expression: String(width) });
}
