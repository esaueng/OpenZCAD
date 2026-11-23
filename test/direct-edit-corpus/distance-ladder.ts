import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import type { FaceTopology } from '@openzcad/shared';

import { buildOffsetFaces } from '../../apps/web/src/lib/faceSetOffset';
import { planFaceOffset } from '../../apps/web/src/lib/interaction/faceOffsetPlan';
import { blendCarrierSnapshot } from '../../packages/kernel-adapter/src/exact-measure';
import {
  BOX,
  EMBED,
  POST,
  RIM,
  ROOT,
  TAPER,
  type PartName,
  type ReferencePart
} from './reference-parts';
import { faceSelector, resolveFixtureFace } from './resolve';

type Operation = 'offset' | 'offset-set' | 'blend-radius' | 'cylinder-radius';

/** null denotes a direction with no geometric bound. */
export interface Ladder {
  part: PartName;
  target: string;
  operation: Operation;
  pick: readonly ((face: FaceTopology) => boolean)[];
  inward: number | null;
  outward: number | null;
  section?: number;
  extraOutward?: readonly number[];
}

const horizontal =
  (z: number, sign = 1) =>
  (face: FaceTopology) =>
    face.geometry?.surfaceType === 'plane' &&
    face.geometry.normal?.z === sign &&
    Math.abs(face.geometry.center.z - z) < 1e-9;
const root = (face: FaceTopology) =>
  face.geometry?.surfaceType === 'torus' && face.geometry.blendRadius === ROOT;
const wall = (face: FaceTopology) =>
  face.geometry?.surfaceType === 'cylinder' &&
  face.geometry.radius === POST.radius;
const verticalRound = (face: FaceTopology) =>
  face.geometry?.surfaceType === 'cylinder' &&
  Math.abs(face.geometry.center.x - RIM / 2) < 1e-9 &&
  Math.abs(face.geometry.center.y - RIM / 2) < 1e-9 &&
  Math.abs(face.geometry.center.z - BOX.depth / 2) < 1e-9;
const plateArea = BOX.width * BOX.height;
const roundedPlateArea = plateArea - (4 - Math.PI) * RIM ** 2;
const postArea = Math.PI * POST.radius ** 2;
const bossRise = POST.height - EMBED;

export const LADDERS: readonly Ladder[] = [
  {
    part: 'A',
    target: 'bottom',
    operation: 'offset',
    pick: [horizontal(0, -1)],
    inward: BOX.depth - 2 * RIM,
    outward: null,
    section: roundedPlateArea
  },
  {
    part: 'A',
    target: 'cone-cap',
    operation: 'offset',
    pick: [horizontal(BOX.depth + bossRise)],
    inward: bossRise,
    outward:
      (TAPER.topRadius * TAPER.height) / (TAPER.bottomRadius - TAPER.topRadius)
  },
  {
    part: 'A',
    target: 'shoulder',
    operation: 'offset',
    pick: [horizontal(BOX.depth)],
    inward: BOX.depth - 2 * RIM,
    outward: bossRise - ROOT
  },
  {
    part: 'A',
    target: 'root',
    operation: 'blend-radius',
    pick: [root],
    inward: ROOT,
    outward: BOX.height / 2 - TAPER.bottomRadius - ROOT
  },
  {
    part: 'B',
    target: 'cap',
    operation: 'offset',
    pick: [horizontal(BOX.depth)],
    inward: BOX.depth - 2 * RIM,
    outward: null,
    section: roundedPlateArea
  },
  {
    part: 'B',
    target: 'edge-round',
    operation: 'blend-radius',
    pick: [verticalRound],
    inward: RIM,
    outward: BOX.depth / 2 - RIM,
    extraOutward: [Math.min(BOX.width, BOX.height) - 2 * RIM]
  },
  {
    part: 'C',
    target: 'shoulder',
    operation: 'offset',
    pick: [horizontal(BOX.depth)],
    inward: BOX.depth,
    outward: bossRise - ROOT,
    section: plateArea - postArea
  },
  {
    part: 'C',
    target: 'boss-cap',
    operation: 'offset',
    pick: [horizontal(BOX.depth + bossRise)],
    inward: bossRise - ROOT,
    outward: null,
    section: postArea
  },
  {
    part: 'C',
    target: 'cap-set',
    operation: 'offset-set',
    pick: [horizontal(BOX.depth + bossRise), horizontal(BOX.depth)],
    inward: BOX.depth,
    outward: null,
    section: plateArea
  },
  {
    part: 'C',
    target: 'root',
    operation: 'blend-radius',
    pick: [root],
    inward: ROOT,
    outward: BOX.height / 2 - POST.radius - ROOT
  },
  {
    part: 'C',
    target: 'wall',
    operation: 'cylinder-radius',
    pick: [wall],
    inward: POST.radius,
    outward: BOX.height / 2 - POST.radius - ROOT
  },
  {
    part: 'D',
    target: 'cap',
    operation: 'offset',
    pick: [horizontal(POST.height)],
    inward: POST.height - 2 * RIM,
    outward: null,
    section: postArea
  },
  {
    part: 'D',
    target: 'wall',
    operation: 'cylinder-radius',
    pick: [wall],
    inward: POST.radius - RIM,
    outward: null
  }
];

export function ladderSteps(ladder: Ladder, sign: -1 | 1): number[] {
  const limit = sign < 0 ? ladder.inward : ladder.outward;
  const span = ladder.part === 'D' ? POST.height : BOX.width;
  const values =
    limit === null
      ? [0.1, 1, span / 4, span / 2, span, 2 * span]
      : [
          0.1,
          1,
          limit / 4,
          limit / 2,
          limit - 0.1,
          limit,
          limit + 0.1,
          2 * limit
        ];
  if (sign > 0) values.push(...(ladder.extraOutward ?? []));
  return [...new Set(values)]
    .sort((a, b) => a - b)
    .map((value) => sign * value);
}

function requireCommand(command: AnyCommand | null | undefined): AnyCommand {
  if (!command)
    throw new Error('The ladder pick could not create an edit command.');
  return command;
}

export function ladderFaces(
  part: ReferencePart,
  ladder: Ladder
): FaceTopology[] {
  return ladder.pick.map((pick) => {
    const matches = part.body.topology!.faces.filter(pick);
    if (matches.length !== 1) {
      throw new Error(
        `${ladder.part}/${ladder.target}: expected one face, found ${matches.length}`
      );
    }
    return resolveFixtureFace(part.body, faceSelector(matches[0]!));
  });
}

export function ladderCommand(
  part: ReferencePart,
  ladder: Ladder,
  faces: FaceTopology[],
  distance: number
): AnyCommand {
  const [face, ...others] = faces;
  const geometry = face!.geometry!;
  const faceHash = face!.hash;
  const { bodyId, document } = part;
  const identity = {
    faceHash,
    ...(face!.reference ? { faceReference: face!.reference } : {})
  };
  switch (ladder.operation) {
    case 'offset':
      return requireCommand(
        planFaceOffset({
          document,
          bodyId,
          face: face!,
          faceHash,
          offset: distance,
          localOnly: true
        })?.command
      );
    case 'offset-set':
      return requireCommand(
        buildOffsetFaces({
          document: {
            ...document,
            derived: {
              ...document.derived,
              bodyRepresentations: { [bodyId]: part.body }
            }
          },
          bodyId,
          face: face!,
          members: others,
          offset: distance
        })
      );
    case 'blend-radius': {
      const carrier = blendCarrierSnapshot(geometry);
      if (!carrier)
        throw new Error(`No analytic blend carrier for ${ladder.target}`);
      return commandFactories.directEditBody({
        name: 'Resize blend',
        targetBodyId: bodyId,
        operation: {
          kind: 'resize-blend',
          ...identity,
          surfaceClass: carrier.surfaceClass,
          recordedRadius: carrier.radius,
          recordedCenter: carrier.center,
          recordedAxis: carrier.axis,
          newRadius: carrier.radius + distance
        }
      });
    }
    case 'cylinder-radius':
      return commandFactories.directEditBody({
        name: 'Resize cylindrical face',
        targetBodyId: bodyId,
        operation: {
          kind: 'resize-cylindrical-face',
          ...identity,
          sourceRadius: geometry.radius!,
          sourceAxisStart: geometry.axisStart!,
          sourceAxisEnd: geometry.axisEnd!,
          concavity: 'boss',
          radius: geometry.radius! + distance
        }
      });
  }
}
